// Deposit-guard tests:
//  - Near-duplicate bookings are ALLOWED (no 409); finalize adds a staff
//    heads-up note when the client has another active appointment nearby
//  - Deposit ceiling (DEPOSIT_TOO_LARGE)
//  - Cancel verification (CANCEL_UNCONFIRMED) on /api/appointments/cancel
//
// Mirrors the mocking pattern in paymentSafetyNets.test.ts.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

// ── Environment ─────────────────────────────────────────────────────────────
process.env.SESSION_SECRET = "test-deposit-guards-secret";
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

// ── Phorest mock (keep real error classes) ───────────────────────────────────
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
      id: "pi_guard_test",
      client_secret: "pi_guard_test_secret",
      status: "requires_payment_method",
      amount: 2000,
      currency: "cad",
    })),
  },
  refunds: {
    create: vi.fn(async () => ({ id: "re_guard", status: "succeeded" })),
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

const serviceCacheMock = vi.hoisted(() => ({
  getServiceById: vi.fn(),
}));

vi.mock("./services/serviceCache", () => ({
  warmCache: vi.fn(async () => {}),
  startBackgroundRefresh: vi.fn(),
  stopBackgroundRefresh: vi.fn(),
  forceRefresh: vi.fn(async () => {}),
  isCacheReady: vi.fn(() => true),
  getServices: vi.fn(() => []),
  getCategories: vi.fn(() => []),
  getServiceById: serviceCacheMock.getServiceById,
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

const CLIENT_ID = "client-guard-1";
const SESSION_ID = "session-guard-1";

// Signed session token matching signSessionToken() in routes.ts
function makeSessionToken(sessionId = SESSION_ID, clientId = CLIENT_ID): string {
  const payload = `${sessionId}:${clientId}:${Date.now()}`;
  const hmac = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("hex");
  return `${payload}:${hmac}`;
}

// A slot ~30 days out so it's always in the future
const START = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
START.setUTCHours(15, 0, 0, 0);
const START_ISO = START.toISOString();

// staffIds intentionally omitted: staff validation is exercised elsewhere and
// the mocked staff cache reports not-ready (which would 503 before the guards).
const BASE_BODY = {
  serviceIds: ["svc-guard"],
  startDateTime: START_ISO,
  sessionToken: makeSessionToken(),
};

function mockServicePrice(dollars: number) {
  serviceCacheMock.getServiceById.mockReturnValue({
    name: "WOMENS CUT",
    category: "Hair",
    phorestBasePrice: dollars,
    staffPrices: [],
  });
}

beforeAll(async () => {
  const { registerRoutes } = await import("./routes");
  app = express();
  app.use(express.json());
  await registerRoutes(app);
});

beforeEach(() => {
  serviceCacheMock.getServiceById.mockReset();
  vi.mocked(phorestApi.isPhorestConfigured).mockReset().mockReturnValue(true);
  vi.mocked(phorestApi.listAppointments).mockReset().mockResolvedValue({ content: [] } as any);
  vi.mocked(phorestApi.getAppointment).mockReset().mockResolvedValue({ activationState: "ACTIVE" } as any);
  vi.mocked(phorestApi.cancelAppointment).mockReset().mockResolvedValue({} as any);
  vi.mocked(phorestApi.createBooking).mockReset().mockResolvedValue({ phorestBookingId: "phbk-guard" } as any);
  vi.mocked(phorestApi.activateBooking).mockReset().mockResolvedValue({} as any);
  vi.mocked(pendingBookings.get).mockReset().mockResolvedValue(undefined);
  vi.mocked(pendingBookings.delete).mockReset().mockResolvedValue(undefined);
  stripeMock.paymentIntents.create.mockClear();
  stripeMock.paymentIntents.retrieve.mockReset();
  stripeMock.paymentIntents.update.mockReset().mockResolvedValue({});
  stripeMock.refunds.create.mockReset().mockResolvedValue({ id: "re_guard", status: "succeeded" });
  vi.mocked(paymentLocks.withRefundLock).mockClear();
});

// ===========================================================================
// Duplicate guard on create-intent
// ===========================================================================
describe("create-intent allows near-duplicate bookings with no warning", () => {
  it("returns 200 (no 409) when an active appointment exists within ±2h", async () => {
    mockServicePrice(100);
    const nearbyStart = new Date(START.getTime() + 60 * 60 * 1000).toISOString(); // +1h
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [{ appointmentId: "apt-1", activationState: "ACTIVE", startTime: nearbyStart }],
    } as any);

    const res = await request(app).post("/api/payments/create-intent").send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("pi_guard_test_secret");
    expect(stripeMock.paymentIntents.create).toHaveBeenCalledTimes(1);
  });

  it("returns 200 with the REAL Phorest shape: time-only startTime + appointmentDate", async () => {
    mockServicePrice(100);
    const localParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(START);
    const lp = (t: string) => localParts.find(p => p.type === t)?.value || "";
    const localDate = `${lp("year")}-${lp("month")}-${lp("day")}`;
    const totalMin = parseInt(lp("hour"), 10) * 60 + parseInt(lp("minute"), 10) + 30;
    const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [{ appointmentId: "apt-real", activationState: "ACTIVE", state: "PAID", startTime: `${hh}:${mm}:00.000`, appointmentDate: localDate }],
    } as any);

    const res = await request(app).post("/api/payments/create-intent").send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("pi_guard_test_secret");
  });

  it("returns 200 even when the Phorest appointment lookup errors", async () => {
    mockServicePrice(100);
    vi.mocked(phorestApi.listAppointments).mockRejectedValue(new Error("Phorest down"));

    const res = await request(app).post("/api/payments/create-intent").send(BASE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("pi_guard_test_secret");
  });
});

// ===========================================================================
// Deposit ceiling
// ===========================================================================
describe("create-intent deposit ceiling (DEPOSIT_TOO_LARGE)", () => {
  it("returns 503 DEPOSIT_TOO_LARGE when the 20% deposit exceeds $200", async () => {
    mockServicePrice(1500); // $1500 → $300 deposit > $200 ceiling

    const res = await request(app).post("/api/payments/create-intent").send(BASE_BODY);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("DEPOSIT_TOO_LARGE");
    expect(stripeMock.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("allows a deposit exactly at the ceiling", async () => {
    mockServicePrice(1000); // $1000 → $200 deposit == ceiling

    const res = await request(app).post("/api/payments/create-intent").send(BASE_BODY);
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Cancel verification (CANCEL_UNCONFIRMED)
// ===========================================================================
describe("appointment cancel verification", () => {
  const futureStart = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

  function mockAppointmentStates(states: Array<Record<string, any>>) {
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    for (const s of states) {
      mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: futureStart, ...s } as any);
    }
  }

  it("returns success when activationState becomes CANCELED after cancel", async () => {
    mockAppointmentStates([{ activationState: "ACTIVE" }, { activationState: "CANCELED" }]);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-1" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(phorestApi.cancelAppointment).toHaveBeenCalledWith("apt-cancel-1");
  });

  it("returns 503 CANCEL_UNCONFIRMED when activationState stays ACTIVE", async () => {
    mockAppointmentStates([{ activationState: "ACTIVE" }, { activationState: "ACTIVE" }]);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-2" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CANCEL_UNCONFIRMED");
  });

  it("returns 503 CANCEL_UNCONFIRMED when the verify fetch fails", async () => {
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: futureStart, activationState: "ACTIVE" } as any);
    mock.mockRejectedValue(new Error("Phorest timeout"));

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-3" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CANCEL_UNCONFIRMED");
  });

  it("succeeds when cancellation only reflects on a later verify attempt (Phorest lag)", async () => {
    mockAppointmentStates([
      { activationState: "ACTIVE" },   // pre-cancel fetch
      { activationState: "ACTIVE" },   // verify attempt 1 — not yet reflected
      { activationState: "CANCELED" }, // verify attempt 2 — reflected
    ]);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-lag" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("accepts the activation_state (snake_case) verify shape", async () => {
    mockAppointmentStates([
      { activationState: "ACTIVE" },
      { activation_state: "CANCELED", activationState: undefined },
    ]);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-snake" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("handles Phorest's TIME-ONLY startTime + appointmentDate shape (future appt cancels fine)", async () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(future); // YYYY-MM-DD
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: "10:00:00.000", appointmentDate: parts, activationState: "ACTIVE" } as any);
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: "10:00:00.000", appointmentDate: parts, activationState: "CANCELED" } as any);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-timeonly" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects cancelling a past appointment (time-only shape)", async () => {
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(past);
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: "10:00:00.000", appointmentDate: date, activationState: "ACTIVE" } as any);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-past" });
    expect(res.status).toBe(400);
    expect(vi.mocked(phorestApi.cancelAppointment)).not.toHaveBeenCalledWith("apt-cancel-past");
  });

  it("returns success without re-cancelling when the appointment is already cancelled", async () => {
    mockAppointmentStates([{ activationState: "CANCELED" }]);
    vi.mocked(phorestApi.cancelAppointment).mockClear();

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-already" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(phorestApi.cancelAppointment).not.toHaveBeenCalled();
  });

  it("fails closed (no cancel sent) when the start time is unparseable", async () => {
    mockAppointmentStates([
      { startTime: "garbage", appointmentDate: undefined, activationState: "ACTIVE" },
    ]);
    vi.mocked(phorestApi.cancelAppointment).mockClear();

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-unparse" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("CANCEL_TIME_UNVERIFIED");
    expect(res.body.message).toMatch(/call us/i);
    expect(phorestApi.cancelAppointment).not.toHaveBeenCalled();
  });

  it("confirms cancellation when the verify response is HAL-wrapped", async () => {
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: futureStart, activationState: "ACTIVE" } as any);
    mock.mockResolvedValueOnce({ _embedded: { appointments: [{ activationState: "CANCELED" }] } } as any);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-hal" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("does NOT confirm cancellation from `state` alone (activationState still ACTIVE)", async () => {
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: futureStart, activationState: "ACTIVE" } as any);
    mock.mockResolvedValue({ state: "CANCELLED", activationState: "ACTIVE" } as any);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-state-only" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CANCEL_UNCONFIRMED");
  });

  it("does NOT confirm cancellation when only `state` is CANCELED and activationState is missing", async () => {
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: futureStart, activationState: "ACTIVE" } as any);
    mock.mockResolvedValue({ state: "CANCELED" } as any);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-state-noact" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("CANCEL_UNCONFIRMED");
  });

  it("confirms cancellation when the verify response is nested under content[]", async () => {
    const mock = vi.mocked(phorestApi.getAppointment).mockReset();
    mock.mockResolvedValueOnce({ clientId: CLIENT_ID, startTime: futureStart, activationState: "ACTIVE" } as any);
    mock.mockResolvedValueOnce({ content: [{ activation_state: "CANCELED" }] } as any);

    const res = await request(app)
      .post("/api/appointments/cancel")
      .send({ sessionToken: makeSessionToken(), appointmentId: "apt-cancel-content" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ===========================================================================
// Activation failures after payment (finalize)
// ===========================================================================
describe("finalize activation-failure branches", () => {
  const pendingId = "pending-guard-activate";
  const piId = "pi_guard_activate";

  const BASE_PENDING = {
    serviceIds: ["svc-guard"],
    staffIds: ["staff-guard"],
    startDateTime: START_ISO,
    branchId: "kAzBqW9d2LmXo4Vu",
    clientId: CLIENT_ID,
    sessionId: SESSION_ID,
    serviceName: "WOMENS CUT",
    servicePrice: 10000,
    depositAmount: 2000,
    loyaltyPointsRedeemed: 0,
    loyaltyDiscountCents: 0,
    createdAt: Date.now(),
    paymentIntentId: piId,
  };

  function succeededIntent() {
    return {
      id: piId,
      status: "succeeded",
      amount: 2000,
      currency: "cad",
      metadata: { pendingId, clientId: CLIENT_ID, expectedAmount: "2000" },
      latest_charge: null,
    };
  }

  it("definite activation failure (4xx) → refunds via lock and reports BOOKING_UNAVAILABLE", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    vi.mocked(phorestApi.activateBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Bad request", { status: 400 })
    );

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_UNAVAILABLE");
    expect(res.body.refunded).toBe(true);
    expect(vi.mocked(paymentLocks.withRefundLock)).toHaveBeenCalledWith(piId, expect.any(Function));
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: piId }),
      expect.objectContaining({ idempotencyKey: `refund-${piId}` })
    );
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });

  it("unverifiable activation failure (5xx) → NO refund, tags statusUnknown, defers to sweep", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    vi.mocked(phorestApi.activateBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Internal server error", { status: 500 })
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
      expect.objectContaining({
        metadata: expect.objectContaining({ statusUnknown: "1", phorestBookingId: "phbk-guard" }),
      })
    );
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });

  it("missing phorestBookingId → treated as definite failure and refunded", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    vi.mocked(phorestApi.createBooking).mockResolvedValue({} as any); // no booking id

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.refunded).toBe(true);
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refund failure after definite activation failure → REFUND_FAILED, not silently swallowed", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    vi.mocked(phorestApi.activateBooking).mockRejectedValue(
      new phorestApi.PhorestApiError("Bad request", { status: 400 })
    );
    stripeMock.refunds.create.mockRejectedValue(new Error("Stripe down"));

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("REFUND_FAILED");
    expect(res.body.refunded).toBe(false);
    expect(res.body.paymentId).toBe(piId);
  });

  it("successful activation → tags PI with phorestBookingId + appointmentStart", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(200);
    expect(stripeMock.paymentIntents.update).toHaveBeenCalledWith(
      piId,
      expect.objectContaining({
        metadata: expect.objectContaining({
          phorestBookingId: "phbk-guard",
          appointmentStart: START_ISO,
        }),
      })
    );
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("adds a staff heads-up note when the client has another active appointment near the slot", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    const nearbyStart = new Date(START.getTime() + 60 * 60 * 1000).toISOString(); // +1h
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({
      content: [{ appointmentId: "apt-family", activationState: "ACTIVE", startTime: nearbyStart }],
    } as any);

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(200);
    expect(phorestApi.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        note: expect.stringContaining("another appointment"),
      })
    );
  });

  it("keeps the plain deposit note when no nearby appointment exists", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    vi.mocked(phorestApi.listAppointments).mockResolvedValue({ content: [] } as any);

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(200);
    const note = vi.mocked(phorestApi.createBooking).mock.calls[0][0].note || "";
    expect(note).toContain("Deposit paid");
    expect(note).not.toContain("another appointment");
  });

  it("still books (fail-open) when the nearby-appointment check errors", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValue(BASE_PENDING as any);
    stripeMock.paymentIntents.retrieve.mockResolvedValue(succeededIntent());
    vi.mocked(phorestApi.listAppointments).mockRejectedValue(new Error("Phorest down"));

    const res = await request(app)
      .post("/api/bookings/finalize")
      .send({ pendingId, paymentIntentId: piId });

    expect(res.status).toBe(200);
    expect(phorestApi.createBooking).toHaveBeenCalledTimes(1);
  });
});
