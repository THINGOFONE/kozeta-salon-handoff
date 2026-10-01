// Staff/auto deposit refund service tests (Task #79).
//
// Verifies:
//  - only succeeded booking-deposit intents are refundable
//  - amounts validated against the live remaining un-refunded balance
//  - each sequential refund gets a DISTINCT Stripe idempotency key
//  - the shared refund lock is used (in-flight refunds are rejected)
//  - Phorest client note is appended best-effort after a refund

import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.PHOREST_USERNAME = "global/test";
process.env.PHOREST_PASSWORD = "test-password";
process.env.PHOREST_BUSINESS_ID = "test-business";
process.env.PHOREST_BRANCH_ID = "test-branch";

const dbInsertValues = vi.hoisted(() => vi.fn(async () => ({})));
const dbSelectRows = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock("./db", () => ({
  db: {
    insert: vi.fn(() => ({ values: dbInsertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => dbSelectRows.rows),
        })),
      })),
    })),
  },
  pool: { end: vi.fn() },
}));

const stripeMock = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(),
  },
  charges: {
    retrieve: vi.fn(),
  },
  refunds: {
    create: vi.fn(),
  },
}));

vi.mock("./stripeClient", () => ({
  getStripeClient: vi.fn(async () => stripeMock),
  isStripeConfigured: vi.fn(async () => true),
}));

const refundLockAvailable = vi.hoisted(() => ({ value: true }));
const fullServiceLockAvailable = vi.hoisted(() => ({ value: true }));
vi.mock("./paymentLocks", () => ({
  withRefundLock: vi.fn(async (_id: string, fn: () => any) => {
    if (!refundLockAvailable.value) return { ran: false };
    try {
      const result = await fn();
      return { ran: true, result };
    } catch (error) {
      return { ran: true, error };
    }
  }),
  tryAcquireFinalizeLock: vi.fn(async () => fullServiceLockAvailable.value),
  releaseFinalizeLock: vi.fn(async () => {}),
}));

vi.mock("./phorestApi", () => ({
  isPhorestConfigured: vi.fn(() => true),
  getClient: vi.fn(async () => ({ clientId: "cl_1", firstName: "A", lastName: "B", notes: "existing note" })),
  updateClient: vi.fn(async () => ({})),
  createVoucher: vi.fn(async () => ({
    voucherId: "v_1",
    serialNumber: "SER123",
    clientId: "cl_1",
    creatingBranchId: "test-branch",
    originalBalance: 10,
    remainingBalance: 10,
    issueDate: "2026-07-22T00:00:00Z",
    expiryDate: "2031-07-21T00:00:00Z",
  })),
}));

import {
  issueDepositRefund,
  issueServiceRefund,
  issueFullServiceRefund,
  isBookingDepositIntent,
  REFUND_LABELS,
} from "./refundService";
import * as phorestApi from "./phorestApi";
import * as paymentLocks from "./paymentLocks";

function depositPi(overrides: Record<string, any> = {}) {
  return {
    id: "pi_dep1",
    status: "succeeded",
    amount: 2000,
    latest_charge: "ch_1",
    metadata: { type: "booking_deposit", clientId: "cl_1", serviceName: "WOMENS CUT", startDateTime: "2026-08-01T14:00:00" },
    ...overrides,
  };
}

beforeEach(() => {
  refundLockAvailable.value = true;
  fullServiceLockAvailable.value = true;
  dbSelectRows.rows = [];
  stripeMock.paymentIntents.retrieve.mockReset();
  stripeMock.charges.retrieve.mockReset();
  stripeMock.refunds.create.mockReset();
  stripeMock.refunds.create.mockResolvedValue({ id: "re_1", status: "succeeded" });
  stripeMock.charges.retrieve.mockResolvedValue({ id: "ch_1", amount: 2000, amount_refunded: 0 });
  dbInsertValues.mockClear();
  vi.mocked(phorestApi.getClient).mockReset();
  vi.mocked(phorestApi.getClient).mockResolvedValue({
    clientId: "cl_1", firstName: "A", lastName: "B", notes: "existing note",
  } as any);
  vi.mocked(phorestApi.updateClient).mockClear();
  vi.mocked(phorestApi.createVoucher).mockClear();
});

describe("isBookingDepositIntent", () => {
  it("accepts booking_deposit and legacy pendingId intents, rejects product purchases", () => {
    expect(isBookingDepositIntent(depositPi())).toBe(true);
    expect(isBookingDepositIntent({ metadata: { pendingId: "p1" } })).toBe(true);
    expect(isBookingDepositIntent({ metadata: { type: "product_purchase", pendingId: "p1" } })).toBe(false);
    expect(isBookingDepositIntent({ metadata: {} })).toBe(false);
    expect(isBookingDepositIntent(null)).toBe(false);
  });
});

