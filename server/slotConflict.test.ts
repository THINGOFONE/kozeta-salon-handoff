// Simulated slot-conflict verification (Task: confirm a client is told clearly
// when their time slot is snatched mid-payment).
//
// A real Phorest race (two live bookings fighting for one slot) can't be safely
// reproduced against the production salon, so these tests stub the Phorest
// createBooking call to throw the exact structured errors Phorest returns
// (HTTP 409 / SLOT_UNAVAILABLE detail codes) and assert both server paths
// classify them as SLOT_CONFLICT with the tailored client-facing messages:
//  - POST /api/book        → 409 { code: SLOT_CONFLICT, "just taken" message }
//  - POST /api/bookings/finalize → 503 { code: SLOT_CONFLICT, refunded: true }
// The frontend keys its toast / "Time Slot Taken" dialog / "Choose Another
// Time" recovery entirely off these codes.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import crypto from "crypto";
import express from "express";
import request from "supertest";

process.env.SESSION_SECRET = "test-session-secret";
process.env.PHOREST_USERNAME = "global/test";
process.env.PHOREST_PASSWORD = "test-password";
process.env.PHOREST_BUSINESS_ID = "test-business";
process.env.PHOREST_BRANCH_ID = "kAzBqW9d2LmXo4Vu";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";

vi.mock("./db", () => {
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") {
        return (resolve: any) => resolve([]);
      }
      return (..._args: any[]) => chain;
    },
    apply: () => chain,
  });
  return { db: chain, pool: { end: vi.fn() } };
});

// Keep the REAL PhorestApiError + classifyPhorestError (that's the logic under
// test) while stubbing every network-touching function.
vi.mock("./phorestApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./phorestApi")>();
  return {
    ...actual,
    listClients: vi.fn(async () => ({ content: [] })),
    getClient: vi.fn(async () => ({})),
    createClient: vi.fn(async () => ({})),
    updateClient: vi.fn(async () => ({})),
    getClientServiceHistories: vi.fn(async () => ({ content: [] })),
    getClientLoyalty: vi.fn(async () => ({ points: 0 })),
    listAppointments: vi.fn(async () => ({ content: [] })),
    getAppointment: vi.fn(async () => ({})),
    checkAppointmentAvailability: vi.fn(async () => ({})),
    createBooking: vi.fn(async () => ({})),
    activateBooking: vi.fn(async () => ({})),
    listBranchServices: vi.fn(async () => ({ content: [] })),
    listStaff: vi.fn(async () => ({ content: [] })),
    listProducts: vi.fn(async () => ({ content: [] })),
  };
});

const stripeMock = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(),
    update: vi.fn(async () => ({})),
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
  withRefundLock: vi.fn(async (_id: string, fn: () => any) => ({ ran: true, result: await fn() })),
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

let app: express.Express;

function signSessionToken(sessionId: string, clientId: string): string {
  const payload = `${sessionId}:${clientId}:${Date.now()}`;
  const hmac = crypto.createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("hex");
  return `${payload}:${hmac}`;
}

beforeAll(async () => {
  const { registerRoutes } = await import("./routes");
  app = express();
  app.use(express.json());
  await registerRoutes(app);
});

beforeEach(() => {
  vi.mocked(phorestApi.createBooking).mockReset();
  vi.mocked(phorestApi.createBooking).mockResolvedValue({} as any);
  stripeMock.paymentIntents.retrieve.mockReset();
  stripeMock.refunds.create.mockReset();
  stripeMock.refunds.create.mockResolvedValue({ id: "re_test", status: "succeeded" });
});

