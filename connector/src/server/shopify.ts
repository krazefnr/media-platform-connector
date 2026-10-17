import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckoutInput, OrderInput } from "./connector.js";
import type { CustomerData, LineItem } from "./conversions.js";
import { isUuid } from "./validate.js";

const uuidOrNull = (v: string | undefined) => (v && isUuid(v) ? v : null);

/*
 * Shopify helpers for stores whose own site creates the cart (Storefront API)
 * and hands off to Shopify's checkout. The site copies connector.cartAttributes()
 * onto the cart; Shopify passes them through to its checkout and order webhooks
 * as note_attributes, where these helpers read them back.
 */

/** Cart attribute names the connector reads back from Shopify webhooks. */
export const SHOPIFY_ATTRIBUTES = {
  click: "md_click",
  visitor: "md_vid",
  fbp: "md_fbp",
  fbc: "md_fbc",
  ttp: "md_ttp",
  ttclid: "md_ttclid",
  ga: "md_ga",
  cart: "md_cart",
} as const;

/**
 * The token Shopify's webhooks call cart_token, from a Storefront API cart id
 * ("gid://shopify/Cart/<token>?key=...") or a checkoutUrl (".../cart/c/<token>?key=...").
 * Use it as checkoutId when the site records the checkout itself.
 */
export function shopifyCartToken(cartIdOrUrl: string): string | null {
  const m = cartIdOrUrl.match(/(?:gid:\/\/shopify\/Cart\/|\/cart\/c\/)([A-Za-z0-9_-]{8,200})/);
  return m ? m[1]! : null;
}

/** true when the raw webhook body was signed with the store's webhook secret (x-shopify-hmac-sha256). */
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null | undefined, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const digest = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === digest.length && timingSafeEqual(given, digest);
}

type Json = Record<string, any>;

function attributes(body: Json): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of Array.isArray(body.note_attributes) ? body.note_attributes : []) {
    const name = typeof a?.name === "string" ? a.name : typeof a?.key === "string" ? a.key : null;
    if (name && typeof a.value === "string") map.set(name, a.value);
  }
  return map;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function customer(body: Json, attrs: Map<string, string>): CustomerData {
  const c = body.customer ?? {};
  const address = body.shipping_address ?? body.billing_address ?? {};
  const client = body.client_details ?? {};
  const out: CustomerData = {
    email: text(body.email) ?? text(c.email),
    phone: text(body.phone) ?? text(c.phone) ?? text(address.phone),
    firstName: text(c.first_name) ?? text(address.first_name),
    lastName: text(c.last_name) ?? text(address.last_name),
    city: text(address.city),
    postcode: text(address.zip),
    country: text(address.country_code),
    externalId: text(c.id),
    ip: text(body.browser_ip) ?? text(client.browser_ip),
    userAgent: text(client.user_agent),
    fbp: attrs.get(SHOPIFY_ATTRIBUTES.fbp) ?? null,
    fbc: attrs.get(SHOPIFY_ATTRIBUTES.fbc) ?? null,
    ttp: attrs.get(SHOPIFY_ATTRIBUTES.ttp) ?? null,
    ttclid: attrs.get(SHOPIFY_ATTRIBUTES.ttclid) ?? null,
    gaClientId: attrs.get(SHOPIFY_ATTRIBUTES.ga) ?? null,
  };
  for (const k of Object.keys(out) as (keyof CustomerData)[]) if (out[k] === null) delete out[k];
  return out;
}

function items(body: Json): LineItem[] {
  return (Array.isArray(body.line_items) ? body.line_items : []).map((l: Json) => ({
    id: text(l.sku) ?? text(l.variant_id) ?? text(l.product_id) ?? "item",
    name: text(l.title),
    quantity: Number(l.quantity ?? 1),
    price: Number(l.price ?? 0),
  }));
}

const code = (body: Json) => text(body.discount_codes?.[0]?.code);

/** Webhooks checkouts/create and checkouts/update -> connector.recordCheckout(). */
export function shopifyCheckoutInput(body: Json): CheckoutInput {
  const attrs = attributes(body);
  const who = customer(body, attrs);
  return {
    // Keyed by the cart, so it merges with the checkout the site recorded when the shopper typed their email.
    checkoutId: text(body.cart_token) ?? text(body.token) ?? text(body.id) ?? "",
    clickId: uuidOrNull(attrs.get(SHOPIFY_ATTRIBUTES.click)),
    visitorId: uuidOrNull(attrs.get(SHOPIFY_ATTRIBUTES.visitor)),
    code: code(body),
    cartTotal: body.total_price ?? "0",
    currency: text(body.currency) ?? "GBP",
    customer: who,
    items: items(body),
    customerRef: text(body.customer?.id),
    recoveryUrl: text(body.abandoned_checkout_url),
    marketingConsent: body.buyer_accepts_marketing === true,
    test: body.test === true,
  };
}

