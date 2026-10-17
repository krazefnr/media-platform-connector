import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { APP_SERVICE_BY_ID, validateService, type SavedServices } from "./app-services.js";
import { ConfigUnavailableError } from "./config.js";
import { createConnector, type Connector, type ConnectorOptions } from "./connector.js";
import { loadPrivateKey } from "./keys.js";
import { TokenBucket } from "./rate-limit.js";
import { setupPage, type CheckResult } from "./setup-page.js";
import {
  createStorefront,
  shopifyCartToken,
  shopifyCheckoutInput,
  shopifyOrderInput,
  StorefrontError,
  verifyShopifyWebhook,
} from "./shopify.js";
import type { Store } from "./store.js";
import { cleanText, ValidationError } from "./validate.js";

/*
 * The connector app each brand deploys to its own Vercel account. It owns:
 * - its key pair (made on first start, kept in its own database),
 * - the service keys the owner pastes into its setup page,
 * - every route the brand's site sends to it through one rewrite rule
 *   (/api/md/* and /media), plus Shopify's webhooks and checkout pixel,
 * - scheduled work (config refresh, abandoned-checkout emails),
 * - a self-check that says exactly what's missing.
 * Its data never leaves it; the platform only learns service NAMES and
 * check states, so it can show ticks.
 */

export type ConnectorAppOptions = {
  env: Record<string, string | undefined>;
  store: Store;
  /** Creates the md_ tables (ensureSchema(pool)). Runs once per server instance. */
  ensureSchema?: () => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Serverless: keeps background work alive after the response (Next's after / Vercel's waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type ConnectorApp = { handle(request: Request): Promise<Response> };

type Env = {
  dashboardUrl: string;
  brand: string;
  brandName: string;
  siteOrigin: string;
  ownerKey: string;
  connectorOrigin: string | null;
  cronSecret: string | null;
};

const STEP_NAMES = ["information", "shipping", "payment", "paying"];
const SETTINGS_TTL_MS = 60_000;
const BEAT_WRITE_MS = 5 * 60_000;
const TASKS_EVERY_MS = 2 * 60_000;
const DAY = 86_400_000;

function origin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

function readEnv(env: Record<string, string | undefined>): { env: Env | null; missing: string[] } {
  const missing: string[] = [];
  const dashboardUrl = origin(env.MEDIA_PLATFORM_URL);
  const brand = (env.BRAND ?? "").trim().toLowerCase();
  const siteOrigin = origin(env.SITE_URL);
  const ownerKey = env.OWNER_KEY ?? "";
  if (!dashboardUrl) missing.push("MEDIA_PLATFORM_URL (the Media Platform's address)");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(brand)) missing.push("BRAND (your brand id, e.g. kraze)");
  if (!siteOrigin) missing.push("SITE_URL (your website, e.g. https://www.kraze.com)");
  if (ownerKey.trim().length < 12) missing.push("OWNER_KEY (at least 12 characters)");
  if (missing.length) return { env: null, missing };
  return {
    env: {
      dashboardUrl: dashboardUrl!,
      brand,
      brandName: (env.BRAND_NAME ?? "").trim() || brand.charAt(0).toUpperCase() + brand.slice(1),
      siteOrigin: siteOrigin!,
      ownerKey: ownerKey.trim(),
      connectorOrigin: origin(env.CONNECTOR_URL) ?? origin(env.VERCEL_PROJECT_PRODUCTION_URL),
      cronSecret: env.CRON_SECRET?.trim() || null,
    },
    missing,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const html = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
    },
  });

