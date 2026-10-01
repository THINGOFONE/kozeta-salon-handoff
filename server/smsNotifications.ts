// Booking confirmations (SMS + email) and 2-day appointment reminders.
// All message tone: short, warm, structured — no filler.

import { sendSms } from "./twilioClient";
import { sendEmail } from "./emailClient";
import * as phorestApi from "./phorestApi";
import * as authUtils from "./utils/authUtils";
import { db } from "./db";
import { smsRemindersSent } from "@shared/schema";
import { eq } from "drizzle-orm";
import { torontoDateString, torontoDateAtHour } from "./utils/torontoTime";
import { createHash } from "crypto";

const SALON_NAME = "Kozeta Salon";
const SALON_PHONE = "(416) 932-3131";
const SALON_ADDRESS = "Kozeta Salon & Spa, Toronto, ON";

// ─── Formatting helpers ────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-CA", {
      timeZone: "America/Toronto",
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-CA", {
      timeZone: "America/Toronto",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ─── Booking confirmation ──────────────────────────────────────────────────

export interface BookingConfirmationOpts {
  clientPhone?: string;
  clientEmail?: string;
  clientFirstName?: string;
  serviceName: string;
  staffName?: string;
  startDateTime: string;
  depositPaidCents: number;
  remainingBalanceCents: number;
}

export async function sendBookingConfirmation(opts: BookingConfirmationOpts): Promise<void> {
  const {
    clientPhone,
    clientEmail,
    clientFirstName,
    serviceName,
    staffName,
    startDateTime,
    depositPaidCents,
    remainingBalanceCents,
  } = opts;

  const greeting = clientFirstName ? `Hi ${clientFirstName}!` : "Your appointment is confirmed!";
  const stylistLine = staffName ? `${serviceName} · ${staffName}` : serviceName;
  const dateLine = `${fmtDate(startDateTime)} at ${fmtTime(startDateTime)}`;
  const depositLine = `Deposit paid: ${fmtMoney(depositPaidCents)} · Balance: ~${fmtMoney(remainingBalanceCents)} at salon`;

  const smsBody =
    `${greeting} Your appointment is confirmed:\n\n` +
    `${stylistLine}\n` +
    `${dateLine}\n` +
    `${depositLine}\n\n` +
    `See you then! — ${SALON_NAME}`;

  if (clientPhone) {
    await sendSms(clientPhone, smsBody).catch(err =>
      console.error("[Notifications] SMS confirmation failed:", err)
    );
  }

  if (clientEmail) {
    const subject = `Your appointment at ${SALON_NAME} — ${serviceName} on ${fmtDate(startDateTime)}`;
    const html = `
<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#2a2a2a">
  <p style="font-size:18px;font-weight:bold;margin-bottom:4px">${SALON_NAME}</p>
  <hr style="border:none;border-top:1px solid #e0d9d0;margin:16px 0"/>
  <p style="font-size:16px;margin-bottom:20px">${greeting} Your appointment is confirmed.</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:6px 0;color:#7a6f65">Service</td><td style="padding:6px 0">${stylistLine}</td></tr>
    <tr><td style="padding:6px 0;color:#7a6f65">Date &amp; Time</td><td style="padding:6px 0">${dateLine}</td></tr>
    <tr><td style="padding:6px 0;color:#7a6f65">Deposit Paid</td><td style="padding:6px 0">${fmtMoney(depositPaidCents)}</td></tr>
    <tr><td style="padding:6px 0;color:#7a6f65">Balance at Salon</td><td style="padding:6px 0">~${fmtMoney(remainingBalanceCents)}</td></tr>
  </table>
  <hr style="border:none;border-top:1px solid #e0d9d0;margin:24px 0"/>
  <p style="font-size:13px;color:#7a6f65">${SALON_ADDRESS}</p>
  <p style="font-size:13px;color:#7a6f65">To make changes, text or call us at ${SALON_PHONE}.</p>
</div>`;

    const text =
      `${greeting}\n\nAppointment confirmed:\n${stylistLine}\n${dateLine}\n` +
      `Deposit paid: ${fmtMoney(depositPaidCents)}\nBalance at salon: ~${fmtMoney(remainingBalanceCents)}\n\n` +
      `${SALON_ADDRESS}\nCall or text: ${SALON_PHONE}`;

    await sendEmail({ to: clientEmail, subject, html, text }).catch(err =>
      console.error("[Notifications] Email confirmation failed:", err)
    );
  }
}

// ─── Appointment reminder ─────────────────────────────────────────────────

export interface ReminderOpts {
  clientPhone: string;
  clientFirstName?: string;
  serviceName: string;
  staffName?: string;
  startDateTime: string;
  appointmentId: string;
}

function reminderDedupeId(appointmentId: string, phone: string): string {
  return createHash("sha256").update(`${appointmentId}:${phone}`).digest("hex").slice(0, 32);
}

