// Tests the cancel-appointment mutation logic extracted from portal-card.tsx.
//
// Coverage:
//   - mutationFn: CANCEL_UNCONFIRMED response does NOT throw → routes to onSuccess
//   - mutationFn: generic 5xx error DOES throw → routes to onError
//   - onSuccess: CANCEL_UNCONFIRMED → "call us" toast, NO cache invalidation
//   - onSuccess: confirmed cancel → standard toast + cache invalidation
//
// These are pure logic tests; no DOM or React rendering required.

import { describe, it, expect, vi } from "vitest";

// ── Extracted logic (mirrors portal-card.tsx cancelAppointmentMutation) ───────

async function cancelMutationFn(
  appointmentId: string,
  sessionId: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): Promise<{ code?: string; success?: boolean; appointmentId: string; [k: string]: unknown }> {
  const res = await fetchImpl("/api/appointments/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, appointmentId }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok && data?.code !== "CANCEL_UNCONFIRMED") {
    throw new Error((data?.error as string) || "Failed to cancel appointment");
  }
  return { ...data, appointmentId };
}

type ToastArgs = { title: string; description: string; variant?: string; duration?: number };

function simulateOnSuccess(
  data: { code?: string; [k: string]: unknown },
  toast: (args: ToastArgs) => void,
  invalidateCache: () => void,
): void {
  if (data?.code === "CANCEL_UNCONFIRMED") {
    toast({
      title: "Cancellation not confirmed",
      description:
        "We sent your cancellation request but couldn't confirm it went through. Please call us at (416) 932-3131 to make sure your appointment is cancelled.",
      variant: "destructive",
      duration: 10000,
    });
  } else {
    invalidateCache();
    toast({
      title: "Appointment cancelled",
      description: "Your appointment has been cancelled.",
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubFetch(body: unknown, ok: boolean) {
  return vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const APT_ID = "apt-cancel-frontend-1";
const SESSION_ID = "sess-test";

describe("cancelAppointmentMutation — CANCEL_UNCONFIRMED routing", () => {
  it("does NOT throw when server returns CANCEL_UNCONFIRMED (routes to onSuccess, not onError)", async () => {
    const fetch = stubFetch({ code: "CANCEL_UNCONFIRMED", error: "Cancellation could not be confirmed" }, false);
    const result = await cancelMutationFn(APT_ID, SESSION_ID, fetch);
    expect(result.code).toBe("CANCEL_UNCONFIRMED");
    expect(result.appointmentId).toBe(APT_ID);
  });

  it("DOES throw for a generic server error so onError fires", async () => {
    const fetch = stubFetch({ error: "Phorest unavailable" }, false);
    await expect(cancelMutationFn(APT_ID, SESSION_ID, fetch)).rejects.toThrow("Phorest unavailable");
  });

  it("returns success data when the server confirms cancellation", async () => {
    const fetch = stubFetch({ success: true, message: "Appointment cancelled" }, true);
    const result = await cancelMutationFn(APT_ID, SESSION_ID, fetch);
    expect(result.success).toBe(true);
    expect(result.appointmentId).toBe(APT_ID);
  });
});

describe("cancelAppointmentMutation — onSuccess toast selection", () => {
  it("shows the 'call us' toast (not generic success) when code is CANCEL_UNCONFIRMED", () => {
    const toast = vi.fn();
    const invalidate = vi.fn();

    simulateOnSuccess({ code: "CANCEL_UNCONFIRMED", appointmentId: APT_ID }, toast, invalidate);

    expect(toast).toHaveBeenCalledOnce();
    const call = toast.mock.calls[0][0] as ToastArgs;
    expect(call.title).toBe("Cancellation not confirmed");
    expect(call.description).toMatch(/call us/i);
    expect(call.variant).toBe("destructive");
    expect(call.duration).toBe(10000);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("shows standard success toast and invalidates cache for a confirmed cancellation", () => {
    const toast = vi.fn();
    const invalidate = vi.fn();

    simulateOnSuccess({ success: true, message: "Done" }, toast, invalidate);

    expect(toast).toHaveBeenCalledOnce();
    const call = toast.mock.calls[0][0] as ToastArgs;
    expect(call.title).toBe("Appointment cancelled");
    expect(call.description).not.toMatch(/call us/i);
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
