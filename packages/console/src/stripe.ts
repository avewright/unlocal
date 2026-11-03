import { UnlocalError } from "@unlocal/core";

/**
 * Stripe Checkout through its REST API (no SDK). Enabled when STRIPE_SECRET_KEY is set.
 * Use a test key (sk_test_…) until launch. Crediting is verified server-side by
 * retrieving the Checkout Session, never trusted from the browser.
 */

export const stripeEnabled = (env: NodeJS.ProcessEnv) => Boolean(env.STRIPE_SECRET_KEY);
const api = (env: NodeJS.ProcessEnv) => env.STRIPE_API_BASE ?? "https://api.stripe.com";

async function call(env: NodeJS.ProcessEnv, method: "GET" | "POST", path: string, body?: URLSearchParams) {
  const res = await fetch(`${api(env)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body,
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) {
    throw new UnlocalError("PAYMENT_FAILED", `Stripe: ${json.error?.message ?? res.statusText}`);
  }
  return json;
}

export async function createCheckout(
  env: NodeJS.ProcessEnv,
  opts: { amountUsd: number; userId: string; baseUrl: string },
): Promise<string> {
  const session = await call(env, "POST", "/v1/checkout/sessions", new URLSearchParams({
    mode: "payment",
    success_url: `${opts.baseUrl}/api/funds/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${opts.baseUrl}/`,
    client_reference_id: opts.userId,
    "metadata[unlocal_user]": opts.userId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(Math.round(opts.amountUsd * 100)),
    "line_items[0][price_data][product_data][name]": "unlocal balance",
  }));
  return session.url as string;
}

export async function fetchCheckout(env: NodeJS.ProcessEnv, sessionId: string) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new UnlocalError("USAGE", "invalid checkout session");
  const s = await call(env, "GET", `/v1/checkout/sessions/${sessionId}`);
  return {
    paid: s.payment_status === "paid",
    amountUsd: (s.amount_total ?? 0) / 100,
    userId: s.metadata?.unlocal_user as string | undefined,
  };
}