async function hasReminderBeenSent(appointmentId: string, phone: string): Promise<boolean> {
  const id = reminderDedupeId(appointmentId, phone);
  const rows = await db.select().from(smsRemindersSent).where(eq(smsRemindersSent.id, id));
  return rows.length > 0;
}

async function markReminderSent(appointmentId: string, phone: string): Promise<void> {
  const id = reminderDedupeId(appointmentId, phone);
  await db
    .insert(smsRemindersSent)
    .values({ id, appointmentId, phone })
    .onConflictDoNothing();
}

export async function sendReminderSms(opts: ReminderOpts): Promise<void> {
  const { clientPhone, clientFirstName, serviceName, staffName, startDateTime, appointmentId } = opts;

  if (await hasReminderBeenSent(appointmentId, clientPhone)) {
    console.log(`[Reminders] Already sent reminder for ${appointmentId} to ${clientPhone}`);
    return;
  }

  const greeting = clientFirstName ? `Hi ${clientFirstName}` : "Hi there";
  const stylistLine = staffName ? `${serviceName} · ${staffName}` : serviceName;

  // "Tomorrow" label if the appointment is the next calendar day, else the date
  const now = new Date();
  const apptDate = torontoDateString(new Date(startDateTime));
  const tomorrow = torontoDateString(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const datePart =
    apptDate === tomorrow
      ? `Tomorrow (${fmtDate(startDateTime)})`
      : fmtDate(startDateTime);

  const body =
    `${greeting}, just a reminder!\n\n` +
    `${stylistLine}\n` +
    `${datePart} at ${fmtTime(startDateTime)}\n\n` +
    `Questions? Just text back. — ${SALON_NAME}`;

  const sent = await sendSms(clientPhone, body);
  if (sent) {
    await markReminderSent(appointmentId, clientPhone);
    console.log(`[Reminders] Sent reminder for ${appointmentId} to ${clientPhone}`);
  }
}

// ─── Daily reminder job ────────────────────────────────────────────────────
// Runs daily at 9:00 AM Toronto time. Fetches all appointments in the
// 48–72-hour window from Phorest and sends one SMS per client.

let reminderJobTimer: ReturnType<typeof setTimeout> | null = null;

async function runReminderJob(): Promise<void> {
  console.log("[Reminders] Running 2-day reminder job...");
  try {
    const branchId = process.env.PHOREST_BRANCH_ID;
    if (!branchId) {
      console.warn("[Reminders] PHOREST_BRANCH_ID not set — skipping reminder job");
      return;
    }

    const now = new Date();
    // Window: 48 hours → 72 hours from now (Toronto YYYY-MM-DD)
    const from48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    const to72h = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const fromDate = torontoDateString(from48h);
    const toDate = torontoDateString(to72h);

    let page = 0;
    let totalPages = 1;
    let sent = 0;

    while (page < totalPages) {
      const result = await phorestApi.listAppointments({ fromDate, toDate, page, size: 50 });
      totalPages = result.totalPages;

      for (const appt of result.content) {
        try {
          if (!appt.clientId) continue;
          // Strict 48–72h window: the Phorest query is date-based (Toronto day
          // boundaries), so post-filter by exact appointment timestamp to avoid
          // reminders firing too early/late around day edges.
          const startMs = new Date(appt.startTime).getTime();
          if (isNaN(startMs) || startMs < from48h.getTime() || startMs >= to72h.getTime()) continue;
          const client = await phorestApi.getClient(appt.clientId);
          const phone = client.mobile || client.landline;
          if (!phone) continue;

          const normalized = authUtils.normalizePhoneForSearch(phone);
          const serviceName = appt.services?.[0]?.serviceName ?? "your appointment";
          const staffName = appt.staffName ?? undefined;

          await sendReminderSms({
            clientPhone: normalized,
            clientFirstName: client.firstName,
            serviceName,
            staffName,
            startDateTime: appt.startTime,
            appointmentId: appt.appointmentId,
          });
          sent++;
        } catch (clientErr) {
          console.error(`[Reminders] Error processing appointment ${appt.appointmentId}:`, clientErr);
        }
      }
      page++;
    }

    console.log(`[Reminders] Job complete — ${sent} reminders sent`);
  } catch (err) {
    console.error("[Reminders] Job failed:", err);
  }
}

function scheduleNextReminderJob(): void {
  const now = new Date();
  // Next 9:00 AM Toronto
  const target = torontoDateAtHour(now, 9);
  let ms = target.getTime() - now.getTime();
  if (ms <= 0) {
    // 9am already passed today — schedule for tomorrow
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    ms = torontoDateAtHour(tomorrow, 9).getTime() - now.getTime();
  }
  console.log(`[Reminders] Next job in ${Math.round(ms / 60000)} min`);
  reminderJobTimer = setTimeout(async () => {
    await runReminderJob();
    scheduleNextReminderJob(); // reschedule for next day
  }, ms);
}

export function startReminderJob(): void {
  scheduleNextReminderJob();
}
