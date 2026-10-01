// Integration tests for PostgreSQL advisory lock concurrency in paymentLocks.ts.
//
// These tests require DATABASE_URL and use a *real* PostgreSQL connection.
// They are automatically skipped when DATABASE_URL is absent.
//
// What is verified here that the mocked unit tests in paymentSafetyNets.test.ts
// cannot cover:
//
//  A. PG-layer lock: an external pg.Client holds pg_advisory_lock while
//     tryAcquireFinalizeLock is called → PG returns false → function returns false.
//
//  B. Release semantics: after the external client releases, the module can
//     re-acquire the same key.
//
//  C. withRefundLock concurrent callers in the same process: exactly one inner
//     function executes when two callers race on the same PI ID.
//
//  D. HTTP POST /api/bookings/finalize — two simultaneous requests for the same
//     pendingId → exactly one 409 FINALIZE_IN_PROGRESS, one continues normally.

import pg from "pg";
import express from "express";
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const DB_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// FNV-1a 32-bit hash — must match the implementation in paymentLocks.ts so
// the external PG client and the module agree on which lock integer to use.
// ---------------------------------------------------------------------------
function keyToLockInt(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

// ---------------------------------------------------------------------------
// Environment stubs for modules imported transitively by routes.ts.
// These must be set *before* any dynamic import of routes/paymentLocks.
// ---------------------------------------------------------------------------
process.env.SESSION_SECRET = "test-locks-integration-secret";
process.env.PHOREST_USERNAME = "global/test";
process.env.PHOREST_PASSWORD = "test-password";
process.env.PHOREST_BUSINESS_ID = "test-business";
process.env.PHOREST_BRANCH_ID = "kAzBqW9d2LmXo4Vu";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_FROM_NUMBER = "+15550000000";

// ---------------------------------------------------------------------------
// Mocks for *all* heavy dependencies except paymentLocks (which is intentionally
// left un-mocked so the real PG advisory lock logic runs).
// ---------------------------------------------------------------------------

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
    createBooking: vi.fn(async () => ({ phorestBookingId: "phbk-integ-1" })),
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
    create: vi.fn(async () => ({
      id: "pi_integ_new",
      client_secret: "pi_integ_new_secret",
      status: "requires_payment_method",
      amount: 2000,
      currency: "cad",
    })),
  },
  refunds: {
    create: vi.fn(async () => ({ id: "re_integ", status: "succeeded" })),
  },
}));

