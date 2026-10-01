// ─── Portal kill switch ──────────────────────────────────────────────────────
// When PORTAL_ENABLED is false, the entire custom portal experience is switched
// OFF (nothing is deleted — flip this back to true to restore it):
//   - Frontend: AI chat bar, AI Stylist Portal, OTP login, in-app booking and
//     deposit checkout are hidden; a single "Book Now" button linking to
//     Phorest's own online booking page is shown instead.
//   - Backend: AI chat, recommendations, OTP auth, booking, availability and
//     payment endpoints return 503 { disabled: true } so no OpenAI or Stripe
//     calls can be triggered from the site.
//   - SMS: inbound texts get a short static reply with the booking link and
//     salon phone number (no AI, no payment links).
//   - Background jobs: the deposit refund sweep and appointment reminders are
//     not started.
// The admin deposits page stays available (read-only history).
export const PORTAL_ENABLED = false;

// ─── Login/profile switch ────────────────────────────────────────────────────
// When LOGIN_ENABLED is true (and PORTAL_ENABLED is false), the original OTP
// email/phone login is restored so clients can sign in and view their profile,
// appointment history, purchases and loyalty points. Booking still goes
// through Phorest's page and AI chat / Stripe payments stay OFF.
export const LOGIN_ENABLED = true;

// Official Phorest online booking page for Kozeta Salon & Spa.
export const PHOREST_BOOKING_URL =
  "https://phorest.com/book/salons/kozetasalonandspa";

export const SALON_PHONE_DISPLAY = "(416) 932-3131";
