// Salon-local matching of Phorest appointments against an ISO slot.
//
// Phorest returns `appointmentDate` ("YYYY-MM-DD") plus a TIME-ONLY `startTime`
// ("09:45:00.000") in salon-local time, so comparisons must be done in the
// salon's timezone — naive Date() parsing of a time-only string is NaN and
// silently fail-opens.

import * as phorestApi from "../phorestApi";

const SALON_TZ = "America/Toronto";

export interface SlotLocal {
  date: string;    // YYYY-MM-DD in salon-local time
  minutes: number; // minutes since local midnight
  ms: number;      // absolute epoch ms
}

export function slotToSalonLocal(iso: string): SlotLocal | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SALON_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const lp = (t: string) => parts.find(p => p.type === t)?.value || "";
  return {
    date: `${lp("year")}-${lp("month")}-${lp("day")}`,
    minutes: parseInt(lp("hour"), 10) * 60 + parseInt(lp("minute"), 10),
    ms: d.getTime(),
  };
}

/**
 * Whether an appointment's start falls within `windowMs` of the slot.
 * Returns null when the appointment start cannot be parsed at all.
 */
export function appointmentNearSlot(appt: any, slot: SlotLocal, windowMs: number): boolean | null {
  const rawStart = String(appt?.startDateTime || appt?.startTime || "");
  // Full ISO datetime (contains a date part) → direct comparison
  if (/\d{4}-\d{2}-\d{2}/.test(rawStart)) {
    const t = new Date(rawStart).getTime();
    if (isNaN(t)) return null;
    return Math.abs(t - slot.ms) <= windowMs;
  }
  // Time-only startTime ("HH:mm[:ss[.SSS]]") — salon-local
  const m = rawStart.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  if (appt?.appointmentDate && String(appt.appointmentDate).slice(0, 10) !== slot.date) return false;
  const minutes = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return Math.abs(minutes - slot.minutes) * 60 * 1000 <= windowMs;
}

// Judge cancellation ONLY by activationState (Phorest's `state` field is
// read-only/unreliable for cancellation — verified live: a cancel PUT on
// `state` returns 200 but is silently ignored; trusting `state` here would
// risk false-positive cancel confirmations).
export function isCancelledAppointment(a: any): boolean {
  return /cancel/i.test(
    String(a?.activationState || a?.activation_state || "")
  );
}

/**
 * Converts a salon-local wall time (YYYY-MM-DD + minutes since midnight in
 * America/Toronto) to absolute epoch ms. Two-pass correction handles DST.
 */
export function salonLocalToMs(date: string, minutes: number): number | null {
  const parts = date.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [y, mo, d] = parts;
  let guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  for (let i = 0; i < 2; i++) {
    const local = slotToSalonLocal(new Date(guess).toISOString());
    if (!local) return null;
    const dayDiffMs = Date.parse(local.date) - Date.parse(date);
    const diff = dayDiffMs + (local.minutes - minutes) * 60_000;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/**
 * Absolute epoch ms of an appointment's start, handling both Phorest shapes:
 * full-ISO `startDateTime`/`startTime`, or TIME-ONLY `startTime` plus
 * `appointmentDate` (salon-local). Returns null when unparseable.
 */
export function appointmentStartMs(appt: any): number | null {
  const rawStart = String(appt?.startDateTime || appt?.startTime || "");
  if (/\d{4}-\d{2}-\d{2}/.test(rawStart)) {
    const t = new Date(rawStart).getTime();
    return isNaN(t) ? null : t;
  }
  const m = rawStart.match(/^(\d{1,2}):(\d{2})/);
  const date = String(appt?.appointmentDate || "").slice(0, 10);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return salonLocalToMs(date, parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
}

const NEARBY_WINDOW_MS = 2 * 60 * 60 * 1000; // ±2h

/**
 * Finds an existing non-cancelled appointment for the client near the slot
 * (same salon-local day, ±2h). Returns null when none exists. Throws on
 * Phorest errors — callers decide their own fail-open behavior.
 */
export async function findNearbyActiveAppointment(
  clientId: string,
  startDateTime: string,
  windowMs: number = NEARBY_WINDOW_MS
): Promise<any | null> {
  const slot = slotToSalonLocal(startDateTime);
  if (!slot) return null;
  const appts = await phorestApi.listAppointments({
    clientId,
    fromDate: slot.date,
    toDate: slot.date,
    size: 100,
  });
  const list: any[] = (appts as any)?._embedded?.appointments || (appts as any)?.content || [];
  return list.find(a => !isCancelledAppointment(a) && appointmentNearSlot(a, slot, windowMs) === true) || null;
}

/**
 * Heads-up note for staff when the client already has another active
 * appointment near this slot (e.g. booking for a family member). Both deposits
 * auto-apply at their own checkouts — the note only makes it visible at the
 * till. Never throws; returns "" when there is nothing to note (fail-open:
 * a Phorest error must never block a booking).
 */
export async function buildDuplicateDepositNote(clientId: string, startDateTime: string): Promise<string> {
  try {
    if (!phorestApi.isPhorestConfigured()) return "";
    const nearby = await findNearbyActiveAppointment(clientId, startDateTime);
    if (!nearby) return "";
    const when = nearby.startTime || nearby.startDateTime || "another time";
    console.log(`[Booking] Client ${clientId} has another active appointment around ${when} — adding 2-deposit heads-up note`);
    return `NOTE: client has another appointment around ${when} today with its own online deposit — each deposit auto-applies at its own checkout (2 deposits today).`;
  } catch (e) {
    console.warn("[Booking] Nearby-appointment note check failed (continuing):", e);
    return "";
  }
}
