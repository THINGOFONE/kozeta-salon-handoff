// PaymentIntent reuse / session-binding unit tests.
//
// Verifies that checkout retries within the same session reuse the existing
// PaymentIntent (no double-charge), while a re-login (new session) forces a
// fresh one so the new session cannot piggyback on an old payment.
//
// Uses the real findReusablePendingOrder implementation with a mocked DB,
// mirroring the pendingStoreReuse.test.ts pattern for booking reuse.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRows: any[] = [];

vi.mock("./db", () => {
  const chain: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve: any) => resolve(mockRows);
      return (..._args: any[]) => chain;
    },
    apply: () => chain,
  });
  return { db: chain, pool: { end: vi.fn() } };
});

import { findReusablePendingOrder, PENDING_EXPIRY_MS } from "./pendingStore";

const NOW = Date.now();

function makeRow(overrides: Partial<{
  clientId: string;
  sessionId: string;
  items: Array<{ productId: string; quantity: number; productName: string; priceInCents: number }>;
  totalInCents: number;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountCents: number;
  paymentIntentId: string;
  createdAt: number;
}> = {}) {
  const payload = {
    clientId: "client-reuse-1",
    sessionId: "session-reuse-a",
    items: [{ productId: "prod-1", quantity: 1, productName: "Shampoo", priceInCents: 1500 }],
    totalInCents: 1500,
    loyaltyPointsRedeemed: 0,
    loyaltyDiscountCents: 0,
    paymentIntentId: "pi_existing_order",
    createdAt: NOW,
    ...overrides,
  };
  return { id: "order-row-1", kind: "order", payload, paymentIntentId: "pi_existing_order" };
}

beforeEach(() => {
  mockRows.length = 0;
});

// ===========================================================================
// 5. Checkout retry (same session) → reuses the existing PaymentIntent
// ===========================================================================
describe("Checkout retry: same session reuses the existing PaymentIntent", () => {
  it("returns the existing pending order when client, items, loyalty, and session all match", async () => {
    mockRows.push(makeRow());

    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-1", quantity: 1 }],
      0,
      "session-reuse-a",
    );

    expect(result).toBeDefined();
    expect(result?.order.paymentIntentId).toBe("pi_existing_order");
  });

  it("returns the existing order when cart has multiple items in different order", async () => {
    mockRows.push(makeRow({
      items: [
        { productId: "prod-1", quantity: 2, productName: "Shampoo", priceInCents: 1500 },
        { productId: "prod-2", quantity: 1, productName: "Conditioner", priceInCents: 1200 },
      ],
    }));

    // Items submitted in reverse order — should still match after sort
    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-2", quantity: 1 }, { productId: "prod-1", quantity: 2 }],
      0,
      "session-reuse-a",
    );

    expect(result).toBeDefined();
  });
});

// ===========================================================================
// 6. Re-login (new session) → creates a fresh PaymentIntent (no reuse)
// ===========================================================================
describe("Re-login: new session forces a fresh PaymentIntent", () => {
  it("does NOT reuse when the sessionId differs (re-login scenario)", async () => {
    mockRows.push(makeRow({ sessionId: "session-reuse-a" }));

    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-1", quantity: 1 }],
      0,
      "session-reuse-b", // new session after re-login
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse when the clientId differs", async () => {
    mockRows.push(makeRow({ clientId: "client-reuse-1" }));

    const result = await findReusablePendingOrder(
      "client-reuse-2", // different client
      [{ productId: "prod-1", quantity: 1 }],
      0,
      "session-reuse-a",
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse when the cart contents differ", async () => {
    mockRows.push(makeRow());

    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-2", quantity: 1 }], // different product
      0,
      "session-reuse-a",
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse when the quantity differs for the same product", async () => {
    mockRows.push(makeRow());

    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-1", quantity: 2 }], // quantity changed
      0,
      "session-reuse-a",
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse when loyalty redemption amount differs", async () => {
    mockRows.push(makeRow({ loyaltyPointsRedeemed: 0 }));

    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-1", quantity: 1 }],
      100, // redeemed 100 points this time
      "session-reuse-a",
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse an expired pending order even when everything else matches", async () => {
    mockRows.push(makeRow({ createdAt: NOW - PENDING_EXPIRY_MS - 1 }));

    const result = await findReusablePendingOrder(
      "client-reuse-1",
      [{ productId: "prod-1", quantity: 1 }],
      0,
      "session-reuse-a",
    );

    expect(result).toBeUndefined();
  });
});
