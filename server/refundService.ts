// Shared refund service for portal booking deposits.
//
// Used by:
//  - the staff "Deposits & Refunds" admin page (full & partial refunds), and
//  - the client cancellation flow (>24h cancellations auto-refund in full).
//
// Safety properties:
//  - Reuses the shared refund advisory lock (withRefundLock) so this service,
//    the finalize safety-nets, and the orphan sweep can never race a refund
//    against the same PaymentIntent.
//  - Amounts are validated against the live remaining un-refunded balance
//    from Stripe (never negative/zero, never more than remaining).
//  - Each refund gets a DISTINCT Stripe idempotency key derived from the
//    balance state at request time: retries of the same logical refund are
//    deduplicated by Stripe, while a second sequential partial refund gets a
//    fresh key (the prior `refund-{intentId}` single key would silently
//    no-op it).
//  - Every attempt (success or failure) is recorded in deposit_refunds for
//    the admin history view.

import * as stripeClient from "./stripeClient";
import * as phorestApi from "./phorestApi";
import { withRefundLock, tryAcquireFinalizeLock, releaseFinalizeLock } from "./paymentLocks";
import { db } from "./db";
import { depositRefunds } from "@shared/schema";
import { and, eq } from "drizzle-orm";

// Canonical transaction labels. Charge side and refund side must always use
// the same convention so bank statements, Phorest records, and the audit
// trail line up.
export const REFUND_LABELS = {
  /** Stripe charge (online deposit). Applied as statement descriptor suffix + metadata. */
  depositCharge: "KOZETA SALON Deposit",
  /** Till-side service money as referenced in our records (till receipt text is Phorest's). */
  serviceCharge: "KOZETA SALON Service",
  /** Stripe refund of the deposit portion. */
  depositRefund: "KOZETA SALON Deposit Refund",
  /** Phorest-side refund of the service portion (salon credit voucher). */
  serviceRefund: "KOZETA SALON Service Refund",
} as const;

export interface RefundRequest {
  paymentIntentId: string;
  /** Amount in cents. Omit for a full refund of the remaining balance. */
  amountCents?: number;
  reason?: string;
  initiatedBy: "staff" | "client-cancellation" | "auto-cancellation-sweep";
  /**
   * Already-fetched PaymentIntent (e.g. from a list call). Skips the
   * retrieve round-trip; the refund state is still re-read live from the
   * charge before any money moves.
   */
  preloadedIntent?: any;
}

export interface RefundResult {
  ok: boolean;
  code?:
    | "NOT_FOUND"
    | "NOT_A_DEPOSIT"
    | "NOT_SUCCEEDED"
    | "INVALID_AMOUNT"
    | "NOTHING_TO_REFUND"
    | "REFUND_IN_FLIGHT"
    | "STRIPE_ERROR";
  message?: string;
  refundId?: string;
  amountRefundedCents?: number;
  remainingCents?: number;
}

/** True if this PaymentIntent is a portal booking deposit (not a product order). */
export function isBookingDepositIntent(pi: any): boolean {
  if (!pi?.metadata) return false;
  if (pi.metadata.type === "product_purchase") return false;
  return pi.metadata.type === "booking_deposit" || !!pi.metadata.pendingId;
}

async function recordRefundAttempt(row: {
  paymentIntentId: string;
  amountCents: number;
  stripeRefundId?: string;
  status: "succeeded" | "failed";
  reason?: string;
  initiatedBy: string;
  errorMessage?: string;
  source?: "stripe" | "phorest";
  label?: string;
  phorestVoucherId?: string;
  phorestVoucherSerial?: string;
}): Promise<void> {
  try {
    await db.insert(depositRefunds).values(row);
  } catch (e) {
    console.error(`[Refunds] Could not record refund history for ${row.paymentIntentId}:`, e);
  }
}

/** Get the charged/refunded amounts for a PI from its latest charge. */
export async function getRefundState(stripe: any, pi: any): Promise<{ chargedCents: number; refundedCents: number; remainingCents: number } | null> {
  if (!pi.latest_charge) {
    return { chargedCents: pi.amount || 0, refundedCents: 0, remainingCents: pi.amount || 0 };
  }
  const chargeId = typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id;
  // If the list endpoint already expanded the charge, use it without re-fetching.
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge.amount !== undefined
    ? pi.latest_charge
    : await stripe.charges.retrieve(chargeId);
  const chargedCents = charge.amount ?? pi.amount ?? 0;
  const refundedCents = charge.amount_refunded ?? 0;
  return { chargedCents, refundedCents, remainingCents: Math.max(0, chargedCents - refundedCents) };
}

