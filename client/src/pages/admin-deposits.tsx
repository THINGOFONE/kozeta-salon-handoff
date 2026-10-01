import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Search, RefreshCw, ArrowLeft, Undo2, Lock, History, CheckCircle2, XCircle } from "lucide-react";
import { Link } from "wouter";
import { PORTAL_ENABLED } from "@shared/portalConfig";

const PASSCODE_STORAGE_KEY = "admin-passcode";

async function adminFetch(passcode: string, url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      "x-admin-passcode": passcode,
    },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch { /* non-JSON error body */ }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res;
}

interface RefundHistoryItem {
  amountCents: number;
  status: "succeeded" | "failed";
  reason: string | null;
  initiatedBy: string;
  errorMessage: string | null;
  createdAt: string;
  source?: "stripe" | "phorest";
  label?: string | null;
  phorestVoucherSerial?: string | null;
}

interface DepositItem {
  paymentIntentId: string;
  createdAt: number;
  amountCents: number;
  refundedCents: number;
  remainingCents: number;
  refundStatus: "none" | "partial" | "full";
  clientId: string | null;
  clientName: string | null;
  serviceName: string | null;
  startDateTime: string | null;
  appointmentId: string | null;
  description: string | null;
  estimatedServiceTotalCents: number | null;
  history: RefundHistoryItem[];
  reviewFlag?: {
    reason: string;
    sweepCount: number;
    firstFlaggedAt: string;
    escalated: boolean;
  } | null;
}

interface FullServiceResult {
  success: boolean;
  scope: "full-service";
  totalRequestedCents: number;
  deposit: { attempted: boolean; ok: boolean; amountCents: number; label: string; refundId?: string; error?: string };
  service: { attempted: boolean; ok: boolean; amountCents: number; label: string; voucherSerial?: string; error?: string };
}

interface DepositsResponse {
  deposits: DepositItem[];
}