async function readJson(request: Request, limit: number): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => "");
  if (!text || text.length > limit) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createConnectorApp(options: ConnectorAppOptions): ConnectorApp {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const background = (promise: Promise<unknown>) => {
    const safe = promise.catch(() => undefined);
    options.waitUntil?.(safe);
  };
  const { env, missing } = readEnv(options.env);

  let schema: Promise<void> | null = null;
  let key: Promise<KeyObject> | null = null;
  let cached: { at: number; services: SavedServices; version: string; connector: Connector; connectorOrigin: string } | null = null;
  let checksState: Record<string, string> = {};
  const beats = new Map<string, number>();
  let lastTaskCheck = 0;
  const startedLimiter = new TokenBucket(120, 2);
  const stepLimiter = new TokenBucket(300, 5);

  function ensureSchema() {
    schema ??= (options.ensureSchema?.() ?? Promise.resolve()).catch((error) => {
      schema = null;
      throw error;
    });
    return schema;
  }

  /** Made on first start, kept in the app's own database, never leaves it. */
  function privateKey(): Promise<KeyObject> {
    key ??= (async () => {
      await ensureSchema();
      let stored = await store.getSetting("app:private_key");
      if (typeof stored !== "string") {
        if (await store.useTokenOnce("lock:app:private_key", new Date("2100-01-01T00:00:00Z"), now())) {
          const pair = generateKeyPairSync("ed25519");
          stored = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
          await store.setSetting("app:private_key", stored, now());
        } else {
          for (let i = 0; i < 40 && typeof stored !== "string"; i++) {
            await sleep(250);
            stored = await store.getSetting("app:private_key");
          }
        }
      }
      if (typeof stored !== "string") throw new Error("The app's key isn't ready yet. Try again in a moment.");
      return loadPrivateKey(stored);
    })().catch((error) => {
      key = null;
      throw error;
    });
    return key;
  }

  async function services(): Promise<SavedServices> {
    const all = await store.listSettings("svc:");
    const out: SavedServices = {};
    for (const [k, v] of Object.entries(all)) {
      if (v && typeof v === "object") out[k.slice(4)] = v as Record<string, string>;
    }
    return out;
  }

  function connectorOptions(e: Env, k: KeyObject, svc: SavedServices, connectorOrigin: string): ConnectorOptions {
    const s = (id: string) => svc[id];
    return {
      brand: e.brand,
      brandName: e.brandName,
      dashboardUrl: e.dashboardUrl,
      privateKey: k,
      store,
      fetch: fetchImpl,
      now,
      siteOrigin: [e.siteOrigin, connectorOrigin],
      storefrontOrigins: [e.siteOrigin],
      configRefresh: "manual",
      waitUntil: options.waitUntil,
      access: { ownerKey: e.ownerKey, ownerName: `${e.brandName} owner` },
      reportStatus: () => checksState,
      installedTools: s("shopify") ? ["shopify"] : [],
      tags: {
        clarity: s("clarity")?.projectId,
        tiktok: s("tiktok")?.pixelCode,
        meta: s("meta")?.pixelId,
        ga4: s("ga4")?.measurementId,
        pinterest: s("pinterest")?.tagId,
        snap: s("snap")?.pixelId,
      },
      conversions: {
        meta: s("meta") ? { pixelId: s("meta")!.pixelId!, accessToken: s("meta")!.accessToken! } : undefined,
        tiktok: s("tiktok") ? { pixelCode: s("tiktok")!.pixelCode!, accessToken: s("tiktok")!.accessToken! } : undefined,
        ga4: s("ga4") ? { measurementId: s("ga4")!.measurementId!, apiSecret: s("ga4")!.apiSecret! } : undefined,
      },
      recoveryEmails: s("resend") ? { resendApiKey: s("resend")!.apiKey!, from: s("resend")!.from!, brandName: e.brandName } : undefined,
      webhooks: s("webhook") ? { endpoints: [{ url: s("webhook")!.url!, secret: s("webhook")!.secret! }] } : undefined,
    };
  }

  async function load(request: Request | null, force = false) {
    if (!env) throw new Error("not_configured");
    const at = now().getTime();
    if (cached && !force && at - cached.at < SETTINGS_TTL_MS) return cached;
    const [k, svc] = await Promise.all([privateKey(), services()]);
    const version = JSON.stringify(svc);
    const connectorOrigin = env.connectorOrigin ?? cached?.connectorOrigin ?? (request ? new URL(request.url).origin : env.siteOrigin);
    if (cached && cached.version === version && cached.connectorOrigin === connectorOrigin) {
      cached.at = at;
      return cached;
    }
    const checks = await store.getSetting("app:checks");
    if (checks && typeof checks === "object" && "state" in checks) checksState = (checks as { state: Record<string, string> }).state ?? {};
    cached?.connector.close();
    const connector = createConnector(connectorOptions(env, k, svc, connectorOrigin));
    // Start the first pull now: requests that need the config wait for it instead of failing.
    background(connector.refreshConfig());
    cached = { at, services: svc, version, connector, connectorOrigin };
    return cached;
  }

  function beat(kind: string) {
    const at = now().getTime();
    if (at - (beats.get(kind) ?? 0) < BEAT_WRITE_MS) return;
    beats.set(kind, at);
    background(store.setSetting(`beat:${kind}`, { at: new Date(at).toISOString() }, new Date(at)));
  }

  function maybeTasks(request: Request) {
    const at = now().getTime();
    if (at - lastTaskCheck < 60_000) return;
    lastTaskCheck = at;
    background(
      (async () => {
        const last = await store.getSetting("app:tasks_at");
        if (typeof last === "string" && at - Date.parse(last) < TASKS_EVERY_MS) return;
        await store.setSetting("app:tasks_at", new Date(at).toISOString(), new Date(at));
        await runTasks(request);
      })()
    );
  }

  async function runTasks(request: Request | null) {
    const { connector } = await load(request);
    const config = await connector.refreshConfig().then(() => "ok", () => "failed");
    const tasks = await connector.runScheduledTasks().catch(() => ({ abandoned: 0, recovery_emails: 0 }));
    beat("tasks");
    return { config, ...tasks };
  }

  const sameSite = (request: Request, c: { connectorOrigin: string }) => {
    const o = request.headers.get("origin");
    return o === null || o === env!.siteOrigin || o === c.connectorOrigin;
  };

  // ---- Shopify --------------------------------------------------------------

  async function handleShopifyWebhook(request: Request): Promise<Response> {
    const c = await load(request);
    const secret = c.services.shopify?.webhookSecret;
    const raw = await request.text();
    if (!secret || !verifyShopifyWebhook(raw, request.headers.get("x-shopify-hmac-sha256"), secret)) {
      return new Response("bad hmac", { status: 401 });
    }
    const topic = request.headers.get("x-shopify-topic") ?? "";
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return new Response("ignored");
    }
    beat(`shopify:${topic}`);
    try {
      if (topic === "checkouts/create" || topic === "checkouts/update") await c.connector.recordCheckout(shopifyCheckoutInput(body));
      else if (topic === "orders/paid") await c.connector.recordOrder(shopifyOrderInput(body));
      else if (topic === "orders/updated" && body.financial_status === "refunded") await c.connector.recordRefund({ orderId: String(body.id) });
    } catch (error) {
      if (error instanceof ValidationError) return new Response("ignored");
      if (error instanceof ConfigUnavailableError) return new Response("not ready", { status: 503 });
      throw error;
    }
    return new Response("ok");
  }

  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };

  async function handleStep(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!stepLimiter.take("site", now().getTime())) return new Response(null, { status: 429, headers: cors });
    const c = await load(request);
    const body = await readJson(request, 1024);
    const step = typeof body?.step === "string" ? body.step : "";
    const token = cleanText(body?.token, 200);
    if (!token || !STEP_NAMES.includes(step) || !/^[\w-]{8,200}$/.test(token)) return new Response(null, { status: 400, headers: cors });
    await c.connector.recordCheckoutStep({ checkoutId: token, step }).catch(() => null);
    beat("pixel");
    return new Response(null, { status: 204, headers: cors });
  }

  async function handleCheckoutStarted(request: Request): Promise<Response> {
    const c = await load(request);
    if (!sameSite(request, c)) return json(403, { error: "forbidden_origin" });
    if (!startedLimiter.take("site", now().getTime())) return json(429, { error: "rate_limited" });
    const shop = c.services.shopify;
    if (!shop) return json(503, { error: "shopify_not_set_up" });
    const body = await readJson(request, 2048);
    const email = cleanText(body?.email, 254)?.toLowerCase() ?? "";
    const cartId = cleanText(body?.cart_id, 300) ?? "";
    const token = shopifyCartToken(cartId);
    if (!/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i.test(email) || !token) return json(400, { error: "invalid_request" });
    const storefront = createStorefront({ storeDomain: shop.storeDomain!, storefrontToken: shop.storefrontToken!, fetch: fetchImpl });
    try {
      const cart = await storefront.cart(cartId);
      if (!cart || !cart.items.length) return json(404, { error: "cart_not_found" });
      const ours = c.connector.cartAttributes(request, cartId);
      const merged = [...cart.attributes.filter((a) => !ours.some((o) => o.key === a.key)), ...ours];
      const changed = ours.some((o) => !cart.attributes.some((a) => a.key === o.key && a.value === o.value));
      await Promise.all([
        changed ? storefront.setAttributes(cartId, merged) : null,
        cart.email?.toLowerCase() !== email ? storefront.setEmail(cartId, email) : null,
      ]);
      await c.connector.recordCheckout({
        checkoutId: token,
        clickId: c.connector.clickIdFromRequest(request),
        visitorId: c.connector.visitorIdFromRequest(request),
        cartTotal: cart.total,
        currency: cart.currency,
        customer: { ...c.connector.browserContext(request), email, firstName: cleanText(body?.first_name, 80) },
        items: cart.items,
        recoveryUrl: cart.checkoutUrl || null,
        step: "email",
      });
      beat("checkout_started");
      return json(200, { ok: true });
    } catch (error) {
      if (error instanceof StorefrontError) return json(502, { error: "shopify_error" });
      if (error instanceof ValidationError) return json(400, { error: "invalid_request" });
      if (error instanceof ConfigUnavailableError) return json(503, { error: "not_ready" });
      throw error;
    }
  }

  // ---- Setup ----------------------------------------------------------------

  async function register(c: { connectorOrigin: string }, code: string): Promise<{ ok: boolean; error?: string }> {
    const k = await privateKey();
    const body = JSON.stringify({
      brand: env!.brand,
      code,
      public_key: Buffer.from(createPublicKey(k).export({ type: "spki", format: "pem" }).toString()).toString("base64"),
      site_origin: env!.siteOrigin,
      connector_origin: c.connectorOrigin,
      ts: now().toISOString(),
    });
    try {
      const response = await fetchImpl(`${env!.dashboardUrl}/api/brand/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-md-signature": sign(null, Buffer.from(body), k).toString("base64") },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      const answer = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) return { ok: false, error: answer.error ?? `The Media Platform answered ${response.status}.` };
      await store.setSetting("app:registered", { at: now().toISOString() }, now());
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't reach the Media Platform. Check MEDIA_PLATFORM_URL." };
    }
  }

  async function check(c: Awaited<ReturnType<typeof load>>): Promise<CheckResult[]> {
    const beatsSaved = await store.listSettings("beat:");
    const seen = (kind: string, withinMs = 30 * DAY) => {
      const v = beatsSaved[`beat:${kind}`] as { at?: string } | undefined;
      return !!v?.at && now().getTime() - Date.parse(v.at) < withinMs;
    };
    const registered = !!(await store.getSetting("app:registered"));
    const results: CheckResult[] = [];
    const add = (r: CheckResult) => results.push(r);

    add({ id: "database", label: "Database", state: "ok", detail: "Tables ready." });

    const config = await c.connector.refreshConfig().then(
      () => ({ ok: true, error: "" }),
      (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "unreachable" })
    );
    add(
      config.ok
        ? { id: "platform", label: "Connected to the Media Platform", state: "ok", detail: "Settings received." }
        : {
            id: "platform",
            label: "Connected to the Media Platform",
            state: "fail",
            detail: registered
              ? `Can't get settings from the Media Platform (${config.error}).`
              : "Paste the connect code from the Media Platform's Integration page in step 1.",
          }
    );

    const health = await fetchImpl(`${env!.siteOrigin}/api/md/health`, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } })
      .then(async (r) => (r.ok ? ((await r.json()) as { app_id?: string }) : null))
      .catch(() => null);
    const ownHealth = (await (await c.connector.handle(new Request(`${c.connectorOrigin}/api/md/health`))).json()) as { app_id?: string };
    add(
      health?.app_id && health.app_id === ownHealth.app_id
        ? { id: "website", label: "Website rewrite", state: "ok", detail: `${env!.siteOrigin}/api/md reaches this app.` }
        : { id: "website", label: "Website rewrite", state: "fail", detail: `${env!.siteOrigin}/api/md doesn't reach this app yet. Add the rewrite rule (step 2) and deploy your website.` }
    );
    const media = await fetchImpl(`${env!.siteOrigin}/media`, { signal: AbortSignal.timeout(8000) })
      .then(async (r) => (r.ok ? await r.text() : ""))
      .catch(() => "");
    add(
      media.includes("Media Platform")
        ? { id: "media_page", label: "/media page", state: "ok", detail: `${env!.siteOrigin}/media works.` }
        : { id: "media_page", label: "/media page", state: "fail", detail: `${env!.siteOrigin}/media isn't showing this app's page. Add the /media rewrite (step 2).` }
    );
    add(
      seen("tracker", 7 * DAY)
        ? { id: "tracker", label: "Tracker on your pages", state: "ok", detail: "Visits are being recorded." }
        : { id: "tracker", label: "Tracker on your pages", state: "warn", detail: "No visits seen yet. Add the script tag (step 2), then open your site once." }
    );
    add(
      seen("checkout_started")
        ? { id: "checkout_email", label: "Email step", state: "ok", detail: "Shopper emails are being logged." }
        : { id: "checkout_email", label: "Email step", state: "warn", detail: "No checkout started yet. Add the checkoutStarted line (step 2), then start a test checkout." }
    );
    const shop = c.services.shopify;
    const webhooks = ["checkouts/create", "orders/paid"].filter((t) => seen(`shopify:${t}`));
    add(
      !shop
        ? { id: "shopify", label: "Shopify", state: "fail", detail: "Add your Shopify details in step 3." }
        : webhooks.length === 2
          ? { id: "shopify", label: "Shopify", state: "ok", detail: "Checkouts and paid orders are arriving." }
          : { id: "shopify", label: "Shopify", state: "warn", detail: `Waiting for Shopify: ${["checkouts/create", "orders/paid"].filter((t) => !webhooks.includes(t)).join(" and ")} not received yet. Create the webhooks in step 3, then place a test order.` }
    );
    add(
      seen("pixel")
        ? { id: "shopify_pixel", label: "Checkout steps pixel", state: "ok", detail: "Checkout steps are arriving." }
        : { id: "shopify_pixel", label: "Checkout steps pixel", state: "warn", detail: "No checkout steps yet. Add the custom pixel in step 3." }
    );
    add(
      seen("tasks", 6 * 3600_000)
        ? { id: "tasks", label: "Background tasks", state: "ok", detail: "Running." }
        : { id: "tasks", label: "Background tasks", state: "warn", detail: "Not run recently. They run whenever your site has visitors; the daily Vercel cron is a backup." }
    );
    for (const id of ["resend", "tiktok", "meta", "ga4", "clarity", "pinterest", "snap", "webhook"]) {
      if (c.services[id]) add({ id, label: APP_SERVICE_BY_ID.get(id)!.name, state: "ok", detail: "Switched on." });
    }
    const state: Record<string, string> = {};
    for (const r of results) state[r.id] = r.state;
    checksState = state;
    await store.setSetting("app:checks", { at: now().toISOString(), state }, now());
    return results;
  }

  async function handleSetup(request: Request, path: string): Promise<Response> {
    if (!env) return html(503, setupPage({ kind: "missing", missing }));
    const c = await load(request);
    const owner = c.connector.isOwner(request);
    if (path === "/" || path === "/setup") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
      if (!owner) return html(200, setupPage({ kind: "locked", brandName: env.brandName }));
      const results = await check(c);
      const registered = !!(await store.getSetting("app:registered"));
      return html(
        200,
        setupPage({
          kind: "setup",
          brandName: env.brandName,
          dashboardUrl: env.dashboardUrl,
          siteOrigin: env.siteOrigin,
          connectorOrigin: c.connectorOrigin,
          registered,
          services: c.services,
          checks: results,
        })
      );
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!owner) return json(401, { error: "locked" });
    if (!sameSite(request, c)) return json(403, { error: "forbidden_origin" });
    const body = await readJson(request, 8192);
    if (!body) return json(400, { error: "invalid_body" });
    if (path === "/setup/connect") {
      const code = cleanText(body.code, 100) ?? "";
      if (!/^[A-Za-z0-9-]{8,100}$/.test(code)) return json(400, { error: "That doesn't look like a connect code." });
      const result = await register(c, code);
      return result.ok ? json(200, { ok: true }) : json(400, { error: result.error });
    }
    if (path === "/setup/service") {
      const id = typeof body.service === "string" ? body.service : "";
      if (body.remove === true) {
        if (!APP_SERVICE_BY_ID.has(id)) return json(400, { error: "Unknown service." });
        await store.setSetting(`svc:${id}`, null, now());
      } else {
        const valid = validateService(id, body.values);
        if (!valid.ok) return json(400, { error: valid.error });
        await store.setSetting(`svc:${id}`, valid.values, now());
      }
      await load(request, true);
      return json(200, { ok: true });
    }
    return json(404, { error: "not_found" });
  }

  // ---- Router ---------------------------------------------------------------

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/setup" || path.startsWith("/setup/")) return handleSetup(request, path);
    if (!env) return json(503, { error: "not_configured", missing });
    if (path === "/api/cron") {
      const auth = request.headers.get("authorization");
      if (env.cronSecret && auth !== `Bearer ${env.cronSecret}`) return json(401, { error: "unauthorized" });
      return json(200, await runTasks(request));
    }
    if (path === "/api/md/shopify/webhook" && request.method === "POST") return handleShopifyWebhook(request);
    if (path === "/api/md/shopify/step") return handleStep(request);
    if (path === "/api/md/checkout-started" && request.method === "POST") return handleCheckoutStarted(request);
    const c = await load(request);
    if (path === "/media") {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed" });
      return c.connector.mediaPage(request);
    }
    if (path.startsWith("/api/md/")) {
      if (path === "/api/md/t.js" || path === "/api/md/touch" || path === "/api/md/click") beat("tracker");
      return c.connector.handle(request);
    }
    return json(404, { error: "not_found" });
  }

  return {
    async handle(request) {
      try {
        const response = await route(request);
        if (env) maybeTasks(request);
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "not_configured") return json(503, { error: "not_configured", missing });
        return json(500, { error: "internal_error" });
      }
    },
  };
}
