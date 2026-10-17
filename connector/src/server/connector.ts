import { readFile } from "node:fs/promises";
import { createHash, createHmac, createPublicKey, randomUUID, timingSafeEqual, type KeyObject } from "node:crypto";
import { attribute, commissionFor, findAffiliateByCode, matchLink } from "./attribution.js";
import { ConfigClient, ConfigUnavailableError, storefrontCheck } from "./config.js";
import { createIpHasher, loadPrivateKey, mintPassToken } from "./keys.js";
import { TokenBucket } from "./rate-limit.js";
import { ABANDON_AFTER_MS, buildStats, creatorLinkRows, isStatsRange, rangeBounds, shareLinks } from "./stats.js";
import type { Aggregate, CheckoutRecord, CheckoutWatch, ClickRecord, OrderRecord, Store } from "./store.js";
import { CLICK_COOKIE, TTCLID_COOKIE, VISITOR_COOKIE, trackerScript } from "./tracker.js";
import {
  browserContextFromHeaders,
  cleanCustomer,
  cleanItems,
  createForwarder,
  type ConversionsOptions,
  type CustomerData,
  type ForwardResult,
  type LineItem,
} from "./conversions.js";
import {
  buildAttribution,
  classifyTouch,
  MAX_JOURNEY_TOUCHES,
  TOUCH_DEDUPE_MS,
  type AttributionReport,
  type JourneyTouch,
} from "./journey.js";
import { createDispatcher, type WebhookEvent, type WebhooksOptions } from "./webhooks.js";
import { createRecoverySender, type RecoveryEmailsOptions } from "./recovery.js";
import { SHOPIFY_ATTRIBUTES, shopifyCartToken } from "./shopify.js";
import { createAccess, type Access, type AccessOptions } from "./access.js";
import { cleanTags, type BrowserTags } from "./tags.js";

const TAG_FEATURE: Record<keyof BrowserTags, string> = {
  clarity: "clarity",
  tiktok: "tiktok_pixel",
  meta: "meta_pixel",
  ga4: "ga4",
  pinterest: "pinterest_tag",
  snap: "snap_pixel",
};
import { mediaPage as renderMediaPage } from "./media-page.js";
import type { ConfigRejection, CreatorLinkRow, ProgramConfig, StatsRange, StatsResponse, Viewer } from "./types.js";
import {
  amount,
  cleanHost,
  cleanPath,
  cleanText,
  currency,
  isUuid,
  optionalDate,
  optionalId,
  optionalUuid,
  requiredId,
  ValidationError,
} from "./validate.js";

export type ConnectorOptions = {
  /** Brand id on the media dashboard, e.g. "kraze". */
  brand: string;
  /** e.g. https://media-dashboard.example.com */
  dashboardUrl: string;
  /** MEDIA_DASHBOARD_PRIVATE_KEY: base64 of the PKCS8 PEM, a PEM, or a KeyObject. */
  privateKey: string | KeyObject;
  store: Store;
  /**
   * The brand's own session check. Return null for anyone not signed in.
   * Optional with `access`, which then decides: the owner by OWNER_KEY, creators by the platform's signed sign-in.
   */
  getViewer?: (request: Request) => Promise<Viewer | null>;
  /** Owner key + creator sign-in handled by the connector itself (the connector app). */
  access?: AccessOptions;
  /** Brand name for the /media page. */
  brandName?: string;
  /** Setup checks to report to the platform with each config pull (names and ok/warn/fail only). */
  reportStatus?: () => Record<string, string>;
  /** Where the routes are mounted. Default "/api/md". */
  mountPath?: string;
  /**
   * "interval" (default): pull the programme config about every
   * configRefreshSeconds on a timer, for long-running servers. "manual": never
   * pull on its own; call refreshConfig() from a cron (serverless hosting).
   */
  configRefresh?: "interval" | "manual";
  /** Default 60, at least 10. */
  configRefreshSeconds?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  /**
   * The site's public origin(s), for when request.url doesn't show it (some
   * proxies, Shopify app proxies). Used for the same-origin checks.
   */
  siteOrigin?: string | string[];
  /**
   * Origins creator links may point at. Default: siteOrigin. When set, a
   * dashboard config whose storefront_url is elsewhere is refused.
   */
  storefrontOrigins?: string | string[];
  /** Hosts (or "*.domain") creator deep links may point at. Default: the hosts of storefrontOrigins. */
  deepLinkDomains?: string[];
  /**
   * The request header your hosting sets to the visitor's IP, for per-IP click
   * rate limiting. Only name a header the platform overwrites: "x-real-ip"
   * (Vercel), "cf-connecting-ip" (Cloudflare), "fly-client-ip" (Fly),
   * "x-nf-client-connection-ip" (Netlify), or "x-forwarded-for" behind exactly
   * one proxy you run (its right-most entry is used). Default: none, so clicks
   * share one site-wide limit. The IP is only ever hashed.
   */
  trustedIpHeader?: string;
  /** Overrides trustedIpHeader. */
  getClientIp?: (request: Request) => string | null;
  /** Server-side Purchase / InitiateCheckout events to Meta, TikTok and GA4. */
  conversions?: ConversionsOptions;
  /** Signed webhooks to the brand's own tools, e.g. abandoned-checkout emails. */
  webhooks?: WebhooksOptions;
  /** Minutes before an unpaid checkout counts as abandoned (webhooks and the checkout list). Default 60, at least 5. */
  abandonAfterMinutes?: number;
  /** How far back an order's journey looks for marketing touches. Default 30. */
  journeyLookbackDays?: number;
  /**
   * Serverless hosts (Vercel, Cloudflare) stop work once the response is sent:
   * pass their waitUntil so webhook deliveries finish. Long-running servers don't need it.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Cart-recovery emails sent by the connector through the brand's own Resend
   * account. Wording and delay are edited in the media dashboard.
   */
  recoveryEmails?: RecoveryEmailsOptions;
  /**
   * Browser-side tools this site has installed (e.g. "clarity", "tiktok_pixel"),
   * reported to the dashboard by name so its setup builder knows what's done.
   * Names only; nothing about visitors or sales.
   */
  installedTools?: string[];
  /** Browser tags (Clarity, ad pixels) the tracker loads by itself. Ids only. */
  tags?: BrowserTags;
};

/** Shared by checkouts and orders: who the shopper is and what they bought, for ad-platform conversions. */
type ConversionFields = {
  /** The md_vid cookie (connector.visitorIdFromRequest), for the marketing journey and Clarity. */
  visitorId?: string | null;
  /** Shopper details for Meta / TikTok / GA4 matching. Hashed before sending, never stored. Spread connector.browserContext(request) in. */
  customer?: CustomerData | null;
  items?: LineItem[] | null;
  /** The page the event happened on. */
  sourceUrl?: string | null;
};

export type CheckoutInput = ConversionFields & {
  checkoutId: string;
  clickId?: string | null;
  code?: string | null;
  cartTotal: number | string;
  currency: string;
  /** Test mode (Stripe test keys, Shopify test orders): kept for attribution, never counted. */
  test?: boolean;
  /** Your own customer reference, sent back in webhooks so your handler can look up who to email. */
  customerRef?: string | null;
  /** A link that reopens this cart, for recovery messages. */
  recoveryUrl?: string | null;
  /** The checkout step the shopper is on, e.g. "information", "shipping", "payment". */
  step?: string | null;
  /** The shopper agreed to marketing emails (Shopify: buyer_accepts_marketing). Needed for recovery emails by default. */
  marketingConsent?: boolean;
};

type Forwarded = { conversions?: ForwardResult[] };

export type CheckoutResult = Forwarded &
  ({ status: "recorded" | "updated"; checkout: CheckoutRecord } | { status: "not_attributed"; checkout: null });

export type CheckoutFailedInput = { checkoutId: string; reason?: string | null };
export type CheckoutFailedResult = { status: "failed" | "not_found" | "ignored" };

export type CheckoutStepInput = { checkoutId: string; step: string };

export type OrderInput = ConversionFields & {
  orderId: string;
  checkoutId?: string | null;
  clickId?: string | null;
  code?: string | null;
  /** Major currency units, e.g. 49.99 (Stripe: amount_total / 100). */
  amount: number | string;
  currency: string;
  occurredAt?: Date | string | number | null;
  test?: boolean;
  campaignId?: string | null;
  productRef?: string | null;
};

