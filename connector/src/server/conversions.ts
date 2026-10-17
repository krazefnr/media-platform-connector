import { createHash } from "node:crypto";
import { cleanText } from "./validate.js";

/*
 * Server-side conversion forwarding: the brand's own server sends checkout and
 * purchase events straight to Meta, TikTok and Google, so ad blockers and iOS
 * browser limits don't lose them. Personal data is normalised and SHA-256
 * hashed before it leaves, as each platform requires, and is never stored.
 */

export type MetaConversions = { pixelId: string; accessToken: string; testEventCode?: string; apiVersion?: string };
export type TikTokConversions = { pixelCode: string; accessToken: string; testEventCode?: string };
export type Ga4Conversions = { measurementId: string; apiSecret: string };

export type ConversionPlatform = "meta" | "tiktok" | "ga4";

export type ConversionsOptions = {
  meta?: MetaConversions;
  tiktok?: TikTokConversions;
  ga4?: Ga4Conversions;
  /** Forward test-mode orders too (only useful with a testEventCode). Default false. */
  forwardTestEvents?: boolean;
  /** Called when a platform rejects an event or can't be reached. Forwarding never throws. */
  onError?: (platform: ConversionPlatform, error: Error) => void;
  /** Per-request timeout. Default 5000. */
  timeoutMs?: number;
};

/** What the brand knows about the shopper. Everything is optional; more matches more conversions. */
export type CustomerData = {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  postcode?: string | null;
  /** ISO 3166-1 alpha-2, e.g. "GB". */
  country?: string | null;
  /** The brand's own customer id. */
  externalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Meta browser cookies _fbp / _fbc. */
  fbp?: string | null;
  fbc?: string | null;
  /** TikTok browser cookie _ttp and the ttclid from the landing URL. */
  ttp?: string | null;
  ttclid?: string | null;
  /** GA4 client id, from the _ga cookie. GA4 forwarding is skipped without it. */
  gaClientId?: string | null;
};

export type LineItem = { id: string; name?: string | null; quantity: number; price: number };

export type ConversionEvent = {
  kind: "checkout" | "purchase";
  /** The order or checkout id; platforms use it to dedupe against the browser pixel. */
  eventId: string;
  value: number;
  currency: string;
  occurredAt: Date;
  customer: CustomerData;
  items: LineItem[];
  sourceUrl: string | null;
};

export type ForwardResult = { platform: ConversionPlatform; status: "sent" | "skipped" | "failed"; detail?: string };

