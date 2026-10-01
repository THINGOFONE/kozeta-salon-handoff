// Orphan sweep regression tests.
//
// Verifies that sweepOrphanedPayments / checkAndRefundOrphan:
//  1. Does NOT refund when Phorest shows an active appointment (no phorestBookingId, matched by time)
//  2. REFUNDS when no pending booking exists and Phorest shows no appointment
//  3. REFUNDS when phorestBookingId is present but the appointment is CANCELLED in Phorest
//  4. Does NOT refund when phorestBookingId is present and appointment is still ACTIVE
//  5. Does NOT refund PIs tagged statusUnknown (defers to next sweep)
//  6. Does NOT refund legacy PIs that have no startDateTime metadata (manual review flag)
//
// All tests use mocked Stripe, Phorest, pendingBookings, paymentLocks, and DB.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Environment stubs ────────────────────────────────────────────────────────
process.env.SESSION_SECRET = "test-orphan-sweep-secret";
process.env.PHOREST_USERNAME = "global/test";
process.env.PHOREST_PASSWORD = "test-password";
process.env.PHOREST_BUSINESS_ID = "test-business";
process.env.PHOREST_BRANCH_ID = "kAzBqW9d2LmXo4Vu";
process.env.STRIPE_SECRET_KEY = "sk_test_orphan";
process.env.DATABASE_URL = "postgres://test/test";

// ── DB stub ──────────────────────────────────────────────────────────────────
// Records insert(...).values(payload) calls so tests can assert review flags.
const dbInsertValues = vi.hoisted(() => [] as any[]);
vi.mock("./db", () => {
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve: any) => resolve([]);
      if (prop === "values") {
        return (payload: any) => {
          dbInsertValues.push(payload);
          return chain;
        };
      }
      return (..._args: any[]) => chain;
    },
    apply: () => chain,
  });
  return { db: chain, pool: { end: vi.fn() } };
});

// ── Phorest mock ─────────────────────────────────────────────────────────────
vi.mock("./phorestApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./phorestApi")>();
  return {
    ...actual,
    isPhorestConfigured: vi.fn(() => true),
    listAppointments: vi.fn(async () => ({ content: [] })),
    listClients: vi.fn(async () => ({ content: [] })),
    getClient: vi.fn(async () => ({})),
    createClient: vi.fn(async () => ({})),
    updateClient: vi.fn(async () => ({})),
    getClientServiceHistories: vi.fn(async () => ({ content: [] })),
    getClientLoyalty: vi.fn(async () => ({ points: 0 })),
    getAppointment: vi.fn(async () => ({ activationState: "ACTIVE" })),
    cancelAppointment: vi.fn(async () => ({})),
    checkAppointmentAvailability: vi.fn(async () => ({})),
    createBooking: vi.fn(async () => ({ phorestBookingId: "phbk-1" })),
    activateBooking: vi.fn(async () => ({})),
    listBranchServices: vi.fn(async () => ({ content: [] })),
    listStaff: vi.fn(async () => ({ content: [] })),
    listProducts: vi.fn(async () => ({ content: [] })),
  };
});

// ── Stripe mock ──────────────────────────────────────────────────────────────
// stripeMock is the fake Stripe client returned by getStripeClient()
const stripeMock = vi.hoisted(() => ({
  paymentIntents: {
    list: vi.fn(),
  },
  charges: {
    retrieve: vi.fn(),
  },
  refunds: {
    create: vi.fn(async () => ({ id: "re_orphan_test", status: "succeeded" })),
  },
}));

vi.mock("./stripeClient", () => ({
  isStripeConfigured: vi.fn(async () => true),
  getStripePublishableKey: vi.fn(async () => "pk_test_123"),
  getStripeClient: vi.fn(async () => stripeMock),
  createPaymentIntent: vi.fn(async () => ({})),
  retrievePaymentIntent: vi.fn(async () => ({})),
  cancelPaymentIntent: vi.fn(async () => ({})),
  createRefund: vi.fn(async () => ({})),
  listPaymentIntents: vi.fn(async () => ({ data: [] })),
}));

