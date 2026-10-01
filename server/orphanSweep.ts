import * as stripeClient from "./stripeClient";
import * as phorestApi from "./phorestApi";
import { pendingBookings } from "./pendingStore";
import { db } from "./db";
import { depositReviewFlags } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import { slotToSalonLocal, appointmentNearSlot, isCancelledAppointment } from "./utils/apptSlotMatch";
import { issueDepositRefund } from "./refundService";

// Safety-net sweep for orphaned deposit payments.
//
// Finds succeeded booking-deposit PaymentIntents that are older than ~15 minutes,
// whose pending booking never finalized (no row left in the DB) and for which no
// matching Phorest appointment exists — then refunds them automatically.
// This guarantees no client is ever left charged without an appointment, even if
// the server crashed at the worst possible moment.

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;      // run every 5 minutes
const MIN_AGE_MS = 15 * 60 * 1000;            // only touch payments older than 15 min
// Scan the last 30 days so deposits are still auto-refunded when an appointment
// is cancelled in Phorest days or weeks after the deposit was paid.
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

let sweeping = false;

// Live-safe dry run: when REFUND_SWEEP_DRY_RUN=1, the sweep runs its full
// decision matrix and logs exactly what it WOULD refund, but never moves money.
function isDryRun(): boolean {
  return process.env.REFUND_SWEEP_DRY_RUN === "1";
}

// After this many sweeps still unresolved, a flagged deposit is escalated with
// a loud error log so it can never rot silently in a warn-once set.
const ESCALATION_SWEEP_COUNT = 6; // ~30 minutes at 5-minute sweeps

// Persist a manual-review flag for a payment intent (survives restarts).
// Each sweep that still sees the problem increments sweepCount; once it crosses
// ESCALATION_SWEEP_COUNT the flag is escalated exactly once with console.error.
async function flagForManualReview(piId: string, reason: string): Promise<void> {
  try {
    const rows = await db
      .insert(depositReviewFlags)
      .values({ paymentIntentId: piId, reason })
      .onConflictDoUpdate({
        target: depositReviewFlags.paymentIntentId,
        set: {
          reason,
          sweepCount: sql`${depositReviewFlags.sweepCount} + 1`,
          lastSeenAt: new Date(),
        },
      })
      .returning();
    const flag = rows[0];
    if (!flag) return;
    if (flag.sweepCount === 1) {
      console.warn(`[OrphanSweep] ${piId} flagged for manual review: ${reason} (no auto-refund)`);
    } else if (flag.sweepCount >= ESCALATION_SWEEP_COUNT && !flag.escalatedAt) {
      await db
        .update(depositReviewFlags)
        .set({ escalatedAt: new Date() })
        .where(eq(depositReviewFlags.paymentIntentId, piId));
      console.error(
        `[OrphanSweep][ESCALATION] Deposit ${piId} has been flagged for manual review for ${flag.sweepCount} sweeps ` +
        `(first flagged ${flag.firstFlaggedAt.toISOString()}) and is still unresolved: ${reason}. ` +
        `A client may be charged without a confirmed appointment — review this payment in Stripe NOW.`
      );
    }
  } catch (e) {
    console.error(`[OrphanSweep] Could not persist manual-review flag for ${piId}:`, e);
  }
}

// Clear a flag once the payment is resolved (refunded or verified consumed).
async function clearReviewFlag(piId: string): Promise<void> {
  try {
    await db.delete(depositReviewFlags).where(eq(depositReviewFlags.paymentIntentId, piId));
  } catch {}
}

export function startOrphanSweep(): void {
  setInterval(() => {
    sweepOrphanedPayments().catch(e =>
      console.error("[OrphanSweep] Sweep failed:", e)
    );
  }, SWEEP_INTERVAL_MS);
  // Also run once shortly after startup (a restart is exactly when orphans appear)
  setTimeout(() => {
    sweepOrphanedPayments().catch(e =>
      console.error("[OrphanSweep] Startup sweep failed:", e)
    );
  }, 60 * 1000);
}

