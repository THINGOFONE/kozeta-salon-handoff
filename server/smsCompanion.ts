// SMS AI Companion — handles inbound Twilio messages that are not OTP codes.
// Maintains per-number conversation history in PostgreSQL, calls OpenAI with
// function tools for Phorest data access and booking, and replies via TwiML.

import OpenAI from "openai";
import { randomUUID } from "crypto";
import { db } from "./db";
import { smsConversations } from "@shared/schema";
import { eq } from "drizzle-orm";
import * as phorestApi from "./phorestApi";
import * as authUtils from "./utils/authUtils";
import { pendingBookings, PENDING_EXPIRY_MS, findPendingBookingBySlot } from "./pendingStore";
import { withRefundLock, tryAcquireFinalizeLock, releaseFinalizeLock } from "./paymentLocks";
import {
  getStripeClient,
  getOrCreateStripeCustomer,
  listSavedCards,
  chargeSavedCard,
} from "./stripeClient";
import { torontoDateString, torontoDateAtHour } from "./utils/torontoTime";
import { sendSms } from "./twilioClient";
import { sendBookingConfirmation } from "./smsNotifications";
import { buildDuplicateDepositNote } from "./utils/apptSlotMatch";
import { REFUND_LABELS } from "./refundService";

// ─── Kill switch ────────────────────────────────────────────────────────────
// The SMS AI companion is DISABLED unless SMS_COMPANION_ENABLED=1 is set.
// While disabled: inbound texts get no reply at all; the card-save opt-in SMS
// is not sent. OTP login texts, booking confirmations and appointment
// reminders are unaffected.
export const isSmsCompanionEnabled = () => process.env.SMS_COMPANION_ENABLED === "1";

// Use direct OPENAI_API_KEY when available (Fly.io / production), fall back to
// Replit AI Integrations variables when running on Replit.
const openai = new OpenAI({
  ...(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL }
    : {}),
  apiKey: process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY || "",
});

const DEPOSIT_PERCENT = 20;
// Server-side deposit ceiling — guards against corrupted/misconfigured Phorest
// prices producing an absurd charge. Keep in sync with routes.ts.
const MAX_DEPOSIT_CENTS = 20000;
const MAX_HISTORY = 20;  // rolling window sent to OpenAI
const SALON_PHONE = "(416) 932-3131";
const SALON_NAME = "Kozeta Salon";
const PORTAL_BASE = process.env.PORTAL_BASE_URL || "https://kozetasalon.com";
const BRANCH_ID = process.env.PHOREST_BRANCH_ID || "";

// ─── DB helpers ────────────────────────────────────────────────────────────