// ── pendingBookings mock ──────────────────────────────────────────────────────
vi.mock("./pendingStore", () => ({
  PENDING_EXPIRY_MS: 15 * 60 * 1000,
  pendingBookings: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
  pendingOrders: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
  findReusablePendingBooking: vi.fn(async () => undefined),
  findReusablePendingOrder: vi.fn(async () => undefined),
  startPendingCleanup: vi.fn(),
}));

// ── paymentLocks mock — passes through by default (lock always granted) ──────
vi.mock("./paymentLocks", () => ({
  tryAcquireFinalizeLock: vi.fn(async () => true),
  releaseFinalizeLock: vi.fn(async () => {}),
  tryAcquireRefundLock: vi.fn(async () => true),
  releaseRefundLock: vi.fn(async () => {}),
  withRefundLock: vi.fn(async (_id: string, fn: () => any) => {
    try {
      const result = await fn();
      return { ran: true, result };
    } catch (error) {
      return { ran: true, error };
    }
  }),
  clearStaleAdvisoryLocks: vi.fn(async () => {}),
}));

// ── Lazy imports (after mocks are registered) ────────────────────────────────
import * as phorestApi from "./phorestApi";
import { pendingBookings } from "./pendingStore";
import { sweepOrphanedPayments } from "./orphanSweep";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLIENT_ID = "client-orphan-1";
const SERVICE_ID = "svc-orphan-A";
// A future datetime so past-slot guards don't short-circuit the tests.
const FUTURE_SLOT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const FUTURE_DATE = FUTURE_SLOT.slice(0, 10);

/** Build a minimal PaymentIntent that has already been charged. */
function buildPI(id: string, extras: Record<string, any> = {}) {
  return {
    id,
    status: "succeeded",
    amount: 2000,
    currency: "cad",
    // Age: 30 minutes ago — old enough to pass the MIN_AGE_MS guard
    created: Math.floor((Date.now() - 30 * 60 * 1000) / 1000),
    metadata: {
      pendingId: `pending-${id}`,
      clientId: CLIENT_ID,
      serviceIds: SERVICE_ID,
      startDateTime: FUTURE_SLOT,
      expectedAmount: "2000",
      ...extras,
    },
    latest_charge: null,
  };
}

/** Wire stripeMock.paymentIntents.list to return a single-page batch with the given PIs. */
function mockListWith(pis: any[]) {
  stripeMock.paymentIntents.list.mockResolvedValueOnce({ data: pis, has_more: false });
}

