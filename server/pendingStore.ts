import { db } from "./db";
import { pendingPayments } from "@shared/schema";
import { eq, and, lt } from "drizzle-orm";

// Database-backed store for pending bookings and product orders.
// Survives server restarts/deploys — previously these lived in an in-memory Map,
// which caused paid-but-lost bookings whenever the server restarted mid-payment.

export const PENDING_EXPIRY_MS = 15 * 60 * 1000;

export interface PendingBooking {
  serviceIds: string[];
  staffIds: string[];
  startDateTime: string;
  endDateTime?: string;
  branchId?: string;
  clientId: string;
  sessionId?: string;
  serviceName: string;
  servicePrice: number; // in cents
  depositAmount: number; // in cents
  loyaltyPointsRedeemed: number;
  loyaltyDiscountCents: number;
  paymentIntentId?: string;
  createdAt: number;
  /** One-time token for SMS payment links (?t=) — no login required when provided. 20-min TTL enforced by PENDING_EXPIRY_MS. */
  smsToken?: string;
}

export interface PendingOrder {
  clientId: string;
  sessionId: string;
  items: Array<{
    productId: string;
    productName: string;
    quantity: number;
    priceInCents: number;
  }>;
  totalInCents: number;
  loyaltyPointsRedeemed: number;
  loyaltyDiscountCents: number;
  paymentIntentId: string;
  createdAt: number;
}

async function getPending<T>(kind: string, id: string): Promise<T | undefined> {
  const rows = await db.select().from(pendingPayments)
    .where(and(eq(pendingPayments.id, id), eq(pendingPayments.kind, kind)));
  const row = rows[0];
  if (!row) return undefined;
  const payload = row.payload as T & { createdAt: number };
  if (Date.now() - payload.createdAt > PENDING_EXPIRY_MS) {
    await db.delete(pendingPayments).where(eq(pendingPayments.id, id));
    return undefined;
  }
  return payload;
}

async function setPending(kind: string, id: string, payload: unknown, paymentIntentId?: string): Promise<void> {
  await db.insert(pendingPayments)
    .values({ id, kind, payload, paymentIntentId: paymentIntentId ?? null })
    .onConflictDoUpdate({
      target: pendingPayments.id,
      set: { payload, paymentIntentId: paymentIntentId ?? null },
    });
}

async function deletePending(id: string): Promise<void> {
  await db.delete(pendingPayments).where(eq(pendingPayments.id, id));
}

export const pendingBookings = {
  get: (id: string) => getPending<PendingBooking>("booking", id),
  set: (id: string, b: PendingBooking) => setPending("booking", id, b, b.paymentIntentId),
  delete: deletePending,
};

/**
 * Find a live (non-expired) pending booking for the same client + service + slot.
 * Used to prevent cross-channel double-charges: if a payment link is already open
 * for this exact slot, the SMS saved-card path must not create a second charge
 * (and vice versa).
 */
export async function findPendingBookingBySlot(
  clientId: string,
  serviceId: string,
  startDateTime: string,
): Promise<{ pendingId: string; booking: PendingBooking } | undefined> {
  const rows = await db.select().from(pendingPayments).where(eq(pendingPayments.kind, "booking"));
  for (const row of rows) {
    const b = row.payload as PendingBooking & { createdAt: number };
    if (Date.now() - b.createdAt > PENDING_EXPIRY_MS) continue;
    if (b.clientId === clientId && b.startDateTime === startDateTime && b.serviceIds?.includes(serviceId)) {
      return { pendingId: row.id, booking: b };
    }
  }
  return undefined;
}

export const pendingOrders = {
  get: (id: string) => getPending<PendingOrder>("order", id),
  set: (id: string, o: PendingOrder) => setPending("order", id, o, o.paymentIntentId),
  delete: deletePending,
};

// Find a reusable pending booking for the same client + services + time slot,
// so a retry does NOT create a second PaymentIntent (prevents double charges).
export async function findReusablePendingBooking(
  clientId: string,
  serviceIds: string[],
  startDateTime: string,
  loyaltyPointsRedeemed: number,
  staffIds?: string[],
): Promise<{ pendingId: string; booking: PendingBooking } | undefined> {
  const rows = await db.select().from(pendingPayments).where(eq(pendingPayments.kind, "booking"));
  const wanted = [...serviceIds].sort().join(",");
  const wantedStaff = staffIds ? [...staffIds].sort().join(",") : "";
  for (const row of rows) {
    const b = row.payload as PendingBooking;
    if (Date.now() - b.createdAt > PENDING_EXPIRY_MS) continue;
    const rowStaff = b.staffIds ? [...b.staffIds].sort().join(",") : "";
    if (
      b.clientId === clientId &&
      b.startDateTime === startDateTime &&
      [...b.serviceIds].sort().join(",") === wanted &&
      rowStaff === wantedStaff &&
      b.loyaltyPointsRedeemed === loyaltyPointsRedeemed &&
      b.paymentIntentId
    ) {
      return { pendingId: row.id, booking: b };
    }
  }
  return undefined;
}

// Find a reusable pending product order for the same client + items + loyalty,
// so a checkout retry does NOT create a second PaymentIntent (prevents double charges).
export async function findReusablePendingOrder(
  clientId: string,
  items: Array<{ productId: string; quantity: number }>,
  loyaltyPointsRedeemed: number,
  sessionId: string,
): Promise<{ pendingOrderId: string; order: PendingOrder } | undefined> {
  const rows = await db.select().from(pendingPayments).where(eq(pendingPayments.kind, "order"));
  const wanted = items
    .map(i => `${i.productId}x${i.quantity}`)
    .sort()
    .join(",");
  for (const row of rows) {
    const o = row.payload as PendingOrder;
    if (Date.now() - o.createdAt > PENDING_EXPIRY_MS) continue;
    const got = o.items
      .map(i => `${i.productId}x${i.quantity}`)
      .sort()
      .join(",");
    if (
      o.clientId === clientId &&
      // Session binding: finalize verifies the PI's metadata.sessionId against
      // the stored order, so reusing across sessions would dead-end at finalize.
      o.sessionId === sessionId &&
      got === wanted &&
      o.loyaltyPointsRedeemed === loyaltyPointsRedeemed &&
      o.paymentIntentId
    ) {
      return { pendingOrderId: row.id, order: o };
    }
  }
  return undefined;
}

// Periodic cleanup of expired rows (payload.createdAt based, same 15-min TTL)
export function startPendingCleanup(): void {
  setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - PENDING_EXPIRY_MS - 60_000);
      await db.delete(pendingPayments).where(lt(pendingPayments.createdAt, cutoff));
    } catch (e) {
      console.error("[PendingStore] Cleanup failed:", e);
    }
  }, 5 * 60 * 1000);
}