export async function issueDepositRefund(req: RefundRequest): Promise<RefundResult> {
  const stripe = await stripeClient.getStripeClient();

  let pi: any = req.preloadedIntent;
  if (!pi || pi.id !== req.paymentIntentId) {
    try {
      pi = await stripe.paymentIntents.retrieve(req.paymentIntentId);
    } catch (e) {
      return { ok: false, code: "NOT_FOUND", message: "Payment not found in Stripe" };
    }
  }

  if (!isBookingDepositIntent(pi)) {
    return { ok: false, code: "NOT_A_DEPOSIT", message: "This payment is not a booking deposit" };
  }
  if (pi.status !== "succeeded") {
    return { ok: false, code: "NOT_SUCCEEDED", message: `Payment is not refundable (status: ${pi.status})` };
  }

  let state;
  try {
    state = await getRefundState(stripe, pi);
  } catch (e) {
    return { ok: false, code: "STRIPE_ERROR", message: "Could not read refund state from Stripe" };
  }
  if (!state || state.remainingCents <= 0) {
    return { ok: false, code: "NOTHING_TO_REFUND", message: "This deposit has already been fully refunded" };
  }

  const amountCents = req.amountCents ?? state.remainingCents;
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Refund amount must be a positive whole number of cents" };
  }
  if (amountCents > state.remainingCents) {
    return {
      ok: false,
      code: "INVALID_AMOUNT",
      message: `Refund amount exceeds the remaining balance ($${(state.remainingCents / 100).toFixed(2)})`,
    };
  }

  // Distinct idempotency key per sequential refund: keyed off the refunded
  // balance BEFORE this refund plus the requested amount. A network retry of
  // the same logical refund reuses the key (Stripe dedupes); the next partial
  // refund sees a different refundedCents and gets a fresh key.
  const idempotencyKey = `refund-${pi.id}-r${state.refundedCents}-a${amountCents}`;

  const outcome = await withRefundLock(pi.id, () =>
    stripe.refunds.create(
      {
        payment_intent: pi.id,
        amount: amountCents,
        reason: "requested_by_customer",
        metadata: {
          initiatedBy: req.initiatedBy,
          label: REFUND_LABELS.depositRefund,
          ...(req.reason ? { reason: req.reason.slice(0, 480) } : {}),
        },
      },
      { idempotencyKey }
    )
  );

  if (!outcome.ran) {
    return { ok: false, code: "REFUND_IN_FLIGHT", message: "Another refund for this deposit is already in progress. Try again in a moment." };
  }
  if (outcome.error) {
    const msg = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    await recordRefundAttempt({
      paymentIntentId: pi.id,
      amountCents,
      status: "failed",
      reason: req.reason,
      initiatedBy: req.initiatedBy,
      errorMessage: msg.slice(0, 1000),
      source: "stripe",
      label: REFUND_LABELS.depositRefund,
    });
    if (/already.*refunded|has already been refunded/i.test(msg)) {
      return { ok: false, code: "NOTHING_TO_REFUND", message: "This deposit has already been refunded" };
    }
    console.error(`[Refunds] Stripe refund failed for ${pi.id}:`, msg);
    return { ok: false, code: "STRIPE_ERROR", message: msg };
  }

  const refund: any = outcome.result;
  await recordRefundAttempt({
    paymentIntentId: pi.id,
    amountCents,
    stripeRefundId: refund?.id,
    status: "succeeded",
    reason: req.reason,
    initiatedBy: req.initiatedBy,
    source: "stripe",
    label: REFUND_LABELS.depositRefund,
  });

  const remainingAfter = state.remainingCents - amountCents;
  console.log(
    `[Refunds] REFUNDED $${(amountCents / 100).toFixed(2)} of ${pi.id} (${req.initiatedBy}); ` +
    `remaining $${(remainingAfter / 100).toFixed(2)}; client ${pi.metadata?.clientId || "unknown"}`
  );

  // Best-effort: make the refund visible in Phorest HOST via a client note.
  await writePhorestRefundNote(pi, amountCents, state.chargedCents).catch((e) =>
    console.warn(`[Refunds] Could not write Phorest note for ${pi.id}:`, e)
  );

  return { ok: true, refundId: refund?.id, amountRefundedCents: amountCents, remainingCents: remainingAfter };
}

// ─── Phorest-side service refunds (salon credit voucher) ────────────────────