vi.mock("./stripeClient", () => ({
  isStripeConfigured: vi.fn(async () => true),
  getStripePublishableKey: vi.fn(async () => "pk_test_integ"),
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

// pendingStore: intentionally left as a controllable mock so individual tests
// can inject any pending booking state they need.
const pendingStoreMock = vi.hoisted(() => ({
  pendingBookings: {
    get: vi.fn(async () => undefined as any),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
  pendingOrders: {
    get: vi.fn(async () => undefined as any),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  },
}));

vi.mock("./pendingStore", () => ({
  PENDING_EXPIRY_MS: 15 * 60 * 1000,
  ...pendingStoreMock,
  findReusablePendingBooking: vi.fn(async () => undefined),
  findReusablePendingOrder: vi.fn(async () => undefined),
  startPendingCleanup: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const BASE_PENDING = {
  serviceIds: ["svc-integ"],
  staffIds: ["staff-integ"],
  startDateTime: "2026-11-01T15:00:00.000Z",
  branchId: "kAzBqW9d2LmXo4Vu",
  clientId: "client-integ-1",
  sessionId: "session-integ-1",
  serviceName: "WOMENS CUT",
  servicePrice: 10000,
  depositAmount: 2000,
  loyaltyPointsRedeemed: 0,
  loyaltyDiscountCents: 0,
  createdAt: Date.now(),
};

function succeededIntent(piId: string, pendingId: string) {
  return {
    id: piId,
    status: "succeeded",
    amount: 2000,
    currency: "cad",
    metadata: { pendingId, clientId: BASE_PENDING.clientId, expectedAmount: "2000" },
    latest_charge: null,
  };
}

// ===========================================================================
// A & B — Direct PG advisory lock behaviour (external client holds the lock)
// ===========================================================================
describe.skipIf(!DB_URL)(
  "paymentLocks: PG advisory lock layer (external client simulates a competing server instance)",
  () => {
    let externalClient: pg.Client;
    let tryAcquireFinalizeLock: (key: string) => Promise<boolean>;
    let releaseFinalizeLock: (key: string) => Promise<void>;
    let tryAcquireRefundLock: (piId: string) => Promise<boolean>;
    let releaseRefundLock: (piId: string) => Promise<void>;
    let withRefundLock: <T>(
      piId: string,
      fn: () => Promise<T>
    ) => Promise<{ ran: boolean; result?: T; error?: unknown }>;

    beforeAll(async () => {
      externalClient = new pg.Client({ connectionString: DB_URL });
      await externalClient.connect();

      const locks = await import("./paymentLocks");
      tryAcquireFinalizeLock = locks.tryAcquireFinalizeLock;
      releaseFinalizeLock = locks.releaseFinalizeLock;
      tryAcquireRefundLock = locks.tryAcquireRefundLock;
      releaseRefundLock = locks.releaseRefundLock;
      withRefundLock = locks.withRefundLock;
    });

    afterAll(async () => {
      await externalClient.end().catch(() => {});
    });

    // A — external session holds the lock; module must return false
    it("A: tryAcquireFinalizeLock returns false when a different PG session already holds the advisory lock", async () => {
      const key = `integ-finalize-block-${Date.now()}`;
      const lockInt = keyToLockInt(key);

      // External PG session acquires the lock (simulates another server instance)
      await externalClient.query("SELECT pg_advisory_lock($1::int8)", [lockInt]);

      try {
        const acquired = await tryAcquireFinalizeLock(key);
        expect(acquired).toBe(false);
      } finally {
        await externalClient.query("SELECT pg_advisory_unlock($1::int8)", [lockInt]);
      }
    });

    // B — lock becomes available again after the holder releases it
    it("B: tryAcquireFinalizeLock succeeds once the external session releases the advisory lock", async () => {
      const key = `integ-finalize-reacquire-${Date.now()}`;
      const lockInt = keyToLockInt(key);

      // Hold externally first
      await externalClient.query("SELECT pg_advisory_lock($1::int8)", [lockInt]);

      const blockedWhileHeld = await tryAcquireFinalizeLock(key);
      expect(blockedWhileHeld).toBe(false);

      // Release from external session
      await externalClient.query("SELECT pg_advisory_unlock($1::int8)", [lockInt]);

      // Now the module must succeed
      const acquired = await tryAcquireFinalizeLock(key);
      expect(acquired).toBe(true);
      await releaseFinalizeLock(key);
    });

    // Refund lock variant — uses the "refund:" namespace prefix
    it("A (refund): tryAcquireRefundLock returns false when a different PG session holds the refund advisory lock", async () => {
      const piId = `pi_integ_refund_block_${Date.now()}`;
      const key = `refund:${piId}`;
      const lockInt = keyToLockInt(key);

      await externalClient.query("SELECT pg_advisory_lock($1::int8)", [lockInt]);

      try {
        const acquired = await tryAcquireRefundLock(piId);
        expect(acquired).toBe(false);
      } finally {
        await externalClient.query("SELECT pg_advisory_unlock($1::int8)", [lockInt]);
      }
    });

    // withRefundLock: inner function must not run when external client holds lock
    it("withRefundLock: inner function does not run when another PG session holds the refund lock", async () => {
      const piId = `pi_integ_withlock_block_${Date.now()}`;
      const key = `refund:${piId}`;
      const lockInt = keyToLockInt(key);

      await externalClient.query("SELECT pg_advisory_lock($1::int8)", [lockInt]);

      let innerRan = false;
      let result: { ran: boolean; result?: unknown; error?: unknown };

      try {
        result = await withRefundLock(piId, async () => {
          innerRan = true;
          return "should-not-run";
        });
      } finally {
        await externalClient.query("SELECT pg_advisory_unlock($1::int8)", [lockInt]);
      }

      expect(result!.ran).toBe(false);
      expect(innerRan).toBe(false);
    });
  }
);

// ===========================================================================
// C — withRefundLock concurrent callers in the same process
// ===========================================================================
describe.skipIf(!DB_URL)(
  "paymentLocks: withRefundLock concurrent callers (same process)",
  () => {
    let withRefundLock: <T>(
      piId: string,
      fn: () => Promise<T>
    ) => Promise<{ ran: boolean; result?: T; error?: unknown }>;

    beforeAll(async () => {
      const locks = await import("./paymentLocks");
      withRefundLock = locks.withRefundLock;
    });

    it("C: only one inner function runs when two concurrent callers race on the same PI ID", async () => {
      const piId = `pi_integ_concurrent_refund_${Date.now()}`;
      let runCount = 0;

      // Fire both callers concurrently via Promise.all.
      // Caller A holds the lock (either via heldClients map or PG advisory lock)
      // while B tries to acquire — B must see the lock held and skip.
      const [resultA, resultB] = await Promise.all([
        withRefundLock(piId, async () => {
          runCount++;
          // Small pause so the event loop has a chance to start caller B
          await new Promise((r) => setTimeout(r, 40));
          return "A";
        }),
        // Slight artificial delay so A's pool connect starts first and it wins
        // the race to the PG layer — in practice only one can hold per session.
        new Promise<{ ran: boolean; result?: unknown; error?: unknown }>((resolve) =>
          setTimeout(
            () =>
              withRefundLock(piId, async () => {
                runCount++;
                return "B";
              }).then(resolve),
            5
          )
        ),
      ]);

      // Exactly one caller runs the inner function
      expect(runCount).toBe(1);

      const results = [resultA, resultB];
      expect(results.filter((r) => r.ran)).toHaveLength(1);
      expect(results.filter((r) => !r.ran)).toHaveLength(1);
    });
  }
);

// ===========================================================================
// D — HTTP POST /api/bookings/finalize concurrent requests
// ===========================================================================
describe.skipIf(!DB_URL)(
  "POST /api/bookings/finalize — concurrent requests for the same pendingId",
  () => {
    let app: express.Express;

    beforeAll(async () => {
      const { registerRoutes } = await import("./routes");
      app = express();
      app.use(express.json());
      await registerRoutes(app);
    });

    it("D: exactly one request gets 409 FINALIZE_IN_PROGRESS when two hit the same pendingId simultaneously", async () => {
      const pendingId = `pending-integ-concurrent-${Date.now()}`;
      const piId = `pi_integ_concurrent_finalize_${Date.now()}`;

      // Both requests will find a valid pending booking (with their Stripe PI)
      const intent = succeededIntent(piId, pendingId);
      stripeMock.paymentIntents.retrieve.mockResolvedValue(intent);

      // Make pendingBookings.get pause briefly on the first call so A holds the
      // lock while B tries to acquire — this ensures real concurrency overlap.
      let getCallCount = 0;
      pendingStoreMock.pendingBookings.get.mockImplementation(async (_id: string) => {
        if (++getCallCount === 1) {
          // First caller: pause after the lock is already held, so the second
          // concurrent request has a chance to attempt lock acquisition.
          await new Promise((r) => setTimeout(r, 60));
        }
        return { ...BASE_PENDING, paymentIntentId: piId };
      });

      // Fire both requests at the same time
      const [resA, resB] = await Promise.all([
        request(app).post("/api/bookings/finalize").send({ pendingId, paymentIntentId: piId }),
        // Small delay so A's lock acquisition starts slightly before B's
        new Promise<any>((resolve) =>
          setTimeout(() => {
            request(app)
              .post("/api/bookings/finalize")
              .send({ pendingId, paymentIntentId: piId })
              .then(resolve);
          }, 10)
        ),
      ]);

      const statuses = [resA.status, resB.status];
      const codes = [resA.body?.code, resB.body?.code];

      // Exactly one request must be blocked with 409 FINALIZE_IN_PROGRESS
      expect(statuses).toContain(409);
      expect(codes).toContain("FINALIZE_IN_PROGRESS");

      // The other request must succeed with 200 — the lock guard must not block
      // the winner, only the duplicate. If the winner also fails we have a bug
      // in the happy path, not just in concurrency protection.
      expect(statuses).toContain(200);

      const loser = [resA, resB].find(
        (r) => r.status === 409 && r.body?.code === "FINALIZE_IN_PROGRESS"
      );
      const winner = [resA, resB].find((r) => r.status === 200);
      expect(loser).toBeDefined();
      expect(winner).toBeDefined();
    });
  }
);