describe("issueDepositRefund", () => {
  it("issues a full refund of the remaining balance by default", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(res.ok).toBe(true);
    expect(res.amountRefundedCents).toBe(2000);
    expect(res.remainingCents).toBe(0);
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_dep1", amount: 2000 }),
      expect.objectContaining({ idempotencyKey: "refund-pi_dep1-r0-a2000" })
    );
  });

  it("issues a partial refund and validates against the remaining balance", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    stripeMock.charges.retrieve.mockResolvedValue({ id: "ch_1", amount: 2000, amount_refunded: 500 });

    const tooMuch = await issueDepositRefund({ paymentIntentId: "pi_dep1", amountCents: 1600, initiatedBy: "staff" });
    expect(tooMuch.ok).toBe(false);
    expect(tooMuch.code).toBe("INVALID_AMOUNT");

    const ok = await issueDepositRefund({ paymentIntentId: "pi_dep1", amountCents: 1000, initiatedBy: "staff" });
    expect(ok.ok).toBe(true);
    expect(ok.remainingCents).toBe(500);
    // Distinct key: includes prior refunded balance so a SECOND partial
    // refund can never be swallowed by Stripe idempotency dedup.
    expect(stripeMock.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1000 }),
      expect.objectContaining({ idempotencyKey: "refund-pi_dep1-r500-a1000" })
    );
  });

  it("rejects zero/negative/non-integer amounts", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    for (const amountCents of [0, -100, 10.5]) {
      const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", amountCents, initiatedBy: "staff" });
      expect(res.ok).toBe(false);
      expect(res.code).toBe("INVALID_AMOUNT");
    }
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("rejects fully-refunded deposits", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    stripeMock.charges.retrieve.mockResolvedValue({ id: "ch_1", amount: 2000, amount_refunded: 2000 });
    const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("NOTHING_TO_REFUND");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("rejects non-deposit and non-succeeded intents", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(
      depositPi({ metadata: { type: "product_purchase" } })
    );
    const notDeposit = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(notDeposit.code).toBe("NOT_A_DEPOSIT");

    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi({ status: "requires_payment_method" }));
    const notSucceeded = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(notSucceeded.code).toBe("NOT_SUCCEEDED");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("uses the shared refund lock and reports in-flight refunds", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    refundLockAvailable.value = false;
    const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("REFUND_IN_FLIGHT");
    expect(vi.mocked(paymentLocks.withRefundLock)).toHaveBeenCalledWith("pi_dep1", expect.any(Function));
  });

  it("records failed Stripe refunds in history and surfaces the error", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    stripeMock.refunds.create.mockRejectedValue(new Error("Card issuer declined refund"));
    const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("STRIPE_ERROR");
    expect(dbInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("appends a refund note to the Phorest client record after success", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "client-cancellation" });
    expect(res.ok).toBe(true);
    expect(vi.mocked(phorestApi.updateClient)).toHaveBeenCalledWith(
      "cl_1",
      expect.objectContaining({
        notes: expect.stringContaining("KOZETA SALON Deposit Refund $20.00 of $20.00"),
      })
    );
    // Existing notes preserved
    const notesArg = vi.mocked(phorestApi.updateClient).mock.calls[0][1].notes as string;
    expect(notesArg).toContain("existing note");
  });

  it("refund still succeeds when the Phorest note write fails", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    vi.mocked(phorestApi.getClient).mockRejectedValue(new Error("Phorest down"));
    const res = await issueDepositRefund({ paymentIntentId: "pi_dep1", initiatedBy: "staff" });
    expect(res.ok).toBe(true);
    expect(dbInsertValues).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });
});

describe("issueServiceRefund", () => {
  it("creates a Phorest voucher, records audit row, and appends a labeled client note", async () => {
    const res = await issueServiceRefund({
      paymentIntentId: "pi_dep1",
      clientId: "cl_1",
      amountCents: 1000,
      initiatedBy: "staff",
    });
    expect(res.ok).toBe(true);
    expect(res.voucherSerial).toBe("SER123");
    expect(vi.mocked(phorestApi.createVoucher)).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: "cl_1", originalBalance: 10, creatingBranchId: "test-branch" })
    );
    expect(dbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "phorest",
        label: REFUND_LABELS.serviceRefund,
        status: "succeeded",
        phorestVoucherId: "v_1",
        phorestVoucherSerial: "SER123",
      })
    );
    expect(vi.mocked(phorestApi.updateClient)).toHaveBeenCalledWith(
      "cl_1",
      expect.objectContaining({
        notes: expect.stringContaining("KOZETA SALON Service Refund $10.00"),
      })
    );
  });

  it("rejects invalid amounts", async () => {
    const res = await issueServiceRefund({
      paymentIntentId: "pi_dep1", clientId: "cl_1", amountCents: 0, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("INVALID_AMOUNT");
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
  });

  it("records failed voucher creation and reports the failure", async () => {
    vi.mocked(phorestApi.createVoucher).mockRejectedValueOnce(new Error("Phorest 500"));
    const res = await issueServiceRefund({
      paymentIntentId: "pi_dep1", clientId: "cl_1", amountCents: 1000, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("PHOREST_ERROR");
    expect(dbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ source: "phorest", status: "failed" })
    );
  });
});

