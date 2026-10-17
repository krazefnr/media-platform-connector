import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createPublicKey, verify } from "node:crypto";
import { createConnectorApp, memoryStore } from "../server/index.js";
import { configFixture, DASHBOARD, SITE, testStore } from "./helpers.js";

const CONNECTOR = "https://kraze-connector.example";
const SHOP = "kraze.myshopify.com";
const OWNER_KEY = "a-very-long-owner-key-123";
const CART_ID = "gid://shopify/Cart/Z2NwLWV1cm9wZS13ZXN0NDox?key=abc";
const CART_TOKEN = "Z2NwLWV1cm9wZS13ZXN0NDox";
const WEBHOOK_SECRET = "test_webhook_secret_not_real_000000";

const ENV = {
  MEDIA_PLATFORM_URL: DASHBOARD,
  BRAND: "kraze",
  BRAND_NAME: "Kraze",
  SITE_URL: SITE,
  OWNER_KEY,
  CONNECTOR_URL: CONNECTOR,
};

type Registered = { body: Record<string, string>; validSignature: boolean };

function world() {
  const registered: Registered[] = [];
  const configHeaders: Record<string, string>[] = [];
  const cart = {
    attributes: [{ key: "gift", value: "no" }] as Array<{ key: string; value: string }>,
    email: null as string | null,
  };
  let app: ReturnType<typeof createConnectorApp>;

  // The brand's main site: its next.config rewrite sends /api/md/* and /media to the connector app.
  const viaSite = (request: Request) => {
    const url = new URL(request.url);
    return app.handle(
      new Request(`${CONNECTOR}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        // @ts-expect-error Node needs duplex for a streamed body
        duplex: "half",
      })
    );
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === `${DASHBOARD}/api/brand/kraze/config`) {
      const h: Record<string, string> = {};
      headers.forEach((v, k) => (h[k] = v));
      configHeaders.push(h);
      return Response.json(configFixture());
    }
    if (url === `${DASHBOARD}/api/brand/register`) {
      const body = String(init?.body);
      const parsed = JSON.parse(body) as Record<string, string>;
      const pub = createPublicKey(Buffer.from(parsed.public_key!, "base64").toString("utf8"));
      const validSignature = verify(null, Buffer.from(body), pub, Buffer.from(headers.get("x-md-signature") ?? "", "base64"));
      registered.push({ body: parsed, validSignature });
      return parsed.code === "GOOD-CODE-123" ? Response.json({ ok: true }) : Response.json({ error: "That code has expired." }, { status: 400 });
    }
    if (url.startsWith(SITE)) return viaSite(new Request(url, init));
    if (url === `https://${SHOP}/api/2026-07/graphql.json`) {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
      assert.equal(headers.get("x-shopify-storefront-access-token"), "storefront_token_0123456789");
      if (query.includes("cartAttributesUpdate")) {
        cart.attributes = variables.attributes;
        return Response.json({ data: { cartAttributesUpdate: { userErrors: [] } } });
      }
      if (query.includes("cartBuyerIdentityUpdate")) {
        cart.email = variables.buyerIdentity.email;
        return Response.json({ data: { cartBuyerIdentityUpdate: { userErrors: [] } } });
      }
      if (variables.id !== CART_ID) return Response.json({ data: { cart: null } });
      return Response.json({
        data: {
          cart: {
            id: CART_ID,
            checkoutUrl: `https://${SHOP}/cart/c/${CART_TOKEN}?key=abc`,
            cost: { totalAmount: { amount: "49.99", currencyCode: "GBP" } },
            buyerIdentity: { email: cart.email },
            attributes: cart.attributes,
            lines: { nodes: [{ quantity: 1, merchandise: { id: "gid://shopify/ProductVariant/1", sku: "HOODIE-M", title: "M", price: { amount: "49.99" }, product: { title: "Hoodie" } } }] },
          },
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const store = testStore();
  app = createConnectorApp({ env: ENV, store, fetch: fetchImpl });
  return { app: () => app, store, viaSite, registered, configHeaders, cart };
}

const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
const jar = new Map<string, string>();
const cookies = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
const keep = (r: Response) => {
  const c = cookieOf(r);
  if (c.includes("=")) jar.set(c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1));
  return r;
};

test("a brand goes from fresh deploy to fully connected, and every private step stays on its own app", async () => {
  const w = world();
  const app = w.app();

  // Fresh deploy: locked setup page, key unlocks it.
  const locked = await (await app.handle(new Request(`${CONNECTOR}/`))).text();
  assert.match(locked, /Owner sign-in/);
  const owner = await app.handle(
    new Request(`${CONNECTOR}/api/md/owner/unlock`, { method: "POST", headers: { "content-type": "application/json", origin: CONNECTOR }, body: JSON.stringify({ key: OWNER_KEY }) })
  );
  assert.equal(owner.status, 200);
  const ownerCookie = cookieOf(owner);

  const setup = await (await app.handle(new Request(`${CONNECTOR}/`, { headers: { cookie: ownerCookie } }))).text();
  assert.match(setup, /Connect to the Media Platform/);
  assert.match(setup, /destination: &quot;https:\/\/kraze-connector\.example\/api\/md\/:path\*&quot;/, "the site prompt has this app's address filled in");
  assert.match(setup, /https:\/\/kraze-connector\.example\/api\/md\/shopify\/webhook/);

  const ownerPost = (path: string, body: unknown) =>
    app.handle(new Request(`${CONNECTOR}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: CONNECTOR, cookie: ownerCookie }, body: JSON.stringify(body) }));

  // Connect code.
  assert.equal((await ownerPost("/setup/connect", { code: "BAD-CODE-999" })).status, 400);
  assert.equal((await ownerPost("/setup/connect", { code: "GOOD-CODE-123" })).status, 200);
  const reg = w.registered.at(-1)!;
  assert.ok(reg.validSignature, "the registration is signed with the app's own key");
  assert.deepEqual([reg.body.brand, reg.body.site_origin, reg.body.connector_origin], ["kraze", SITE, CONNECTOR]);
  assert.ok(!JSON.stringify(reg.body).includes("PRIVATE"), "only the public key is sent");

  // Shopify details.
  assert.equal((await ownerPost("/setup/service", { service: "shopify", values: { storeDomain: "nope", storefrontToken: "x", webhookSecret: "y" } })).status, 400);
  assert.equal(
    (await ownerPost("/setup/service", { service: "shopify", values: { storeDomain: SHOP, storefrontToken: "storefront_token_0123456789", webhookSecret: WEBHOOK_SECRET } })).status,
    200
  );
  assert.equal(
    (await app.handle(new Request(`${CONNECTOR}/setup/service`, { method: "POST", headers: { "content-type": "application/json", origin: CONNECTOR }, body: "{}" }))).status,
    401,
    "settings can't be changed without the owner key"
  );

  // A shopper arrives through a creator link on the brand's own domain.
  const site = (path: string, init: RequestInit = {}) =>
    w.viaSite(new Request(`${SITE}${path}`, { ...init, headers: { origin: SITE, cookie: cookies(), ...(init.headers as Record<string, string>) } })).then(keep);
  assert.equal((await site("/api/md/t.js")).status, 200);
  assert.equal((await site("/api/md/touch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: "ANNA10", landing_path: "/" }) })).status, 200);
  assert.equal((await site("/api/md/click", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: "ANNA10" }) })).status, 200);
  assert.ok(jar.has("md_vid") && jar.has("md_click"), "first-party cookies on the brand's own domain");

  // They type their email; the app tags the cart and logs the checkout.
  const started = await site("/api/md/checkout-started", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "Jane@Example.com", cart_id: CART_ID }) });
  assert.equal(started.status, 200);
  assert.equal(w.cart.email, "jane@example.com", "Shopify's checkout is pre-filled");
  const attrs = Object.fromEntries(w.cart.attributes.map((a) => [a.key, a.value]));
  assert.equal(attrs.gift, "no", "the cart's own attributes are kept");
  assert.equal(attrs.md_cart, CART_TOKEN);
  assert.equal(attrs.md_click, jar.get("md_click"));
  const watch = await w.store.getCheckoutWatch(CART_TOKEN);
  assert.equal(watch?.email, "jane@example.com");
  assert.equal(watch?.code, "ANNA10", "credited to the creator");
  assert.equal(watch?.step, "email");

  // Shopify's checkout pixel reports a step (no cookies, any origin).
  const pre = await app.handle(new Request(`${CONNECTOR}/api/md/shopify/step`, { method: "OPTIONS" }));
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const step = await app.handle(new Request(`${CONNECTOR}/api/md/shopify/step`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: CART_TOKEN, step: "payment" }) }));
  assert.equal(step.status, 204);
  assert.equal((await w.store.getCheckoutWatch(CART_TOKEN))?.step, "payment");

  // Shopify says it's paid.
  const order = {
    id: 9001,
    cart_token: CART_TOKEN,
    checkout_token: "chk_1",
    email: "jane@example.com",
    current_total_price: "49.99",
    currency: "GBP",
    processed_at: new Date().toISOString(),
    note_attributes: w.cart.attributes.map((a) => ({ name: a.key, value: a.value })),
  };
  const raw = JSON.stringify(order);
  const hook = (secret: string) =>
    app.handle(
      new Request(`${CONNECTOR}/api/md/shopify/webhook`, {
        method: "POST",
        headers: { "x-shopify-topic": "orders/paid", "x-shopify-hmac-sha256": createHmac("sha256", secret).update(raw).digest("base64") },
        body: raw,
      })
    );
  assert.equal((await hook("wrong-secret")).status, 401);
  assert.equal((await hook(WEBHOOK_SECRET)).status, 200);
  assert.equal((await w.store.getCheckoutWatch(CART_TOKEN))?.status, "completed");
  assert.equal((await w.store.getOrder("9001"))?.code, "ANNA10", "the order is credited to the creator's link");

  // The /media page works on the brand's own domain; the owner gets the admin panel there after unlocking there.
  const mediaCreator = await (await site("/media")).text();
  assert.match(mediaCreator, /I'm the owner/);
  const ownerOnSite = await site("/api/md/owner/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: OWNER_KEY }) });
  assert.equal(ownerOnSite.status, 200);
  const mediaOwner = await (await site("/media")).text();
  assert.match(mediaOwner, /\/enter\/admin\?pass=/);

  // Self-check: the rewrite and /media are verified by fetching the brand's real site address.
  const checked = await (await app.handle(new Request(`${CONNECTOR}/`, { headers: { cookie: ownerCookie } }))).text();
  for (const label of ["Connected to the Media Platform", "Website rewrite", "/media page", "Email step"]) {
    assert.match(checked, new RegExp(`<li class="ok"><span class="dot">✓</span><span><strong>${label.replace("/", "\\/")}`), label);
  }

  // The platform only ever learns names and tick states.
  await app.handle(new Request(`${CONNECTOR}/api/cron`));
  const last = w.configHeaders.at(-1)!;
  assert.match(last["x-md-features"] ?? "", /connector/);
  assert.match(last["x-md-checks"] ?? "", /website=ok/);
  assert.ok(!JSON.stringify(w.configHeaders).includes("jane"), "no shopper data in what the platform receives");
  assert.ok(!JSON.stringify(w.registered).includes("jane"));
});

test("the setup page says exactly which Vercel settings are missing", async () => {
  const app = createConnectorApp({ env: { BRAND: "kraze" }, store: memoryStore(), fetch: async () => new Response("{}") });
  const page = await (await app.handle(new Request(`${CONNECTOR}/`))).text();
  for (const name of ["MEDIA_PLATFORM_URL", "SITE_URL", "OWNER_KEY"]) assert.match(page, new RegExp(name));
  assert.equal((await app.handle(new Request(`${CONNECTOR}/media`))).status, 503);
});

test("the app makes its own key once and keeps it", async () => {
  const w = world();
  const first = await (await w.app().handle(new Request(`${CONNECTOR}/api/md/health`))).json();
  const second = createConnectorApp({ env: ENV, store: w.store, fetch: async () => Response.json(configFixture()) });
  const again = await (await second.handle(new Request(`${CONNECTOR}/api/md/health`))).json();
  assert.equal((first as { app_id: string }).app_id, (again as { app_id: string }).app_id, "a second server instance uses the same key");
});