export interface ServiceRefundResult {
  ok: boolean;
  code?: "INVALID_AMOUNT" | "PHOREST_UNAVAILABLE" | "PHOREST_ERROR" | "ALREADY_ISSUED" | "AUDIT_UNAVAILABLE";
  message?: string;
  voucherId?: string;
  voucherSerial?: string;
  amountRefundedCents?: number;
}

/**
 * Refund the service (till-paid) portion via Phorest.
 *
 * Method verified live (July 2026): Phorest's create-purchase endpoint
 * rejects negative/refund totals, and there is no API that can push money
 * back to a card terminal — so the service portion is delivered as a salon
 * credit voucher on the client's Phorest account, labeled
 * "KOZETA SALON Service Refund" in the client's notes with the voucher
 * serial as the reference staff quote at the till.
 */
export async function issueServiceRefund(req: {
  /** The booking's deposit PaymentIntent id — used as the audit anchor. */
  paymentIntentId: string;
  clientId: string;
  amountCents: number;
  reason?: string;
  initiatedBy: "staff" | "client-cancellation";
}): Promise<ServiceRefundResult> {
  if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Service refund amount must be a positive whole number of cents" };
  }
  if (!phorestApi.isPhorestConfigured()) {
    return { ok: false, code: "PHOREST_UNAVAILABLE", message: "Phorest is not configured — service portion must be handed back at the till" };
  }
  const branchId = process.env.PHOREST_BRANCH_ID?.trim();
  if (!branchId) {
    return { ok: false, code: "PHOREST_UNAVAILABLE", message: "Phorest branch not configured" };
  }

  // Idempotency guard: vouchers cannot be deleted via the Phorest API, so a
  // duplicate issuance is real money out the door. Never issue a second
  // service-refund voucher anchored to the same PaymentIntent.
  try {
    const existing = await db
      .select()
      .from(depositRefunds)
      .where(and(
        eq(depositRefunds.paymentIntentId, req.paymentIntentId),
        eq(depositRefunds.source, "phorest"),
        eq(depositRefunds.status, "succeeded"),
      ))
      .limit(1);
    if (existing.length > 0) {
      const serial = existing[0].phorestVoucherSerial || existing[0].phorestVoucherId || "unknown";
      return {
        ok: false,
        code: "ALREADY_ISSUED",
        message: `A service refund voucher (#${serial}, $${(existing[0].amountCents / 100).toFixed(2)}) was already issued for this deposit — refusing to issue a second one. Verify the voucher in Phorest before doing anything further.`,
      };
    }
  } catch (e) {
    // If the audit table cannot be read we cannot prove this is not a
    // duplicate — fail closed rather than risk double credit.
    console.error(`[Refunds] Could not check for existing service refund on ${req.paymentIntentId}:`, e);
    return { ok: false, code: "AUDIT_UNAVAILABLE", message: "Could not verify refund history — service refund not issued. Try again shortly." };
  }

  const now = new Date();
  const expiry = new Date(now.getTime() + 5 * 365 * 24 * 60 * 60 * 1000); // 5 years
  let voucher: phorestApi.PhorestVoucher;
  try {
    voucher = await phorestApi.createVoucher({
      clientId: req.clientId,
      originalBalance: req.amountCents / 100,
      creatingBranchId: branchId,
      issueDate: now.toISOString(),
      expiryDate: expiry.toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await recordRefundAttempt({
      paymentIntentId: req.paymentIntentId,
      amountCents: req.amountCents,
      status: "failed",
      reason: req.reason,
      initiatedBy: req.initiatedBy,
      errorMessage: msg.slice(0, 1000),
      source: "phorest",
      label: REFUND_LABELS.serviceRefund,
    });
    console.error(`[Refunds] Phorest service refund voucher failed for ${req.paymentIntentId}:`, msg);
    return { ok: false, code: "PHOREST_ERROR", message: "Could not create the Phorest credit voucher. The service portion was NOT refunded — retry, or hand it back at the till." };
  }

  await recordRefundAttempt({
    paymentIntentId: req.paymentIntentId,
    amountCents: req.amountCents,
    status: "succeeded",
    reason: req.reason,
    initiatedBy: req.initiatedBy,
    source: "phorest",
    label: REFUND_LABELS.serviceRefund,
    phorestVoucherId: voucher.voucherId,
    phorestVoucherSerial: voucher.serialNumber,
  });

  console.log(
    `[Refunds] SERVICE REFUND $${(req.amountCents / 100).toFixed(2)} via Phorest voucher #${voucher.serialNumber} ` +
    `(${req.initiatedBy}); client ${req.clientId}; anchor ${req.paymentIntentId}`
  );

  // Best-effort: label the refund in the client's Phorest notes so staff see it in HOST.
  await appendPhorestClientNote(
    req.clientId,
    `${REFUND_LABELS.serviceRefund} $${(req.amountCents / 100).toFixed(2)} issued as salon credit voucher ` +
    `#${voucher.serialNumber} on ${now.toISOString().slice(0, 10)}${req.reason ? ` — ${req.reason.slice(0, 200)}` : ""}`
  ).catch((e) => console.warn(`[Refunds] Could not write Phorest note for service refund ${voucher.voucherId}:`, e));

  return {
    ok: true,
    voucherId: voucher.voucherId,
    voucherSerial: voucher.serialNumber,
    amountRefundedCents: req.amountCents,
  };
}

// ─── Full-service refunds (deposit portion + service portion) ───────────────

export interface SplitPreview {
  totalCents: number;
  depositPortionCents: number;
  servicePortionCents: number;
  depositRemainingCents: number;
}

/** How a staff-entered total splits across the two sources. */
export async function previewSplit(paymentIntentId: string, totalCents: number): Promise<
  { ok: true; preview: SplitPreview } | { ok: false; code: string; message: string }
> {
  const stripe = await stripeClient.getStripeClient();
  let pi: any;
  try {
    pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  } catch {
    return { ok: false, code: "NOT_FOUND", message: "Payment not found in Stripe" };
  }
  if (!isBookingDepositIntent(pi)) {
    return { ok: false, code: "NOT_A_DEPOSIT", message: "This payment is not a booking deposit" };
  }
  if (pi.status !== "succeeded") {
    return { ok: false, code: "NOT_SUCCEEDED", message: "This deposit was never successfully charged — there is nothing to refund against it" };
  }
  let state;
  try {
    state = await getRefundState(stripe, pi);
  } catch {
    return { ok: false, code: "STRIPE_ERROR", message: "Could not read refund state from Stripe" };
  }
  const depositRemaining = pi.status === "succeeded" ? (state?.remainingCents ?? 0) : 0;
  const depositPortion = Math.min(depositRemaining, totalCents);
  return {
    ok: true,
    preview: {
      totalCents,
      depositPortionCents: depositPortion,
      servicePortionCents: totalCents - depositPortion,
      depositRemainingCents: depositRemaining,
    },
  };
}

export interface FullServiceRefundResult {
  /** True only if every applicable portion succeeded. */
  ok: boolean;
  totalRequestedCents: number;
  deposit: {
    attempted: boolean;
    ok: boolean;
    amountCents: number;
    label: string;
    refundId?: string;
    error?: string;
    code?: string;
  };
  service: {
    attempted: boolean;
    ok: boolean;
    amountCents: number;
    label: string;
    voucherSerial?: string;
    voucherId?: string;
    error?: string;
    code?: string;
  };
}

/**
 * Refund a staff-entered total across both sources, as TWO separate
 * transactions: the deposit portion back through Stripe (capped at the
 * remaining refundable deposit), the rest as a Phorest service refund.
 * Both fire immediately and synchronously; a completed portion is never
 * rolled back if the other fails — the caller gets per-source results.
 */
export async function issueFullServiceRefund(req: {
  paymentIntentId: string;
  totalCents: number;
  clientId?: string;
  reason?: string;
  initiatedBy: "staff" | "client-cancellation";
}): Promise<FullServiceRefundResult | { ok: false; code: string; message: string }> {
  if (!Number.isInteger(req.totalCents) || req.totalCents <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", message: "Refund total must be a positive whole number of cents" };
  }

  // One full-service operation at a time per PaymentIntent (DB advisory
  // lock, works across instances). Prevents two concurrent requests from
  // both issuing the service-portion voucher.
  const lockKey = `full-service:${req.paymentIntentId}`;
  let locked: boolean;
  try {
    locked = await tryAcquireFinalizeLock(lockKey);
  } catch {
    return { ok: false, code: "LOCK_ERROR", message: "Could not secure the refund lock — nothing was refunded. Try again." };
  }
  if (!locked) {
    return { ok: false, code: "REFUND_IN_FLIGHT", message: "Another refund for this payment is already in progress — nothing was refunded." };
  }
  try {
    return await doFullServiceRefund(req);
  } finally {
    await releaseFinalizeLock(lockKey);
  }
}

async function doFullServiceRefund(req: {
  paymentIntentId: string;
  totalCents: number;
  clientId?: string;
  reason?: string;
  initiatedBy: "staff" | "client-cancellation";
}): Promise<FullServiceRefundResult | { ok: false; code: string; message: string }> {
  const split = await previewSplit(req.paymentIntentId, req.totalCents);
  if (!split.ok) return split;
  const { depositPortionCents, servicePortionCents } = split.preview;

  // Resolve the client for the Phorest-side voucher.
  let clientId = req.clientId;
  if (!clientId) {
    try {
      const stripe = await stripeClient.getStripeClient();
      const pi = await stripe.paymentIntents.retrieve(req.paymentIntentId);
      clientId = pi.metadata?.clientId;
    } catch { /* handled below */ }
  }
  if (servicePortionCents > 0 && !clientId) {
    return { ok: false, code: "NO_CLIENT", message: "This payment has no linked Phorest client — the service portion cannot be issued as salon credit. Refund the deposit only, and hand back the service amount at the till." };
  }

  const result: FullServiceRefundResult = {
    ok: false,
    totalRequestedCents: req.totalCents,
    deposit: { attempted: depositPortionCents > 0, ok: false, amountCents: depositPortionCents, label: REFUND_LABELS.depositRefund },
    service: { attempted: servicePortionCents > 0, ok: false, amountCents: servicePortionCents, label: REFUND_LABELS.serviceRefund },
  };

  if (depositPortionCents > 0) {
    const dep = await issueDepositRefund({
      paymentIntentId: req.paymentIntentId,
      amountCents: depositPortionCents,
      reason: req.reason,
      initiatedBy: req.initiatedBy,
    });
    result.deposit.ok = dep.ok;
    result.deposit.refundId = dep.refundId;
    if (!dep.ok) {
      result.deposit.error = dep.message;
      result.deposit.code = dep.code;
    }
  } else {
    result.deposit.ok = true; // nothing to do on this source
  }

  // If the deposit leg was attempted and failed, its true state may be
  // uncertain (e.g. an in-flight refund elsewhere, a Stripe timeout). Do NOT
  // proceed to issue irreversible salon credit on top of an unknown deposit
  // state — staff can re-run once the deposit side is resolved.
  if (result.deposit.attempted && !result.deposit.ok) {
    result.service.attempted = false;
    result.service.error = "Skipped — the deposit portion failed, so the service credit was not issued. Resolve the deposit refund first, then retry.";
    return result;
  }

  if (servicePortionCents > 0) {
    const svc = await issueServiceRefund({
      paymentIntentId: req.paymentIntentId,
      clientId: clientId!,
      amountCents: servicePortionCents,
      reason: req.reason,
      initiatedBy: req.initiatedBy,
    });
    result.service.ok = svc.ok;
    result.service.voucherId = svc.voucherId;
    result.service.voucherSerial = svc.voucherSerial;
    if (!svc.ok) {
      result.service.error = svc.message;
      result.service.code = svc.code;
    }
  } else {
    result.service.ok = true;
  }

  result.ok =
    (!result.deposit.attempted || result.deposit.ok) &&
    (!result.service.attempted || result.service.ok);
  return result;
}

// Append a refund line to the client's Phorest notes so staff see it in HOST.
// Phorest has no appointment-note-update API, so the client record is the
// only writable surface. Read-modify-write on the full client object keeps
// the required fields (and version, when present) intact.
async function writePhorestRefundNote(pi: any, amountCents: number, chargedCents: number): Promise<void> {
  const clientId = pi.metadata?.clientId;
  if (!clientId) return;
  const when = new Date().toISOString().slice(0, 10);
  const appt = pi.metadata?.startDateTime
    ? ` — appointment ${pi.metadata.startDateTime}`
    : "";
  const line =
    `${REFUND_LABELS.depositRefund} $${(amountCents / 100).toFixed(2)} of $${(chargedCents / 100).toFixed(2)} ` +
    `issued via portal on ${when}${appt} (Stripe ${pi.id})`;
  await appendPhorestClientNote(clientId, line);
}

/** Shared note appender used by both refund sources. */
async function appendPhorestClientNote(clientId: string, line: string): Promise<void> {
  if (!clientId || !phorestApi.isPhorestConfigured()) return;
  const client: any = await phorestApi.getClient(clientId);
  const existing = (client?.notes || "").trim();
  // Keep notes bounded — trim oldest content if we ever approach Phorest's cap.
  const combined = existing ? `${existing}\n${line}` : line;
  const notes = combined.length > 40000 ? combined.slice(combined.length - 40000) : combined;
  await phorestApi.updateClient(clientId, { ...client, notes });
}