export type OrderResult = Forwarded &
  ({ status: "recorded" | "duplicate"; order: OrderRecord } | { status: "not_attributed"; order: null });

export type CheckoutListRow = {
  checkout_id: string;
  /** "abandoned" = still unpaid after abandonAfterMinutes. */
  status: "started" | "failed" | "abandoned" | "completed";
  failure_reason: string | null;
  step: string | null;
  cart_total: number;
  currency: string;
  code: string | null;
  creator_id: string | null;
  creator_name: string | null;
  /** Filter Clarity recordings by the custom tag md_vid = this value. */
  visitor_id: string | null;
  /** The address the shopper typed. Admin-only route; stays on this site. */
  email: string | null;
  /** When a cart-recovery email went to this shopper, if one did. */
  recovery_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CheckoutListResponse = {
  range: StatsRange;
  generated_at: string;
  abandon_after_minutes: number;
  /** Cart-recovery emails sent in the range, and how many of those carts were paid afterwards. */
  recovery: { emails_sent: number; recovered_orders: number; recovered_value: number };
  /** Recovery emails are set up on this site and the dashboard has wording for them: admins can send one per checkout. */
  recovery_ready: boolean;
  /** The dashboard's switch for sending them automatically. */
  recovery_automatic: boolean;
  /** Per creator code: how many credited checkouts failed or were abandoned in the range. */
  by_code: { code: string; creator_name: string | null; failed: number; abandoned: number; lost_value: number }[];
  checkouts: CheckoutListRow[];
};

export type RefundInput = { orderId: string; refundedAt?: Date | string | number | null };
/** "pending": the order isn't recorded yet; the refund is applied when it is. */
export type RefundResult = { status: "refunded" | "already_refunded" | "pending" };

/** userRef may be left out for a creator pass: the creator then signs in with their platform login alone. */
export type PassInput = { userRef?: string | null; name?: string | null };
export type AdminPassInput = { userRef: string; name: string };

export type ApproveCreatorLinkInput = {
  creatorId: string;
  userRef: string;
  /** The codes to pin. Default: the codes the dashboard currently lists for this creator. */
  affiliateIds?: string[];
};
/** "changed": the dashboard's config no longer matches what was approved; reload and try again. "conflict": unlink the creator or login first. */
export type ApproveCreatorLinkResult = { status: "approved" | "changed" | "conflict" };
export type UnlinkCreatorResult = { status: "unlinked" | "not_found" };

export type RouteHandler = (request: Request) => Promise<Response>;

export type Connector = {
  /** Serves GET t.js, POST click, GET stats, GET host.js, GET health and the admin creator-link actions under mountPath; 404 otherwise. */
  handle(request: Request): Promise<Response>;
  /** For app/api/md/[...path]/route.ts: export const { GET, POST } = connector.routeHandlers(); */
  routeHandlers(): { GET: RouteHandler; POST: RouteHandler };
  recordCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  recordCheckoutFailed(input: CheckoutFailedInput): Promise<CheckoutFailedResult>;
  recordOrder(input: OrderInput): Promise<OrderResult>;
  recordRefund(input: RefundInput): Promise<RefundResult>;
  /** Records which checkout step a shopper reached (shown on the failed/abandoned checkout list). */
  recordCheckoutStep(input: CheckoutStepInput): Promise<{ status: "updated" | "not_found" }>;
  /** The md_click cookie of the visitor making this request, or null. */
  clickIdFromRequest(request: Request | { headers: Headers }): string | null;
  /** The md_vid visitor cookie of this request, or null. */
  visitorIdFromRequest(request: Request | { headers: Headers }): string | null;
  /** IP, user agent and ad cookies (_fbp, _fbc, _ttp, ttclid, _ga) from the shopper's request, for `customer`. */
  browserContext(request: Request): CustomerData;
  /** Multi-touch attribution report (admins only on the HTTP route). */
  getAttribution(range?: StatsRange): Promise<AttributionReport>;
  /** Failed and abandoned checkouts, newest first. */
  listCheckouts(range?: StatsRange, options?: { statuses?: CheckoutListRow["status"][]; code?: string | null }): Promise<CheckoutListResponse>;
  /** Sends checkout.abandoned webhooks. Runs every minute on its own unless configRefresh is "manual"; then call it from a cron. */
  runScheduledTasks(): Promise<{ abandoned: number; recovery_emails: number }>;
  /** Sends the recovery email for one unpaid checkout now (an admin's decision), even with automatic sending off. Once per checkout. */
  sendRecoveryEmail(checkoutId: string): Promise<{ status: SendRecoveryStatus }>;
  /**
   * Cart attributes to copy onto a Shopify cart (Storefront API cartCreate /
   * cartAttributesUpdate) inside the shopper's request, so checkout and order
   * webhooks can be tied back to the visit and its ad cookies.
   */
  cartAttributes(request: Request, cartId?: string | null): Array<{ key: string; value: string }>;
  /** Stats for a viewer, for server-rendered pages of the brand's own site. */
  getStats(viewer: Viewer, range?: StatsRange): Promise<StatsResponse>;
  /** The last accepted programme config. Never contacts the dashboard. */
  getConfig(): Promise<ProgramConfig>;
  /** Pulls the programme config from the dashboard now: call it from a cron when configRefresh is "manual". */
  refreshConfig(): Promise<ProgramConfig>;
  /** Approved and proposed creator logins, as on the admin sales screen. */
  listCreatorLinks(): Promise<CreatorLinkRow[]>;
  /** Lets this login see this creator's numbers (only the pinned codes). Only call it for a decision by one of your admins. */
  approveCreatorLink(input: ApproveCreatorLinkInput): Promise<ApproveCreatorLinkResult>;
  unlinkCreator(creatorId: string): Promise<UnlinkCreatorResult>;
  mintCreatorPass(input: PassInput): string;
  mintAdminPass(input: AdminPassInput): string;
  /** iframe src for the creator area. Mint a fresh one per page view; it works once, for 5 minutes. */
  creatorEmbedUrl(input: PassInput): string;
  /** Entry link for a signed-in brand admin. Mint it when they click; it works once, for 5 minutes. */
  adminEntryUrl(input: AdminPassInput): string;
  /** With `access`: the GET /media page (owner unlock bar, dashboard iframe, data drawn over it). */
  mediaPage(request: Request): Response;
  /** With `access`: whether this request comes from an owner-unlocked device. */
  isOwner(request: Request): boolean;
  /** Stops the background config refresh. */
  close(): void;
};

const CLICK_DEDUPE_MS = 30 * 60_000;
const MAX_CLICK_BODY = 2048;
const MAX_ADMIN_BODY = 32_768;
const MAX_PINNED_CODES = 500;

const CONFIG_WARNINGS: Record<ConfigRejection, string> = {
  storefront_url:
    "The dashboard's storefront URL points outside this site, so its latest programme settings were refused and the last accepted ones stay in use. Creators should copy their links from this site.",
  allowed_deep_link_domains:
    "The dashboard allows creator links to domains this site hasn't declared, so its latest programme settings were refused and the last accepted ones stay in use. Creators should copy their links from this site.",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function origins(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : []).map(normalizeOrigin).filter((o): o is string => o !== null);
}

function uuidCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (isUuid(value)) return value.toLowerCase();
  }
  return null;
}

function rawCookie(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i;

/** Lower-cased, trimmed address, or null when it doesn't look like one. */
function cleanEmail(value: unknown): string | null {
  const text = cleanText(value, 254)?.toLowerCase() ?? null;
  return text && EMAIL_RE.test(text) ? text : null;
}

export type SendRecoveryStatus =
  | "sent"
  | "failed"
  | "not_found"
  | "not_configured"
  | "no_template"
  | "no_email"
  | "no_link"
  | "no_consent"
  | "paid"
  | "already_sent"
  | "unsubscribed";

const VISITOR_MAX_AGE = 400 * 86_400;
const SCHEDULE_MS = 60_000;
const ABANDON_LOOKBACK_MS = 7 * 86_400_000;
const MAX_TOUCH_BODY = 2048;

export function clickIdFromCookieHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== CLICK_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (isUuid(value)) return value.toLowerCase();
  }
  return null;
}