describe("issueFullServiceRefund", () => {
  it("splits the total: deposit portion via Stripe, remainder via Phorest voucher", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 10000, initiatedBy: "staff",
    });
    if (!("deposit" in res)) throw new Error("expected split result");
    expect(res.ok).toBe(true);
    expect(res.deposit.amountCents).toBe(2000); // capped at remaining deposit
    expect(res.deposit.ok).toBe(true);
    expect(res.deposit.label).toBe(REFUND_LABELS.depositRefund);
    expect(res.service.amountCents).toBe(8000);
    expect(res.service.ok).toBe(true);
    expect(res.service.label).toBe(REFUND_LABELS.serviceRefund);
    expect(res.service.voucherSerial).toBe("SER123");
    // Two separate transactions
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(phorestApi.createVoucher)).toHaveBeenCalledTimes(1);
  });

  it("skips the Stripe leg when the deposit is already fully refunded", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    stripeMock.charges.retrieve.mockResolvedValue({ id: "ch_1", amount: 2000, amount_refunded: 2000 });
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 5000, initiatedBy: "staff",
    });
    if (!("deposit" in res)) throw new Error("expected split result");
    expect(res.ok).toBe(true);
    expect(res.deposit.attempted).toBe(false);
    expect(res.service.amountCents).toBe(5000);
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("does not roll back the Stripe leg when the Phorest leg fails, and reports per-source", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    vi.mocked(phorestApi.createVoucher).mockRejectedValueOnce(new Error("Phorest down"));
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 10000, initiatedBy: "staff",
    });
    if (!("deposit" in res)) throw new Error("expected split result");
    expect(res.ok).toBe(false);
    expect(res.deposit.ok).toBe(true);
    expect(res.service.ok).toBe(false);
    expect(res.service.error).toBeTruthy();
    expect(stripeMock.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refuses the service portion when no Phorest client is linked", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi({ metadata: { type: "booking_deposit" } }));
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 10000, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    if ("deposit" in res) throw new Error("expected pre-flight failure");
    expect(res.code).toBe("NO_CLIENT");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });

  it("only refunds via Stripe when the total fits within the remaining deposit", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 1500, initiatedBy: "staff",
    });
    if (!("deposit" in res)) throw new Error("expected split result");
    expect(res.ok).toBe(true);
    expect(res.deposit.amountCents).toBe(1500);
    expect(res.service.attempted).toBe(false);
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
  });
});

describe("full-service refund safety guards (Task #82 review fixes)", () => {
  it("refuses a second service refund for the same PaymentIntent (voucher dedupe)", async () => {
    dbSelectRows.rows = [{ phorestVoucherSerial: "OLD1", phorestVoucherId: "v_old", amountCents: 8000 }];
    const res = await issueServiceRefund({
      paymentIntentId: "pi_dep1", clientId: "cl_1", amountCents: 8000, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("ALREADY_ISSUED");
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
  });

  it("fails closed when the refund audit table cannot be read", async () => {
    const { db } = await import("./db");
    vi.mocked(db.select as any).mockImplementationOnce(() => { throw new Error("db down"); });
    const res = await issueServiceRefund({
      paymentIntentId: "pi_dep1", clientId: "cl_1", amountCents: 1000, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("AUDIT_UNAVAILABLE");
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
  });

  it("rejects a concurrent full-service refund via the operation lock", async () => {
    fullServiceLockAvailable.value = false;
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 10000, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    if ("deposit" in res) throw new Error("expected lock rejection");
    expect(res.code).toBe("REFUND_IN_FLIGHT");
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
  });

  it("skips the service voucher when the deposit leg fails (uncertain state)", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi());
    stripeMock.refunds.create.mockRejectedValue(new Error("Stripe timeout"));
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 10000, initiatedBy: "staff",
    });
    if (!("deposit" in res)) throw new Error("expected split result");
    expect(res.ok).toBe(false);
    expect(res.deposit.ok).toBe(false);
    expect(res.service.attempted).toBe(false);
    expect(res.service.error).toContain("Skipped");
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
  });

  it("refuses a full-service refund against a deposit that never succeeded", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue(depositPi({ status: "requires_payment_method" }));
    const res = await issueFullServiceRefund({
      paymentIntentId: "pi_dep1", totalCents: 10000, initiatedBy: "staff",
    });
    expect(res.ok).toBe(false);
    if ("deposit" in res) throw new Error("expected pre-flight failure");
    expect(res.code).toBe("NOT_SUCCEEDED");
    expect(vi.mocked(phorestApi.createVoucher)).not.toHaveBeenCalled();
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
  });
});
