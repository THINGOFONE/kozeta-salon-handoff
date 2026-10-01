const STRIPE_API = "https://api.stripe.com/v1";

function getCredentials() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) {
    throw new Error("Stripe API keys not configured. Please set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY.");
  }
  return { secretKey, publishableKey };
}

function encodeParams(obj: Record<string, any>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === "object") {
          parts.push(encodeParams(v, `${fullKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(fullKey)}[${i}]=${encodeURIComponent(String(v))}`);
        }
      });
    } else if (typeof value === "object") {
      parts.push(encodeParams(value, fullKey));
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.join("&");
}

async function stripeRequest(
  method: string,
  path: string,
  body?: Record<string, any>,
  options?: { idempotencyKey?: string }
): Promise<any> {
  const { secretKey } = getCredentials();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Stripe-side idempotency: retries of the same logical operation (network
  // blips, client retries) can never create a duplicate charge or refund.
  if (options?.idempotencyKey) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers,
    body: body ? encodeParams(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const message = data?.error?.message || `Stripe API error ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function getStripeClient() {
  return {
    paymentIntents: {
      create: (params: Record<string, any>, options?: { idempotencyKey?: string }) =>
        stripeRequest("POST", "/payment_intents", params, options),
      retrieve: (id: string) =>
        stripeRequest("GET", `/payment_intents/${id}`),
      update: (id: string, params: Record<string, any>) =>
        stripeRequest("POST", `/payment_intents/${id}`, params),
      list: (params: Record<string, any> = {}) =>
        stripeRequest("GET", `/payment_intents?${encodeParams(params)}`),
      search: (params: Record<string, any>) =>
        stripeRequest("GET", `/payment_intents/search?${encodeParams(params)}`),
    },
    charges: {
      retrieve: (id: string) =>
        stripeRequest("GET", `/charges/${id}`),
    },
    refunds: {
      create: (params: Record<string, any>, options?: { idempotencyKey?: string }) =>
        stripeRequest("POST", "/refunds", params, options),
      list: (params: Record<string, any> = {}) =>
        stripeRequest("GET", `/refunds?${encodeParams(params)}`),
    },
    customers: {
      create: (params: Record<string, any>) =>
        stripeRequest("POST", "/customers", params),
      retrieve: (id: string) =>
        stripeRequest("GET", `/customers/${id}`),
      search: (params: Record<string, any>) =>
        stripeRequest("GET", `/customers/search?${encodeParams(params)}`),
    },
    paymentMethods: {
      list: (params: Record<string, any>) =>
        stripeRequest("GET", `/payment_methods?${encodeParams(params)}`),
      retrieve: (id: string) =>
        stripeRequest("GET", `/payment_methods/${id}`),
      attach: (id: string, params: Record<string, any>) =>
        stripeRequest("POST", `/payment_methods/${id}/attach`, params),
    },
    setupIntents: {
      create: (params: Record<string, any>) =>
        stripeRequest("POST", "/setup_intents", params),
    },
    account: {
      // Read-only: Stripe forbids POST /v1/account on your own (non-connected)
      // account, so the payout statement descriptor ("KS DEPOSITS") must be set
      // manually in the Stripe Dashboard → Settings → Bank accounts and payouts.
      retrieve: () => stripeRequest("GET", "/account"),
    },
  };
}

// ─── Saved card helpers ───────────────────────────────────────────────────

/** Find or create a Stripe Customer for a Phorest clientId. */
export async function getOrCreateStripeCustomer(
  phorestClientId: string,
  name?: string,
  email?: string
): Promise<string> {
  const stripe = await getStripeClient();
  // Search by metadata.phorestClientId
  const searchResult = await stripe.customers.search({
    query: `metadata['phorestClientId']:'${phorestClientId}'`,
    limit: 1,
  }).catch(() => ({ data: [] as any[] }));

  if (searchResult.data?.length > 0) {
    return searchResult.data[0].id;
  }

  const params: Record<string, any> = {
    metadata: { phorestClientId },
  };
  if (name) params.name = name;
  if (email) params.email = email;

  const customer = await stripe.customers.create(params);
  return customer.id;
}

export interface SavedCard {
  paymentMethodId: string;
  brand: string;
  last4: string;
}

/** List the saved payment methods for a Stripe Customer, newest first. */
export async function listSavedCards(customerId: string): Promise<SavedCard[]> {
  const stripe = await getStripeClient();
  const result = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 5 });
  return (result.data ?? []).map((pm: any) => ({
    paymentMethodId: pm.id,
    brand: pm.card?.brand ?? "card",
    last4: pm.card?.last4 ?? "••••",
  }));
}

/** Create a Stripe SetupIntent so a client can save their card after payment. */
export async function createSetupIntent(customerId: string): Promise<{ clientSecret: string; setupIntentId: string }> {
  const stripe = await getStripeClient();
  const si = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ["card"],
    usage: "off_session",
  });
  return { clientSecret: si.client_secret, setupIntentId: si.id };
}

/** Charge a saved card directly (off-session). Returns the PaymentIntent. */
export async function chargeSavedCard(
  customerId: string,
  paymentMethodId: string,
  amountCents: number,
  currency: string,
  idempotencyKey: string,
  metadata: Record<string, string>,
  extraParams?: Record<string, any>
): Promise<any> {
  const stripe = await getStripeClient();
  return stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      metadata,
      ...(extraParams || {}),
    },
    { idempotencyKey }
  );
}

export async function getStripePublishableKey(): Promise<string> {
  const { publishableKey } = getCredentials();
  return publishableKey;
}

export async function isStripeConfigured(): Promise<boolean> {
  try {
    getCredentials();
    return true;
  } catch {
    return false;
  }
}
