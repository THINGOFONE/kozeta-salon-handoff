declare global {
  interface Window {
    Stripe?: (publishableKey: string, options?: any) => any;
  }
}

export async function loadStripe(publishableKey: string): Promise<any> {
  if (!window.Stripe) {
    await new Promise<void>((resolve) => {
      const check = () => {
        if (window.Stripe) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }
  return window.Stripe!(publishableKey);
}

export type StripeElementsOptions = {
  clientSecret?: string;
  appearance?: any;
  [key: string]: any;
};
