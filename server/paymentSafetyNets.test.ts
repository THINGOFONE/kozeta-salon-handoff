// Payment safety-net regression tests.
//
// Covers four critical paths that protect real customer money:
//  1. Definite 4xx failure → immediate single refund via withRefundLock + idempotency key
//  2. Timeout / 5xx → NO refund, statusUnknown tag written, pending row deleted
//  3. Concurrent finalize → second caller gets 409 FINALIZE_IN_PROGRESS
//  4. Orphan sweep and finalize safety-net are mutually exclusive (withRefundLock { ran: false })
//
// PaymentIntent checkout-retry session-binding is covered by paymentIntentReuse.test.ts.
// All tests are mocked — no live Stripe, Phorest, or DB calls.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// ── Environment ─────────────────────────────────────────────────────────────
process.env.SESSION_SECRET = "test-safety-nets-secret";
process.env.PHOREST_USERNAME = "global/test";
process.env.PHOREST_PASSWORD = "test-password";
process.env.PHOREST_BUSINESS_ID = "test-business";
process.env.PHOREST_BRANCH_ID = "kAzBqW9d2LmXo4Vu";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";

// ── DB stub ──────────────────────────────────────────────────────────────────
vi.mock("./db", () => {
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve: any) => resolve([]);
      return (..._args: any[]) => chain;
    },
    apply: () => chain,
  });
  return { db: chain, pool: { end: vi.fn() } };
});

// ── Phorest: keep real classifyPhorestError + PhorestApiError ────────────────
vi.mock("./phorestApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./phorestApi")>();
  return {
    ...actual,
    isPhorestConfigured: vi.fn(() => true),
    listClients: vi.fn(async () => ({ content: [] })),
    getClient: vi.fn(async () => ({})),
    createClient: vi.fn(async () => ({})),
    updateClient: vi.fn(async () => ({})),
    getClientServiceHistories: vi.fn(async () => ({ content: [] })),
    getClientLoyalty: vi.fn(async () => ({ points: 0 })),
    listAppointments: vi.fn(async () => ({ content: [] })),
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
const stripeMock = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(),
    update: vi.fn(async () => ({})),
    create: vi.fn(async () => ({
      id: "pi_new_test",
      client_secret: "pi_new_test_secret",
      status: "requires_payment_method",
      amount: 2000,
      currency: "cad",
    })),
  },
  refunds: {
    create: vi.fn(async () => ({ id: "re_test", status: "succeeded" })),
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

vi.mock("./services/productCache", () => ({
  warmCache: vi.fn(async () => {}),
  startBackgroundRefresh: vi.fn(),
  isCacheReady: vi.fn(() => false),
  isCacheStale: vi.fn(() => false),
  refreshCacheIfStale: vi.fn(),
  getProducts: vi.fn(() => ({ products: [], brands: [], page: 0, totalPages: 0, totalElements: 0, cacheAge: 0 })),
  getProductById: vi.fn(() => undefined),
  getCachedProducts: vi.fn(async () => ({ products: [] })),
}));

vi.mock("./services/productEnrichment", () => ({
  enrichProduct: vi.fn(async (p: any) => p),
  enrichProducts: vi.fn(async (p: any) => p),
  getEnrichmentStatus: vi.fn(() => ({})),
}));

vi.mock("./services/serviceCache", () => ({
  warmCache: vi.fn(async () => {}),
  startBackgroundRefresh: vi.fn(),
  stopBackgroundRefresh: vi.fn(),
  forceRefresh: vi.fn(async () => {}),
  isCacheReady: vi.fn(() => true),
  getServices: vi.fn(() => []),
  getCategories: vi.fn(() => []),
  getServiceById: vi.fn(() => undefined),
  getServicesByCategory: vi.fn(() => []),
  getCacheStatus: vi.fn(() => ({ lastUpdated: 0, serviceCount: 0, categoryCount: 0, isWarming: false })),
}));

vi.mock("./services/staffServiceSync", () => ({
  STAFF_DISPLAY_ORDER: [],
  warmCache: vi.fn(async () => {}),
  startBackgroundRefresh: vi.fn(),
  stopBackgroundRefresh: vi.fn(),
  isCacheReady: vi.fn(() => false),
  getStaff: vi.fn(() => undefined),
  getAllStaff: vi.fn(() => []),
  getAllServices: vi.fn(() => []),
  getService: vi.fn(() => undefined),
  getQualifiedStaffForService: vi.fn(() => []),
  getQualifiedStaffDetails: vi.fn(() => []),
  getCacheStatus: vi.fn(() => ({ lastSync: null, serviceCount: 0, staffCount: 0, isWarming: false })),
}));

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

vi.mock("./paymentLocks", () => ({
  tryAcquireFinalizeLock: vi.fn(() => true),
  releaseFinalizeLock: vi.fn(),
  tryAcquireRefundLock: vi.fn(() => true),
  releaseRefundLock: vi.fn(),
  withRefundLock: vi.fn(async (_id: string, fn: () => any) => {
    try {
      const result = await fn();
      return { ran: true, result };
    } catch (error) {
      return { ran: true, error };
    }
  }),
}));

vi.mock("./orphanSweep", () => ({
  startOrphanSweep: vi.fn(),
  sweepOrphanedPayments: vi.fn(async () => {}),
}));

const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: any, init?: any) => {
    if (String(url).includes("api.twilio.com")) {
      return { ok: true, status: 201, json: async () => ({ sid: "SMtest" }), text: async () => "" } as any;
    }
    return realFetch(url, init);
  })
);

