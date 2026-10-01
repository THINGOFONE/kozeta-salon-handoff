// Shared Twilio SMS helper used by both OTP (routes.ts) and the SMS companion.

function getTwilioCreds() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

export function isTwilioConfigured(): boolean {
  return getTwilioCreds() !== null;
}

/** Send an SMS via Twilio. Returns true on success, false on any failure. */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const creds = getTwilioCreds();
  if (!creds) {
    console.error("[Twilio] Not configured — missing env vars");
    return false;
  }
  const { accountSid, authToken, fromNumber } = creds;
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams({ To: to, From: fromNumber, Body: body });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[Twilio] SMS send failed ${res.status}:`, text);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Twilio] SMS send error:", err);
    return false;
  }
}