describe("Slot conflict on direct booking (/api/book)", () => {
  function bookPayload() {
    const sessionId = "session-conflict-book";
    return {
      serviceIds: ["svc-1"],
      staffIds: ["staff-1"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionId,
      sessionToken: signSessionToken(sessionId, "client-conflict-book"),
    };
  }

  it("returns 409 SLOT_CONFLICT when Phorest rejects with HTTP 409", async () => {
    vi.mocked(phorestApi.createBooking).mockRejectedValueOnce(
      new phorestApi.PhorestApiError("Phorest createbooking failed: 409", {
        status: 409,
        body: JSON.stringify({ detail: "SLOT_UNAVAILABLE" }),
      })
    );

    const res = await request(app).post("/api/book").send(bookPayload());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_CONFLICT");
    expect(res.body.message).toMatch(/just taken/i);
  });

  it("returns 409 SLOT_CONFLICT when Phorest sends a 400 with a conflict detail code", async () => {
    vi.mocked(phorestApi.createBooking).mockRejectedValueOnce(
      new phorestApi.PhorestApiError("Phorest createbooking failed: 400", {
        status: 400,
        body: JSON.stringify({ detail: "STAFF_DOUBLE_BOOKED" }),
      })
    );

    const res = await request(app).post("/api/book").send(bookPayload());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_CONFLICT");
  });

  it("does NOT classify a plain validation 400 as a conflict", async () => {
    vi.mocked(phorestApi.createBooking).mockRejectedValueOnce(
      new phorestApi.PhorestApiError("Phorest createbooking failed: 400", {
        status: 400,
        body: JSON.stringify({ detail: "INVALID_SERVICE" }),
      })
    );

    const res = await request(app).post("/api/book").send(bookPayload());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_UNAVAILABLE");
  });
});

describe("Slot conflict at payment finalize (/api/bookings/finalize)", () => {
  const pendingId = "pending-conflict-1";
  const paymentIntentId = "pi_conflict_1";

  const pendingBooking = {
    serviceIds: ["svc-1"],
    staffIds: ["staff-1"],
    startDateTime: "2026-08-01T14:00:00.000Z",
    branchId: "kAzBqW9d2LmXo4Vu",
    clientId: "client-conflict-fin",
    sessionId: "session-conflict-fin",
    serviceName: "WOMENS CUT",
    servicePrice: 10000,
    depositAmount: 2000,
    loyaltyPointsRedeemed: 0,
    loyaltyDiscountCents: 0,
    paymentIntentId,
    createdAt: Date.now(),
  };

  function mockSucceededIntent() {
    stripeMock.paymentIntents.retrieve.mockResolvedValue({
      id: paymentIntentId,
      status: "succeeded",
      amount: 2000,
      currency: "cad",
      metadata: {
        pendingId,
        clientId: pendingBooking.clientId,
        expectedAmount: "2000",
      },
    });
  }

  it("refunds the deposit and returns SLOT_CONFLICT when Phorest 409s after payment", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValueOnce(pendingBooking as any);
    mockSucceededIntent();
    vi.mocked(phorestApi.createBooking).mockRejectedValueOnce(
      new phorestApi.PhorestApiError("Phorest createbooking failed: 409", {
        status: 409,
        body: JSON.stringify({ detail: "SLOT_UNAVAILABLE" }),
      })
    );

    const res = await request(app).post("/api/bookings/finalize").send({ pendingId, paymentIntentId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("SLOT_CONFLICT");
    expect(res.body.refunded).toBe(true);
    expect(res.body.message).toMatch(/just taken/i);
    expect(res.body.message).toMatch(/refunded/i);
    // The deposit refund actually happened (idempotent, against the right intent)
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: paymentIntentId }),
      expect.objectContaining({ idempotencyKey: `refund-${paymentIntentId}` })
    );
    // Pending row cleared so a retry can't double-book
    expect(vi.mocked(pendingBookings.delete)).toHaveBeenCalledWith(pendingId);
  });

  it("does NOT refund on an unverifiable failure (timeout) — defers to orphan sweep", async () => {
    vi.mocked(pendingBookings.get).mockResolvedValueOnce(pendingBooking as any);
    mockSucceededIntent();
    vi.mocked(phorestApi.createBooking).mockRejectedValueOnce(
      new phorestApi.PhorestApiError("Phorest createbooking timed out", { isTimeout: true })
    );

    const res = await request(app).post("/api/bookings/finalize").send({ pendingId, paymentIntentId });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("BOOKING_STATUS_UNKNOWN");
    expect(res.body.refunded).toBe(false);
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});