/** Stops reading as soon as the body passes `limit` bytes, whatever Content-Length claims. */
async function readJsonBody(request: Request, limit: number): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isJson = (request: Request) => (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");

function scriptResponse(request: Request, body: string, cacheControl: string): Response {
  const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
  const headers = { "content-type": "text/javascript; charset=utf-8", "cache-control": cacheControl, etag };
  const match = request.headers.get("if-none-match");
  if (match && match.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}

function emptyAggregate(): Aggregate {
  return { clicks: [], checkouts: [], orders: [] };
}

function cleanUserRef(value: unknown): string {
  const userRef = typeof value === "string" ? value.trim() : "";
  if (!userRef || userRef.length > 128 || /[\u0000-\u001f\u007f]/.test(userRef)) {
    throw new ValidationError("userRef must be the site's own user id (1-128 characters)");
  }
  return userRef;
}

let hostScriptCache: Promise<string | null> | null = null;

function loadHostScript(): Promise<string | null> {
  hostScriptCache ??= readFile(new URL("../host/index.js", import.meta.url), "utf8").catch(() => {
    hostScriptCache = null;
    return null;
  });
  return hostScriptCache;
}

export function createConnector(options: ConnectorOptions): Connector {
  const brand = options.brand;
  if (typeof brand !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(brand)) {
    throw new Error("brand must be the dashboard brand id, e.g. \"kraze\".");
  }
  let dashboard: URL;
  try {
    dashboard = new URL(options.dashboardUrl);
  } catch {
    throw new Error("dashboardUrl must be an absolute URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(dashboard.hostname) || dashboard.hostname.endsWith(".localhost");
  if (dashboard.protocol !== "https:" && !(local && dashboard.protocol === "http:")) {
    throw new Error("dashboardUrl must use https.");
  }
  const refreshMode = options.configRefresh ?? "interval";
  if (refreshMode !== "interval" && refreshMode !== "manual") throw new Error('configRefresh must be "interval" or "manual".');
  const dashboardUrl = dashboard.href.replace(/\/+$/, "");
  const key = loadPrivateKey(options.privateKey);
  const store = options.store;
  const now = options.now ?? (() => new Date());
  const mountPath = `/${(options.mountPath ?? "/api/md").replace(/^\/+|\/+$/g, "")}`;
  const siteOrigins = origins(options.siteOrigin);
  const storefrontOrigins = options.storefrontOrigins === undefined ? siteOrigins : origins(options.storefrontOrigins);
  const deepLinkDomains = options.deepLinkDomains ?? storefrontOrigins.map((o) => new URL(o).hostname);
  const ipHeader = options.trustedIpHeader?.trim().toLowerCase() || null;
  const hashIp = createIpHasher(key);
  const perIp = new TokenBucket(20, 1 / 3);
  const siteWide = new TokenBucket(600, 20, 1);
  const browserTags = cleanTags(options.tags);
  const features = [
    "connector",
    ...(options.conversions?.meta ? ["conversions.meta"] : []),
    ...(options.conversions?.tiktok ? ["conversions.tiktok"] : []),
    ...(options.conversions?.ga4 ? ["conversions.ga4"] : []),
    ...(options.webhooks?.endpoints?.length ? ["webhooks"] : []),
    ...(options.recoveryEmails ? ["recovery.resend"] : []),
    ...(Object.keys(browserTags) as (keyof BrowserTags)[]).map((t) => TAG_FEATURE[t]),
    ...(options.installedTools ?? []).filter((t) => typeof t === "string" && /^[a-z0-9_.-]{1,40}$/.test(t)).slice(0, 40),
  ];
  const rawConfig = new ConfigClient({
    features: () => features,
    status: options.reportStatus,
    brand,
    dashboardUrl,
    key,
    refreshSeconds: Math.max(10, options.configRefreshSeconds ?? 60),
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    now,
    store,
    check: storefrontCheck(storefrontOrigins, deepLinkDomains),
  });
  if (refreshMode === "interval") rawConfig.start();

  // With the platform's own sign-in, a creator's login IS their creator account: propose that link to the owner.
  const identityMode = !!options.access;
  const mapped = new WeakMap<ProgramConfig, ProgramConfig>();
  const view = (cfg: ProgramConfig): ProgramConfig => {
    if (!identityMode) return cfg;
    let out = mapped.get(cfg);
    if (!out) {
      out = { ...cfg, affiliates: cfg.affiliates.map((a) => ({ ...a, creator: { ...a.creator, brand_user_ref: a.creator.id } })) };
      mapped.set(cfg, out);
    }
    return out;
  };
  const config = {
    current: async () => view(await rawConfig.current()),
    refresh: async () => view(await rawConfig.refresh()),
    stop: () => rawConfig.stop(),
    get loadedAt() {
      return rawConfig.loadedAt;
    },
    get reachable() {
      return rawConfig.reachable;
    },
    get rejection() {
      return rawConfig.rejection;
    },
  };
  if (!options.getViewer && !options.access) throw new Error("createConnector needs getViewer or access.");
  const access: Access | null = options.access
    ? createAccess(options.access, { key, brand, dashboardUrl, fetch: options.fetch ?? globalThis.fetch.bind(globalThis), store, now })
    : null;
  const getViewer = async (request: Request): Promise<Viewer | null> =>
    options.getViewer ? options.getViewer(request) : access!.viewer(request);

  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const forwarder = createForwarder(options.conversions, fetchImpl);
  const forwardTest = options.conversions?.forwardTestEvents === true;
  const webhooks = createDispatcher(options.webhooks, fetchImpl, now);
  const defaultAbandonMs = Math.max(5, options.abandonAfterMinutes ?? 60) * 60_000;
  const recovery = createRecoverySender(options.recoveryEmails, fetchImpl);
  if (recovery && !siteOrigins.length) throw new Error("recoveryEmails needs siteOrigin, for the unsubscribe link in each email.");
  /** With recovery emails switched on in the dashboard, its delay decides when a checkout counts as abandoned. */
  const abandonMsFor = (cfg: ProgramConfig | null) =>
    recovery && cfg?.recovery_email?.enabled ? cfg.recovery_email.delay_minutes * 60_000 : defaultAbandonMs;
  const lookbackMs = Math.max(1, Math.min(365, options.journeyLookbackDays ?? 30)) * 86_400_000;
  const background = (promise: Promise<unknown>) => {
    const safe = promise.catch(() => undefined);
    options.waitUntil?.(safe);
  };
  let scheduleTimer: ReturnType<typeof setInterval> | null = null;
  if (refreshMode === "interval" && (webhooks?.wants("checkout.abandoned") || recovery)) {
    scheduleTimer = setInterval(() => void runScheduledTasks().catch(() => undefined), SCHEDULE_MS);
    (scheduleTimer as { unref?: () => void }).unref?.();
  }

  const creatorName = (cfg: ProgramConfig | null, creatorId: string | null) => {
    if (!cfg || !creatorId) return null;
    const c = cfg.affiliates.find((a) => a.creator.id === creatorId)?.creator;
    return c ? c.display_name ?? c.username : null;
  };

  function watchPayload(w: CheckoutWatch, cfg: ProgramConfig | null): Record<string, unknown> {
    return {
      checkout_id: w.id,
      status: w.status,
      step: w.step,
      failure_reason: w.failureReason,
      cart_total: w.cartTotal,
      currency: w.currency,
      code: w.code,
      creator: w.creatorId ? { id: w.creatorId, name: creatorName(cfg, w.creatorId) } : null,
      customer_ref: w.customerRef,
      recovery_url: w.recoveryUrl,
      visitor_id: w.visitorId,
      created_at: w.createdAt.toISOString(),
    };
  }

  function emit(event: WebhookEvent, data: Record<string, unknown>) {
    if (webhooks?.wants(event)) background(webhooks.send(event, data));
  }

  const ownOrigins =(request: Request) => (siteOrigins.length ? siteOrigins : [new URL(request.url).origin]);

  /** Same-origin only: a present Origin header must be the site's own; cross-site fetch metadata is refused. */
  function sameOrigin(request: Request): boolean {
    if (request.headers.get("sec-fetch-site") === "cross-site") return false;
    const origin = request.headers.get("origin");
    return origin === null || ownOrigins(request).includes(origin);
  }

  function isSecure(request: Request): boolean {
    return (
      new URL(request.url).protocol === "https:" ||
      ownOrigins(request)[0]?.startsWith("https:") === true ||
      request.headers.get("x-forwarded-proto") === "https"
    );
  }

  function clientIp(request: Request): string | null {
    if (options.getClientIp) return options.getClientIp(request);
    const value = ipHeader ? request.headers.get(ipHeader) : null;
    if (!value) return null;
    const ip = ipHeader === "x-forwarded-for" ? value.split(",").at(-1) : value;
    return ip?.trim() || null;
  }

  async function handleClick(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    if (!isJson(request)) return json(415, { error: "expected_json" });
    const ip = clientIp(request);
    const ipHash = ip ? hashIp(ip) : null;
    // Without a trusted IP every visitor would share one small bucket, so the limit is site-wide and generous instead.
    const [limiter, bucketKey] = ipHash ? [perIp, ipHash] : [siteWide, "site"];
    if (!limiter.take(bucketKey, now().getTime())) {
      return json(429, { error: "rate_limited" }, { "retry-after": String(limiter.retryAfter(bucketKey) || 1) });
    }
    const body = await readJsonBody(request, MAX_CLICK_BODY);
    if (!body) return json(400, { error: "invalid_body" });
    const ref = cleanText(body.ref, 65);
    if (!ref || ref.length > 64) return json(400, { error: "invalid_ref" });

    const cfg = await config.current();
    const affiliate = findAffiliateByCode(cfg, ref);
    if (!affiliate || affiliate.status !== "active") return json(404, { error: "unknown_code" });

    const campaignId =
      isUuid(body.campaign) && cfg.campaigns.some((c) => c.id === (body.campaign as string).toLowerCase())
        ? (body.campaign as string).toLowerCase()
        : null;
    const landingPath = cleanPath(body.landing_path);
    const at = now();

    let click: ClickRecord | null = null;
    const previousId = clickIdFromCookieHeader(request.headers.get("cookie"));
    if (previousId) {
      const previous = await store.getClick(previousId);
      if (
        previous &&
        previous.affiliateId === affiliate.id &&
        previous.campaignId === campaignId &&
        at.getTime() - previous.createdAt.getTime() < CLICK_DEDUPE_MS
      ) {
        click = previous;
      }
    }
    if (!click) {
      click = {
        id: randomUUID(),
        affiliateId: affiliate.id,
        creatorId: affiliate.creator.id,
        code: affiliate.code,
        campaignId,
        linkId: matchLink(cfg, affiliate.id, landingPath)?.id ?? null,
        landingPath,
        referrerHost: cleanHost(body.referrer_host),
        ipHash,
        createdAt: at,
      };
      await store.insertClick(click);
    }

    const cookie = [
      `${CLICK_COOKIE}=${click.id}`,
      "Path=/",
      `Max-Age=${cfg.program.cookie_window_days * 86_400}`,
      "SameSite=Lax",
      ...(isSecure(request) ? ["Secure"] : []),
    ].join("; ");
    return json(200, { click_id: click.id }, { "set-cookie": cookie });
  }

  async function handleTouch(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    if (!isJson(request)) return json(415, { error: "expected_json" });
    // Global Privacy Control: the shopper opted out of tracking, so no visitor id and no touch.
    if (request.headers.get("sec-gpc") === "1") return new Response(null, { status: 204 });
    const ip = clientIp(request);
    const ipHash = ip ? hashIp(ip) : null;
    const [limiter, bucketKey] = ipHash ? [perIp, ipHash] : [siteWide, "site"];
    if (!limiter.take(bucketKey, now().getTime())) {
      return json(429, { error: "rate_limited" }, { "retry-after": String(limiter.retryAfter(bucketKey) || 1) });
    }
    const body = await readJsonBody(request, MAX_TOUCH_BODY);
    if (!body) return json(400, { error: "invalid_body" });

    const cfg = await config.current().catch(() => null);
    const typedRef = cleanText(body.ref, 64);
    const affiliate = cfg && typedRef ? findAffiliateByCode(cfg, typedRef) : null;
    const refCode = affiliate?.status === "active" ? affiliate.code : null;
    const utm = (k: string) => cleanText(body[k], 120)?.toLowerCase() ?? null;
    const signals = {
      ref: refCode,
      utmSource: utm("utm_source"),
      utmMedium: utm("utm_medium"),
      utmCampaign: utm("utm_campaign"),
      utmContent: utm("utm_content"),
      utmTerm: utm("utm_term"),
      gclid: body.gclid === true,
      fbclid: body.fbclid === true,
      ttclid: body.ttclid === true,
      msclkid: body.msclkid === true,
      referrerHost: cleanHost(body.referrer_host),
    };
    const own = ownOrigins(request).map((o) => new URL(o).hostname);
    if (signals.referrerHost && own.includes(signals.referrerHost)) signals.referrerHost = null;

    const visitorId = uuidCookie(request.headers.get("cookie"), VISITOR_COOKIE) ?? randomUUID();
    const kind = classifyTouch(signals);
    let recorded = false;
    if (kind) {
      const at = now();
      const last = await store.lastTouch(visitorId);
      const same =
        last &&
        last.channel === kind.channel &&
        last.source === kind.source &&
        last.campaign === signals.utmCampaign &&
        last.refCode === refCode &&
        at.getTime() - last.createdAt.getTime() < TOUCH_DEDUPE_MS;
      if (!same) {
        await store.insertTouch({
          id: randomUUID(),
          visitorId,
          channel: kind.channel,
          source: kind.source,
          medium: kind.medium,
          campaign: signals.utmCampaign,
          content: signals.utmContent,
          refCode,
          landingPath: cleanPath(body.landing_path),
          createdAt: at,
        });
        recorded = true;
      }
    }
    const cookie = [
      `${VISITOR_COOKIE}=${visitorId}`,
      "Path=/",
      `Max-Age=${VISITOR_MAX_AGE}`,
      "SameSite=Lax",
      ...(isSecure(request) ? ["Secure"] : []),
    ].join("; ");
    return json(200, { visitor_id: visitorId, recorded, channel: kind?.channel ?? null }, { "set-cookie": cookie });
  }

  async function adminOnly(request: Request): Promise<Response | null> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    const viewer = validViewer(await getViewer(request));
    if (!viewer) return json(401, { error: "unauthorized" });
    if (viewer.role !== "admin") return json(403, { error: "admin_only" });
    return null;
  }

  function rangeOf(request: Request): StatsRange | null {
    const value = new URL(request.url).searchParams.get("range") ?? "30d";
    return isStatsRange(value) ? value : null;
  }

  async function getAttribution(range: StatsRange = "30d"): Promise<AttributionReport> {
    const at = now();
    const { from, to } = rangeBounds(range, at);
    return buildAttribution(await store.listJourneys(from, to), range, at);
  }

  async function handleAttribution(request: Request): Promise<Response> {
    const denied = await adminOnly(request);
    if (denied) return denied;
    const range = rangeOf(request);
    if (!range) return json(400, { error: "invalid_range" });
    return json(200, await getAttribution(range), { vary: "cookie" });
  }

  const LIST_STATUSES = ["started", "failed", "abandoned", "completed"] as const;

  async function listCheckouts(
    range: StatsRange = "30d",
    filter: { statuses?: CheckoutListRow["status"][]; code?: string | null } = {}
  ): Promise<CheckoutListResponse> {
    const at = now();
    const { from, to } = rangeBounds(range, at);
    const cfg = await config.current().catch(() => null);
    const abandonAfterMs = abandonMsFor(cfg);
    const abandonedBefore = new Date(at.getTime() - abandonAfterMs);
    let affiliateIds: string[] | null = null;
    if (filter.code) {
      const affiliate = cfg ? findAffiliateByCode(cfg, filter.code) : null;
      affiliateIds = affiliate ? [affiliate.id] : [];
    }
    const statuses = filter.statuses?.length ? filter.statuses : (["failed", "abandoned"] as CheckoutListRow["status"][]);
    const [rows, everything] = await Promise.all([
      store.listCheckoutWatch({ from, to, statuses, abandonedBefore, affiliateIds, limit: 500 }),
      store.listCheckoutWatch({ from, to, statuses: null, abandonedBefore, affiliateIds: null, limit: 10000 }),
    ]);
    const lost = everything.filter(
      (w) => w.status === "failed" || (w.status === "started" && w.createdAt.getTime() < abandonedBefore.getTime())
    );
    const emailed = everything.filter((w) => w.recoverySentAt);
    const recovered = emailed.filter((w) => w.status === "completed");
    const statusOf = (w: CheckoutWatch): CheckoutListRow["status"] =>
      w.status === "started" && w.createdAt.getTime() < abandonedBefore.getTime() ? "abandoned" : w.status;
    const byCode = new Map<string, CheckoutListResponse["by_code"][number]>();
    for (const w of lost) {
      if (!w.code) continue;
      const row = byCode.get(w.code) ?? { code: w.code, creator_name: creatorName(cfg, w.creatorId), failed: 0, abandoned: 0, lost_value: 0 };
      if (statusOf(w) === "failed") row.failed += 1;
      else row.abandoned += 1;
      row.lost_value = Math.round((row.lost_value + w.cartTotal) * 100) / 100;
      byCode.set(w.code, row);
    }
    return {
      range,
      generated_at: at.toISOString(),
      abandon_after_minutes: abandonAfterMs / 60_000,
      recovery: {
        emails_sent: emailed.length,
        recovered_orders: recovered.length,
        recovered_value: Math.round(recovered.reduce((sum, w) => sum + w.cartTotal, 0) * 100) / 100,
      },
      recovery_ready: !!recovery && !!cfg?.recovery_email,
      recovery_automatic: !!recovery && cfg?.recovery_email?.enabled === true,
      by_code: [...byCode.values()].sort((a, b) => b.failed + b.abandoned - (a.failed + a.abandoned)),
      checkouts: rows.map((w) => ({
        checkout_id: w.id,
        status: statusOf(w),
        failure_reason: w.failureReason,
        step: w.step,
        cart_total: w.cartTotal,
        currency: w.currency,
        code: w.code,
        creator_id: w.creatorId,
        creator_name: creatorName(cfg, w.creatorId),
        visitor_id: w.visitorId,
        email: w.email,
        recovery_sent_at: w.recoverySentAt?.toISOString() ?? null,
        created_at: w.createdAt.toISOString(),
        updated_at: w.updatedAt.toISOString(),
      })),
    };
  }

  async function handleCheckouts(request: Request): Promise<Response> {
    const denied = await adminOnly(request);
    if (denied) return denied;
    const range = rangeOf(request);
    if (!range) return json(400, { error: "invalid_range" });
    const params = new URL(request.url).searchParams;
    const statuses = (params.get("status") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is CheckoutListRow["status"] => (LIST_STATUSES as readonly string[]).includes(s));
    return json(200, await listCheckouts(range, { statuses, code: cleanText(params.get("code"), 64) }), { vary: "cookie" });
  }

  async function runScheduledTasks(): Promise<{ abandoned: number; recovery_emails: number }> {
    const wantsWebhook = webhooks?.wants("checkout.abandoned") === true;
    if (!wantsWebhook && !recovery) return { abandoned: 0, recovery_emails: 0 };
    const at = now();
    const cfg = await config.current().catch(() => null);
    const claimed = await store.claimAbandoned(
      new Date(at.getTime() - abandonMsFor(cfg)),
      new Date(at.getTime() - ABANDON_LOOKBACK_MS),
      at,
      100
    );
    let sent = 0;
    await Promise.all(
      claimed.map(async (w) => {
        const tasks: Promise<unknown>[] = [];
        if (wantsWebhook) tasks.push(webhooks!.send("checkout.abandoned", watchPayload(w, cfg)));
        const template = cfg?.recovery_email;
        if (recovery && template?.enabled && w.email && !(await store.isEmailSuppressed(w.email))) {
          tasks.push(
            recovery.send(w, template, { creatorName: creatorName(cfg, w.creatorId), unsubscribeUrl: unsubscribeUrl(w.email) }).then(async (r) => {
              if (r === "sent" && (await store.markRecoverySent(w.id, now()))) sent += 1;
            })
          );
        }
        await Promise.all(tasks);
      })
    );
    return { abandoned: claimed.length, recovery_emails: sent };
  }

  async function sendRecoveryEmail(checkoutId: string): Promise<{ status: SendRecoveryStatus }> {
    const id = requiredId(checkoutId, "checkoutId");
    if (!recovery) return { status: "not_configured" };
    const w = await store.getCheckoutWatch(id);
    if (!w) return { status: "not_found" };
    if (w.status === "completed") return { status: "paid" };
    if (w.recoverySentAt) return { status: "already_sent" };
    const cfg = await config.current().catch(() => null);
    const template = cfg?.recovery_email;
    if (!template) return { status: "no_template" };
    if (!w.email) return { status: "no_email" };
    if (await store.isEmailSuppressed(w.email)) return { status: "unsubscribed" };
    const result = await recovery.send(w, template, {
      creatorName: creatorName(cfg, w.creatorId),
      unsubscribeUrl: unsubscribeUrl(w.email),
      manual: true,
    });
    if (result !== "sent") return { status: result === "disabled" ? "no_template" : result };
    await store.markRecoverySent(w.id, now());
    return { status: "sent" };
  }

  async function handleSendRecovery(request: Request): Promise<Response> {
    const denied = await adminOnly(request);
    if (denied) return denied;
    if (!isJson(request)) return json(415, { error: "expected_json" });
    const body = await readJsonBody(request, MAX_ADMIN_BODY);
    if (!body) return json(400, { error: "invalid_body" });
    const result = await sendRecoveryEmail(body.checkout_id as string);
    return json(result.status === "sent" ? 200 : result.status === "not_found" ? 404 : 409, result);
  }

  // Unsubscribe links: an HMAC of the address, so only links the connector sent work.
  const unsubKey = createHash("sha256").update("md-unsubscribe:v1:").update(key.export({ format: "der", type: "pkcs8" })).digest();
  function unsubscribeToken(email: string) {
    const mac = createHmac("sha256", unsubKey).update(email).digest("base64url").slice(0, 32);
    return `${Buffer.from(email).toString("base64url")}.${mac}`;
  }
  function unsubscribeUrl(email: string) {
    return `${siteOrigins[0]}${mountPath}/unsubscribe?t=${unsubscribeToken(email)}`;
  }
  function emailFromToken(token: string | null): string | null {
    const [encoded, mac] = (token ?? "").split(".");
    if (!encoded || !mac || encoded.length > 400) return null;
    const email = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = Buffer.from(unsubscribeToken(email).split(".")[1]!);
    const given = Buffer.from(mac);
    return expected.length === given.length && timingSafeEqual(expected, given) ? email : null;
  }

  async function handleUnsubscribe(request: Request): Promise<Response> {
    const email = emailFromToken(new URL(request.url).searchParams.get("t"));
    const page = (title: string, text: string, form = "") =>
      new Response(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 20px;color:#111"><h1 style="font-size:22px">${title}</h1><p>${text}</p>${form}</body></html>`,
        { status: email ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
      );
    if (!email) return page("Link not valid", "This unsubscribe link isn't valid. Reply to the email you received and we'll take you off the list.");
    // Mail apps' one-click unsubscribe POSTs here; a GET (which link scanners also make) only asks for confirmation.
    if (request.method === "POST") {
      await store.suppressEmail(email, now());
      return page("You're unsubscribed", "You won't get any more of these emails.");
    }
    return page(
      "Unsubscribe?",
      "Stop getting reminder emails about carts you left?",
      `<form method="post"><button type="submit" style="font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#111;color:#fff;cursor:pointer">Unsubscribe</button></form>`
    );
  }

  /** Where share links point: the dashboard's storefront_url only when it is one of this site's own origins. */
  function shareBase(cfg: ProgramConfig, requestOrigin: string | null): string | null {
    const allowed = storefrontOrigins.length ? storefrontOrigins : requestOrigin ? [requestOrigin] : [];
    const storefront = cfg.program.storefront_url;
    if (storefront && allowed.includes(normalizeOrigin(storefront) ?? "")) return storefront;
    return allowed[0] ?? null;
  }

  async function statsFor(viewer: Viewer, range: StatsRange, requestOrigin: string | null): Promise<StatsResponse> {
    const cfg = await config.current();
    const at = now();
    const { from, to } = rangeBounds(range, at);
    const abandonedBefore = new Date(at.getTime() - ABANDON_AFTER_MS);

    if (viewer.role === "admin") {
      const [aggregate, links] = await Promise.all([
        store.aggregate({ from, to, abandonedBefore, affiliateIds: null }),
        store.listCreatorLinks(),
      ]);
      return {
        ...buildStats(aggregate, cfg, { range, now: at, role: "admin" }),
        creator_links: creatorLinkRows(cfg, links),
        config_warning: config.rejection ? CONFIG_WARNINGS[config.rejection] : null,
      };
    }

    // Only a link approved by one of the site's admins counts; the dashboard's brand_user_ref is a proposal.
    const link = await store.getCreatorLinkByUserRef(viewer.userRef);
    if (!link) {
      return {
        ...buildStats(emptyAggregate(), cfg, { range, now: at, role: "creator" }),
        linked: false,
        link_pending: cfg.affiliates.some((a) => a.creator.brand_user_ref === viewer.userRef),
      };
    }
    const aggregate = link.affiliateIds.length
      ? await store.aggregate({ from, to, abandonedBefore, affiliateIds: link.affiliateIds })
      : emptyAggregate();
    return {
      ...buildStats(aggregate, cfg, {
        range,
        now: at,
        role: "creator",
        scope: { creatorId: link.creatorId, affiliateIds: link.affiliateIds },
      }),
      share_links: shareLinks(cfg, link.affiliateIds, shareBase(cfg, requestOrigin)),
    };
  }

  function validViewer(value: unknown): Viewer | null {
    if (!value || typeof value !== "object") return null;
    const v = value as { role?: unknown; userRef?: unknown };
    if (v.role === "admin") return { role: "admin" };
    if (v.role === "creator" && typeof v.userRef === "string" && v.userRef.trim()) {
      return { role: "creator", userRef: v.userRef.trim() };
    }
    return null;
  }

  async function handleStats(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    const viewer = validViewer(await getViewer(request));
    if (!viewer) return json(401, { error: "unauthorized" });
    const rangeParam = new URL(request.url).searchParams.get("range") ?? "30d";
    if (!isStatsRange(rangeParam)) return json(400, { error: "invalid_range" });
    return json(200, await statsFor(viewer, rangeParam, ownOrigins(request)[0] ?? null), { vary: "cookie" });
  }

  async function adminAction(
    request: Request,
    run: (body: Record<string, unknown>) => Promise<{ status: string }>
  ): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    if (!isJson(request)) return json(415, { error: "expected_json" });
    const viewer = validViewer(await getViewer(request));
    if (!viewer) return json(401, { error: "unauthorized" });
    if (viewer.role !== "admin") return json(403, { error: "admin_only" });
    const body = await readJsonBody(request, MAX_ADMIN_BODY);
    if (!body) return json(400, { error: "invalid_body" });
    const result = await run(body);
    const status = result.status === "approved" || result.status === "unlinked" ? 200 : result.status === "not_found" ? 404 : 409;
    return json(status, result);
  }

  async function handleTracker(request: Request): Promise<Response> {
    const cfg = await config.current().catch(() => null);
    const script = trackerScript({
      refParam: cfg?.program.ref_param ?? "ref",
      mountPath,
      cookieWindowDays: cfg?.program.cookie_window_days ?? 30,
      tags: browserTags,
    });
    return scriptResponse(request, script, cfg ? "public, max-age=300" : "no-store");
  }

  async function handleHost(request: Request): Promise<Response> {
    const script = await loadHostScript();
    if (!script) return json(404, { error: "host_script_missing" });
    return scriptResponse(request, script, "public, max-age=300");
  }

  const appId = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

  async function handleHealth(): Promise<Response> {
    await config.current().catch(() => null);
    return json(200, {
      app_id: appId,
      ok: config.loadedAt !== null,
      config_loaded_at: config.loadedAt?.toISOString() ?? null,
      dashboard_reachable: config.reachable,
      config_rejected: config.rejection,
    });
  }

  async function approveCreatorLink(input: ApproveCreatorLinkInput): Promise<ApproveCreatorLinkResult> {
    const creatorId = optionalUuid(input.creatorId, "creatorId");
    if (!creatorId) throw new ValidationError("creatorId is required");
    const userRef = cleanUserRef(input.userRef);
    if (input.affiliateIds !== undefined && (!Array.isArray(input.affiliateIds) || input.affiliateIds.length > MAX_PINNED_CODES)) {
      throw new ValidationError("affiliateIds must be a list of UUIDs");
    }
    const requested = input.affiliateIds?.map((id) => optionalUuid(id, "affiliateIds") ?? "");
    if (requested?.includes("")) throw new ValidationError("affiliateIds must be a list of UUIDs");

    const cfg = await config.current();
    const links = await store.listCreatorLinks();
    const existing = links.find((l) => l.creatorId === creatorId);
    if (existing ? existing.userRef !== userRef : links.some((l) => l.userRef === userRef)) return { status: "conflict" };
    const owned = cfg.affiliates.filter((a) => a.creator.id === creatorId);
    if (!existing && owned[0]?.creator.brand_user_ref !== userRef) return { status: "changed" };
    const affiliateIds = [...new Set(requested ?? owned.map((a) => a.id))];
    if (affiliateIds.some((id) => !owned.some((a) => a.id === id))) return { status: "changed" };
    const ok = await store.approveCreatorLink({ creatorId, userRef, affiliateIds, approvedAt: now() });
    return { status: ok ? "approved" : "conflict" };
  }

  async function unlinkCreator(creatorId: string): Promise<UnlinkCreatorResult> {
    const id = optionalUuid(creatorId, "creatorId");
    if (!id) throw new ValidationError("creatorId is required");
    return { status: (await store.deleteCreatorLink(id)) ? "unlinked" : "not_found" };
  }

  async function handleUnlock(request: Request): Promise<Response> {
    if (!access) return json(404, { error: "not_found" });
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    if (!isJson(request)) return json(415, { error: "expected_json" });
    const body = await readJsonBody(request, 2048);
    const result = access.unlock(body?.key, isSecure(request), now());
    if (!result.ok) {
      return json(result.reason === "rate_limited" ? 429 : 401, { error: result.reason }, result.reason === "rate_limited" ? { "retry-after": "60" } : {});
    }
    return json(200, { ok: true }, { "set-cookie": result.cookie });
  }

  async function handleLock(request: Request): Promise<Response> {
    if (!access) return json(404, { error: "not_found" });
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    return json(200, { ok: true }, { "set-cookie": access.lockCookie(isSecure(request)) });
  }

  async function handleSession(request: Request): Promise<Response> {
    if (!access) return json(404, { error: "not_found" });
    if (!sameOrigin(request)) return json(403, { error: "forbidden_origin" });
    if (!isJson(request)) return json(415, { error: "expected_json" });
    const body = await readJsonBody(request, 8192);
    const result = await access.exchange(body?.token, isSecure(request), now());
    if (!result.ok) return json(result.reason === "identity_unavailable" ? 503 : 401, { error: result.reason });
    return json(200, { ok: true, role: "creator" }, { "set-cookie": result.cookie });
  }

  /** GET /media: the platform's dashboard in an iframe with this site's data drawn over it. */
  function mediaPageResponse(request: Request): Response {
    if (!access) return json(404, { error: "not_found" });
    const owner = access.isOwner(request);
    const ownerPass = { userRef: "owner", name: access.ownerName };
    const page = renderMediaPage({
      brandName: options.brandName ?? brand,
      dashboardOrigin: new URL(dashboardUrl).origin,
      src: owner ? adminEntryUrlFor(ownerPass) : `${dashboardUrl}/embed?pass=${encodeURIComponent(mintCreatorPass({}))}`,
      newTabSrc: owner ? adminEntryUrlFor(ownerPass) : null,
      owner,
      mountPath,
    });
    return new Response(request.method === "HEAD" ? null : page.html, { headers: page.headers });
  }

  const routes: Record<string, { method: "GET" | "POST"; alsoPost?: boolean; run: (request: Request) => Promise<Response> }> = {
    "/owner/unlock": { method: "POST", run: handleUnlock },
    "/owner/lock": { method: "POST", run: handleLock },
    "/session": { method: "POST", run: handleSession },
    "/t.js": { method: "GET", run: handleTracker },
    "/click": { method: "POST", run: handleClick },
    "/touch": { method: "POST", run: handleTouch },
    "/stats": { method: "GET", run: handleStats },
    "/attribution": { method: "GET", run: handleAttribution },
    "/checkouts": { method: "GET", run: handleCheckouts },
    "/checkouts/send-recovery": { method: "POST", run: handleSendRecovery },
    "/unsubscribe": { method: "GET", alsoPost: true, run: handleUnsubscribe },
    "/host.js": { method: "GET", run: handleHost },
    "/health": { method: "GET", run: handleHealth },
    "/creator-links/approve": {
      method: "POST",
      run: (request) =>
        adminAction(request, (body) =>
          approveCreatorLink({
            creatorId: body.creator_id as string,
            userRef: body.user_ref as string,
            affiliateIds: Array.isArray(body.affiliate_ids) ? (body.affiliate_ids as string[]) : [],
          })
        ),
    },
    "/creator-links/unlink": {
      method: "POST",
      run: (request) => adminAction(request, (body) => unlinkCreator(body.creator_id as string)),
    },
  };

  async function handle(request: Request): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return json(400, { error: "bad_request" });
    }
    if (!pathname.startsWith(`${mountPath}/`)) return json(404, { error: "not_found" });
    const route = routes[pathname.slice(mountPath.length)];
    if (!route) return json(404, { error: "not_found" });
    const head = request.method === "HEAD" && route.method === "GET";
    if (request.method !== route.method && !head && !(route.alsoPost && request.method === "POST")) {
      return json(405, { error: "method_not_allowed" }, { allow: route.method === "GET" ? "GET, HEAD" : "POST" });
    }
    try {
      const response = await route.run(request);
      return head ? new Response(null, { status: response.status, headers: response.headers }) : response;
    } catch (error) {
      if (error instanceof ConfigUnavailableError) return json(503, { error: "config_unavailable" });
      if (error instanceof ValidationError) return json(400, { error: "invalid_request" });
      return json(500, { error: "internal_error" });
    }
  }

  function cleanUrl(value: unknown): string | null {
    const text = cleanText(value, 1000);
    if (!text) return null;
    try {
      const url = new URL(text);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  async function recordCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const id = requiredId(input.checkoutId, "checkoutId");
    const cartTotal = amount(input.cartTotal, "cartTotal");
    const cur = currency(input.currency);
    const visitorId = optionalUuid(input.visitorId, "visitorId");
    const at = now();
    const result = await creditCheckout(input);
    const credited = result.checkout;
    const { created, row } = await store.upsertCheckoutWatch({
      id,
      visitorId,
      clickId: credited?.clickId ?? null,
      affiliateId: credited?.affiliateId ?? null,
      creatorId: credited?.creatorId ?? null,
      code: credited?.code ?? null,
      cartTotal,
      currency: cur,
      status: "started",
      failureReason: null,
      step: cleanText(input.step, 40),
      customerRef: cleanText(input.customerRef, 200),
      recoveryUrl: cleanUrl(input.recoveryUrl),
      // Addresses are only kept when this site sends recovery emails, and only until sent or paid.
      email: cleanEmail(input.customer?.email),
      firstName: cleanText(input.customer?.firstName, 80),
      marketingConsent: input.marketingConsent === true,
      test: input.test === true,
      createdAt: at,
      updatedAt: at,
      abandonedNotifiedAt: null,
      recoverySentAt: null,
    });
    if (!created) return result;
    if (!row.test) emit("checkout.started", watchPayload(row, await config.current().catch(() => null)));
    if (forwarder && (!row.test || forwardTest)) {
      result.conversions = await forwarder.send({
        kind: "checkout",
        eventId: `checkout-${id}`,
        value: cartTotal,
        currency: cur,
        occurredAt: at,
        customer: cleanCustomer(input.customer),
        items: cleanItems(input.items),
        sourceUrl: cleanUrl(input.sourceUrl),
      });
    }
    return result;
  }

  async function recordCheckoutStep(input: CheckoutStepInput): Promise<{ status: "updated" | "not_found" }> {
    const id = requiredId(input.checkoutId, "checkoutId");
    const step = cleanText(input.step, 40);
    if (!step) throw new ValidationError("step is required");
    return { status: (await store.setCheckoutWatchStep(id, step, now())) ? "updated" : "not_found" };
  }

  async function creditCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const id = requiredId(input.checkoutId, "checkoutId");
    const cartTotal = amount(input.cartTotal, "cartTotal");
    const cur = currency(input.currency);
    const clickId = optionalUuid(input.clickId, "clickId");
    const code = cleanText(input.code, 64);
    const at = now();

    const existing = await store.getCheckout(id);
    if (existing) {
      const checkout = await store.upsertCheckout({
        ...existing,
        cartTotal,
        currency: cur,
        typedCode: code ?? existing.typedCode,
        updatedAt: at,
      });
      return { status: "updated", checkout };
    }
    const cfg = await config.current();
    const click = clickId ? await store.getClick(clickId) : null;
    const credit = attribute(cfg, [click], code, at);
    if (!credit) return { status: "not_attributed", checkout: null };
    const checkout = await store.upsertCheckout({
      id,
      clickId: credit.click?.id ?? null,
      affiliateId: credit.affiliate.id,
      creatorId: credit.affiliate.creator.id,
      code: credit.affiliate.code,
      typedCode: code,
      campaignId: credit.click?.campaignId ?? null,
      linkId: credit.click?.linkId ?? null,
      cartTotal,
      currency: cur,
      status: "started",
      failureReason: null,
      test: input.test === true,
      createdAt: at,
      updatedAt: at,
    });
    return { status: "recorded", checkout };
  }

  async function recordCheckoutFailed(input: CheckoutFailedInput): Promise<CheckoutFailedResult> {
    const id = requiredId(input.checkoutId, "checkoutId");
    const reason = cleanText(input.reason, 120);
    const at = now();
    const existing = await store.getCheckout(id);
    const changed = existing ? await store.setCheckoutStatus(id, "failed", reason, at) : false;
    const watchChanged = await store.setCheckoutWatchStatus(id, "failed", reason, at);
    if (watchChanged) {
      const row = await store.getCheckoutWatch(id);
      if (row && !row.test) emit("checkout.failed", watchPayload(row, await config.current().catch(() => null)));
    }
    if (!existing && !watchChanged && !(await store.getCheckoutWatch(id))) return { status: "not_found" };
    return { status: changed || watchChanged ? "failed" : "ignored" };
  }

  async function recordOrder(input: OrderInput): Promise<OrderResult> {
    const result = await creditOrder(input);
    const id = requiredId(input.orderId, "orderId");
    const checkoutId = optionalId(input.checkoutId, "checkoutId");
    const total = amount(input.amount, "amount");
    const cur = currency(input.currency);
    const at = now();
    const occurredAt = optionalDate(input.occurredAt, "occurredAt", at);
    const test = input.test === true;

    const watch = checkoutId ? await store.getCheckoutWatch(checkoutId) : null;
    if (watch) await store.setCheckoutWatchStatus(watch.id, "completed", null, at);
    // Paid from a different cart than the one that was recorded: close this shopper's other open checkouts too.
    const paidBy = cleanEmail(input.customer?.email);
    if (paidBy && !input.test) await store.completeOpenCheckoutsByEmail(paidBy, new Date(at.getTime() - ABANDON_LOOKBACK_MS), at);
    const visitorId = optionalUuid(input.visitorId, "visitorId") ?? watch?.visitorId ?? null;
    const touches = visitorId
      ? await store.listTouches(visitorId, new Date(occurredAt.getTime() - lookbackMs), occurredAt, MAX_JOURNEY_TOUCHES)
      : [];
    const journey: JourneyTouch[] = touches.map((t) => ({
      channel: t.channel,
      source: t.source,
      campaign: t.campaign,
      refCode: t.refCode,
      at: t.createdAt,
    }));
    // The journey row is the per-order idempotency key: retried webhooks don't re-send conversions or events.
    const isNew = await store.insertJourney({
      orderId: id,
      visitorId,
      amount: total,
      currency: cur,
      test,
      occurredAt,
      refundedAt: null,
      touches: journey,
    });
    if (!isNew) return result;

    if (!test) {
      const cfg = await config.current().catch(() => null);
      emit("order.created", {
        order_id: id,
        checkout_id: checkoutId,
        amount: total,
        currency: cur,
        code: result.order?.code ?? null,
        creator: result.order?.creatorId ? { id: result.order.creatorId, name: creatorName(cfg, result.order.creatorId) } : null,
        commission: result.order?.commission ?? null,
        attributed_via: result.order?.attributedVia ?? null,
        first_touch: journey[0]?.channel ?? "direct",
        last_touch: journey.at(-1)?.channel ?? "direct",
        touches: journey.length,
        occurred_at: occurredAt.toISOString(),
      });
    }
    if (forwarder && (!test || forwardTest)) {
      result.conversions = await forwarder.send({
        kind: "purchase",
        eventId: id,
        value: total,
        currency: cur,
        occurredAt,
        customer: cleanCustomer(input.customer),
        items: cleanItems(input.items),
        sourceUrl: cleanUrl(input.sourceUrl),
      });
    }
    return result;
  }

  async function creditOrder(input: OrderInput): Promise<OrderResult> {
    const id = requiredId(input.orderId, "orderId");
    const checkoutId = optionalId(input.checkoutId, "checkoutId");
    const clickId = optionalUuid(input.clickId, "clickId");
    const total = amount(input.amount, "amount");
    const cur = currency(input.currency);
    const at = now();
    const occurredAt = optionalDate(input.occurredAt, "occurredAt", at);
    const explicitCampaign = optionalUuid(input.campaignId, "campaignId");
    const productRef = cleanText(input.productRef, 200);
    const code = cleanText(input.code, 64);

    const checkout = checkoutId ? await store.getCheckout(checkoutId) : null;
    if (checkout) await store.setCheckoutStatus(checkout.id, "completed", null, at);

    const existing = await store.getOrder(id);
    if (existing) return { status: "duplicate", order: existing };

    const cfg = await config.current();
    const clickIds = [...new Set([clickId, checkout?.clickId ?? null].filter((c): c is string => c !== null))];
    const clicks = await Promise.all(clickIds.map((c) => store.getClick(c)));
    // Only a code the customer actually typed is a fallback; the checkout's credited code is not.
    const credit = attribute(cfg, clicks, code ?? checkout?.typedCode ?? null, occurredAt);
    if (!credit) {
      await store.takePendingRefund(id);
      return { status: "not_attributed", order: null };
    }

    const order: OrderRecord = {
      id,
      checkoutId,
      clickId: credit.click?.id ?? null,
      affiliateId: credit.affiliate.id,
      creatorId: credit.affiliate.creator.id,
      code: credit.affiliate.code,
      campaignId: explicitCampaign ?? credit.click?.campaignId ?? null,
      linkId: credit.click?.linkId ?? null,
      attributedVia: credit.via,
      amount: total,
      currency: cur,
      commissionBps: credit.affiliate.commission_bps,
      commission: commissionFor(total, credit.affiliate.commission_bps),
      productRef,
      test: input.test === true,
      occurredAt,
      refundedAt: null,
      createdAt: at,
    };
    if (await store.insertOrder(order)) {
      const refundedAt = await store.takePendingRefund(id);
      if (refundedAt && (await store.markOrderRefunded(id, refundedAt))) order.refundedAt = refundedAt;
      return { status: "recorded", order };
    }
    const stored = await store.getOrder(id);
    return stored ? { status: "duplicate", order: stored } : { status: "recorded", order };
  }

  async function recordRefund(input: RefundInput): Promise<RefundResult> {
    const id = requiredId(input.orderId, "orderId");
    const received = now();
    const at = optionalDate(input.refundedAt, "refundedAt", received);
    if (await store.markJourneyRefunded(id, at)) emit("order.refunded", { order_id: id, refunded_at: at.toISOString() });
    return creditRefund(id, at, received);
  }

  async function creditRefund(id: string, at: Date, received: Date): Promise<RefundResult> {
    const existing = await store.getOrder(id);
    if (existing) {
      if (existing.refundedAt) return { status: "already_refunded" };
      return { status: (await store.markOrderRefunded(id, at)) ? "refunded" : "already_refunded" };
    }
    // Webhooks arrive out of order: keep it for the order. Whichever side takes the pending refund applies it.
    await store.savePendingRefund(id, at, received);
    if (!(await store.getOrder(id))) return { status: "pending" };
    const pending = await store.takePendingRefund(id);
    if (!pending) return { status: "refunded" };
    return { status: (await store.markOrderRefunded(id, pending)) ? "refunded" : "already_refunded" };
  }

  function passUser(input: { userRef?: unknown; name?: unknown }, nameRequired: boolean) {
    const userRef = cleanUserRef(input.userRef);
    const name = cleanText(input.name, 80);
    if (nameRequired && !name) throw new ValidationError("name is required for admin passes");
    return { userRef, name };
  }

  function mintCreatorPass(input: PassInput): string {
    if (input.userRef === undefined || input.userRef === null || input.userRef === "") {
      return mintPassToken(key, { brand, role: "creator", sub: "", name: cleanText(input.name, 80), now: now() });
    }
    const { userRef, name } = passUser(input, false);
    return mintPassToken(key, { brand, role: "creator", sub: userRef, name, now: now() });
  }

  function adminEntryUrlFor(input: AdminPassInput): string {
    return `${dashboardUrl}/enter/admin?pass=${encodeURIComponent(mintAdminPass(input))}`;
  }

  function mintAdminPass(input: AdminPassInput): string {
    const { userRef, name } = passUser(input, true);
    return mintPassToken(key, { brand, role: "admin", sub: userRef, name, now: now() });
  }

  return {
    handle,
    routeHandlers: () => ({ GET: (request) => handle(request), POST: (request) => handle(request) }),
    recordCheckout,
    recordCheckoutFailed,
    recordOrder,
    recordRefund,
    recordCheckoutStep,
    clickIdFromRequest: (request) => clickIdFromCookieHeader(request.headers.get("cookie")),
    visitorIdFromRequest: (request) => uuidCookie(request.headers.get("cookie"), VISITOR_COOKIE),
    browserContext: (request) => {
      const ctx = browserContextFromHeaders(request.headers, clientIp(request));
      const ttclid = cleanText(rawCookie(request.headers.get("cookie"), TTCLID_COOKIE), 200);
      return ttclid ? { ...ctx, ttclid } : ctx;
    },
    getAttribution,
    listCheckouts,
    runScheduledTasks,
    sendRecoveryEmail,
    cartAttributes: (request, cartId) => {
      const header = request.headers.get("cookie");
      const ctx = browserContextFromHeaders(request.headers, null);
      const pairs: Array<[string, string | null | undefined]> = [
        [SHOPIFY_ATTRIBUTES.click, clickIdFromCookieHeader(header)],
        [SHOPIFY_ATTRIBUTES.visitor, uuidCookie(header, VISITOR_COOKIE)],
        [SHOPIFY_ATTRIBUTES.fbp, ctx.fbp],
        [SHOPIFY_ATTRIBUTES.fbc, ctx.fbc],
        [SHOPIFY_ATTRIBUTES.ttp, ctx.ttp],
        [SHOPIFY_ATTRIBUTES.ttclid, cleanText(rawCookie(header, TTCLID_COOKIE), 200)],
        [SHOPIFY_ATTRIBUTES.ga, ctx.gaClientId],
        [SHOPIFY_ATTRIBUTES.cart, cartId ? shopifyCartToken(cartId) : null],
      ];
      return pairs.filter((p): p is [string, string] => !!p[1]).map(([key, value]) => ({ key, value }));
    },
    getStats: async (viewer, range = "30d") => {
      const v = validViewer(viewer);
      if (!v) throw new ValidationError("viewer must be { role: \"admin\" } or { role: \"creator\", userRef }");
      return statsFor(v, range, null);
    },
    getConfig: () => config.current(),
    refreshConfig: () => config.refresh(),
    listCreatorLinks: async () => creatorLinkRows(await config.current(), await store.listCreatorLinks()),
    approveCreatorLink,
    unlinkCreator,
    mintCreatorPass,
    mintAdminPass,
    creatorEmbedUrl: (input) => `${dashboardUrl}/embed?pass=${encodeURIComponent(mintCreatorPass(input))}`,
    adminEntryUrl: adminEntryUrlFor,
    mediaPage: mediaPageResponse,
    isOwner: (request) => access?.isOwner(request) ?? false,
    close: () => {
      config.stop();
      if (scheduleTimer) clearInterval(scheduleTimer);
    },
  };
}