export type Forwarder = {
  readonly platforms: ConversionPlatform[];
  send(event: ConversionEvent): Promise<ForwardResult[]>;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function hashed(value: string | null | undefined, normalise: (v: string) => string = (v) => v.trim().toLowerCase()) {
  if (!value) return null;
  const v = normalise(value);
  if (!v) return null;
  // Already a SHA-256 hex digest: pass it through rather than hashing twice.
  return /^[0-9a-f]{64}$/.test(v) ? v : sha256(v);
}

const phoneDigits = (v: string) => v.replace(/[^0-9]/g, "");
const phoneE164 = (v: string) => {
  const digits = phoneDigits(v);
  return digits ? `+${digits}` : "";
};
const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Normalises the shopper data a brand passes in: trimmed strings only, nothing else. */
export function cleanCustomer(input: unknown): CustomerData {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: CustomerData = {};
  const keys: (keyof CustomerData)[] = [
    "email", "phone", "firstName", "lastName", "city", "postcode", "country", "externalId",
    "ip", "userAgent", "fbp", "fbc", "ttp", "ttclid", "gaClientId",
  ];
  for (const k of keys) {
    const v = cleanText(raw[k], k === "userAgent" ? 500 : 200);
    if (v) out[k] = v;
  }
  return out;
}

export function cleanItems(input: unknown): LineItem[] {
  if (!Array.isArray(input)) return [];
  const items: LineItem[] = [];
  for (const raw of input.slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = cleanText(typeof r.id === "number" ? String(r.id) : r.id, 100);
    const quantity = Number(r.quantity ?? 1);
    const price = Number(r.price ?? 0);
    if (!id || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) continue;
    items.push({ id, name: cleanText(r.name, 200), quantity: Math.round(quantity), price });
  }
  return items;
}

function metaBody(e: ConversionEvent, testEventCode?: string) {
  const c = e.customer;
  const user: Record<string, unknown> = {};
  const put = (k: string, v: string | null) => {
    if (v) user[k] = [v];
  };
  put("em", hashed(c.email));
  put("ph", hashed(c.phone, phoneDigits));
  put("fn", hashed(c.firstName));
  put("ln", hashed(c.lastName));
  put("ct", hashed(c.city, squash));
  put("zp", hashed(c.postcode, squash));
  put("country", hashed(c.country, squash));
  put("external_id", hashed(c.externalId));
  if (c.ip) user.client_ip_address = c.ip;
  if (c.userAgent) user.client_user_agent = c.userAgent;
  if (c.fbp) user.fbp = c.fbp;
  if (c.fbc) user.fbc = c.fbc;
  return {
    data: [
      {
        event_name: e.kind === "purchase" ? "Purchase" : "InitiateCheckout",
        event_time: Math.floor(e.occurredAt.getTime() / 1000),
        event_id: e.eventId,
        action_source: "website",
        ...(e.sourceUrl ? { event_source_url: e.sourceUrl } : {}),
        user_data: user,
        custom_data: {
          currency: e.currency,
          value: e.value,
          ...(e.kind === "purchase" ? { order_id: e.eventId } : {}),
          ...(e.items.length
            ? {
                content_type: "product",
                content_ids: e.items.map((i) => i.id),
                contents: e.items.map((i) => ({ id: i.id, quantity: i.quantity, item_price: i.price })),
                num_items: e.items.reduce((n, i) => n + i.quantity, 0),
              }
            : {}),
        },
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

function tiktokBody(e: ConversionEvent, pixelCode: string, testEventCode?: string) {
  const c = e.customer;
  const user: Record<string, unknown> = {};
  const email = hashed(c.email);
  const phone = hashed(c.phone, phoneE164);
  const external = hashed(c.externalId);
  if (email) user.email = email;
  if (phone) user.phone = phone;
  if (external) user.external_id = external;
  if (c.ip) user.ip = c.ip;
  if (c.userAgent) user.user_agent = c.userAgent;
  if (c.ttp) user.ttp = c.ttp;
  if (c.ttclid) user.ttclid = c.ttclid;
  return {
    event_source: "web",
    event_source_id: pixelCode,
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
    data: [
      {
        event: e.kind === "purchase" ? "CompletePayment" : "InitiateCheckout",
        event_time: Math.floor(e.occurredAt.getTime() / 1000),
        event_id: e.eventId,
        user,
        ...(e.sourceUrl ? { page: { url: e.sourceUrl } } : {}),
        properties: {
          currency: e.currency,
          value: e.value,
          ...(e.kind === "purchase" ? { order_id: e.eventId } : {}),
          ...(e.items.length
            ? {
                content_type: "product",
                contents: e.items.map((i) => ({ content_id: i.id, content_name: i.name ?? undefined, quantity: i.quantity, price: i.price })),
              }
            : {}),
        },
      },
    ],
  };
}

function ga4Body(e: ConversionEvent, clientId: string) {
  return {
    client_id: clientId,
    ...(e.customer.externalId ? { user_id: e.customer.externalId } : {}),
    timestamp_micros: e.occurredAt.getTime() * 1000,
    events: [
      {
        name: e.kind === "purchase" ? "purchase" : "begin_checkout",
        params: {
          currency: e.currency,
          value: e.value,
          ...(e.kind === "purchase" ? { transaction_id: e.eventId } : {}),
          items: e.items.map((i) => ({ item_id: i.id, item_name: i.name ?? i.id, quantity: i.quantity, price: i.price })),
        },
      },
    ],
  };
}

/** "GA1.1.123456789.1700000000" (the _ga cookie) -> "123456789.1700000000". A bare client id is kept. */
export function gaClientIdFromCookie(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^GA\d\.\d+\.(\d+\.\d+)$/);
  if (m) return m[1]!;
  return /^\d+\.\d+$/.test(value) ? value : null;
}

export function createForwarder(options: ConversionsOptions | undefined, fetchImpl: typeof fetch): Forwarder | null {
  if (!options) return null;
  const platforms: ConversionPlatform[] = [];
  if (options.meta) {
    if (!/^\d{5,25}$/.test(options.meta.pixelId) || !options.meta.accessToken) throw new Error("conversions.meta needs pixelId and accessToken.");
    platforms.push("meta");
  }
  if (options.tiktok) {
    if (!options.tiktok.pixelCode || !options.tiktok.accessToken) throw new Error("conversions.tiktok needs pixelCode and accessToken.");
    platforms.push("tiktok");
  }
  if (options.ga4) {
    if (!/^G-[A-Z0-9]{4,20}$/.test(options.ga4.measurementId) || !options.ga4.apiSecret) {
      throw new Error("conversions.ga4 needs measurementId (G-XXXX) and apiSecret.");
    }
    platforms.push("ga4");
  }
  if (!platforms.length) return null;
  const timeoutMs = options.timeoutMs ?? 5000;

  async function post(platform: ConversionPlatform, url: string, body: unknown, headers: Record<string, string> = {}): Promise<ForwardResult> {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text().catch(() => "");
      // TikTok answers 200 with a non-zero "code" for rejected events.
      let rejected = !response.ok;
      if (platform === "tiktok" && response.ok) {
        try {
          rejected = (JSON.parse(text) as { code?: number }).code !== 0;
        } catch {
          rejected = true;
        }
      }
      if (rejected) throw new Error(`${platform} answered ${response.status}: ${text.slice(0, 300)}`);
      return { platform, status: "sent" };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      options!.onError?.(platform, err);
      return { platform, status: "failed", detail: err.message.slice(0, 300) };
    }
  }

  return {
    platforms,
    async send(event) {
      const jobs: Promise<ForwardResult>[] = [];
      if (options.meta) {
        const version = options.meta.apiVersion ?? "v21.0";
        const url = `https://graph.facebook.com/${version}/${options.meta.pixelId}/events?access_token=${encodeURIComponent(options.meta.accessToken)}`;
        jobs.push(post("meta", url, metaBody(event, options.meta.testEventCode)));
      }
      if (options.tiktok) {
        jobs.push(
          post("tiktok", "https://business-api.tiktok.com/open_api/v1.3/event/track/", tiktokBody(event, options.tiktok.pixelCode, options.tiktok.testEventCode), {
            "access-token": options.tiktok.accessToken,
          })
        );
      }
      if (options.ga4) {
        const clientId = gaClientIdFromCookie(event.customer.gaClientId);
        if (!clientId) {
          jobs.push(Promise.resolve({ platform: "ga4", status: "skipped", detail: "no GA client id (_ga cookie)" }));
        } else {
          const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(options.ga4.measurementId)}&api_secret=${encodeURIComponent(options.ga4.apiSecret)}`;
          jobs.push(post("ga4", url, ga4Body(event, clientId)));
        }
      }
      return Promise.all(jobs);
    },
  };
}

/** Reads the ad-platform cookies and request details a browser sent, for CustomerData. */
export function browserContextFromHeaders(headers: Headers, ip: string | null): CustomerData {
  const cookies = new Map<string, string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies.set(part.slice(0, eq).trim(), decodeURIComponentSafe(part.slice(eq + 1).trim()));
  }
  const out: CustomerData = {};
  const fbp = cookies.get("_fbp");
  const fbc = cookies.get("_fbc");
  const ttp = cookies.get("_ttp");
  const ga = gaClientIdFromCookie(cookies.get("_ga"));
  const ua = headers.get("user-agent");
  if (fbp) out.fbp = fbp.slice(0, 200);
  if (fbc) out.fbc = fbc.slice(0, 200);
  if (ttp) out.ttp = ttp.slice(0, 200);
  if (ga) out.gaClientId = ga;
  if (ua) out.userAgent = ua.slice(0, 500);
  if (ip) out.ip = ip;
  return out;
}

function decodeURIComponentSafe(v: string) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