export async function sweepOrphanedPayments(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    if (!(await stripeClient.isStripeConfigured())) return;
    const stripe = await stripeClient.getStripeClient();

    const createdGte = Math.floor((Date.now() - LOOKBACK_MS) / 1000);
    let startingAfter: string | undefined;

    for (let page = 0; page < 5; page++) {
      const params: Record<string, any> = { limit: 100, created: { gte: createdGte } };
      if (startingAfter) params.starting_after = startingAfter;
      const batch = await stripe.paymentIntents.list(params);
      const intents: any[] = batch.data || [];
      if (intents.length === 0) break;

      for (const pi of intents) {
        try {
          await checkAndRefundOrphan(stripe, pi);
        } catch (e) {
          console.error(`[OrphanSweep] Error checking ${pi.id}:`, e);
        }
      }

      if (!batch.has_more) break;
      startingAfter = intents[intents.length - 1].id;
    }
  } finally {
    sweeping = false;
  }
}

async function checkAndRefundOrphan(stripe: any, pi: any): Promise<void> {
  // Only succeeded booking deposits (identified by pendingId metadata, not product purchases)
  if (pi.status !== "succeeded") return;
  const pendingId = pi.metadata?.pendingId;
  if (!pendingId || pi.metadata?.type === "product_purchase") return;

  // Too fresh — the client may still be mid-finalize
  const ageMs = Date.now() - pi.created * 1000;
  if (ageMs < MIN_AGE_MS) return;

  // Pending booking still exists → finalize may still be in-flight; leave it alone
  const stillPending = await pendingBookings.get(pendingId);
  if (stillPending) return;

  // PI is tagged statusUnknown=1: a 5xx/timeout from Phorest during finalize means we
  // cannot know whether the booking was actually created on Phorest's side. An empty
  // Phorest appointment list could mean "no booking" OR "booking exists but response was
  // lost". Auto-refunding here would wrongly charge back a real appointment.
  // Defer to manual review; the tag remains on the PI until a human clears it.
  if (pi.metadata?.statusUnknown === "1") {
    // Persist a review flag so the admin deposits page shows a "Needs review"
    // badge — these are exactly the outage-caused ambiguous cases staff must
    // check by hand. Still fail-closed: never auto-refund on uncertainty.
    await flagForManualReview(pi.id, "booking status unknown (Phorest error during finalize) — verify the appointment exists, then refund manually if not");
    return;
  }

  // Already refunded (fully or partially)? Skip.
  if (pi.latest_charge) {
    try {
      const charge = await stripe.charges.retrieve(
        typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge.id
      );
      if (charge.refunded || (charge.amount_refunded || 0) > 0) return;
    } catch (e) {
      console.warn(`[OrphanSweep] Could not read charge for ${pi.id}, skipping this round:`, e);
      return;
    }
  }

  // Does a matching Phorest appointment exist for this payment?
  const clientId = pi.metadata?.clientId;
  const startDateTime = pi.metadata?.startDateTime;
  if (!startDateTime) {
    // Legacy intent without startDateTime metadata — cannot safely verify against
    // Phorest, so never auto-refund; flag for manual review (persisted + escalated).
    await flagForManualReview(pi.id, "no startDateTime metadata — cannot verify against Phorest");
    return;
  }
  const bookingId = pi.metadata?.phorestBookingId;
  const appointmentId = pi.metadata?.appointmentId;
  let refundReason = "orphaned deposit (booking never created)";

  if (appointmentId && phorestApi.isPhorestConfigured()) {
    // PRECISE PATH (new bookings): the PI carries the real Phorest appointment
    // id — judge cancellation directly by that appointment's activationState.
    // Never time-based, immune to reschedules and same-day rebooking noise.
    let appt: any;
    try {
      appt = await phorestApi.getAppointment(appointmentId);
      appt = (appt as any)?.appointment || appt;
    } catch (e) {
      // Cannot verify (Phorest error / appointment lookup failed) → never
      // refund on uncertainty; try again next sweep.
      console.warn(`[OrphanSweep] Could not fetch appointment ${appointmentId} for ${pi.id}, deferring:`, e);
      return;
    }
    if (!isCancelledAppointment(appt)) {
      // Appointment on the books — deposit is legitimately held/consumed.
      await clearReviewFlag(pi.id);
      return;
    }
    refundReason = `appointment ${appointmentId} cancelled in Phorest`;
  } else if (bookingId) {
    // CONSUMED deposit: finalize succeeded and a Phorest booking was recorded.
    // Only refund if the appointment was CANCELLED in Phorest. Time-based
    // matching alone is unsafe here — a rescheduled appointment would miss the
    // original slot and cause a wrongful refund. Instead, look for ANY active
    // appointment for this client with a matching service in the upcoming window.
    const startMs = new Date(startDateTime).getTime();
    if (isNaN(startMs)) return; // invalid → cannot verify, never auto-refund
    if (!clientId || !phorestApi.isPhorestConfigured()) return;
    let verifiedPastCancellation = false;
    if (startMs <= Date.now()) {
      // STALE consumed deposit: the appointment date has passed. Normally the
      // deposit was applied at the visit's checkout — but if the appointment
      // was cancelled (or vanished), the deposit was never consumed. Verify:
      //   cancelled → refund; missing → manual-review flag; otherwise →
      //   consumed, clear any stale flag.
      // Grace of 1 day (same-day checkouts may lag) and a 7-day lookback
      // horizon (older deposits stay hands-off, as before).
      const DAY = 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      if (startMs > nowMs - DAY || startMs < nowMs - 7 * DAY) return;
      const slot = slotToSalonLocal(startDateTime);
      if (!slot) return;
      let list: any[] = [];
      try {
        const appts = await phorestApi.listAppointments({
          clientId,
          fromDate: slot.date,
          toDate: slot.date,
          size: 100,
        });
        list = (appts as any)?._embedded?.appointments || (appts as any)?.content || [];
      } catch (e) {
        console.warn(`[OrphanSweep] Could not verify past appointment for ${pi.id}, deferring:`, e);
        return;
      }
      const match = list.find((a: any) => appointmentNearSlot(a, slot, 5 * 60 * 1000) === true);
      if (!match) {
        await flagForManualReview(
          pi.id,
          "appointment date passed but no matching appointment found in Phorest — verify the deposit was applied at checkout or refund manually"
        );
        return;
      }
      if (!isCancelledAppointment(match)) {
        // Appointment was on the books at its slot — deposit consumed at checkout.
        await clearReviewFlag(pi.id);
        return;
      }
      refundReason = "appointment cancelled in Phorest (past slot, deposit never consumed)";
      verifiedPastCancellation = true;
    }
    if (!verifiedPastCancellation) {
    try {
      const wanted = new Set(
        String(pi.metadata?.serviceIds || "").split(",").filter(Boolean)
      );
      // Phorest limits ranges to ~31 days per query. Scan TWO windows:
      // 1) today → +30 days (catches near-term reschedules), and
      // 2) a window anchored around the booked startDateTime, in case the
      //    booking is further out than 30 days (prevents wrongly treating a
      //    valid far-future booking as cancelled).
      const DAY = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const windows: Array<[number, number]> = [[now, now + 30 * DAY]];
      if (startMs > now + 28 * DAY) {
        windows.push([startMs - 2 * DAY, startMs + 28 * DAY]);
      }
      let list: any[] = [];
      for (const [from, to] of windows) {
        const appts = await phorestApi.listAppointments({
          clientId,
          fromDate: new Date(from).toISOString().slice(0, 10),
          toDate: new Date(to).toISOString().slice(0, 10),
          size: 100,
        });
        list = list.concat(
          (appts as any)?._embedded?.appointments || (appts as any)?.content || []
        );
      }
      // Sanity guard: the booked slot must fall inside a scanned window,
      // otherwise we cannot verify cancellation — defer, never refund.
      const covered = windows.some(([from, to]) => startMs >= from - DAY && startMs <= to + DAY);
      if (!covered) {
        console.warn(`[OrphanSweep] Booked slot for ${pi.id} outside verifiable window, deferring`);
        return;
      }
      const stillBooked = list.some((a: any) => {
        if ((a.activationState || a.state || "").toUpperCase().includes("CANCEL")) return false;
        if (wanted.size === 0) return true; // no service metadata → any active appointment counts
        const apptServiceIds: string[] = Array.isArray(a.services)
          ? a.services.map((s: any) => s.serviceId)
          : a.serviceId ? [a.serviceId] : [];
        // Appointments without service info count as a match (err on NOT refunding)
        return apptServiceIds.length === 0 || apptServiceIds.some((id) => wanted.has(id));
      });
      if (stillBooked) {
        // Appointment active — deposit legitimately consumed; clear any stale flag.
        await clearReviewFlag(pi.id);
        return;
      }
      refundReason = "appointment cancelled in Phorest";
    } catch (e) {
      console.warn(`[OrphanSweep] Could not verify cancellation for ${pi.id}, deferring:`, e);
      if (pi.metadata?.statusUnknown === "1") {
        await flagForManualReview(pi.id, "statusUnknown deposit — Phorest verification keeps failing");
      }
      return;
    }
    } // end future-slot verification
  } else if (clientId && phorestApi.isPhorestConfigured()) {
    // NOT consumed: no booking was ever recorded on this payment. Verify no
    // appointment exists at the paid slot before refunding as an orphan.
    try {
      // Query by the SALON-LOCAL date of the slot (not the UTC date) — near
      // midnight UTC these differ, and querying the wrong day would miss a
      // live appointment and cause a wrongful refund.
      const querySlot = slotToSalonLocal(startDateTime);
      if (!querySlot) return; // unparseable slot — cannot verify, never refund
      const appts = await phorestApi.listAppointments({
        clientId,
        fromDate: querySlot.date,
        toDate: querySlot.date,
        size: 100,
      });
      const list: any[] = (appts as any)?._embedded?.appointments
        || (appts as any)?.content
        || [];
      // Salon-local matching handles Phorest's REAL shape (time-only startTime
      // + appointmentDate) — naive Date() parsing of a time-only string is NaN
      // and would wrongly treat a live appointment as missing.
      const matched = list.some(
        (a: any) => !isCancelledAppointment(a) && appointmentNearSlot(a, querySlot, 5 * 60 * 1000) === true
      );
      if (matched) {
        await clearReviewFlag(pi.id);
        return; // appointment exists — payment is legitimate
      }
    } catch (e) {
      // If we can't verify against Phorest, DO NOT refund — try again next sweep
      console.warn(`[OrphanSweep] Could not verify Phorest appointment for ${pi.id}, deferring:`, e);
      if (pi.metadata?.statusUnknown === "1") {
        await flagForManualReview(pi.id, "statusUnknown deposit — Phorest verification keeps failing");
      }
      return;
    }
  }

  // HARD GATE: auto-refunds are appointmentId-verified ONLY. Legacy deposits
  // without appointmentId metadata reach this point when the heuristic scan
  // says "refund looks safe" — but time/service-window matching is not proof
  // (reschedules, listing gaps). Never move money on a heuristic: flag for
  // manual review and surface it on the admin deposits page instead.
  if (!appointmentId) {
    await flagForManualReview(
      pi.id,
      `legacy deposit without appointmentId metadata — sweep verdict: ${refundReason}; verify in Phorest and refund manually`
    );
    return;
  }

  // Refund confirmed safe: succeeded deposit, no pending booking, and the
  // appointment identified by metadata.appointmentId is cancelled in Phorest.
  if (isDryRun()) {
    console.log(`[OrphanSweep][DRY RUN] Would refund ${pi.id} ($${(pi.amount / 100).toFixed(2)}) — ${refundReason}; client ${clientId}, slot ${startDateTime || "unknown"}. No money moved (REFUND_SWEEP_DRY_RUN=1).`);
    return;
  }
  // Route through the shared refund service: same advisory lock as the
  // finalize safety-nets (no double refund), fresh balance re-check before any
  // money moves, "KOZETA SALON Deposit Refund" label in Stripe metadata,
  // deposit_refunds audit row for the admin history, and a Phorest client note.
  const result = await issueDepositRefund({
    paymentIntentId: pi.id,
    reason: refundReason,
    initiatedBy: "auto-cancellation-sweep",
    preloadedIntent: pi,
  });
  if (!result.ok) {
    if (result.code === "REFUND_IN_FLIGHT") {
      console.log(`[OrphanSweep] Refund for ${pi.id} already in flight elsewhere; skipping`);
    } else if (result.code === "NOTHING_TO_REFUND") {
      await clearReviewFlag(pi.id);
    } else {
      console.error(`[OrphanSweep] Refund failed for ${pi.id}: ${result.code} ${result.message}`);
    }
    return;
  }
  await clearReviewFlag(pi.id);
  console.log(`[OrphanSweep] REFUNDED ${pi.id} ($${((result.amountRefundedCents ?? pi.amount) / 100).toFixed(2)}) — ${refundReason}; client ${clientId}, pending ${pendingId}, slot ${startDateTime || "unknown"}`);
}