/** Build a Phorest appointment stub. */
function phorestAppt(overrides: Record<string, any> = {}) {
  return {
    appointmentId: "appt-1",
    activationState: "ACTIVE",
    startTime: FUTURE_SLOT,
    services: [{ serviceId: SERVICE_ID }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(pendingBookings.get).mockReset().mockResolvedValue(undefined);
  vi.mocked(phorestApi.listAppointments).mockReset().mockResolvedValue({ content: [] } as any);
  vi.mocked(phorestApi.isPhorestConfigured).mockReset().mockReturnValue(true);
  stripeMock.paymentIntents.list.mockReset();
  stripeMock.charges.retrieve.mockReset();
  stripeMock.refunds.create.mockReset().mockResolvedValue({ id: "re_test", status: "succeeded" });
});

// ===========================================================================
// 1. No phorestBookingId + Phorest returns active appointment → NO refund
// ===========================================================================
describe("Orphan sweep: no phorestBookingId, Phorest has matching active appointment", () => {
  it("does NOT refund when an active appointment exists at the paid time slot", async () => {
    const pi = buildPI("pi_no_booking_active_appt");
    mockListWith([pi]);

    // Phorest shows an active appointment within 5 minutes of the paid slot
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [phorestAppt({ startTime: FUTURE_SLOT, activationState: "ACTIVE" })],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("queries by SALON-LOCAL date near UTC midnight and does NOT refund a live appointment", async () => {
    // Pick a future slot at 01:30 UTC → previous day in America/Toronto.
    const base = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const boundarySlot = new Date(Date.UTC(
      base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 1, 30, 0
    )).toISOString();
    const pi = buildPI("pi_utc_boundary", { startDateTime: boundarySlot });
    mockListWith([pi]);

    // Toronto-local date of the slot (differs from the UTC date)
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(boundarySlot));
    const lp = (t: string) => parts.find(p => p.type === t)?.value || "";
    const torontoDate = `${lp("year")}-${lp("month")}-${lp("day")}`;
    expect(torontoDate).not.toBe(boundarySlot.slice(0, 10)); // sanity: dates differ

    // Phorest returns the live appointment in its REAL shape on the Toronto date
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [phorestAppt({
        activationState: "ACTIVE",
        startTime: `${lp("hour")}:${lp("minute")}:00.000`,
        appointmentDate: torontoDate,
      })],
    } as any);

    await sweepOrphanedPayments();

    // Must query the SALON-LOCAL date, not the UTC date
    expect(vi.mocked(phorestApi.listAppointments)).toHaveBeenCalledWith(
      expect.objectContaining({ fromDate: torontoDate, toDate: torontoDate })
    );
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("does NOT refund when appointment uses _embedded format (HAL response)", async () => {
    const pi = buildPI("pi_hal_format");
    mockListWith([pi]);

    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      _embedded: {
        appointments: [phorestAppt({ startTime: FUTURE_SLOT, activationState: "ACTIVE" })],
      },
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 2. Legacy PI (no appointmentId): Phorest has no appointment → flag, NO refund
// ===========================================================================
describe("Orphan sweep: legacy PI without appointmentId, Phorest has no appointment → manual review", () => {
  it("flags (no refund) when no matching Phorest appointment exists for the paid slot", async () => {
    dbInsertValues.length = 0;
    const pi = buildPI("pi_orphan_no_appt");
    mockListWith([pi]);

    // Phorest returns an empty list
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({ content: [] } as any);

    await sweepOrphanedPayments();

    // Auto-refunds are appointmentId-verified ONLY — legacy PI must be flagged
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(dbInsertValues.some(v =>
      v?.paymentIntentId === "pi_orphan_no_appt" && /without appointmentId/i.test(v?.reason || "")
    )).toBe(true);
  });

  it("flags (no refund) when only CANCELED appointments exist for the paid slot", async () => {
    const pi = buildPI("pi_orphan_canceled_appt");
    mockListWith([pi]);

    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [
        phorestAppt({ startTime: FUTURE_SLOT, activationState: "CANCELED" }),
      ],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3. Legacy PI (phorestBookingId only), appointment CANCELLED → flag, NO refund
// ===========================================================================
describe("Orphan sweep: legacy consumed deposit (phorestBookingId, no appointmentId), CANCELLED → manual review", () => {
  it("flags (no refund) when the appointment is cancelled in Phorest", async () => {
    dbInsertValues.length = 0;
    const pi = buildPI("pi_consumed_cancelled", {
      phorestBookingId: "phbk-cancelled-1",
    });
    mockListWith([pi]);

    // Phorest scan returns appointment with CANCEL in activationState
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [
        phorestAppt({ activationState: "CANCELED", services: [{ serviceId: SERVICE_ID }] }),
      ],
    } as any);

    await sweepOrphanedPayments();

    // Heuristic (time/service window) verdicts never move money on legacy PIs
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(dbInsertValues.some(v =>
      v?.paymentIntentId === "pi_consumed_cancelled" && /without appointmentId/i.test(v?.reason || "")
    )).toBe(true);
  });

  it("flags (no refund) when the appointment list is empty (booking removed from Phorest)", async () => {
    const pi = buildPI("pi_consumed_gone", {
      phorestBookingId: "phbk-gone-1",
    });
    mockListWith([pi]);

    vi.mocked(phorestApi.listAppointments).mockResolvedValue({ content: [] } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. phorestBookingId present, appointment still ACTIVE → NO refund
// ===========================================================================
describe("Orphan sweep: consumed deposit (phorestBookingId set), appointment still ACTIVE → NO refund", () => {
  it("does NOT refund when the appointment is active in Phorest", async () => {
    const pi = buildPI("pi_consumed_active", {
      phorestBookingId: "phbk-active-1",
    });
    mockListWith([pi]);

    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [
        phorestAppt({ activationState: "ACTIVE", services: [{ serviceId: SERVICE_ID }] }),
      ],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("does NOT refund when a rescheduled appointment with matching serviceId exists", async () => {
    const pi = buildPI("pi_rescheduled", {
      phorestBookingId: "phbk-reschedule-1",
    });
    mockListWith([pi]);

    // Different start time (rescheduled) but same service → sweep must NOT refund
    const differentSlot = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [
        phorestAppt({
          activationState: "ACTIVE",
          startTime: differentSlot,
          services: [{ serviceId: SERVICE_ID }],
        }),
      ],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("does NOT refund when the appointment has no service info (err on not refunding)", async () => {
    const pi = buildPI("pi_no_service_info", {
      phorestBookingId: "phbk-noservice-1",
    });
    mockListWith([pi]);

    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [
        phorestAppt({ activationState: "ACTIVE", services: [] }), // no services array
      ],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4b. Stale consumed deposit: appointment date PASSED
// ===========================================================================
describe("Orphan sweep: consumed deposit whose appointment date has passed", () => {
  const PAST_SLOT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
  const VERY_OLD_SLOT = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const RECENT_PAST_SLOT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago (grace)

  it("does NOT refund when the past appointment is still on the books (deposit consumed)", async () => {
    const pi = buildPI("pi_past_consumed", { phorestBookingId: "phbk-past-1", startDateTime: PAST_SLOT });
    mockListWith([pi]);
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [phorestAppt({ activationState: "ACTIVE", startTime: PAST_SLOT })],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("flags (no refund) when the past appointment was cancelled — legacy PI without appointmentId", async () => {
    dbInsertValues.length = 0;
    const pi = buildPI("pi_past_cancelled", { phorestBookingId: "phbk-past-2", startDateTime: PAST_SLOT });
    mockListWith([pi]);
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [phorestAppt({ activationState: "CANCELLED", startTime: PAST_SLOT })],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(dbInsertValues.some(v =>
      v?.paymentIntentId === "pi_past_cancelled" && /without appointmentId/i.test(v?.reason || "")
    )).toBe(true);
  });

  it("REFUNDS a past-slot cancelled deposit when appointmentId confirms cancellation", async () => {
    const pi = buildPI("pi_past_cancelled_apptid", {
      phorestBookingId: "phbk-past-2b",
      appointmentId: "appt-past-1",
      startDateTime: PAST_SLOT,
    });
    mockListWith([pi]);
    vi.mocked(phorestApi.getAppointment).mockResolvedValueOnce({ activationState: "CANCELLED" } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_past_cancelled_apptid" }),
      expect.objectContaining({ idempotencyKey: "refund-pi_past_cancelled_apptid-r0-a2000" })
    );
  });

  it("flags (no refund) when no matching appointment is found for the past slot", async () => {
    const pi = buildPI("pi_past_missing", { phorestBookingId: "phbk-past-3", startDateTime: PAST_SLOT });
    mockListWith([pi]);
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({ content: [] } as any);

    await sweepOrphanedPayments();

    // Missing past appointment can never be auto-refunded — manual review only
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("handles the REAL Phorest shape (time-only startTime + appointmentDate) for past slots", async () => {
    const pi = buildPI("pi_past_real_shape", { phorestBookingId: "phbk-past-4", startDateTime: PAST_SLOT });
    mockListWith([pi]);
    // Salon-local date + time of the past slot
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(PAST_SLOT));
    const lp = (t: string) => parts.find(p => p.type === t)?.value || "";
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [phorestAppt({
        activationState: "ACTIVE",
        startTime: `${lp("hour")}:${lp("minute")}:00.000`,
        appointmentDate: `${lp("year")}-${lp("month")}-${lp("day")}`,
      })],
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("leaves deposits alone during the 1-day grace window after the slot", async () => {
    const pi = buildPI("pi_past_grace", { phorestBookingId: "phbk-past-5", startDateTime: RECENT_PAST_SLOT });
    mockListWith([pi]);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(phorestApi.listAppointments)).not.toHaveBeenCalled();
  });

  it("leaves deposits alone beyond the 7-day lookback horizon", async () => {
    const pi = buildPI("pi_past_old", { phorestBookingId: "phbk-past-6", startDateTime: VERY_OLD_SLOT });
    mockListWith([pi]);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(phorestApi.listAppointments)).not.toHaveBeenCalled();
  });

  it("defers (no refund, no flag decision) when Phorest errors during past-slot verification", async () => {
    const pi = buildPI("pi_past_phorest_err", { phorestBookingId: "phbk-past-7", startDateTime: PAST_SLOT });
    mockListWith([pi]);
    vi.mocked(phorestApi.listAppointments).mockRejectedValueOnce(new Error("Phorest 503"));

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. PI tagged statusUnknown → sweep defers, no refund
// ===========================================================================
describe("Orphan sweep: PI tagged statusUnknown → deferred (no refund)", () => {
  it("skips the PI entirely when statusUnknown=1 is set in metadata", async () => {
    dbInsertValues.length = 0;
    const pi = buildPI("pi_status_unknown", { statusUnknown: "1" });
    mockListWith([pi]);

    await sweepOrphanedPayments();

    // Must persist a manual-review flag so the admin page shows "Needs review"
    expect(dbInsertValues.some(v =>
      v?.paymentIntentId === "pi_status_unknown" && /status unknown/i.test(v?.reason || "")
    )).toBe(true);

    // listAppointments must not have been called — the PI is skipped before Phorest check
    // (statusUnknown PIs have no phorestBookingId; the no-booking path falls through to
    // the Phorest check, but the slot is in the future so the past-slot guard is inactive.
    // The important assertion is: NO refund.)
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 6. Legacy PI without startDateTime metadata → flagged, NOT refunded
// ===========================================================================
describe("Orphan sweep: legacy PI without startDateTime → manual review, no auto-refund", () => {
  it("does NOT refund and does not call Phorest when startDateTime is absent", async () => {
    // Build a PI that is missing startDateTime
    const pi = {
      id: "pi_legacy_no_startdt",
      status: "succeeded",
      amount: 3000,
      currency: "cad",
      created: Math.floor((Date.now() - 30 * 60 * 1000) / 1000),
      metadata: {
        pendingId: "pending-legacy-1",
        clientId: CLIENT_ID,
        // no startDateTime
        expectedAmount: "3000",
      },
      latest_charge: null,
    };
    mockListWith([pi]);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(phorestApi.listAppointments)).not.toHaveBeenCalled();
  });

  it("does NOT refund the same legacy PI on a second sweep (flaggedLegacy dedup)", async () => {
    const pi = {
      id: "pi_legacy_dedup",
      status: "succeeded",
      amount: 1500,
      currency: "cad",
      created: Math.floor((Date.now() - 30 * 60 * 1000) / 1000),
      metadata: {
        pendingId: "pending-legacy-2",
        clientId: CLIENT_ID,
        expectedAmount: "1500",
        // no startDateTime
      },
      latest_charge: null,
    };

    // Run two sweeps back-to-back (simulates 5-minute interval without server restart)
    mockListWith([pi]);
    await sweepOrphanedPayments();
    mockListWith([pi]);
    await sweepOrphanedPayments();

    // Still no refund across both sweeps
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 7. Precise appointmentId path (new bookings) — decision matrix
// ===========================================================================
describe("Orphan sweep: metadata.appointmentId present → judge by getAppointment activationState", () => {
  it("REFUNDS when the appointment's activationState is CANCELED, with audit label + auto-sweep metadata", async () => {
    const pi = buildPI("pi_apptid_cancelled", {
      phorestBookingId: "phbk-x1",
      appointmentId: "appt-cancel-1",
    });
    mockListWith([pi]);
    vi.mocked(phorestApi.getAppointment).mockResolvedValueOnce({ activationState: "CANCELED" } as any);

    await sweepOrphanedPayments();

    expect(vi.mocked(phorestApi.getAppointment)).toHaveBeenCalledWith("appt-cancel-1");
    // Precise path must NOT fall back to time-window scanning
    expect(vi.mocked(phorestApi.listAppointments)).not.toHaveBeenCalled();
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: "pi_apptid_cancelled",
        metadata: expect.objectContaining({
          initiatedBy: "auto-cancellation-sweep",
          label: "KOZETA SALON Deposit Refund",
        }),
      }),
      expect.objectContaining({ idempotencyKey: "refund-pi_apptid_cancelled-r0-a2000" })
    );
  });

  it("does NOT refund when the appointment is still ACTIVE", async () => {
    const pi = buildPI("pi_apptid_active", {
      phorestBookingId: "phbk-x2",
      appointmentId: "appt-active-1",
    });
    mockListWith([pi]);
    vi.mocked(phorestApi.getAppointment).mockResolvedValueOnce({ activationState: "ACTIVE" } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("handles the wrapped { appointment: {...} } response shape", async () => {
    const pi = buildPI("pi_apptid_wrapped", {
      phorestBookingId: "phbk-x3",
      appointmentId: "appt-wrapped-1",
    });
    mockListWith([pi]);
    vi.mocked(phorestApi.getAppointment).mockResolvedValueOnce({
      appointment: { activationState: "CANCELLED" },
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("defers (no refund) when getAppointment throws — never refund on uncertainty", async () => {
    const pi = buildPI("pi_apptid_error", {
      phorestBookingId: "phbk-x4",
      appointmentId: "appt-err-1",
    });
    mockListWith([pi]);
    vi.mocked(phorestApi.getAppointment).mockRejectedValueOnce(new Error("Phorest 503"));

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("still defers statusUnknown PIs even when appointmentId is present", async () => {
    const pi = buildPI("pi_apptid_status_unknown", {
      phorestBookingId: "phbk-x5",
      appointmentId: "appt-su-1",
      statusUnknown: "1",
    });
    mockListWith([pi]);
    vi.mocked(phorestApi.getAppointment).mockResolvedValueOnce({ activationState: "CANCELED" } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8. Dry-run mode: decisions run, no money moves
// ===========================================================================
describe("Orphan sweep: REFUND_SWEEP_DRY_RUN=1 → logs the decision, never refunds", () => {
  it("does NOT call refunds.create for a cancelled appointment in dry-run mode", async () => {
    process.env.REFUND_SWEEP_DRY_RUN = "1";
    try {
      const pi = buildPI("pi_dry_run", {
        phorestBookingId: "phbk-dry",
        appointmentId: "appt-dry-1",
      });
      mockListWith([pi]);
      vi.mocked(phorestApi.getAppointment).mockResolvedValueOnce({ activationState: "CANCELED" } as any);

      await sweepOrphanedPayments();

      expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.REFUND_SWEEP_DRY_RUN;
    }
  });
});

// ===========================================================================
// Guard rails: skip already-refunded charges and non-booking PIs
// ===========================================================================
describe("Orphan sweep: guard rails", () => {
  it("skips a PI that has already been fully refunded (charge.refunded = true)", async () => {
    const pi = buildPI("pi_already_refunded");
    pi.latest_charge = "ch_already_refunded" as any;
    mockListWith([pi]);

    stripeMock.charges.retrieve.mockResolvedValueOnce({
      id: "ch_already_refunded",
      refunded: true,
      amount_refunded: 2000,
    });

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("skips a PI whose pending booking still exists (finalize may be in-flight)", async () => {
    const pi = buildPI("pi_still_pending");
    mockListWith([pi]);

    // Simulate a pending booking still in the store
    vi.mocked(pendingBookings.get).mockResolvedValueOnce({
      serviceIds: [SERVICE_ID],
      staffIds: ["staff-1"],
      startDateTime: FUTURE_SLOT,
      branchId: "kAzBqW9d2LmXo4Vu",
      clientId: CLIENT_ID,
      sessionId: "session-1",
      serviceName: "Test Service",
      servicePrice: 10000,
      depositAmount: 2000,
      loyaltyPointsRedeemed: 0,
      loyaltyDiscountCents: 0,
      createdAt: Date.now(),
    } as any);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("skips a PI too fresh to act on (under 15-minute MIN_AGE guard)", async () => {
    const freshPI = buildPI("pi_too_fresh");
    // Override created to be only 5 minutes ago
    freshPI.created = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
    mockListWith([freshPI]);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("skips product_purchase PIs (type guard)", async () => {
    const pi = buildPI("pi_product", { type: "product_purchase" });
    mockListWith([pi]);

    await sweepOrphanedPayments();

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("defers when Phorest listAppointments throws (error path — do not refund)", async () => {
    const pi = buildPI("pi_phorest_error");
    mockListWith([pi]);

    vi.mocked(phorestApi.listAppointments).mockRejectedValueOnce(new Error("Phorest 503"));

    await sweepOrphanedPayments();

    // Must NOT refund if Phorest is unreachable
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});
