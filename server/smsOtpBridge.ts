// Thin bridge so smsCompanion.ts can check whether a phone number has an active
// OTP session without creating a circular import with routes.ts.
// routes.ts calls registerOtpPhone / clearOtpPhone when it creates/resolves OTPs.

const OTP_EXPIRY_MS = 5 * 60 * 1000;

const activePhonesMap = new Map<string, number>(); // phone → expiresAt

export function registerOtpPhone(phone: string): void {
  activePhonesMap.set(phone, Date.now() + OTP_EXPIRY_MS);
}

export function clearOtpPhone(phone: string): void {
  activePhonesMap.delete(phone);
}

export function hasActiveOtp(phone: string): boolean {
  const expiresAt = activePhonesMap.get(phone);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activePhonesMap.delete(phone);
    return false;
  }
  return true;
}