import * as phorestApi from "./phorestApi";
import { pendingBookings } from "./pendingStore";
import * as paymentLocks from "./paymentLocks";

let app: express.Express;

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const BASE_PENDING = {
  serviceIds: ["svc-safety"],
  staffIds: ["staff-safety"],
  startDateTime: "2026-10-01T15:00:00.000Z",
  branchId: "kAzBqW9d2LmXo4Vu",
  clientId: "client-safety-1",
  sessionId: "session-safety-1",
  serviceName: "WOMENS CUT",
  servicePrice: 10000,
  depositAmount: 2000,
  loyaltyPointsRedeemed: 0,
  loyaltyDiscountCents: 0,
  createdAt: Date.now(),
};

function succeededIntent(piId: string, pendingId: string, extras: Record<string, any> = {}) {
  return {
    id: piId,
    status: "succeeded",
    amount: 2000,
    currency: "cad",
    metadata: {
      pendingId,
      clientId: BASE_PENDING.clientId,
      expectedAmount: "2000",
      ...extras,
    },
    latest_charge: null,
  };
}

beforeAll(async () => {
  const { registerRoutes } = await import("./routes");
  app = express();
  app.use(express.json());
  await registerRoutes(app);
});

beforeEach(() => {
  // Hard-reset all mocks between tests so call counts never bleed across cases
  vi.mocked(pendingBookings.get).mockReset().mockResolvedValue(undefined);
  vi.mocked(pendingBookings.delete).mockReset().mockResolvedValue(undefined);
  stripeMock.paymentIntents.retrieve.mockReset();
  stripeMock.paymentIntents.update.mockReset().mockResolvedValue({});
  stripeMock.refunds.create.mockReset().mockResolvedValue({ id: "re_safety", status: "succeeded" });
  vi.mocked(paymentLocks.tryAcquireFinalizeLock).mockReset().mockReturnValue(true as any);
  vi.mocked(paymentLocks.withRefundLock).mockReset().mockImplementation(async (_id: string, fn: () => any) => {
    try {
      const result = await fn();
      return { ran: true, result };
    } catch (error) {
      return { ran: true, error };
    }
  });
  vi.mocked(phorestApi.createBooking).mockReset().mockResolvedValue({ phorestBookingId: "phbk-1" } as any);
  vi.mocked(phorestApi.activateBooking).mockReset().mockResolvedValue({} as any);
  vi.mocked(phorestApi.isPhorestConfigured).mockReset().mockReturnValue(true);
});

