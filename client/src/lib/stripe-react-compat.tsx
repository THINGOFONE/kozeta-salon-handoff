import { createContext, useContext, useEffect, useRef, useState } from "react";

interface StripeContextValue {
  stripe: any;
  elements: any;
}

const StripeCtx = createContext<StripeContextValue | null>(null);

export function Elements({
  stripe: stripePromise,
  options,
  children,
}: {
  stripe: Promise<any> | null;
  options?: any;
  children: React.ReactNode;
}) {
  const [ctx, setCtx] = useState<StripeContextValue | null>(null);
  const clientSecret = options?.clientSecret;

  useEffect(() => {
    if (!stripePromise) return;
    let cancelled = false;
    stripePromise.then((stripe) => {
      if (cancelled || !stripe) return;
      const elements = stripe.elements(options);
      setCtx({ stripe, elements });
    });
    return () => { cancelled = true; };
  }, [stripePromise, clientSecret]);

  return <StripeCtx.Provider value={ctx}>{children}</StripeCtx.Provider>;
}

export function useStripe() {
  return useContext(StripeCtx)?.stripe ?? null;
}

export function useElements() {
  return useContext(StripeCtx)?.elements ?? null;
}

function StripeElement({
  type,
  onReady,
  options,
}: {
  type: string;
  onReady?: () => void;
  options?: any;
}) {
  const elements = useElements();
  const containerRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (!elements || !containerRef.current || mountedRef.current) return;
    mountedRef.current = true;
    const el = elements.create(type, options);
    el.mount(containerRef.current);
    if (onReady) el.on("ready", onReady);
    return () => {
      el.destroy();
      mountedRef.current = false;
    };
  }, [elements]);

  return <div ref={containerRef} />;
}

export function CardNumberElement({
  onReady,
  options,
}: {
  onReady?: () => void;
  options?: any;
}) {
  return <StripeElement type="cardNumber" onReady={onReady} options={options} />;
}

export function CardExpiryElement({
  onReady,
  options,
}: {
  onReady?: () => void;
  options?: any;
}) {
  return <StripeElement type="cardExpiry" onReady={onReady} options={options} />;
}

export function CardCvcElement({
  onReady,
  options,
}: {
  onReady?: () => void;
  options?: any;
}) {
  return <StripeElement type="cardCvc" onReady={onReady} options={options} />;
}
