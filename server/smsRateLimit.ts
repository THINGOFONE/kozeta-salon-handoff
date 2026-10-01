// Per-phone rate limiter: max 20 inbound messages per hour (sliding window).
// Protects against Twilio billing abuse from malicious or looping senders.

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_MESSAGES = 20;

// phone → timestamps of recent messages
const windows = new Map<string, number[]>();

// Prune old windows every 10 min to avoid memory leaks
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [phone, timestamps] of Array.from(windows.entries())) {
    const fresh = timestamps.filter((t: number) => t > cutoff);
    if (fresh.length === 0) {
      windows.delete(phone);
    } else {
      windows.set(phone, fresh);
    }
  }
}, 10 * 60 * 1000);

/** Returns true if the message should be allowed, false if rate limited. */
export function allowMessage(phone: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const timestamps = (windows.get(phone) ?? []).filter(t => t > cutoff);
  if (timestamps.length >= MAX_MESSAGES) return false;
  timestamps.push(now);
  windows.set(phone, timestamps);
  return true;
}