/** Webhook orders/paid -> connector.recordOrder(). */
export function shopifyOrderInput(body: Json): OrderInput {
  const attrs = attributes(body);
  return {
    orderId: text(body.id) ?? "",
    checkoutId: text(body.cart_token) ?? text(body.checkout_token),
    clickId: uuidOrNull(attrs.get(SHOPIFY_ATTRIBUTES.click)),
    visitorId: uuidOrNull(attrs.get(SHOPIFY_ATTRIBUTES.visitor)),
    code: code(body),
    amount: body.current_total_price ?? body.total_price ?? "0",
    currency: text(body.currency) ?? "GBP",
    occurredAt: text(body.processed_at) ?? text(body.created_at),
    test: body.test === true,
    customer: customer(body, attrs),
    items: items(body),
    sourceUrl: text(body.order_status_url),
  };
}

export type StorefrontOptions = {
  /** e.g. "kraze.myshopify.com". */
  storeDomain: string;
  /** The Storefront API access token the site already uses (public). */
  storefrontToken: string;
  /** Default "2026-07". */
  apiVersion?: string;
  fetch?: typeof fetch;
};

export type StorefrontCart = {
  id: string;
  checkoutUrl: string;
  total: number;
  currency: string;
  email: string | null;
  attributes: Array<{ key: string; value: string }>;
  items: LineItem[];
};

export class StorefrontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorefrontError";
  }
}

/** The shop's Storefront API endpoint. http only for local test shops. */
export function storefrontEndpoint(storeDomain: string, apiVersion = "2026-07"): string {
  const domain = storeDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(domain)) throw new StorefrontError("storeDomain must look like kraze.myshopify.com");
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(domain);
  return `${local ? "http" : "https"}://${domain}/api/${apiVersion}/graphql.json`;
}

const CART_QUERY = `query MdCart($id: ID!) {
  cart(id: $id) {
    id
    checkoutUrl
    cost { totalAmount { amount currencyCode } }
    buyerIdentity { email }
    attributes { key value }
    lines(first: 100) { nodes { quantity merchandise { ... on ProductVariant { id sku title price { amount } product { title } } } } }
  }
}`;

const ATTRIBUTES_MUTATION = `mutation MdAttrs($cartId: ID!, $attributes: [AttributeInput!]!) {
  cartAttributesUpdate(cartId: $cartId, attributes: $attributes) { userErrors { message } }
}`;

const EMAIL_MUTATION = `mutation MdEmail($cartId: ID!, $buyerIdentity: CartBuyerIdentityInput!) {
  cartBuyerIdentityUpdate(cartId: $cartId, buyerIdentity: $buyerIdentity) { userErrors { message } }
}`;

export function createStorefront(options: StorefrontOptions) {
  const endpoint = storefrontEndpoint(options.storeDomain, options.apiVersion);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-storefront-access-token": options.storefrontToken },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) throw new StorefrontError(`Shopify answered ${response.status}`);
    const body = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (body.errors?.length) throw new StorefrontError(body.errors[0]?.message ?? "Shopify returned an error");
    if (!body.data) throw new StorefrontError("Shopify returned no data");
    return body.data;
  }
  return {
    async cart(id: string): Promise<StorefrontCart | null> {
      const data = await gql<{ cart: Json | null }>(CART_QUERY, { id });
      const c = data.cart;
      if (!c) return null;
      const lines = Array.isArray(c.lines?.nodes) ? c.lines.nodes : [];
      return {
        id: String(c.id),
        checkoutUrl: String(c.checkoutUrl ?? ""),
        total: Number(c.cost?.totalAmount?.amount ?? 0),
        currency: String(c.cost?.totalAmount?.currencyCode ?? "GBP"),
        email: typeof c.buyerIdentity?.email === "string" ? c.buyerIdentity.email : null,
        attributes: (Array.isArray(c.attributes) ? c.attributes : [])
          .filter((a: Json) => typeof a?.key === "string" && typeof a?.value === "string")
          .map((a: Json) => ({ key: a.key as string, value: a.value as string })),
        items: lines.map((l: Json) => ({
          id: text(l.merchandise?.sku) ?? text(l.merchandise?.id) ?? "item",
          name: text(l.merchandise?.product?.title) ?? text(l.merchandise?.title),
          quantity: Number(l.quantity ?? 1),
          price: Number(l.merchandise?.price?.amount ?? 0),
        })),
      };
    },
    async setAttributes(cartId: string, attributes: Array<{ key: string; value: string }>) {
      await gql(ATTRIBUTES_MUTATION, { cartId, attributes });
    },
    async setEmail(cartId: string, email: string) {
      await gql(EMAIL_MUTATION, { cartId, buyerIdentity: { email } });
    },
  };
}