function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(value: string | number | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AdminDeposits() {
  const [search, setSearch] = useState("");
  const [refundTarget, setRefundTarget] = useState<DepositItem | null>(null);
  const [refundMode, setRefundMode] = useState<"full" | "partial" | "full-service">("full");
  const [partialAmount, setPartialAmount] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [reason, setReason] = useState("");
  const [splitResult, setSplitResult] = useState<FullServiceResult | null>(null);
  const [historyClientId, setHistoryClientId] = useState<string | null>(null);
  const [passcode, setPasscode] = useState(() => sessionStorage.getItem(PASSCODE_STORAGE_KEY) || "");
  const [passcodeInput, setPasscodeInput] = useState("");
  const { toast } = useToast();

  const clearPasscode = () => {
    sessionStorage.removeItem(PASSCODE_STORAGE_KEY);
    setPasscode("");
  };

  const { data, isLoading, refetch, isFetching, error: listError } = useQuery<DepositsResponse>({
    queryKey: ["/api/admin/deposits", passcode],
    queryFn: async () => {
      const res = await adminFetch(passcode, "/api/admin/deposits");
      return res.json();
    },
    enabled: !!passcode,
    staleTime: 30000,
    retry: (count, err: any) => err?.status !== 401 && err?.status !== 503 && count < 2,
  });

  if (passcode && (listError as any)?.status === 401) {
    clearPasscode();
  }

  const refundMutation = useMutation({
    mutationFn: async (payload: {
      paymentIntentId: string;
      amountCents?: number;
      reason?: string;
      scope?: "full-service";
      totalCents?: number;
      clientId?: string;
    }) => {
      const res = await adminFetch(passcode, "/api/admin/deposits/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/deposits"] });
      setRefundTarget(null);
      setPartialAmount("");
      setTotalAmount("");
      setReason("");
      if (result.scope === "full-service") {
        // Show the per-transaction outcome dialog instead of a toast — staff
        // must see exactly which of the two transactions went through.
        setSplitResult(result as FullServiceResult);
        return;
      }
      toast({
        title: "Refund issued",
        description: `Refunded ${money(result.amountRefundedCents)} — ${money(result.remainingCents)} remaining on this deposit.`,
      });
    },
    onError: (error: Error & { status?: number }) => {
      if (error.status === 401) {
        clearPasscode();
        toast({ title: "Session expired", description: "Please re-enter the staff passcode.", variant: "destructive" });
        return;
      }
      toast({ title: "Refund failed", description: error.message, variant: "destructive" });
    },
  });

  const filtered = useMemo(() => {
    const deposits = data?.deposits || [];
    if (!search) return deposits;
    const q = search.toLowerCase();
    return deposits.filter(
      (d) =>
        d.paymentIntentId.toLowerCase().includes(q) ||
        (d.clientName || "").toLowerCase().includes(q) ||
        (d.clientId || "").toLowerCase().includes(q) ||
        (d.serviceName || "").toLowerCase().includes(q) ||
        (d.description || "").toLowerCase().includes(q)
    );
  }, [data, search]);

  const openRefund = (deposit: DepositItem) => {
    setRefundTarget(deposit);
    setRefundMode(deposit.remainingCents > 0 ? "full" : "full-service");
    setPartialAmount("");
    setTotalAmount(deposit.estimatedServiceTotalCents ? (deposit.estimatedServiceTotalCents / 100).toFixed(2) : "");
    setReason("");
  };

  const partialCents = Math.round(parseFloat(partialAmount || "0") * 100);
  const totalCents = Math.round(parseFloat(totalAmount || "0") * 100);
  const partialValid =
    refundMode === "full" ||
    (refundMode === "partial" &&
      Number.isFinite(partialCents) && partialCents > 0 && refundTarget !== null && partialCents <= refundTarget.remainingCents) ||
    (refundMode === "full-service" && Number.isFinite(totalCents) && totalCents > 0);

  // Split preview: deposit portion capped at the remaining refundable deposit,
  // remainder issued Phorest-side. Mirrors the server's split exactly.
  const splitDepositCents = refundTarget ? Math.min(refundTarget.remainingCents, totalCents > 0 ? totalCents : 0) : 0;
  const splitServiceCents = totalCents > 0 ? totalCents - splitDepositCents : 0;

  const submitRefund = () => {
    if (!refundTarget) return;
    if (refundMode === "full-service") {
      refundMutation.mutate({
        paymentIntentId: refundTarget.paymentIntentId,
        scope: "full-service",
        totalCents,
        ...(refundTarget.clientId ? { clientId: refundTarget.clientId } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      return;
    }
    refundMutation.mutate({
      paymentIntentId: refundTarget.paymentIntentId,
      ...(refundMode === "partial" ? { amountCents: partialCents } : {}),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  const historyQuery = useQuery<{ services: any[]; purchases: any[] }>({
    queryKey: ["/api/admin/clients", historyClientId, "history"],
    queryFn: async () => {
      const res = await adminFetch(passcode, `/api/admin/clients/${historyClientId}/history`);
      return res.json();
    },
    enabled: !!passcode && !!historyClientId,
    staleTime: 60000,
  });

  if (!passcode) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-lg font-semibold" data-testid="text-passcode-title">Staff access</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Enter the staff passcode to view deposits and issue refunds.
            </p>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const value = passcodeInput.trim();
                if (!value) return;
                sessionStorage.setItem(PASSCODE_STORAGE_KEY, value);
                setPasscode(value);
                setPasscodeInput("");
              }}
            >
              <Input
                type="password"
                placeholder="Passcode"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                autoFocus
                data-testid="input-admin-passcode"
              />
              <Button type="submit" className="w-full" disabled={!passcodeInput.trim()} data-testid="button-submit-passcode">
                Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
        {listError && (listError as any)?.status !== 401 ? (
          <p className="text-sm text-destructive" data-testid="text-list-error">
            {(listError as Error).message}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Link href="/admin/products">
              <Button variant="ghost" size="icon" data-testid="button-back-admin">
                <ArrowLeft />
              </Button>
            </Link>
            <div>
              <h1 className="text-xl font-semibold" data-testid="text-page-title">Deposits & Refunds</h1>
              <p className="text-sm text-muted-foreground">Portal booking deposits from the last 60 days</p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-deposits"
          >
            <RefreshCw className={isFetching ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by payment ID, client ID, or service..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-deposits"
          />
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground" data-testid="text-no-deposits">
              No deposits found.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filtered.map((d) => (
              <Card key={d.paymentIntentId} data-testid={`card-deposit-${d.paymentIntentId}`}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium" data-testid={`text-service-${d.paymentIntentId}`}>
                          {d.serviceName || d.description || "Booking deposit"}
                        </span>
                        {d.refundStatus === "full" && (
                          <Badge variant="secondary" data-testid={`badge-refunded-${d.paymentIntentId}`}>Fully refunded</Badge>
                        )}
                        {d.refundStatus === "partial" && (
                          <Badge variant="secondary" data-testid={`badge-partial-${d.paymentIntentId}`}>Partially refunded</Badge>
                        )}
                        {d.reviewFlag && (
                          <Badge variant="destructive" data-testid={`badge-review-${d.paymentIntentId}`}>Needs review</Badge>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground mt-1 space-y-0.5">
                        {d.clientName && (
                          <div className="font-medium text-foreground" data-testid={`text-client-name-${d.paymentIntentId}`}>{d.clientName}</div>
                        )}
                        <div>Paid {formatDate(d.createdAt)} · {d.startDateTime ? `Appt ${formatDate(d.startDateTime)}` : "No appointment linked"}</div>
                        <div className="font-mono text-xs break-all">{d.paymentIntentId}{d.clientId ? ` · client ${d.clientId}` : ""}</div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold" data-testid={`text-amount-${d.paymentIntentId}`}>{money(d.amountCents)}</div>
                      {d.refundedCents > 0 && (
                        <div className="text-sm text-muted-foreground">refunded {money(d.refundedCents)}</div>
                      )}
                    </div>
                  </div>

                  {d.reviewFlag && (
                    <div className="text-xs border-t pt-2 text-destructive" data-testid={`text-review-${d.paymentIntentId}`}>
                      Auto-refund skipped — {d.reviewFlag.reason}. Flagged since {formatDate(d.reviewFlag.firstFlaggedAt)}
                      {d.reviewFlag.escalated ? " · ESCALATED" : ""}. Review this deposit manually.
                    </div>
                  )}

                  {d.history.length > 0 && (
                    <div className="text-xs text-muted-foreground space-y-0.5 border-t pt-2">
                      {d.history.map((h, i) => (
                        <div key={i} data-testid={`text-history-${d.paymentIntentId}-${i}`}>
                          {h.status === "succeeded" ? "Refunded" : "Refund FAILED"} {money(h.amountCents)}
                          {h.label ? ` · ${h.label}` : ""}
                          {h.phorestVoucherSerial ? ` · voucher #${h.phorestVoucherSerial}` : ""}
                          {" · "}{h.initiatedBy} · {formatDate(h.createdAt)}
                          {h.reason ? ` · ${h.reason}` : ""}
                          {h.errorMessage ? ` · ${h.errorMessage}` : ""}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex justify-end gap-2 flex-wrap">
                    {d.clientId && (
                      <Button
                        variant="ghost"
                        onClick={() => setHistoryClientId(d.clientId)}
                        data-testid={`button-history-${d.paymentIntentId}`}
                      >
                        <History />
                        Client history
                      </Button>
                    )}
                    {PORTAL_ENABLED && (
                      <Button
                        variant="outline"
                        onClick={() => openRefund(d)}
                        data-testid={`button-refund-${d.paymentIntentId}`}
                      >
                        <Undo2 />
                        Refund
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={refundTarget !== null} onOpenChange={(open) => { if (!open) setRefundTarget(null); }}>
        <DialogContent data-testid="dialog-refund">
          <DialogHeader>
            <DialogTitle>Refund deposit</DialogTitle>
            <DialogDescription>
              {refundTarget && (
                <>
                  {refundTarget.serviceName || "Booking deposit"} — {money(refundTarget.remainingCents)} available to refund
                  {refundTarget.refundedCents > 0 && ` (${money(refundTarget.refundedCents)} already refunded)`}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex gap-2 flex-wrap">
              <Button
                variant={refundMode === "full" ? "default" : "outline"}
                onClick={() => setRefundMode("full")}
                disabled={refundTarget?.remainingCents === 0}
                data-testid="button-mode-full"
              >
                Full deposit{refundTarget ? ` (${money(refundTarget.remainingCents)})` : ""}
              </Button>
              <Button
                variant={refundMode === "partial" ? "default" : "outline"}
                onClick={() => setRefundMode("partial")}
                disabled={refundTarget?.remainingCents === 0}
                data-testid="button-mode-partial"
              >
                Partial deposit
              </Button>
              <Button
                variant={refundMode === "full-service" ? "default" : "outline"}
                onClick={() => setRefundMode("full-service")}
                data-testid="button-mode-full-service"
              >
                Full service
              </Button>
            </div>

            {refundMode === "partial" && (
              <div className="space-y-1">
                <label className="text-sm font-medium">Amount (CAD)</label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="e.g. 10.00"
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                  data-testid="input-partial-amount"
                />
                {refundTarget && partialAmount && !partialValid && (
                  <p className="text-sm text-destructive" data-testid="text-amount-error">
                    Enter an amount between $0.01 and {money(refundTarget.remainingCents)}.
                  </p>
                )}
              </div>
            )}

            {refundMode === "full-service" && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Total to refund (CAD)</label>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="e.g. 150.00"
                    value={totalAmount}
                    onChange={(e) => setTotalAmount(e.target.value)}
                    data-testid="input-total-amount"
                  />
                  {refundTarget?.estimatedServiceTotalCents ? (
                    <p className="text-xs text-muted-foreground">
                      Estimated service total from booking: {money(refundTarget.estimatedServiceTotalCents)}. Adjust if the final bill differed.
                    </p>
                  ) : null}
                </div>

                {totalCents > 0 && refundTarget && (
                  <div className="rounded-md border p-3 text-sm space-y-2" data-testid="text-split-preview">
                    <p className="font-medium">This issues two separate transactions:</p>
                    <div className="flex justify-between gap-2">
                      <span>KOZETA SALON Deposit Refund <span className="text-muted-foreground">(back to card via Stripe)</span></span>
                      <span className="font-medium">{money(splitDepositCents)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span>KOZETA SALON Service Refund <span className="text-muted-foreground">(salon credit voucher in Phorest)</span></span>
                      <span className="font-medium">{money(splitServiceCents)}</span>
                    </div>
                    {splitServiceCents > 0 && !refundTarget.clientId && (
                      <p className="text-destructive text-xs">
                        No Phorest client is linked to this payment — the service portion cannot be issued as salon credit.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-sm font-medium">Reason (optional)</label>
              <Textarea
                placeholder="e.g. Client rescheduled, goodwill refund..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                data-testid="input-refund-reason"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundTarget(null)} data-testid="button-cancel-refund">
              Cancel
            </Button>
            <Button
              onClick={submitRefund}
              disabled={
                !partialValid ||
                refundMutation.isPending ||
                (refundMode === "full-service" && splitServiceCents > 0 && !refundTarget?.clientId)
              }
              data-testid="button-confirm-refund"
            >
              {refundMutation.isPending
                ? "Refunding..."
                : refundMode === "full" && refundTarget
                ? `Refund ${money(refundTarget.remainingCents)}`
                : partialValid && refundMode === "partial"
                ? `Refund ${money(partialCents)}`
                : partialValid && refundMode === "full-service"
                ? `Refund ${money(totalCents)} (2 transactions)`
                : "Refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-transaction outcome for full-service refunds */}
      <Dialog open={splitResult !== null} onOpenChange={(open) => { if (!open) setSplitResult(null); }}>
        <DialogContent data-testid="dialog-split-result">
          <DialogHeader>
            <DialogTitle>
              {splitResult?.success ? "Full service refund issued" : "Refund partially completed"}
            </DialogTitle>
            <DialogDescription>
              {splitResult && `Requested total: ${money(splitResult.totalRequestedCents)} across two transactions.`}
            </DialogDescription>
          </DialogHeader>
          {splitResult && (
            <div className="space-y-3 text-sm">
              {[
                { key: "deposit", r: splitResult.deposit, how: "back to card via Stripe" },
                { key: "service", r: splitResult.service, how: "salon credit voucher in Phorest" },
              ].map(({ key, r, how }) => (
                <div key={key} className="rounded-md border p-3 space-y-1" data-testid={`text-result-${key}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      {!r.attempted ? null : r.ok
                        ? <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />
                        : <XCircle className="h-4 w-4 text-destructive" />}
                      {r.label}
                    </span>
                    <span className="font-medium">{money(r.amountCents)}</span>
                  </div>
                  <p className="text-muted-foreground text-xs">{how}</p>
                  {!r.attempted && <p className="text-muted-foreground text-xs">Not needed — {money(0)} on this source.</p>}
                  {r.attempted && r.ok && key === "service" && (splitResult.service.voucherSerial
                    ? <p className="text-xs">Voucher #{splitResult.service.voucherSerial} — staff can apply it at the till.</p>
                    : null)}
                  {r.attempted && !r.ok && (
                    <p className="text-destructive text-xs" data-testid={`text-error-${key}`}>
                      FAILED — {r.error || "unknown error"}. This portion was NOT refunded; the other transaction is unaffected.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSplitResult(null)} data-testid="button-close-split-result">Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Client purchase/service history lookup */}
      <Dialog open={historyClientId !== null} onOpenChange={(open) => { if (!open) setHistoryClientId(null); }}>
        <DialogContent className="max-h-[80vh] overflow-y-auto" data-testid="dialog-client-history">
          <DialogHeader>
            <DialogTitle>Client history</DialogTitle>
            <DialogDescription>Recent services and purchases from Phorest, to help work out refund totals.</DialogDescription>
          </DialogHeader>
          {historyQuery.isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : historyQuery.error ? (
            <p className="text-sm text-destructive">{(historyQuery.error as Error).message}</p>
          ) : (
            <div className="space-y-4 text-sm">
              <div>
                <p className="font-medium mb-1">Services</p>
                {(historyQuery.data?.services || []).length === 0 ? (
                  <p className="text-muted-foreground text-xs">No service history found.</p>
                ) : (
                  <div className="space-y-1">
                    {(historyQuery.data?.services || []).slice(0, 15).map((s: any, i: number) => (
                      <div key={i} className="flex justify-between gap-2 text-xs" data-testid={`text-svc-history-${i}`}>
                        <span className="min-w-0 truncate">{s.serviceName || s.name || "Service"}{s.staffName ? ` · ${s.staffName}` : ""}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {(s.date || s.serviceDate || "").toString().slice(0, 10)}{typeof s.price === "number" ? ` · $${s.price.toFixed(2)}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <p className="font-medium mb-1">Purchases</p>
                {(historyQuery.data?.purchases || []).length === 0 ? (
                  <p className="text-muted-foreground text-xs">No purchase history found.</p>
                ) : (
                  <div className="space-y-1">
                    {(historyQuery.data?.purchases || []).slice(0, 15).map((p: any, i: number) => (
                      <div key={i} className="flex justify-between gap-2 text-xs" data-testid={`text-purchase-history-${i}`}>
                        <span className="min-w-0 truncate">
                          {(p.purchaseItems || p.items || []).map((it: any) => it.name || it.itemName).filter(Boolean).join(", ") || "Purchase"}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {(p.purchaseDate || p.date || "").toString().slice(0, 10)}{typeof p.totalAmount === "number" ? ` · $${p.totalAmount.toFixed(2)}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
