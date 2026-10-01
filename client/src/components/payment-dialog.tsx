import { useState, useEffect, useRef } from "react";
import { loadStripe, StripeElementsOptions } from "@/lib/stripe-compat";
import { Elements, CardNumberElement, CardExpiryElement, CardCvcElement, useStripe, useElements } from "@/lib/stripe-react-compat";
import { Loader2, CreditCard, CheckCircle, AlertCircle, Lock, Star, Phone, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface PaymentFormProps {
  pendingId: string;
  depositAmount: string;
  serviceName: string;
  clientSecret: string;
  onSuccess: (paymentIntentId: string) => void;
  onCancel: () => void;
}

const cardStyle = {
  style: {
    base: {
      fontSize: '18px',
      color: '#1a1a1a',
      '::placeholder': { color: '#9ca3af' },
      fontFamily: 'system-ui, sans-serif',
      lineHeight: '28px',
    },
    invalid: { color: '#df1b41' },
  },
};

function PaymentForm({ pendingId, depositAmount, serviceName, clientSecret, onSuccess, onCancel }: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyCount, setReadyCount] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setError(null);

    const cardNumberElement = elements.getElement('cardNumber');
    if (!cardNumberElement) {
      setError("Card form not loaded. Please try again.");
      setIsProcessing(false);
      return;
    }

    const { error: submitError, paymentIntent } = await stripe.confirmCardPayment(
      clientSecret,
      {
        payment_method: {
          card: cardNumberElement,
        },
      }
    );

    if (submitError) {
      const isDeclined = submitError.type === 'card_error';
      setError(isDeclined
        ? `No charge was made. ${submitError.message || "Your card was declined."} Please check your details or try a different card.`
        : submitError.message || "Payment failed. Please try again.");
      setIsProcessing(false);
    } else if (paymentIntent && paymentIntent.status === "succeeded") {
      onSuccess(paymentIntent.id);
    } else {
      setError("Payment was not completed. Please try again.");
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-muted/50 rounded-lg p-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Service</span>
          <span className="font-medium">{serviceName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Deposit (20%)</span>
          <span className="font-semibold text-primary">{depositAmount}</span>
        </div>
      </div>

      <div className="border rounded-lg p-5 space-y-4 bg-white dark:bg-card">
        <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Card Number</label>
        <div className="border-b pb-3">
          <CardNumberElement
            onReady={() => setReadyCount(c => c + 1)}
            options={cardStyle}
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Expiry</label>
            <div className="border-b pb-3">
              <CardExpiryElement
                onReady={() => setReadyCount(c => c + 1)}
                options={cardStyle}
              />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">CVC</label>
            <div className="border-b pb-3">
              <CardCvcElement
                onReady={() => setReadyCount(c => c + 1)}
                options={cardStyle}
              />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
        <Lock className="w-3 h-3" />
        <span>Payments secured by Stripe</span>
      </div>

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isProcessing}
          className="flex-1"
          data-testid="button-cancel-payment"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!stripe || !elements || isProcessing || readyCount < 3}
          className="flex-1"
          data-testid="button-pay-deposit"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <CreditCard className="w-4 h-4 mr-2" />
              Pay {depositAmount}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

function ProductPaymentForm({ totalAmount, clientSecret, onSuccess, onCancel }: {
  totalAmount: string;
  clientSecret: string;
  onSuccess: (paymentIntentId: string) => void;
  onCancel: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readyCount, setReadyCount] = useState(0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsProcessing(true);
    setError(null);

    const cardNumberElement = elements.getElement('cardNumber');
    if (!cardNumberElement) {
      setError("Card form not loaded. Please try again.");
      setIsProcessing(false);
      return;
    }

    const { error: submitError, paymentIntent } = await stripe.confirmCardPayment(
      clientSecret,
      {
        payment_method: {
          card: cardNumberElement,
        },
      }
    );

    if (submitError) {
      const isDeclined = submitError.type === 'card_error';
      setError(isDeclined
        ? `No charge was made. ${submitError.message || "Your card was declined."} Please check your details or try a different card.`
        : submitError.message || "Payment failed. Please try again.");
      setIsProcessing(false);
    } else if (paymentIntent && paymentIntent.status === "succeeded") {
      onSuccess(paymentIntent.id);
    } else {
      setError("Payment was not completed. Please try again.");
      setIsProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-muted/50 rounded-lg p-4">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Order Total</span>
          <span className="font-semibold text-primary text-lg">{totalAmount}</span>
        </div>
      </div>

      <div className="border rounded-lg p-5 space-y-4 bg-white dark:bg-card">
        <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Card Number</label>
        <div className="border-b pb-3">
          <CardNumberElement
            onReady={() => setReadyCount(c => c + 1)}
            options={cardStyle}
          />
        </div>
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Expiry</label>
            <div className="border-b pb-3">
              <CardExpiryElement
                onReady={() => setReadyCount(c => c + 1)}
                options={cardStyle}
              />
            </div>
          </div>
          <div className="flex-1">
            <label className="block text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">CVC</label>
            <div className="border-b pb-3">
              <CardCvcElement
                onReady={() => setReadyCount(c => c + 1)}
                options={cardStyle}
              />
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
        <Lock className="w-3 h-3" />
        <span>Payments secured by Stripe</span>
      </div>

      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isProcessing}
          className="flex-1"
          data-testid="button-cancel-product-payment"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!stripe || !elements || isProcessing || readyCount < 3}
          className="flex-1"
          data-testid="button-pay-product"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <CreditCard className="w-4 h-4 mr-2" />
              Pay {totalAmount}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

// Product Payment Dialog
interface ProductPaymentDialogProps {
  isOpen: boolean;
  clientSecret: string;
  totalAmount: string;
  subtotalAmount?: string;
  loyaltyPointsRedeemed?: number;
  loyaltyDiscountAmount?: string;
  onSuccess: (paymentIntentId: string) => void;
  onCancel: () => void;
}

export function ProductPaymentDialog({
  isOpen,
  clientSecret,
  totalAmount,
  subtotalAmount,
  loyaltyPointsRedeemed,
  loyaltyDiscountAmount,
  onSuccess,
  onCancel
}: ProductPaymentDialogProps) {
  const [stripePromise, setStripePromise] = useState<Promise<any> | null>(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [isProcessingFinal, setIsProcessingFinal] = useState(false);

  const stripeConfigQuery = useQuery<{ configured: boolean; publishableKey?: string; salonPhone?: string | null }>({
    queryKey: ['/api/stripe/config'],
    enabled: isOpen
  });

  useEffect(() => {
    if (isOpen && stripeConfigQuery.data?.configured && stripeConfigQuery.data.publishableKey) {
      setStripePromise(loadStripe(stripeConfigQuery.data.publishableKey));
    }
  }, [isOpen, stripeConfigQuery.data?.configured]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPaymentSuccess(false);
      setIsProcessingFinal(false);
    }
  }, [isOpen]);

  const handlePaymentSuccess = (paymentIntentId: string) => {
    setPaymentSuccess(true);
    setIsProcessingFinal(true);
    onSuccess(paymentIntentId);
  };

  if (!isOpen) return null;

  const elementsOptions: StripeElementsOptions = {
    clientSecret: clientSecret,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#c9a96e',
        colorBackground: '#ffffff',
        colorText: '#1a1a1a',
        colorDanger: '#df1b41',
        fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px',
      }
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      <div className="fixed z-[70] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100%-32px))]">
        <Card className="shadow-2xl rounded-2xl overflow-hidden p-5" data-testid="product-payment-dialog">
          <div className="flex items-center gap-2 mb-4">
            <CreditCard className="w-5 h-5 text-primary" />
            <h2 className="font-serif text-lg font-semibold">Complete Your Purchase</h2>
          </div>

          {!stripeConfigQuery.data?.configured ? (
            <div className="text-center py-8">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                Payment system is being set up. Please try again in a moment.
              </p>
              <Button variant="outline" onClick={onCancel} className="mt-4">
                Go Back
              </Button>
            </div>
          ) : paymentSuccess ? (
            <div className="text-center py-8 space-y-3">
              {isProcessingFinal ? (
                <>
                  <Loader2 className="w-12 h-12 text-primary mx-auto animate-spin" />
                  <p className="text-sm text-muted-foreground">Confirming your order...</p>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                    <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
                  </div>
                  <h3 className="font-semibold text-lg">Order Complete!</h3>
                  <p className="text-sm text-muted-foreground">
                    Your purchase has been confirmed.
                  </p>
                </>
              )}
            </div>
          ) : stripePromise && clientSecret ? (
            <>
              {loyaltyPointsRedeemed && loyaltyPointsRedeemed > 0 && (
                <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 mb-4 space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>{subtotalAmount}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm text-green-600 dark:text-green-400">
                    <span>Loyalty Discount ({loyaltyPointsRedeemed * 300} pts)</span>
                    <span>-{loyaltyDiscountAmount}</span>
                  </div>
                  <div className="flex items-center justify-between font-semibold border-t border-amber-200 dark:border-amber-700 pt-1">
                    <span>Total</span>
                    <span>{totalAmount}</span>
                  </div>
                </div>
              )}
              <Elements stripe={stripePromise} options={elementsOptions}>
                <ProductPaymentForm
                  totalAmount={totalAmount}
                  clientSecret={clientSecret}
                  onSuccess={handlePaymentSuccess}
                  onCancel={onCancel}
                />
              </Elements>
            </>
          ) : (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading payment...</span>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

interface PaymentDialogProps {
  isOpen: boolean;
  bookingDetails: {
    serviceIds: string[];
    staffIds?: string[];
    startDateTime: string;
    branchId?: string;
    serviceName: string;
    servicePrice?: string;
  };
  clientId: string;
  sessionId?: string;
  loyaltyPoints?: number;
  isMassageService?: boolean;
  /** Pre-existing Stripe PaymentIntent client secret (e.g. from an SMS booking hold).
   *  When set the dialog skips the create-intent call and uses this secret directly. */
  initialClientSecret?: string;
  /** Pre-existing pending booking ID matching initialClientSecret. */
  initialPendingId?: string;
  /** Deposit amount in cents for pre-existing intents (used to show formatted amount). */
  initialDepositCents?: number;
  onSuccess: (bookingResponse: any) => void;
  onCancel: () => void;
  /** Called instead of onCancel when the booking failed because the slot was just
   *  taken — lets the parent refresh the availability picker with a tailored notice. */
  onSlotConflict?: () => void;
}

export function PaymentDialog({ 
  isOpen, 
  bookingDetails, 
  clientId, 
  sessionId,
  loyaltyPoints = 0,
  isMassageService = false,
  initialClientSecret,
  initialPendingId,
  initialDepositCents,
  onSuccess, 
  onCancel,
  onSlotConflict
}: PaymentDialogProps) {
  const [stripePromise, setStripePromise] = useState<Promise<any> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(initialClientSecret ?? null);
  const [pendingId, setPendingId] = useState<string | null>(initialPendingId ?? null);
  const [depositInfo, setDepositInfo] = useState<{ amount: string; percent: number } | null>(
    initialDepositCents != null
      ? { amount: `$${(initialDepositCents / 100).toFixed(2)}`, percent: 20 }
      : null
  );
  const [paymentSuccess, setPaymentSuccess] = useState(false);
  const [bookingLoyaltyPoints, setBookingLoyaltyPoints] = useState(0);
  const [loyaltyDiscountInfo, setLoyaltyDiscountInfo] = useState<{ points: number; discount: string } | null>(null);

  const stripeConfigQuery = useQuery<{ configured: boolean; publishableKey?: string; depositPercent?: number; salonPhone?: string | null }>({
    queryKey: ['/api/stripe/config'],
    enabled: isOpen
  });

  const createIntentMutation = useMutation({
    mutationFn: async () => {
      const sessionToken = localStorage.getItem('kozeta_session_token') || undefined;
      const response = await apiRequest("POST", "/api/payments/create-intent", {
        ...bookingDetails,
        clientId,
        sessionId,
        sessionToken,
        loyaltyPointsToRedeem: bookingLoyaltyPoints > 0 ? bookingLoyaltyPoints : undefined
      });
      if (!response.ok) {
        const error = await response.json();
        throw { message: error.error || "Failed to create payment", code: error.code, serverMessage: error.message };
      }
      return response.json();
    },
    onSuccess: (data) => {
      setClientSecret(data.clientSecret);
      setPendingId(data.pendingId);
      setDepositInfo({
        amount: data.depositAmountFormatted,
        percent: data.depositPercent
      });
      if (data.loyaltyPointsRedeemed > 0) {
        setLoyaltyDiscountInfo({
          points: data.loyaltyPointsRedeemed * 300,
          discount: data.loyaltyDiscountFormatted || `$${(data.loyaltyPointsRedeemed * 8).toFixed(2)}`
        });
      }
      // Server says this booking attempt was ALREADY paid (retry after an error).
      // Skip the card form entirely and go straight to finalizing — never charge twice.
      if (data.alreadyPaid) {
        setPaymentSuccess(true);
        finalizeMutation.mutate({ paymentIntentId: "", pendingIdOverride: data.pendingId });
      }
    },
    onError: () => {
      // Allow a retry if intent creation itself failed
      intentRequestedRef.current = false;
    }
  });

  const [finalizeError, setFinalizeError] = useState<{
    message: string;
    refunded: boolean;
    code?: string;
    paymentId?: string;
  } | null>(null);
  const [finalizeData, setFinalizeData] = useState<any>(null);

  const finalizeMutation = useMutation({
    mutationFn: async (args: { paymentIntentId: string; pendingIdOverride?: string }) => {
      const response = await fetch("/api/bookings/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ pendingId: args.pendingIdOverride ?? pendingId, paymentIntentId: args.paymentIntentId })
      });
      const data = await response.json();
      if (!response.ok) {
        throw { 
          message: data.message || data.error || "Failed to complete booking",
          refunded: data.refunded || false,
          code: data.code,
          paymentId: data.paymentId
        };
      }
      return data;
    },
    onSuccess: (data) => {
      setFinalizeData(data);
    },
    onError: (error: { message?: string; refunded?: boolean; code?: string; paymentId?: string } | Error) => {
      const errorObj = error as { message?: string; refunded?: boolean; code?: string; paymentId?: string };
      setFinalizeError({
        message: errorObj.message || 'Booking failed. Please contact us.',
        refunded: errorObj.refunded || false,
        code: errorObj.code,
        paymentId: errorObj.paymentId
      });
    }
  });

  const [loyaltyStepDone, setLoyaltyStepDone] = useState(!isMassageService || loyaltyPoints < 300);
  // Guard so the payment intent is only requested ONCE per dialog open —
  // prevents duplicate PaymentIntents (and possible double charges) if the
  // effect re-fires from dependency changes.
  const intentRequestedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      intentRequestedRef.current = false;
      return;
    }
    if (stripeConfigQuery.data?.configured && stripeConfigQuery.data.publishableKey) {
      setStripePromise(loadStripe(stripeConfigQuery.data.publishableKey));
      // Skip create-intent when an existing client secret was passed in (e.g. SMS booking hold)
      const hasExistingIntent = !!initialClientSecret;
      if (loyaltyStepDone && !intentRequestedRef.current && !clientSecret && !hasExistingIntent) {
        intentRequestedRef.current = true;
        createIntentMutation.mutate();
      }
    }
  }, [isOpen, stripeConfigQuery.data?.configured, loyaltyStepDone]);

  const handlePaymentSuccess = (paymentIntentId: string) => {
    setPaymentSuccess(true);
    finalizeMutation.mutate({ paymentIntentId });
  };

  if (!isOpen) return null;

  const elementsOptions: StripeElementsOptions = {
    clientSecret: clientSecret || undefined,
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#c9a96e',
        colorBackground: '#ffffff',
        colorText: '#1a1a1a',
        colorDanger: '#df1b41',
        fontFamily: 'system-ui, sans-serif',
        borderRadius: '8px',
      }
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
        onClick={() => finalizeData ? onSuccess(finalizeData) : onCancel()}
      />

      <div className="fixed z-[70] top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(420px,calc(100%-32px))]">
        <Card className="shadow-2xl rounded-2xl overflow-hidden p-5" data-testid="payment-dialog">
          <div className="flex items-center gap-2 mb-4">
            <CreditCard className="w-5 h-5 text-primary" />
            <h2 className="font-serif text-lg font-semibold">Secure Deposit Payment</h2>
          </div>

          {!stripeConfigQuery.data?.configured ? (
            <div className="text-center py-8">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">
                Payment system is being set up. Please try again in a moment.
              </p>
              <Button variant="outline" onClick={onCancel} className="mt-4">
                Go Back
              </Button>
            </div>
          ) : isMassageService && loyaltyPoints >= 300 && !loyaltyStepDone ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This is a massage service. You can use your loyalty points for a discount!
              </p>
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Star className="w-4 h-4 text-amber-500" />
                  <span className="text-sm font-medium">Loyalty Points</span>
                  <span className="text-xs text-muted-foreground ml-auto">
                    {loyaltyPoints} pts available
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">300 points = $8 off your massage (stack multiple)</p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    onClick={() => setBookingLoyaltyPoints(Math.max(0, bookingLoyaltyPoints - 1))}
                    disabled={bookingLoyaltyPoints <= 0}
                    data-testid="button-booking-loyalty-minus"
                  >
                    -
                  </Button>
                  <span className="text-sm font-bold w-8 text-center" data-testid="text-booking-loyalty-points">{bookingLoyaltyPoints}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    onClick={() => setBookingLoyaltyPoints(Math.min(bookingLoyaltyPoints + 1, Math.floor(loyaltyPoints / 300)))}
                    disabled={bookingLoyaltyPoints >= Math.floor(loyaltyPoints / 300)}
                    data-testid="button-booking-loyalty-plus"
                  >
                    +
                  </Button>
                  {bookingLoyaltyPoints > 0 && (
                    <span className="text-sm text-green-600 dark:text-green-400 font-medium ml-auto">
                      -{bookingLoyaltyPoints * 300} pts / -${(bookingLoyaltyPoints * 8).toFixed(2)} off
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setBookingLoyaltyPoints(0); setLoyaltyStepDone(true); }} className="flex-1">
                  Skip
                </Button>
                <Button onClick={() => setLoyaltyStepDone(true)} className="flex-1">
                  {bookingLoyaltyPoints > 0 ? `Apply ${bookingLoyaltyPoints * 300} Points` : "Continue"}
                </Button>
              </div>
            </div>
          ) : paymentSuccess ? (
            <div className="text-center py-8 space-y-3">
              {finalizeMutation.isPending ? (
                <>
                  <Loader2 className="w-12 h-12 text-primary mx-auto animate-spin" />
                  <p className="text-sm text-muted-foreground">Confirming your booking...</p>
                </>
              ) : finalizeError ? (
                <>
                  <AlertCircle className={`w-12 h-12 mx-auto ${finalizeError.code === 'REFUND_FAILED' ? 'text-red-500' : 'text-amber-500'}`} />
                  <p className="font-medium">
                    {finalizeError.code === 'SLOT_CONFLICT'
                      ? "Time Slot Taken"
                      : finalizeError.code === 'REFUND_FAILED'
                      ? "Action Required"
                      : finalizeError.code === 'BOOKING_STATUS_UNKNOWN'
                      ? "Confirming Your Booking"
                      : "Booking Unavailable"}
                  </p>
                  <p className="text-sm text-muted-foreground">{finalizeError.message}</p>
                  <div className={`rounded-lg p-3 text-sm font-medium ${finalizeError.refunded
                    ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
                    : finalizeError.code === 'BOOKING_STATUS_UNKNOWN'
                    ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400'
                    : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'}`}
                    data-testid="text-refund-status"
                  >
                    {finalizeError.refunded
                      ? 'Your deposit has been fully refunded — you have not been charged.'
                      : finalizeError.code === 'BOOKING_STATUS_UNKNOWN'
                      ? 'Please do NOT pay again. Your deposit is safe — if the booking did not go through, it will be refunded automatically within 30 minutes.'
                      : 'Please do NOT pay again. Call us and we will resolve this right away.'}
                  </div>
                  {!finalizeError.refunded && stripeConfigQuery.data?.salonPhone && finalizeError.code !== 'REFUND_FAILED' && (
                    <a href={`tel:${stripeConfigQuery.data.salonPhone}`} className="flex items-center justify-center gap-2 w-full">
                      <Button variant="outline" className="w-full gap-2" data-testid="button-call-salon-generic">
                        <Phone className="w-4 h-4" />
                        Call Kozeta Salon
                      </Button>
                    </a>
                  )}
                  {finalizeError.code === 'REFUND_FAILED' && finalizeError.paymentId && (
                    <div className="mt-3 space-y-2">
                      <div className="bg-muted rounded-lg p-3 text-left space-y-2">
                        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Payment Reference</p>
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono flex-1 truncate">{finalizeError.paymentId}</code>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => navigator.clipboard.writeText(finalizeError.paymentId!)}
                            data-testid="button-copy-payment-id"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                      {stripeConfigQuery.data?.salonPhone && (
                        <a href={`tel:${stripeConfigQuery.data.salonPhone}`} className="flex items-center justify-center gap-2 w-full">
                          <Button variant="outline" className="w-full gap-2" data-testid="button-call-salon">
                            <Phone className="w-4 h-4" />
                            Call Kozeta Salon
                          </Button>
                        </a>
                      )}
                    </div>
                  )}
                  <Button
                    onClick={() => {
                      if (finalizeError.code === 'SLOT_CONFLICT' && onSlotConflict) {
                        onSlotConflict();
                      } else {
                        onCancel();
                      }
                    }}
                    className="mt-2 w-full"
                    data-testid="button-finalize-error-action"
                  >
                    {finalizeError.code === 'SLOT_CONFLICT' ? "Choose Another Time" : finalizeError.refunded ? "Try Again" : "Done"}
                  </Button>
                </>
              ) : finalizeData ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                    <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
                  </div>
                  <h3 className="font-semibold text-lg">Booking Confirmed!</h3>
                  {finalizeData.serviceName && (
                    <p className="text-sm font-medium">{finalizeData.serviceName}</p>
                  )}
                  {finalizeData.staffName && (
                    <p className="text-sm text-muted-foreground">with {finalizeData.staffName}</p>
                  )}
                  {finalizeData.startDateTime && (
                    <p className="text-sm text-muted-foreground">
                      {new Date(finalizeData.startDateTime).toLocaleDateString('en-CA', {
                        weekday: 'long', month: 'long', day: 'numeric'
                      })}{' '}at{' '}
                      {new Date(finalizeData.startDateTime).toLocaleTimeString('en-CA', {
                        hour: 'numeric', minute: '2-digit', hour12: true
                      })}
                    </p>
                  )}
                  {(finalizeData.depositPaidFormatted || finalizeData.remainingBalanceFormatted) && (
                    <div className="bg-muted rounded-lg p-3 text-sm space-y-1 text-left w-full mt-1">
                      {finalizeData.depositPaidFormatted && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Deposit paid</span>
                          <span className="font-medium text-green-600">{finalizeData.depositPaidFormatted}</span>
                        </div>
                      )}
                      {finalizeData.remainingBalanceFormatted && finalizeData.remainingBalance > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Due at salon</span>
                          <span className="font-medium">{finalizeData.remainingBalanceFormatted}</span>
                        </div>
                      )}
                      {finalizeData.loyaltyPointsEarned > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Points earned</span>
                          <span className="font-medium text-amber-600">+{finalizeData.loyaltyPointsEarned} pts</span>
                        </div>
                      )}
                    </div>
                  )}
                  <Button
                    className="w-full mt-2"
                    onClick={() => onSuccess(finalizeData)}
                    data-testid="button-booking-confirmed-done"
                  >
                    Done
                  </Button>
                </>
              ) : null}
            </div>
          ) : createIntentMutation.isError ? (
            <div className="text-center py-8 space-y-3" data-testid="payment-setup-error">
              <AlertCircle className="w-8 h-8 text-destructive mx-auto" />
              <p className="text-sm text-muted-foreground">
                {createIntentMutation.error?.message?.replace(/^\d{3}:\s*/, '').replace(/^\{.*"error"\s*:\s*"([^"]+)".*\}$/, '$1') || "Failed to set up payment"}
              </p>
              <Button variant="outline" onClick={onCancel} data-testid="button-payment-error-back">Go Back</Button>
            </div>
          ) : createIntentMutation.isPending || !clientSecret ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Preparing payment...</span>
            </div>
          ) : stripePromise && clientSecret ? (
            <Elements stripe={stripePromise} options={elementsOptions}>
              <PaymentForm
                pendingId={pendingId!}
                depositAmount={depositInfo?.amount || "$0"}
                serviceName={bookingDetails.serviceName}
                clientSecret={clientSecret!}
                onSuccess={handlePaymentSuccess}
                onCancel={onCancel}
              />
            </Elements>
          ) : null}
        </Card>
      </div>
    </>
  );
}