// ===========================================================================
// 1. Definite 4xx failure → immediate single refund
// ===========================================================================
describe("Finalize: definite 4xx Phorest failure → single immediate refund", () => {
  const pendingId = "pending-safety-4xx";
  const piId = "pi_safety_4xx";

  it("refunds immediately on a 409 slot conflict and does not call withRefundLock twice", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    vi.mocked(phorestApi.createBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Conflict", { status: 409 })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.refunded).toBe(true);
    expect(res.body.code).toBe("SLOT_CONFLICT");

    // Refund must flow through the shared lock — exactly once
    expect(vi.mocked(paymentLocks.withRefundLock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(paymentLocks.withRefundLock)).toHaveBeenCalledWith(piId, expect.any(Function));

    // stripe.refunds.create must carry the idempotency key so Stripe deduplicates retries
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: piId }),
      expect.objectContaining({ idempotencyKey: `refund-${piId}` })
    );

    // Pending row must be removed so a retry cannot create a duplicate Phorest booking
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });

  it("refunds immediately on a 400 validation error (definite failure)", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    vi.mocked(phorestApi.createBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Bad request", { status: 400 })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.refunded).toBe(true);
    // 400 is a definite failure but NOT a slot conflict
    expect(res.body.code).toBe("BOOKING_UNAVAILABLE");
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });
});

// ===========================================================================
// 2. Timeout / 5xx → NO refund, statusUnknown tagged, pending row deleted
// ===========================================================================
describe("Finalize: unverifiable Phorest failure (timeout / 5xx) → defer refund to orphan sweep", () => {
  const pendingId = "pending-safety-5xx";
  const piId = "pi_safety_5xx";

  it("does NOT refund on a 5xx error and tags the PI with statusUnknown", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    vi.mocked(phorestApi.createBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Internal server error", { status: 500 })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);

    // NO refund — the booking may have been created on Phorest's side
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(paymentLocks.withRefundLock)).not.toHaveBeenCalled();

    // PI must be tagged so the orphan sweep (not the safety-net) handles the refund
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      piId,
      expect.objectContaining({ metadata: expect.objectContaining({ statusUnknown: "1" }) })
    );

    // Pending row must be removed to prevent a retry from double-booking in Phorest
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });

  it("does NOT refund on a network timeout and tags the PI with statusUnknown", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    vi.mocked(phorestApi.createBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Request timed out", { isTimeout: true })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      piId,
      expect.objectContaining({ metadata: expect.objectContaining({ statusUnknown: "1" }) })
    );
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });
});

