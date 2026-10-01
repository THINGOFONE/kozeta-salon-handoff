import { describe, it, expect, beforeAll, vi } from "vitest";
import crypto from "crypto";
import express from "express";
import request from "supertest";

// ── Environment must be set before routes.ts is imported ────────────────────
process.env.SESSION_SECRET = "test-session-secret";
process.env.PHOREST_USERNAME = "global/test";
process.env.PHOREST_PASSWORD = "test-password";
process.env.PHOREST_BUSINESS_ID = "test-business";
process.env.PHOREST_BRANCH_ID = "test-branch";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";

// ── Mocks for heavy/external modules imported by routes.ts ──────────────────
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

vi.mock("./phorestApi", () => ({
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
}));

vi.mock("./stripeClient", () => ({
  isStripeConfigured: vi.fn(async () => true),
  getStripePublishableKey: vi.fn(async () => "pk_test_123"),
  getStripeClient: vi.fn(async () => ({})),
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
  withRefundLock: vi.fn(async (_id: string, fn: () => any) => fn()),
}));

vi.mock("./orphanSweep", () => ({
  startOrphanSweep: vi.fn(),
  sweepOrphanedPayments: vi.fn(async () => {}),
}));

// Twilio SMS goes through global fetch — stub it so OTP "sends" succeed.
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: any, init?: any) => {
    if (String(url).includes("api.twilio.com")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ sid: "SMtest" }),
        text: async () => "",
      } as any;
    }
    return realFetch(url, init);
  })
);

import * as phorestApi from "./phorestApi";

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

async function requestOtp(phone: string): Promise<string> {
  const testClient = {
    clientId: `client-${phone}`,
    firstName: "Test",
    lastName: "Client",
    mobile: `+1${phone}`,
  };
  vi.mocked(phorestApi.listClients).mockResolvedValueOnce({ content: [testClient] } as any);
  const res = await request(app).post("/api/auth/login").send({ phone });
  expect(res.status).toBe(200);
  expect(res.body.otpSent).toBe(true);
  expect(res.body.otpId).toBeTruthy();
  return res.body.otpId;
}

describe("OTP exhaustion", () => {
  it("returns 429 after 5 failed attempts and invalidates the otpId", async () => {
    const otpId = await requestOtp("4165550101");

    // 5 wrong attempts → 401 with a decreasing attemptsRemaining counter
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await request(app)
        .post("/api/auth/verify")
        .send({ otpId, code: "000000" });
      expect(res.status).toBe(401);
      expect(res.body.attemptsRemaining).toBe(5 - attempt);
    }

    // 6th attempt: exhausted → 429 and the pending OTP is deleted
    const exhausted = await request(app)
      .post("/api/auth/verify")
      .send({ otpId, code: "000000" });
    expect(exhausted.status).toBe(429);
    expect(exhausted.body.attemptsRemaining).toBe(0);

    // The otpId is now gone — even a subsequent attempt gets "expired", not another chance
    const afterDelete = await request(app)
      .post("/api/auth/verify")
      .send({ otpId, code: "000000" });
    expect(afterDelete.status).toBe(400);
    expect(afterDelete.body.error).toMatch(/expired/i);
  });

  it("rejects unknown otpIds", async () => {
    const res = await request(app)
      .post("/api/auth/verify")
      .send({ otpId: "otp-nonexistent", code: "123456" });
    expect(res.status).toBe(400);
  });
});

describe("Logout token revocation", () => {
  it("revokes the signed session token so it cannot restore a session", async () => {
    const sessionId = "session-logout-test-1";
    const clientId = "client-logout-test-1";
    const sessionToken = signSessionToken(sessionId, clientId);

    // Before logout: the signed token authenticates (request proceeds past the
    // 401 check — it fails later with 503 PRICE_UNAVAILABLE, proving auth passed)
    const before = await request(app).post("/api/payments/create-intent").send({
      serviceIds: ["svc-1"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionId,
      sessionToken,
    });
    expect(before.status).not.toBe(401);

    // Logout revokes the session
    const logout = await request(app)
      .delete("/api/auth/session")
      .send({ sessionId, sessionToken });
    expect(logout.status).toBe(200);
    expect(logout.body.success).toBe(true);

    // After logout: the same valid signed token must NOT restore the session
    const after = await request(app).post("/api/payments/create-intent").send({
      serviceIds: ["svc-1"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionId,
      sessionToken,
    });
    expect(after.status).toBe(401);

    // Token alone (without sessionId) must also be refused
    const tokenOnly = await request(app).post("/api/payments/create-intent").send({
      serviceIds: ["svc-1"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionToken,
    });
    expect(tokenOnly.status).toBe(401);
  });

  it("does not revoke when the token does not match the sessionId", async () => {
    const sessionId = "session-mismatch-1";
    const sessionToken = signSessionToken("some-other-session", "client-x");

    const logout = await request(app)
      .delete("/api/auth/session")
      .send({ sessionId, sessionToken });
    // Endpoint always responds success, but the session must NOT be revoked
    expect(logout.status).toBe(200);

    const goodToken = signSessionToken(sessionId, "client-x");
    const res = await request(app).post("/api/payments/create-intent").send({
      serviceIds: ["svc-1"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionId,
      sessionToken: goodToken,
    });
    expect(res.status).not.toBe(401);
  });
});

describe("PRICE_UNAVAILABLE 503", () => {
  it("refuses to create a deposit when the price cannot be verified", async () => {
    const sessionId = "session-price-test-1";
    const sessionToken = signSessionToken(sessionId, "client-price-test-1");

    // Service cache returns nothing and live Phorest fetch has no matching
    // service (mocks return empty), so the price cannot be verified.
    const res = await request(app).post("/api/payments/create-intent").send({
      serviceIds: ["unknown-service-id"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionId,
      sessionToken,
    });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PRICE_UNAVAILABLE");
    expect(res.body.error).toMatch(/price/i);
  });

  it("refuses when Phorest returns the service with a $0 price", async () => {
    const sessionId = "session-price-test-2";
    const sessionToken = signSessionToken(sessionId, "client-price-test-2");

    vi.mocked(phorestApi.listBranchServices).mockResolvedValueOnce({
      content: [{ serviceId: "svc-zero", name: "Mystery Service", price: 0 }],
    } as any);

    const res = await request(app).post("/api/payments/create-intent").send({
      serviceIds: ["svc-zero"],
      startDateTime: "2026-08-01T14:00:00.000Z",
      sessionId,
      sessionToken,
    });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("PRICE_UNAVAILABLE");
  });
});
