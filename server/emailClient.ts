// Transactional email sender via Resend API (https://resend.com).
// Gracefully no-ops when RESEND_API_KEY is not set — the booking still
// completes and only the email is skipped (a warning is logged).

const RESEND_API = "https://api.resend.com/emails";

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Email] RESEND_API_KEY not set — skipping email to", payload.to);
    return;
  }
  const from = process.env.EMAIL_FROM || "Kozeta Salon <bookings@kozetasalon.com>";
  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [payload.to], subject: payload.subject, html: payload.html, text: payload.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[Email] Resend API error ${res.status}:`, body);
    } else {
      console.log("[Email] Sent to", payload.to);
    }
  } catch (err) {
    console.error("[Email] Failed to send:", err);
  }
}