// ===========================================================================
// 3. Concurrent finalize → second caller gets 409
// ===========================================================================
describe("Finalize: concurrent calls for the same pendingId", () => {
  it("returns 409 FINALIZE_IN_PROGRESS when the finalize lock is already held", async () => {
    // Simulate the first finalize holding the lock
    vi.mocked(paymentLocks.tryAcquireFinalizeLock).mockReturnValueOnce(false as any);

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId: "pending-concurrent", paymentIntentId: "pi_concurrent" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FINALIZE_IN_PROGRESS");

    // Must not have touched Stripe or Phorest at all
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
    expect(vi.mocked(phorestApi.createBooking)).not.toHaveBeenCalled();
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Orphan sweep and finalize safety-net are mutually exclusive
// ===========================================================================
describe("Refund mutual exclusion: orphan sweep and finalize safety-net", () => {
  it("does not issue a second refund when withRefundLock returns { ran: false } (lock already held by orphan sweep)", async () => {
    const pendingId = "pending-mutex-1";
    const piId = "pi_mutex_1";

    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    // Phorest returns a 4xx → normally triggers immediate refund
    vi.mocked(phorestApi.createBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Slot taken", { status: 409 })
    );
    // Simulate orphan sweep already holding the refund lock for this PI
    vi.mocked(paymentLocks.withRefundLock).mockResolvedValueOnce({ ran: false });

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    // Route should still return a reasonable status (the lock holder handles the actual refund)
    expect([200, 503]).toContain(res.status);
    // stripe.refunds.create must NOT have been called — the lock holder (orphan sweep) does it
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("does not issue a refund when the pending booking is gone and PI has statusUnknown (orphan sweep owns it)", async () => {
    const pendingId = "pending-mutex-2";
    const piId = "pi_mutex_status_unknown";

    // No pending booking exists (already expired/deleted)
    vi.mocked(pendingBookings.get).mockResolvedValue(undefined);
    // PI is succeeded but tagged statusUnknown — orphan sweep owns the refund decision
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      succeededIntent(piId, pendingId, { statusUnknown: "1" })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    // Must reject with BOOKING_STATUS_UNKNOWN — not attempt its own refund
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("does not issue a refund when the PI has phorestBookingId (consumed deposit; orphan sweep handles cancellations)", async () => {
    const pendingId = "pending-mutex-3";
    const piId = "pi_mutex_consumed";

    vi.mocked(pendingBookings.get).mockResolvedValue(undefined);
    // PI was successfully consumed by a prior finalize — phorestBookingId is present
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      succeededIntent(piId, pendingId, { phorestBookingId: "phbk-consumed-1" })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. activateBooking definite 4xx → immediate refund
// ===========================================================================
describe("Finalize: activateBooking definite 4xx → immediate refund, pending row deleted", () => {
  const pendingId = "pending-activate-4xx";
  const piId = "pi_activate_4xx";

  it("refunds immediately when activateBooking throws a 4xx and deletes the pending row", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    // createBooking succeeds — RESERVED hold is in place
    vi.mocked(phorestApi.createBooking).mockResolvedValue({ phorestBookingId: "phbk-activate-4xx" } as any);
    // activateBooking is the step that fails with a definite 4xx
    vi.mocked(phorestApi.activateBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Bad request from activation", { status: 400 })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.refunded).toBe(true);
    expect(res.body.code).toBe("BOOKING_UNAVAILABLE");

    // Refund must go through the shared lock with an idempotency key
    expect(vi.mocked(paymentLocks.withRefundLock)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(paymentLocks.withRefundLock)).toHaveBeenCalledWith(piId, expect.any(Function));
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: piId }),
      expect.objectContaining({ idempotencyKey: `refund-${piId}` })
    );

    // Pending row must be removed
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });
});

// ===========================================================================
// 6. activateBooking 5xx / timeout → defer to orphan sweep, tag PI
// ===========================================================================
describe("Finalize: activateBooking unverifiable failure (5xx / timeout) → no refund, PI tagged, pending row deleted", () => {
  const pendingId = "pending-activate-5xx";
  const piId = "pi_activate_5xx";

  it("does NOT refund on a 5xx activation error; tags PI with statusUnknown AND phorestBookingId", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    vi.mocked(phorestApi.createBooking).mockResolvedValue({ phorestBookingId: "phbk-activate-5xx" } as any);
    vi.mocked(phorestApi.activateBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Internal server error", { status: 500 })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);

    // No refund — activation may have silently succeeded on Phorest's side
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(paymentLocks.withRefundLock)).not.toHaveBeenCalled();

    // PI must carry BOTH the booking id (so sweep can verify the appointment)
    // and statusUnknown (so the finalize safety-net never blindly refunds it)
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      piId,
      expect.objectContaining({
        metadata: expect.objectContaining({
          phorestBookingId: "phbk-activate-5xx",
          statusUnknown: "1",
        }),
      })
    );

    // Pending row removed — prevents a retry from creating a duplicate booking
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });

  it("does NOT refund on an activation timeout; tags PI with statusUnknown AND phorestBookingId", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue({
      ...BASE_PENDING,
      paymentIntentId: piId,
    } as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent(piId, pendingId));
    vi.mocked(phorestApi.createBooking).mockResolvedValue({ phorestBookingId: "phbk-activate-timeout" } as any);
    vi.mocked(phorestApi.activateBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Request timed out", { isTimeout: true })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);

    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(paymentLocks.withRefundLock)).not.toHaveBeenCalled();

    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      piId,
      expect.objectContaining({
        metadata: expect.objectContaining({
          phorestBookingId: "phbk-activate-timeout",
          statusUnknown: "1",
        }),
      })
    );

    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });
});