interface SmsMessage {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

interface SmsConvRow {
  phone: string;
  clientId: string | null;
  stripeCustomerId: string | null;
  messages: SmsMessage[];
  preferences: { notes?: string[]; pendingSaveCard?: { paymentMethodId: string; clientId: string } };
}

async function loadConversation(phone: string): Promise<SmsConvRow> {
  const rows = await db.select().from(smsConversations).where(eq(smsConversations.phone, phone));
  if (rows[0]) {
    return {
      phone: rows[0].phone,
      clientId: rows[0].clientId ?? null,
      stripeCustomerId: rows[0].stripeCustomerId ?? null,
      messages: (rows[0].messages as SmsMessage[]) ?? [],
      preferences: (rows[0].preferences as { notes?: string[] }) ?? {},
    };
  }
  return { phone, clientId: null, stripeCustomerId: null, messages: [], preferences: {} };
}

async function saveConversation(conv: SmsConvRow): Promise<void> {
  // Persist ALL messages in DB (full history). Only the rolling window is sent to OpenAI.
  await db
    .insert(smsConversations)
    .values({
      phone: conv.phone,
      clientId: conv.clientId,
      stripeCustomerId: conv.stripeCustomerId,
      messages: conv.messages,
      preferences: conv.preferences,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: smsConversations.phone,
      set: {
        clientId: conv.clientId,
        stripeCustomerId: conv.stripeCustomerId,
        messages: conv.messages,
        preferences: conv.preferences,
        updatedAt: new Date(),
      },
    });
}

async function setStripeCustomer(phone: string, customerId: string): Promise<void> {
  await db
    .update(smsConversations)
    .set({ stripeCustomerId: customerId, updatedAt: new Date() })
    .where(eq(smsConversations.phone, phone));
}

// ─── Explicit card-save consent (SMS "Reply SAVE") ─────────────────────────

/** Stores the pending card-save details in the conversation preferences and
 *  sends an opt-in SMS. The actual attach only happens when the client replies "SAVE". */
export async function offerSmsCardSave(phone: string, clientId: string, paymentMethodId: string): Promise<void> {
  if (!isSmsCompanionEnabled()) return; // paused — replies would go unanswered
  // Persist pending-save details in conversation preferences — card attach only happens after "SAVE" reply
  const conv = await loadConversation(phone);
  conv.preferences = { ...conv.preferences, pendingSaveCard: { paymentMethodId, clientId } };
  await saveConversation(conv);

  // Opt-in prompt
  await sendSms(
    phone,
    "Would you like to save your payment method for quick SMS bookings next time? Reply SAVE to save or SKIP to opt out."
  );
}

// ─── Phorest client lookup ─────────────────────────────────────────────────

async function findClientByPhone(phone: string): Promise<phorestApi.PhorestClient | null> {
  try {
    const last10 = phone.replace(/\D/g, "").slice(-10);
    const result = await phorestApi.listClients({ mobile: last10, size: 5 });
    const match = authUtils.findMatchingClients(result.content, phone);
    return match.client ?? null;
  } catch {
    return null;
  }
}

// ─── Service cache lookup ──────────────────────────────────────────────────

interface SimpleCachedService {
  key: string;
  name: string;
  phorestServiceId: string;
  phorestBasePrice?: number;
  staffPrices?: { staffId: string; price: number }[];
  durationMinutes?: number;
  duration: string;
  price: string;
  category: string;
}

async function findServiceByName(query: string): Promise<SimpleCachedService | null> {
  try {
    const serviceCache = await import("./services/serviceCache");
    const services: SimpleCachedService[] = serviceCache.getServices();
    const q = query.toLowerCase();
    // Exact match first
    let found = services.find(s => s.name.toLowerCase() === q);
    // Then partial match
    if (!found) found = services.find(s => s.name.toLowerCase().includes(q));
    // Then word overlap
    if (!found) {
      const words = q.split(/\s+/);
      found = services.find(s => words.some(w => s.name.toLowerCase().includes(w)));
    }
    return found ?? null;
  } catch {
    return null;
  }
}

async function getServicePrice(service: SimpleCachedService, staffId?: string): Promise<number> {
  if (staffId && service.staffPrices) {
    const staffPrice = service.staffPrices.find(sp => sp.staffId === staffId);
    if (staffPrice?.price) return Math.round(staffPrice.price * 100);
  }
  if (service.phorestBasePrice) return Math.round(service.phorestBasePrice * 100);
  return 0;
}

// ─── Booking helpers ───────────────────────────────────────────────────────

async function doBookingHold(params: {
  clientId: string;
  serviceId: string;
  serviceName: string;
  servicePriceCents: number;
  staffIds: string[];
  startDateTime: string;
  endDateTime: string;
  phone: string;
}): Promise<{ pendingId: string; paymentUrl: string; depositCents: number }> {
  const { clientId, serviceId, serviceName, servicePriceCents, staffIds, startDateTime, endDateTime, phone } = params;
  const depositCents = Math.round(servicePriceCents * DEPOSIT_PERCENT / 100);
  if (depositCents > MAX_DEPOSIT_CENTS) {
    console.error(`[SMS Companion] Deposit $${(depositCents / 100).toFixed(2)} exceeds ceiling for ${serviceName} — refusing`);
    throw new Error(`The deposit for ${serviceName} looks incorrect. Please call ${SALON_PHONE} to book this service.`);
  }

  // Cross-channel slot lock — shared namespace with doSavedCardCharge so a
  // payment-link hold and a saved-card charge can never run concurrently for
  // the same client + service + slot.
  const lockKey = slotLockKey(clientId, serviceId, startDateTime);
  if (!await tryAcquireFinalizeLock(lockKey)) {
    throw new Error("A payment is already in progress for this booking. Please wait a moment.");
  }
  try {
    // If a live payment link already exists for this exact slot, reuse it
    // instead of creating a second hold + second PaymentIntent.
    const existing = await findPendingBookingBySlot(clientId, serviceId, startDateTime);
    if (existing) {
      if (existing.booking.smsToken) {
        return {
          pendingId: existing.pendingId,
          paymentUrl: `${PORTAL_BASE}/?smsPid=${existing.pendingId}&t=${existing.booking.smsToken}`,
          depositCents: existing.booking.depositAmount,
        };
      }
      // Token already consumed (checkout page opened) but pending still live —
      // do NOT mint a second hold/PaymentIntent; that would allow a double charge
      // if the original checkout tab is completed too.
      throw new Error("A payment is already in progress for this booking. Please finish the checkout page you opened, or wait 15 minutes and try again.");
    }

    // Create RESERVED booking in Phorest. If the client already has another
    // active appointment near this slot (e.g. booking for family), attach a
    // heads-up note — both deposits auto-apply at their own checkouts.
    const dupNote = await buildDuplicateDepositNote(clientId, startDateTime);
    const booking = await phorestApi.createBooking({
      clientId,
      serviceIds: [serviceId],
      staffIds,
      startDateTime,
      endDateTime,
      bookingStatus: "RESERVED",
      ...(dupNote ? { note: dupNote } : {}),
    });

    // Create PaymentIntent
    const stripe = await getStripeClient();
    const pendingId = randomUUID();
    const idempotencyKey = `sms-deposit-${pendingId}`;

    const pi = await stripe.paymentIntents.create(
      {
        amount: depositCents,
        currency: "cad",
        metadata: {
          pendingId,
          clientId,
          type: "booking_deposit",
          expectedAmount: String(depositCents),
          phorestBookingId: booking.phorestBookingId ?? "",
          // Real Phorest APPOINTMENT id — the cancellation watcher matches on
          // this id (never by time) to auto-refund staff-cancelled deposits.
          appointmentId: booking.appointmentId ?? "",
          // Orphan-sweep metadata: without startDateTime the sweep cannot
          // safely auto-refund a stranded deposit and flags it for manual review.
          startDateTime,
          serviceIds: serviceId,
          branchId: BRANCH_ID,
          channel: "sms",
          chargeLabel: REFUND_LABELS.depositCharge,
        },
        statement_descriptor_suffix: "Deposit",
      },
      { idempotencyKey }
    );

    // Generate one-time token for no-login payment link (20-min TTL via PENDING_EXPIRY_MS)
    const smsToken = randomUUID();

    // Persist pending booking (same pattern as web flow)
    await pendingBookings.set(pendingId, {
      serviceIds: [serviceId],
      staffIds,
      startDateTime,
      endDateTime,
      branchId: BRANCH_ID,
      clientId,
      sessionId: `sms:${phone}`,
      serviceName,
      servicePrice: servicePriceCents,
      depositAmount: depositCents,
      loyaltyPointsRedeemed: 0,
      loyaltyDiscountCents: 0,
      paymentIntentId: pi.id,
      createdAt: Date.now(),
      smsToken,
    });

    const paymentUrl = `${PORTAL_BASE}/?smsPid=${pendingId}&t=${smsToken}`;
    return { pendingId, paymentUrl, depositCents };
  } finally {
    await releaseFinalizeLock(lockKey).catch(() => {});
  }
}

/**
 * Staff-qualification guard: prevents booking a stylist for a service they
 * don't perform (Phorest disqualifiedStaff). Returns an error message for the
 * AI to relay, or null if OK.
 */
async function checkStaffQualified(staffId: string | undefined, serviceId: string, serviceName: string): Promise<string | null> {
  if (!staffId) return null;
  try {
    const staffSync = await import("./services/staffServiceSync");
    if (!staffSync.isCacheReady()) return null; // don't block on cold cache; Phorest will still validate
    const staff = staffSync.getStaff(staffId);
    if (!staff) return `That stylist isn't available in our booking system. Ask me who's available for ${serviceName}.`;
    const qualified = staffSync.getQualifiedStaffForService(serviceId);
    if (qualified.length > 0 && !qualified.includes(staffId)) {
      const name = [staff.firstName, staff.lastName].filter(Boolean).join(" ");
      return `${name} doesn't offer ${serviceName}. Ask me which stylists are available for it.`;
    }
  } catch {}
  return null;
}

/** Deterministic cross-channel lock key for a client+service+slot combination. */
function slotLockKey(clientId: string, serviceId: string, startDateTime: string): string {
  const hash = Buffer.from(`${clientId}:${serviceId}:${startDateTime}`).toString("base64").slice(0, 20).replace(/[/+=]/g, "_");
  return `slot:${hash}`;
}

async function doSavedCardCharge(params: {
  clientId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  serviceId: string;
  serviceName: string;
  servicePriceCents: number;
  staffIds: string[];
  startDateTime: string;
  endDateTime: string;
  staffName?: string;
  clientPhone: string;
  clientEmail?: string;
  clientFirstName?: string;
}): Promise<{ success: boolean; error?: string }> {
  const { clientId, stripeCustomerId, paymentMethodId, serviceId, serviceName,
    servicePriceCents, staffIds, startDateTime, endDateTime,
    staffName, clientPhone, clientEmail, clientFirstName } = params;

  const depositCents = Math.round(servicePriceCents * DEPOSIT_PERCENT / 100);
  if (depositCents > MAX_DEPOSIT_CENTS) {
    console.error(`[SMS Companion] Deposit $${(depositCents / 100).toFixed(2)} exceeds ceiling for ${serviceName} — refusing`);
    return { success: false, error: `The deposit for ${serviceName} looks incorrect. Please call ${SALON_PHONE} to book this service.` };
  }

  // Deterministic idempotency key — deduplicates retries for the SAME slot.
  // If the client texts YES twice for the same booking, Stripe returns the same PI.
  const stableSlotKey = `${clientId}:${serviceId}:${startDateTime}`;
  const stableKeyHash = Buffer.from(stableSlotKey).toString("base64").slice(0, 20).replace(/[/+=]/g, "_");
  const idempotencyKey = `sms-saved-${stableKeyHash}`;
  // Shared cross-channel lock namespace (same as doBookingHold) — a payment-link
  // hold and a saved-card charge can never run concurrently for the same slot.
  const lockKey = slotLockKey(clientId, serviceId, startDateTime);
  const pendingId = randomUUID(); // used only for PI metadata / audit trail

  let lockedKey: string | null = null;
  try {
    // Deterministic lock — prevents concurrent charges for the same slot
    if (!await tryAcquireFinalizeLock(lockKey)) {
      return { success: false, error: "Payment already in progress for this booking" };
    }
    lockedKey = lockKey;

    // Cross-channel double-charge guard: if a payment link is already open for
    // this exact slot, refuse the saved-card charge — the client may pay the
    // link at the same time, which would double-charge them.
    const existingPending = await findPendingBookingBySlot(clientId, serviceId, startDateTime);
    if (existingPending) {
      return {
        success: false,
        error: "A payment link is already open for this booking. Please pay through that link, or wait 15 minutes for it to expire.",
      };
    }

    // Create RESERVED booking first (no money yet). Attach a heads-up note if
    // the client already has another active appointment near this slot.
    const dupNote = await buildDuplicateDepositNote(clientId, startDateTime);
    const booking = await phorestApi.createBooking({
      clientId,
      serviceIds: [serviceId],
      staffIds,
      startDateTime,
      endDateTime,
      bookingStatus: "RESERVED",
      ...(dupNote ? { note: dupNote } : {}),
    });

    // Charge the saved card
    const pi = await chargeSavedCard(
      stripeCustomerId,
      paymentMethodId,
      depositCents,
      "cad",
      idempotencyKey,
      {
        pendingId,
        clientId,
        type: "booking_deposit",
        expectedAmount: String(depositCents),
        // NOTE: phorestBookingId is intentionally NOT set at creation. Like the
        // web flow, the PI is only tagged as "consumed" AFTER activation
        // succeeds — otherwise a failed activation would leave a PI that looks
        // consumed and the orphan sweep would never auto-refund it.
        // Orphan-sweep metadata — required for safe auto-refund verification
        startDateTime,
        serviceIds: serviceId,
        branchId: BRANCH_ID,
        channel: "sms",
        chargeLabel: REFUND_LABELS.depositCharge,
      },
      { statement_descriptor_suffix: "Deposit" }
    );

    if (pi.status !== "succeeded") {
      // Card declined — cancel the reserved booking (cancel takes the
      // APPOINTMENT id, not the booking id)
      if (booking.appointmentId || booking.phorestBookingId) {
        await phorestApi.cancelAppointment(booking.appointmentId ?? booking.phorestBookingId!, BRANCH_ID).catch(() => {});
      }
      return { success: false, error: "Payment did not succeed" };
    }

    // Activate the booking — mirrors the web finalize flow:
    // - unverifiable failure (timeout / 5xx): activation may have succeeded on
    //   Phorest's side, so do NOT refund; tag statusUnknown + phorestBookingId
    //   and let the orphan sweep verify against Phorest.
    // - definite failure (4xx / missing booking id): refund immediately; if the
    //   refund itself fails, tag statusUnknown so the deposit is never lost.
    try {
      if (!booking.phorestBookingId) {
        throw new Error("Missing Phorest booking id for activation");
      }
      await phorestApi.activateBooking(BRANCH_ID, booking.phorestBookingId, depositCents);
    } catch (activateErr) {
      console.error("[SMS Companion] Booking activation failed after charge:", activateErr);
      const stripe = await getStripeClient();
      const isDefiniteFailure = !booking.phorestBookingId
        || phorestApi.classifyPhorestError(activateErr).isDefiniteFailure;

      if (!isDefiniteFailure) {
        // Activation outcome unknown — never refund blindly. Tag for the sweep.
        await stripe.paymentIntents.update(pi.id, {
          metadata: {
            phorestBookingId: booking.phorestBookingId ?? "",
            appointmentId: booking.appointmentId ?? "",
            appointmentStart: startDateTime,
            statusUnknown: "1",
          },
        }).catch(metaErr => console.warn("[SMS Companion] Could not tag PI statusUnknown:", metaErr));
        console.warn(`[SMS Companion] Unverifiable activation failure for PI ${pi.id} — deferring refund decision to orphan sweep`);
        return {
          success: false,
          error: `We could not confirm your booking right now. Do NOT pay again — if the booking did not go through, your deposit will be refunded automatically within 30 minutes. You can also call ${SALON_PHONE} to confirm.`,
        };
      }

      // Definite failure — cancel the reserved hold and refund.
      if (booking.appointmentId || booking.phorestBookingId) {
        await phorestApi.cancelAppointment(booking.appointmentId ?? booking.phorestBookingId!, BRANCH_ID).catch(() => {});
      }
      let refundOk = false;
      try {
        const refundOutcome = await withRefundLock(pi.id, () =>
          stripe.refunds.create(
            { payment_intent: pi.id, reason: "requested_by_customer" },
            { idempotencyKey: `refund-${pi.id}` }
          )
        );
        refundOk = refundOutcome.ran && !refundOutcome.error;
        if (refundOutcome.error) {
          console.error("[SMS Companion] Compensating refund failed:", refundOutcome.error);
        }
      } catch (refundErr) {
        console.error("[SMS Companion] Compensating refund also failed:", refundErr);
      }
      if (!refundOk) {
        // Refund failed — tag the PI so the orphan sweep / manual review never loses it.
        await stripe.paymentIntents.update(pi.id, {
          metadata: { appointmentStart: startDateTime, statusUnknown: "1" },
        }).catch(metaErr => console.warn("[SMS Companion] Could not tag PI after refund failure:", metaErr));
        return {
          success: false,
          error: `Your booking could not be confirmed and we could not process the refund automatically. Do NOT pay again — please call ${SALON_PHONE} and we will sort it out immediately.`,
        };
      }
      return { success: false, error: "Booking could not be confirmed — deposit refunded" };
    }

    // Tag payment with booking ID AFTER successful activation — marks the
    // deposit as consumed so the orphan sweep never auto-refunds it.
    const stripe = await getStripeClient();
    await stripe.paymentIntents
      .update(pi.id, {
        metadata: {
          phorestBookingId: booking.phorestBookingId ?? "",
          appointmentId: booking.appointmentId ?? "",
          appointmentStart: startDateTime,
        },
      })
      .catch(() => {});

    // Send confirmation
    await sendBookingConfirmation({
      clientPhone,
      clientEmail,
      clientFirstName,
      serviceName,
      staffName,
      startDateTime,
      depositPaidCents: depositCents,
      remainingBalanceCents: Math.max(0, servicePriceCents - depositCents),
    });

    return { success: true };
  } catch (err) {
    console.error("[SMS Companion] Saved card charge failed:", err);
    return { success: false, error: err instanceof Error ? err.message : "Payment failed" };
  } finally {
    if (lockedKey) await releaseFinalizeLock(lockedKey).catch(() => {});
  }
}

// ─── OpenAI tools ─────────────────────────────────────────────────────────

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_upcoming_appointments",
      description: "Fetch the client's upcoming appointments from Phorest",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_service_history",
      description: "Fetch the client's past service/appointment history from Phorest (up to 2 years back)",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max results, default 10" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_purchase_history",
      description: "Fetch the client's product purchase history from Phorest",
      parameters: {
        type: "object",
        properties: { limit: { type: "number", description: "Max results, default 5" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_loyalty_points",
      description: "Get the client's current loyalty points balance",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Check available appointment slots for a service",
      parameters: {
        type: "object",
        properties: {
          service_name: { type: "string", description: "Name or partial name of the service" },
          date: { type: "string", description: "Preferred date in YYYY-MM-DD format" },
          staff_id: { type: "string", description: "Optional: specific stylist staffId" },
        },
        required: ["service_name", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_booking_hold",
      description: "Create a RESERVED booking in Phorest and return a payment link for the deposit",
      parameters: {
        type: "object",
        properties: {
          service_name: { type: "string" },
          start_date_time: { type: "string", description: "ISO 8601 format e.g. 2026-08-01T14:00:00" },
          staff_id: { type: "string", description: "Stylist staffId, optional" },
        },
        required: ["service_name", "start_date_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "charge_saved_card",
      description: "Charge the client's saved card on file for a booking deposit (only if they confirmed YES)",
      parameters: {
        type: "object",
        properties: {
          service_name: { type: "string" },
          start_date_time: { type: "string" },
          staff_id: { type: "string" },
        },
        required: ["service_name", "start_date_time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_client_note",
      description: "Save a preference or note to the client's Phorest profile (e.g. 'go lighter next time')",
      parameters: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "identify_client",
      description: "Look up a client in Phorest by name (and optional email). Use this when the caller's phone is not recognised — ask for their first and last name, then call this tool.",
      parameters: {
        type: "object",
        properties: {
          first_name: { type: "string", description: "Client's first name" },
          last_name: { type: "string", description: "Client's last name (optional but helpful)" },
          email: { type: "string", description: "Client's email (optional, to narrow down)" },
        },
        required: ["first_name"],
      },
    },
  },
];

// ─── System prompt ─────────────────────────────────────────────────────────

function buildSystemPrompt(client: phorestApi.PhorestClient | null, savedCard: { brand: string; last4: string } | null): string {
  const now = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const clientInfo = client
    ? `Client: ${client.firstName} ${client.lastName} (ID: ${client.clientId})`
    : "Client: Not yet identified. Ask for their first and last name, then call identify_client.";

  const savedCardInfo = savedCard
    ? `Card on file: ${savedCard.brand} ••••${savedCard.last4}. With explicit YES, charge directly via charge_saved_card.`
    : "No saved card. Bookings require a payment link (create_booking_hold).";

  return `You are Kozeta, the AI for ${SALON_NAME} — a luxury Toronto salon.
Today: ${now}.
${clientInfo}
${savedCardInfo}

STYLE: SMS replies only. Maximum 4 lines. No greetings, no sign-offs, no filler. Lead with the answer. Use line breaks for lists.

RULES:
- Salon topics only: bookings, services, pricing, hair care, products, client history.
- Off-topic: "I can only help with Kozeta Salon. Call ${SALON_PHONE} for anything else."
- Unknown client: ask for first + last name, call identify_client. One question per reply.
- Never invent availability — always call check_availability first.
- Before booking: confirm service, date, time, stylist in ONE message. Then book.
- Before charge_saved_card: state the card (brand + last 4) and deposit amount, then ask "Reply YES to confirm." Call it only after a clear YES.
- Urgent/complex: "Call us at ${SALON_PHONE}."`;
}

// ─── Tool execution ────────────────────────────────────────────────────────

async function executeTool(
  name: string,
  args: Record<string, any>,
  context: {
    client: phorestApi.PhorestClient | null;
    conv: SmsConvRow;
    savedCard: { paymentMethodId: string; brand: string; last4: string } | null;
  }
): Promise<{ result: string; sideEffect?: { type: "booking_url"; url: string; depositCents: number } | { type: "booking_confirmed" } }> {
  const { client, conv, savedCard } = context;

  // identify_client may run even when the client is not yet known
  if (name === "identify_client") {
    try {
      const firstName = (args.first_name as string ?? "").trim();
      const lastName = (args.last_name as string ?? "").trim();
      const email = (args.email as string ?? "").trim();

      const query: Record<string, string | number> = { size: 10 };
      if (firstName) query.firstName = firstName;
      if (lastName) query.lastName = lastName;
      if (email) query.email = email;

      const result = await phorestApi.listClients(query);
      const matches = result.content.filter(c =>
        c.firstName?.toLowerCase() === firstName.toLowerCase()
      );

      if (matches.length === 1) {
        conv.clientId = matches[0].clientId;
        await saveConversation(conv);
        return { result: `Found you! Welcome, ${matches[0].firstName}${matches[0].lastName ? ' ' + matches[0].lastName : ''}. Your profile is now linked — how can I help you today?` };
      } else if (matches.length > 1) {
        const emails = matches.filter(m => m.email).map(m => m.email);
        if (email && emails.length) {
          const exact = matches.find(m => m.email?.toLowerCase() === email.toLowerCase());
          if (exact) {
            conv.clientId = exact.clientId;
            await saveConversation(conv);
            return { result: `Found you! Welcome back, ${exact.firstName}. Your profile is now linked.` };
          }
        }
        return { result: `I found ${matches.length} clients with that name. Could you provide your email to narrow it down?` };
      } else {
        // No match found — create a guest profile in Phorest so the caller can proceed
        try {
          const last10 = conv.phone.replace(/\D/g, "").slice(-10);
          const newClient = await phorestApi.createClient({
            firstName,
            lastName: lastName || "",
            mobile: last10,
          });
          conv.clientId = newClient.clientId;
          await saveConversation(conv);
          return { result: `Welcome, ${firstName}! I've created a profile for you so we can get started. How can I help you today?` };
        } catch (createErr) {
          console.error("[SMS Companion] Guest client creation failed:", createErr);
          return { result: `I couldn't find a profile for ${firstName}${lastName ? ' ' + lastName : ''} in our system. You can create an account at ${PORTAL_BASE} or call us at ${SALON_PHONE} to book your first visit.` };
        }
      }
    } catch (err) {
      console.error("[SMS Companion] identify_client failed:", err);
      return { result: `I couldn't search our records right now. Please call us at ${SALON_PHONE}.` };
    }
  }

  if (!client) {
    return { result: "I don't have your profile on file yet. Could I get your first and last name so I can look you up?" };
  }

  try {
    switch (name) {
      case "get_upcoming_appointments": {
        const today = torontoDateString(new Date());
        // Look 2 years ahead to catch any far-future bookings
        const future = torontoDateString(new Date(Date.now() + 730 * 24 * 60 * 60 * 1000));
        const appts = await phorestApi.listAppointments({
          clientId: client.clientId,
          fromDate: today,
          toDate: future,
          size: 10,
        });
        if (!appts.content.length) return { result: "No upcoming appointments." };
        const lines = appts.content.map(a => {
          const svc = a.services?.[0]?.serviceName ?? "Appointment";
          const dt = new Date(a.startTime);
          const date = dt.toLocaleDateString("en-CA", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric" });
          const time = dt.toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true });
          return `${date} at ${time} — ${svc}${a.staffName ? ` with ${a.staffName}` : ""}`;
        });
        return { result: lines.join("\n") };
      }

      case "get_service_history": {
        // Fetch up to 2 years of history with a generous page size
        const limit = Math.min(Number(args.limit) || 10, 30);
        const history = await phorestApi.getClientServiceHistories(client.clientId, { size: limit });
        if (!history.content.length) return { result: "No service history found." };
        const lines = history.content.map(h => {
          const date = new Date(h.date).toLocaleDateString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", year: "numeric" });
          return `${h.serviceName} — ${date}${h.staffName ? ` · ${h.staffName}` : ""}`;
        });
        return { result: lines.join("\n") };
      }

      case "get_purchase_history": {
        const limit = Math.min(Number(args.limit) || 5, 20);
        const purchases = await phorestApi.getClientPurchaseHistory(client.clientId, { size: limit });
        if (!purchases.content.length) return { result: "No product purchases on record." };
        const lines = purchases.content.map(p => {
          const date = new Date(p.date).toLocaleDateString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", year: "numeric" });
          const items = p.items.map(i => i.productName).filter(Boolean).join(", ");
          return `${date}: ${items || "Product"} — $${p.total.toFixed(2)}`;
        });
        return { result: lines.join("\n") };
      }

      case "get_loyalty_points": {
        const loyalty = await phorestApi.getClientLoyalty(client.clientId);
        const pts = loyalty.points ?? 0;
        const toReward = 300; // Phorest doesn't expose pointsToNextReward in this API version
        return { result: `${pts} loyalty points. ${pts >= toReward ? "Eligible for a reward!" : `${toReward - pts} more points to next reward.`}` };
      }

      case "check_availability": {
        const svc = await findServiceByName(args.service_name);
        if (!svc) return { result: `Service "${args.service_name}" not found. Please check the service name.` };

        const date = args.date as string; // YYYY-MM-DD
        const startOfDay = torontoDateAtHour(date, 9).toISOString();
        const endOfDay = torontoDateAtHour(date, 20).toISOString();

        const staffId = args.staff_id as string | undefined;
        const avail = await phorestApi.checkAppointmentAvailability({
          startTime: startOfDay,
          endTime: endOfDay,
          clientServiceSelections: [{
            clientId: client.clientId,
            serviceSelections: [{ serviceId: svc.phorestServiceId, staffId }],
          }],
          isOnlineAvailability: true,
        });

        const slots = avail.data?.slice(0, 4) ?? [];
        if (!slots.length) return { result: `No availability found for ${svc.name} on ${args.date}.` };

        const lines = slots.map((slot, i) => {
          const dt = new Date(slot.startTime);
          const time = dt.toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true });
          const staffName = slot.clientSchedules?.[0]?.serviceSchedules?.[0]?.staffId ?? "";
          return `${i + 1}. ${time}${staffName ? ` · ${staffName}` : ""}`;
        });
        return { result: `Available for ${svc.name} on ${date}:\n${lines.join("\n")}` };
      }

      case "create_booking_hold": {
        const svc = await findServiceByName(args.service_name);
        if (!svc) return { result: `Service "${args.service_name}" not found.` };

        const staffIds = args.staff_id ? [args.staff_id as string] : [];
        const qualError = await checkStaffQualified(staffIds[0], svc.phorestServiceId, svc.name);
        if (qualError) return { result: qualError };
        const startDateTime = args.start_date_time as string;
        const durationMs = (svc.durationMinutes ?? 60) * 60 * 1000;
        const endDateTime = new Date(new Date(startDateTime).getTime() + durationMs).toISOString();
        const priceCents = await getServicePrice(svc, staffIds[0]);

        const { paymentUrl, depositCents } = await doBookingHold({
          clientId: client.clientId,
          serviceId: svc.phorestServiceId,
          serviceName: svc.name,
          servicePriceCents: priceCents,
          staffIds,
          startDateTime,
          endDateTime,
          phone: conv.phone,
        });

        const depositFmt = `$${(depositCents / 100).toFixed(2)}`;
        return {
          result: `Booking hold created. Deposit: ${depositFmt}. Payment URL: ${paymentUrl}`,
          sideEffect: { type: "booking_url", url: paymentUrl, depositCents },
        };
      }

      case "charge_saved_card": {
        if (!savedCard || !conv.stripeCustomerId) {
          return { result: "No saved card found. Please use the payment link instead." };
        }

        // Hard server-side gate: most recent user message must contain explicit YES
        const recentUserMsg = [...conv.messages].reverse().find(m => m.role === "user")?.content ?? "";
        const hasExplicitYes = /\byes\b|\byep\b|\bsure\b|\bconfirm\b|\bgo\s+ahead\b|\bdo\s+it\b|\bok\s*,?\s*charge\b/i.test(recentUserMsg);
        if (!hasExplicitYes) {
          return { result: `Please reply YES to confirm you'd like to charge your ${savedCard.brand} card ending in ${savedCard.last4}.` };
        }
        const svc = await findServiceByName(args.service_name);
        if (!svc) return { result: `Service "${args.service_name}" not found.` };

        const staffIds = args.staff_id ? [args.staff_id as string] : [];
        const qualError = await checkStaffQualified(staffIds[0], svc.phorestServiceId, svc.name);
        if (qualError) return { result: qualError };
        const startDateTime = args.start_date_time as string;
        const durationMs = (svc.durationMinutes ?? 60) * 60 * 1000;
        const endDateTime = new Date(new Date(startDateTime).getTime() + durationMs).toISOString();
        const priceCents = await getServicePrice(svc, staffIds[0]);

        // Look up stylist name from staff cache
        let staffName: string | undefined;
        try {
          if (staffIds[0]) {
            const staffSync = await import("./services/staffServiceSync");
            const s = staffSync.getStaff(staffIds[0]);
            if (s) staffName = [s.firstName, s.lastName].filter(Boolean).join(" ");
          }
        } catch {}

        const outcome = await doSavedCardCharge({
          clientId: client.clientId,
          stripeCustomerId: conv.stripeCustomerId,
          paymentMethodId: savedCard.paymentMethodId,
          serviceId: svc.phorestServiceId,
          serviceName: svc.name,
          servicePriceCents: priceCents,
          staffIds,
          startDateTime,
          endDateTime,
          staffName,
          clientPhone: conv.phone,
          clientEmail: client.email,
          clientFirstName: client.firstName,
        });

        if (outcome.success) {
          return { result: "Payment successful. Booking confirmed.", sideEffect: { type: "booking_confirmed" } };
        }
        return { result: `Payment failed: ${outcome.error}. Please call us at ${SALON_PHONE}.` };
      }

      case "save_client_note": {
        const note = args.note as string;
        const existing = client.notes ?? "";
        const date = torontoDateString(new Date());
        const updated = existing ? `${existing}\n[${date}] ${note}` : `[${date}] ${note}`;
        await phorestApi.updateClient(client.clientId, { notes: updated });
        return { result: "Note saved to your profile." };
      }

      default:
        return { result: "Unknown tool." };
    }
  } catch (err) {
    console.error(`[SMS Companion] Tool ${name} failed:`, err);
    return { result: `I couldn't retrieve that information right now. Please call us at ${SALON_PHONE}.` };
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────

export async function handleSmsMessage(from: string, body: string): Promise<string> {
  const phone = authUtils.normalizePhoneForSearch(from);
  const userMessage = body.trim();

  // Load conversation history
  const conv = await loadConversation(phone);

  // ── SAVE / SKIP keyword: explicit card-save consent gate ──────────────────
  const keyword = userMessage.toUpperCase().trim();
  if (keyword === "SAVE" || keyword === "SKIP") {
    const pending = (conv.preferences as any).pendingSaveCard as { paymentMethodId: string; clientId: string } | undefined;
    if (pending) {
      // Clear the pending save regardless of choice
      conv.preferences = { ...conv.preferences, pendingSaveCard: undefined };

      if (keyword === "SAVE") {
        try {
          const stripe = await getStripeClient();
          const pClient = await phorestApi.getClient(pending.clientId).catch(() => null);
          const name = pClient ? [pClient.firstName, pClient.lastName].filter(Boolean).join(" ") : "";
          const customerId = await getOrCreateStripeCustomer(pending.clientId, name, pClient?.email);
          await stripe.paymentMethods.attach(pending.paymentMethodId, { customer: customerId });
          conv.stripeCustomerId = customerId;
          await saveConversation(conv);
          return "Your card has been saved! Reply YES the next time you want to book and we'll charge it directly. Reply STOP to opt out anytime.";
        } catch (err) {
          await saveConversation(conv);
          console.error("[SMS Companion] Card save after SAVE reply failed:", err);
          return `Sorry, we couldn't save your card right now. Please call us at ${SALON_PHONE} if you'd like to set this up.`;
        }
      } else {
        // SKIP — clear and acknowledge
        await saveConversation(conv);
        return "No problem! You can always pay via a payment link next time. Is there anything else I can help you with?";
      }
    }
    // No pending save — fall through to normal AI handling (user just typed "SAVE"/"SKIP" for another reason)
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Identify client if not yet known
  let client: phorestApi.PhorestClient | null = null;
  if (conv.clientId) {
    client = await phorestApi.getClient(conv.clientId).catch(() => null);
  }
  if (!client) {
    client = await findClientByPhone(phone);
    if (client) {
      conv.clientId = client.clientId;
    }
  }

  // Check for saved card
  let savedCard: { paymentMethodId: string; brand: string; last4: string } | null = null;
  if (conv.stripeCustomerId) {
    const cards = await listSavedCards(conv.stripeCustomerId).catch(() => []);
    savedCard = cards[0] ?? null;
  }

  // Append user message
  conv.messages.push({ role: "user", content: userMessage, ts: Date.now() });

  // Build OpenAI message array (rolling window)
  const windowMessages = conv.messages.slice(-MAX_HISTORY);
  const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(client, savedCard) },
    ...windowMessages.map(m => ({ role: m.role, content: m.content }) as OpenAI.Chat.ChatCompletionMessageParam),
  ];

  let finalReply = `I'm having trouble right now. Please call us at ${SALON_PHONE}.`;
  let bookingUrl: string | null = null;

  try {
    // Agentic loop: allow up to 5 tool calls
    let loopMessages = [...openaiMessages];
    for (let iteration = 0; iteration < 5; iteration++) {
      // Always pass tools so identify_client is available for unknown clients
      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: loopMessages,
        tools,
        tool_choice: "auto",
        max_tokens: 400,
        temperature: 0.7,
      });

      const msg = response.choices[0]?.message;
      if (!msg) break;

      // No tool calls → we have the final reply
      if (!msg.tool_calls?.length) {
        finalReply = msg.content ?? finalReply;
        break;
      }

      // Execute tool calls
      loopMessages.push(msg as any);
      for (const tc of msg.tool_calls as any[]) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.function.arguments); } catch {}

        const { result, sideEffect } = await executeTool(tc.function.name, args, { client, conv, savedCard });

        if (sideEffect?.type === "booking_url") {
          bookingUrl = sideEffect.url;
        }
        if (sideEffect?.type === "booking_confirmed") {
          // Confirmation sent via sendBookingConfirmation — reply will be crafted by AI
        }

        loopMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        } as any);
      }
    }
  } catch (err) {
    console.error("[SMS Companion] OpenAI call failed:", err);
  }

  // Append assistant reply to history
  conv.messages.push({ role: "assistant", content: finalReply, ts: Date.now() });
  await saveConversation(conv).catch(err => console.error("[SMS Companion] Save history failed:", err));

  // If there's a booking URL to attach, append it to the reply (AI already mentions it but we ensure the link appears)
  if (bookingUrl && !finalReply.includes(bookingUrl)) {
    finalReply = finalReply.trimEnd() + `\n${bookingUrl}`;
  }

  // Twilio SMS has a 1600-character limit — truncate gracefully
  return finalReply.length > 1550
    ? finalReply.slice(0, 1520) + `\n\nCall us at ${SALON_PHONE} for more.`
    : finalReply;
}

// Exported for in-app history merge
export async function getSmsHistory(phone: string): Promise<SmsMessage[]> {
  const conv = await loadConversation(phone);
  return conv.messages;
}
