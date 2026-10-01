// Unit tests for findReusablePendingBooking staff-aware matching (Task #52).
//
// These test the function directly (not through the route) to confirm that
// a different staffId prevents reuse of an existing pending booking — so a
// stylist change always creates a fresh PaymentIntent.

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

import { findReusablePendingBooking, PENDING_EXPIRY_MS } from "./pendingStore";

const NOW = Date.now();

function makeRow(overrides: Partial<{
  clientId: string;
  serviceIds: string[];
  startDateTime: string;
  staffIds: string[];
  loyaltyPointsRedeemed: number;
  paymentIntentId: string;
  createdAt: number;
}> = {}) {
  const payload = {
    clientId: "client-1",
    serviceIds: ["svc-1"],
    startDateTime: "2026-09-15T14:00:00.000Z",
    staffIds: ["staff-a"],
    loyaltyPointsRedeemed: 0,
    paymentIntentId: "pi_test_123",
    createdAt: NOW,
    ...overrides,
  };
  return { id: "row-1", kind: "booking", payload };
}

beforeEach(() => {
  mockRows.length = 0;
});

describe("findReusablePendingBooking — staff-aware reuse", () => {
  it("reuses a pending booking when everything matches including staffId", async () => {
    mockRows.push(makeRow());

    const result = await findReusablePendingBooking(
      "client-1",
      ["svc-1"],
      "2026-09-15T14:00:00.000Z",
      0,
      ["staff-a"],
    );

    expect(result).toBeDefined();
    expect(result?.booking.paymentIntentId).toBe("pi_test_123");
  });

  it("does NOT reuse when the requested staffId differs from the stored one", async () => {
    mockRows.push(makeRow({ staffIds: ["staff-a"] }));

    const result = await findReusablePendingBooking(
      "client-1",
      ["svc-1"],
      "2026-09-15T14:00:00.000Z",
      0,
      ["staff-b"],
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse when caller passes multiple staff and stored has different list", async () => {
    mockRows.push(makeRow({ staffIds: ["staff-a", "staff-b"] }));

    const result = await findReusablePendingBooking(
      "client-1",
      ["svc-1"],
      "2026-09-15T14:00:00.000Z",
      0,
      ["staff-a"],
    );

    expect(result).toBeUndefined();
  });

  it("matches staff-agnostic bookings when no staffId is provided by either side", async () => {
    mockRows.push(makeRow({ staffIds: undefined }));

    const result = await findReusablePendingBooking(
      "client-1",
      ["svc-1"],
      "2026-09-15T14:00:00.000Z",
      0,
      undefined,
    );

    expect(result).toBeDefined();
  });

  it("does NOT reuse an expired pending booking even when staff matches", async () => {
    mockRows.push(makeRow({ createdAt: NOW - PENDING_EXPIRY_MS - 1 }));

    const result = await findReusablePendingBooking(
      "client-1",
      ["svc-1"],
      "2026-09-15T14:00:00.000Z",
      0,
      ["staff-a"],
    );

    expect(result).toBeUndefined();
  });

  it("does NOT reuse when serviceIds differ even if staff matches", async () => {
    mockRows.push(makeRow({ serviceIds: ["svc-1", "svc-2"] }));

    const result = await findReusablePendingBooking(
      "client-1",
      ["svc-1"],
      "2026-09-15T14:00:00.000Z",
      0,
      ["staff-a"],
    );

    expect(result).toBeUndefined();
  });
});
