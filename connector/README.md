# @media-dashboard/brand-connector

The code a brand installs on **its own website and server** to run its affiliate programme alongside the media dashboard.

The media dashboard is a hosted service. It manages creators, campaigns, tasks, guides and the affiliate *configuration* (codes, commission rates, deep links, programme settings). It never receives, stores or displays any of the brand's activity: no clicks, checkouts, orders, revenue, commissions or customers. That data lives only here, in the brand's own database. The brand's own code shows it to the brand's own signed-in users, drawn over a placeholder area of the dashboard iframe.

```
 brand website (this package)                         media dashboard (hosted)
 ─────────────────────────────                        ────────────────────────
 timer or cron: refreshConfig() ────config pull (signed GET)──▶ /api/brand/{brand}/config
 /api/md/t.js     tracker script     ◀── programme config only (codes, rates, links)
 /api/md/click    stores clicks
 /api/md/stats    stats for YOUR users
 /api/md/creator-links/*  your admins approve creator logins
 recordCheckout / recordOrder / recordRefund
 brand DB: md_clicks, md_checkouts, md_orders, md_pending_refunds, md_creator_links, md_config

 brand page ── sandboxed iframe ─────────────────────▶ /embed?pass=…  or  /enter/admin?pass=…
            ◀── postMessage: resize, panel open/closed (sizes only)
            ──▶ postMessage: panel-ready { height }  (a fixed number you choose, never derived from data)
            draws its own sales screen over the iframe's placeholder slot
```

## What never leaves the brand

- Clicks, checkouts (started, failed, abandoned), orders, refunds, revenue, commission, conversion rates and anything derived from them.
- Customer data of any kind. The connector itself never stores customer details: no names, emails or addresses, no user agents, no raw IP addresses (only a keyed hash used for rate limiting), no query strings (landing *path* only) and only the referrer *host*.
- Payment-processor keys (Shopify, Stripe…). You call the connector from your own webhook handlers, verified with your own secrets.
- The Ed25519 **private key**. The dashboard only has the public key.

The only things the connector sends to the dashboard are (1) the signed config request, which carries no data, and (2) the one-time passes your users carry into the iframe (your user id and display name). The only thing your page sends into the iframe is a **fixed panel height you choose** (`panelHeight`, default 960 px). The sales screen scrolls inside that height, so the number is the same whatever the data, the date range, the screen width or the loading state.

## What the dashboard operator can and can't do

The dashboard's database, API and the code it serves never hold your sales data, and the connector doesn't let anything the dashboard sends decide who sees it:

- **Pulls carry no timing.** The config is pulled on a fixed schedule (a timer, or your cron), never because a visitor, click, checkout, order or stats view happened. Request handlers only read the copy kept in your database.
- **The dashboard proposes, you decide who sees a creator's numbers.** The config's `brand_user_ref` (which of your logins belongs to which creator) is only a *proposal*. Nothing is shown to a creator until one of your admins approves that login on the admin sales screen, and only for the codes pinned at approval. Changing `brand_user_ref`, clearing it, or moving a code to another creator in the dashboard changes nothing until you approve again. Check that a proposed login really belongs to that creator before approving.
- **Creator links stay on your storefront.** With `siteOrigin` (or `storefrontOrigins`) set, a config whose `storefront_url` or allowed deep-link domains point anywhere else is refused, the last accepted config stays in use, `/api/md/health` reports `config_rejected` and your admins see a warning. Links shown *inside the dashboard* are still built by the dashboard, so the creator sales screen lists each creator's share links built by your own server from your own origin; tell creators to copy their links there.
- **The iframe is sandboxed** without `allow-top-navigation`, so dashboard code can't send your page (or your admin) to a look-alike login.
- **Only a fixed number goes into the iframe** (see above).

What remains is trust you place in your own decisions: an admin approving a login proposal without checking it, or creators sharing links copied from the dashboard instead of from your site.

## Install

The package has no runtime dependencies. It uses `node:crypto` and the standard Fetch `Request`/`Response` (Node 18.17+). `pg` and `react` are optional peers.

Either install the packed release file (it already contains the built `dist/`, which is not kept in git). Build and pack it once from this folder:

```sh
npm install && npm run build && npm test && npm pack   # -> media-dashboard-brand-connector-1.0.0.tgz
```

Then put the `.tgz` in your repo (e.g. `vendor/`) and depend on it:

```jsonc
// package.json
"dependencies": { "@media-dashboard/brand-connector": "file:./vendor/media-dashboard-brand-connector-1.0.0.tgz" }
```

Don't depend on a copy of the source folder: its `dist/` is git-ignored, so a deploy from git would have no built code.

…or install it from your private registry: `npm install @media-dashboard/brand-connector`.

Entry points:

| Import | Runs in | What |
|---|---|---|
| `@media-dashboard/brand-connector` | server | `createConnector`, stores, types |
| `@media-dashboard/brand-connector/host` | browser | `mountMediaDashboard` and the bridge helpers |
| `@media-dashboard/brand-connector/react` | browser (client component) | `<MediaDashboardEmbed />` |
| `@media-dashboard/brand-connector/sql/schema.sql` | your database | the `md_` tables |

## Keys and environment

Generate the key pair once (Node 18+). The private key goes in **your** site's environment and the public key goes to the media dashboard operator:

```sh
node -e "const {generateKeyPairSync}=require('crypto');const k=generateKeyPairSync('ed25519');console.log('MEDIA_DASHBOARD_PRIVATE_KEY=' + Buffer.from(k.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log('BRAND_<BRAND>_PUBLIC_KEY=' + Buffer.from(k.publicKey.export({type:'spki',format:'pem'})).toString('base64'))"
```

Your site's environment:

```sh
MEDIA_DASHBOARD_URL=https://media-dashboard.example.com   # the dashboard
MEDIA_DASHBOARD_BRAND=kraze                               # your brand id on the dashboard
MEDIA_DASHBOARD_PRIVATE_KEY=<base64 PKCS8 PEM>            # never send this to a browser
DATABASE_URL=postgres://…                                 # your own database
```

The dashboard operator sets `BRAND_<BRAND>_PUBLIC_KEY` and `BRAND_<BRAND>_ORIGINS` (your site origins, comma-separated) on their side, and turns on programme sync for your brand.

## Database

Run [`sql/schema.sql`](sql/schema.sql) against your database. It is idempotent and only creates `md_`-prefixed tables and their indexes, so it can sit next to your existing tables: `md_clicks`, `md_checkouts`, `md_orders`, `md_pending_refunds` (refunds that arrived before their order), `md_creator_links` (creator logins your admins approved) and `md_config` (the last accepted programme config). Re-run it after upgrading.

```sh
psql "$DATABASE_URL" -f node_modules/@media-dashboard/brand-connector/sql/schema.sql
```

For local development you can use `memoryStore()` instead. It loses everything on restart and is not shared between server instances.

## Server setup

```ts
// lib/media-dashboard.ts (server only)
import { createConnector, postgresStore } from "@media-dashboard/brand-connector";
import { Pool } from "pg";
import { getSession } from "@/lib/auth"; // your own session code

export const mediaDashboard = createConnector({
  brand: process.env.MEDIA_DASHBOARD_BRAND!,
  dashboardUrl: process.env.MEDIA_DASHBOARD_URL!,
  privateKey: process.env.MEDIA_DASHBOARD_PRIVATE_KEY!,
  store: postgresStore({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
  siteOrigin: "https://www.yourbrand.com",   // also turns on the storefront check
  configRefresh: "manual",                   // serverless: refresh from a cron (see below)
  trustedIpHeader: "x-real-ip",              // Vercel; see "Click rate limiting"
  // Who may see sales data. Return null for anyone not signed in.
  getViewer: async (request) => {
    const session = await getSession(request);
    if (!session) return null;
    if (session.user.isAdmin) return { role: "admin" };
    if (session.user.isApprovedCreator) return { role: "creator", userRef: session.user.id };
    return null;
  },
});
```

`getViewer` decides everything about access: return `{ role: "admin" }` only for your own admins, and `{ role: "creator" }` only for users *you* have accepted as creators. `userRef` must be the **same id** you put in the creator's pass (`creatorEmbedUrl({ userRef })`). After the creator signs in inside the iframe, the dashboard proposes that id for their creator account (`brand_user_ref` in the config). The proposal shows up under **Creator logins** on your admin sales screen; once an admin approves it, that creator sees their own numbers for the codes pinned at approval. Until then their screen says it is waiting for approval. The same is available on the server: `listCreatorLinks()`, `approveCreatorLink({ creatorId, userRef, affiliateIds? })` and `unlinkCreator(creatorId)`. Only call those for a decision made by one of your admins.

`postgresStore({ connectionString })` also works when the package is not bundled. It loads `pg` lazily. Inside Next.js, prefer passing your own `pool`: `pg` is already external there.

`createConnector` validates its options immediately. If your build step imports this module without the env vars set, create it lazily inside a function instead.

### Config refresh

Request handlers and the `record*` functions never contact the dashboard. They use the last accepted config, kept in memory and in `md_config`, so a new server instance doesn't pull either. If no config has ever been accepted, routes answer 503 and the `record*` functions throw `ConfigUnavailableError`.

- **Long-running server** (default `configRefresh: "interval"`): a timer pulls at start-up and then about every `configRefreshSeconds` (default 60, with ±20% jitter). It skips a pull when another instance pulled recently and never keeps the process alive. `close()` stops it.
- **Serverless** (Vercel, Netlify, Lambda): timers only run while a request is being handled, which would tie pulls to traffic. Set `configRefresh: "manual"` and call `refreshConfig()` from a cron:

```ts
// app/api/md-refresh/route.ts, run every 5 minutes by vercel.json: { "crons": [{ "path": "/api/md-refresh", "schedule": "*/5 * * * *" }] }
import { mediaDashboard } from "@/lib/media-dashboard";

export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) return new Response("unauthorized", { status: 401 });
  await mediaDashboard.refreshConfig(); // throws if the dashboard is unreachable or its settings were refused
  return new Response("ok");
}
```

Run it once after deploying so the first config is in place.

### Routes (Next.js App Router)

```ts
// app/api/md/[...path]/route.ts
import { mediaDashboard } from "@/lib/media-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST } = mediaDashboard.routeHandlers();
```

Any framework that speaks Fetch `Request`/`Response` (Hono, Remix, SvelteKit, Astro, Bun, Deno) can call `mediaDashboard.handle(request)` directly. For Express (with `trustedIpHeader: "x-real-ip"` and Express's `trust proxy` set for your proxies):

```ts
app.set("trust proxy", 1); // so req.protocol / req.ip are the visitor's, not your TLS proxy's (or pass siteOrigin)

const IP_HEADERS = ["x-real-ip", "x-forwarded-for", "cf-connecting-ip", "fly-client-ip", "x-nf-client-connection-ip"];

app.use("/api/md", express.raw({ type: "*/*", limit: "32kb" }), async (req, res) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string" && !IP_HEADERS.includes(key)) headers.set(key, value);
  }
  headers.set("x-real-ip", req.ip ?? ""); // the only IP header the connector trusts here
  const request = new Request(new URL(req.originalUrl, `${req.protocol}://${req.get("host")}`), {
    method: req.method,
    headers,
    body: req.method === "POST" ? req.body : undefined,
  });
  const response = await mediaDashboard.handle(request);
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
});
```

| Route | What |
|---|---|
| `GET /api/md/t.js` | Tracker script (see below). |
| `POST /api/md/click` | `{ ref, campaign?, landing_path?, referrer_host? }`. Same-origin only and rate-limited. The code must be an active affiliate in the current config. Stores the click and sets the `md_click` cookie (first-party, `SameSite=Lax`, `Secure` on https, `Max-Age` = cookie window, readable by JS). Returns `{ click_id }`. A repeat visit through the same link within 30 minutes reuses the click. Bodies over 2 KB are refused while being read. |
| `GET /api/md/stats?range=7d\|30d\|90d` | Calls your `getViewer`; 401 without a viewer. Same-origin only, `Cache-Control: no-store`. Admins get every creator plus the creator-login list; creators only the codes approved for their login. |
| `POST /api/md/creator-links/approve` | `{ creator_id, user_ref, affiliate_ids }`. Admins only (403 otherwise), same-origin JSON. 200 `{ status: "approved" }`, 409 `{ status: "changed" \| "conflict" }`. Used by the admin sales screen. |
| `POST /api/md/creator-links/unlink` | `{ creator_id }`. Admins only, same-origin JSON. 200 or 404. |
| `GET /api/md/host.js` | The browser host module as one ES module, for pages that don't bundle. |
| `GET /api/md/health` | `{ ok, config_loaded_at, dashboard_reachable, config_rejected }`. `dashboard_reachable` is this instance's last pull (`null` before its first one); `config_rejected` is `"storefront_url"`, `"allowed_deep_link_domains"` or `null`. Contains no data. |

Behind a proxy that hides the public origin from `request.url` (or a Shopify app proxy), pass `siteOrigin: "https://www.yourbrand.com"` so the same-origin checks compare against the right origin. `mountPath` changes the `/api/md` prefix.

### Click rate limiting

Per-IP limiting (20 clicks, then one every 3 seconds) only uses a header you name in `trustedIpHeader`, because visitors can send any of these headers themselves. Name one your hosting **overwrites**: `x-real-ip` on Vercel, `cf-connecting-ip` behind Cloudflare, `fly-client-ip` on Fly, `x-nf-client-connection-ip` on Netlify, or `x-forwarded-for` behind exactly one proxy you run (its right-most entry is used). With Express, copy `req.ip` into `x-real-ip` as above. `getClientIp(request)` overrides this. Without a trusted header, clicks share one generous site-wide limit (600, refilling 20 per second) instead of one small bucket, so real visitors aren't turned away.

## Tracker tag

Add it once to every storefront page (main layout, or `theme.liquid`):

```html
<script src="/api/md/t.js" async></script>
```

It only acts when the URL carries your `ref_param` (default `?ref=`, and optionally `&campaign=`). Creator links point **directly** at your storefront, e.g. `https://www.yourbrand.com/products/hoodie?ref=ANNA10&campaign=<uuid>`. Nothing passes through the dashboard.

- `window.MediaDashboard.clickId()` returns the current click id (or `null`).
- On Shopify Online Store themes it copies the id into the cart attribute `md_click`, which arrives on the order as `note_attributes`.
- Elsewhere, read it on the server when the checkout is created: `mediaDashboard.clickIdFromRequest(request)`.

## Creator page

Mint a fresh pass on **every** page view. It works once, for 5 minutes.

### React (Next.js)

```tsx
// app/creators/page.tsx (server component)
import { MediaDashboardEmbed } from "@media-dashboard/brand-connector/react";
import { mediaDashboard } from "@/lib/media-dashboard";
import { requireCreator } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function CreatorsPage() {
  const user = await requireCreator();
  const src = mediaDashboard.creatorEmbedUrl({ userRef: user.id, name: user.name });
  return <MediaDashboardEmbed src={src} dashboardOrigin={process.env.MEDIA_DASHBOARD_URL!} />;
}
```

The component renders the iframe once (client side, sandboxed from its first load), so React Strict Mode never loads the single-use pass twice. `panelHeight` sets the sales screen's fixed height.

### Plain HTML

```html
<div id="media-dashboard"></div>
<script type="module">
  import { mountMediaDashboard } from "/api/md/host.js";
  mountMediaDashboard({
    container: document.getElementById("media-dashboard"),
    src: "{{ creator_embed_url }}",          // rendered by your server from creatorEmbedUrl()
    dashboardOrigin: "https://media-dashboard.example.com",
  });
</script>
```

## Admin page

Only for your signed-in admins. Check that first, then mint the entry URL on the server:

```tsx
// app/admin/media/page.tsx
const admin = await requireAdmin();
const src = mediaDashboard.adminEntryUrl({ userRef: admin.id, name: admin.name });
return <MediaDashboardEmbed src={src} dashboardOrigin={process.env.MEDIA_DASHBOARD_URL!} />;
```

Plain HTML is identical to the creator page, with `adminEntryUrl()` as the `src`. When the dashboard is opened outside your site (a top-level tab), its slot only says that sales data is shown inside your website. That is by design.

## Reporting checkouts and orders

Call these from your own server code: checkout creation, payment webhooks verified with **your** secrets. The connector decides attribution. Send **every** checkout and order: only those with a qualifying click or code are credited to a creator, but all of them feed multi-touch attribution, the failed/abandoned checkout list, webhooks and server-side conversions (see [Growth features](#growth-features)).

```ts
recordCheckout({ checkoutId, clickId?, code?, cartTotal, currency, test? })  // → recorded | updated | not_attributed
recordCheckoutFailed({ checkoutId, reason? })                                // → failed | not_found | ignored
recordOrder({ orderId, checkoutId?, clickId?, code?, amount, currency,
              occurredAt?, test?, campaignId?, productRef? })                // → recorded | duplicate | not_attributed
recordRefund({ orderId, refundedAt? })                                       // → refunded | already_refunded | pending
```

Amounts are in **major** units (`49.99`), as numbers or decimal strings. `recordOrder` is idempotent by `orderId`, so webhook retries are safe. A refund that arrives before its order (webhooks aren't ordered) returns `pending` and is applied when the order is recorded; unclaimed ones are dropped after 30 days. Pass `test: true` for test-mode checkouts and orders: they are kept for attribution but never counted. These functions throw `ValidationError` on bad input and `ConfigUnavailableError` if no programme config has been accepted yet. Let your webhook return a 5xx in that case so the processor retries.

### Shopify

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { mediaDashboard } from "@/lib/media-dashboard";

const attr = (list: { name: string; value: string }[] | undefined, name: string) =>
  list?.find((a) => a.name === name)?.value ?? null;

export async function POST(request: Request) {
  const raw = await request.text();
  const digest = createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET!).update(raw).digest();
  const given = Buffer.from(request.headers.get("x-shopify-hmac-sha256") ?? "", "base64");
  if (given.length !== digest.length || !timingSafeEqual(given, digest)) return new Response("bad hmac", { status: 401 });

  const body = JSON.parse(raw);
  switch (request.headers.get("x-shopify-topic")) {
    case "checkouts/create":
      await mediaDashboard.recordCheckout({
        checkoutId: body.token,
        clickId: attr(body.note_attributes, "md_click"),
        code: body.discount_codes?.[0]?.code ?? null,
        cartTotal: body.total_price,
        currency: body.currency,
        test: body.test === true, // if your test checkouts carry it; test orders below always do
      });
      break;
    case "orders/paid":
      await mediaDashboard.recordOrder({
        orderId: String(body.id),
        checkoutId: body.checkout_token ?? null,
        clickId: attr(body.note_attributes, "md_click"),
        code: body.discount_codes?.[0]?.code ?? null,
        amount: body.current_total_price ?? body.total_price,
        currency: body.currency,
        occurredAt: body.processed_at,
        test: body.test === true,
      });
      break;
    case "orders/updated":
      if (body.financial_status === "refunded") await mediaDashboard.recordRefund({ orderId: String(body.id) });
      break;
  }
  return new Response("ok");
}
```

On a headless storefront (Storefront API), read `mediaDashboard.clickIdFromRequest(request)` when you create the cart and set it as the cart attribute `md_click`.

### Stripe

```ts
// When creating the Checkout Session (your server)
const clickId = mediaDashboard.clickIdFromRequest(request);
const session = await stripe.checkout.sessions.create({ /* … */ metadata: { md_click: clickId ?? "" } });
await mediaDashboard.recordCheckout({
  checkoutId: session.id,
  clickId,
  code: promotionCode ?? null,
  cartTotal: session.amount_total! / 100,
  currency: session.currency!,
  test: !session.livemode,
});

// Webhook, verified with YOUR STRIPE_WEBHOOK_SECRET
const event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET!);
switch (event.type) {
  case "checkout.session.completed":
  case "checkout.session.async_payment_succeeded": {
    const s = event.data.object;
    // Delayed methods (SEPA, ACH, Boleto…) complete as "unpaid" first; only count money that arrived.
    if (s.payment_status !== "paid") break;
    await mediaDashboard.recordOrder({
      orderId: String(s.payment_intent ?? s.id),
      checkoutId: s.id,
      clickId: s.metadata?.md_click || null,
      amount: s.amount_total! / 100,            // zero-decimal currencies (JPY…): don't divide
      currency: s.currency!,
      occurredAt: new Date(event.created * 1000),
      test: !event.livemode,
    });
    break;
  }
  case "checkout.session.async_payment_failed":
    await mediaDashboard.recordCheckoutFailed({ checkoutId: event.data.object.id, reason: "async_payment_failed" });
    break;
  case "charge.refunded":
    if (event.data.object.refunded) await mediaDashboard.recordRefund({ orderId: String(event.data.object.payment_intent) });
    break;
}
```

## Growth features

All optional, all running on your server. The dashboard's **Docs** page has step-by-step setup with AI prompts.

### Server-side ad conversions (Meta CAPI, TikTok Events API, GA4 Measurement Protocol)

```ts
createConnector({
  // ...
  conversions: {
    meta: { pixelId: process.env.META_PIXEL_ID!, accessToken: process.env.META_CAPI_TOKEN! },
    tiktok: { pixelCode: process.env.TIKTOK_PIXEL_CODE!, accessToken: process.env.TIKTOK_EVENTS_TOKEN! },
    ga4: { measurementId: process.env.GA4_MEASUREMENT_ID!, apiSecret: process.env.GA4_API_SECRET! },
    onError: (platform, error) => console.warn(platform, error.message),
  },
});
```

New checkouts send `InitiateCheckout` / `begin_checkout`; new orders send `Purchase` / `CompletePayment` / `purchase` with the order id as event id, so they dedupe against browser pixels. Pass `customer` (email, phone, names, city, postcode, country, externalId, plus `connector.browserContext(request)` for IP, user agent, `_fbp`, `_fbc`, `_ttp`, ttclid and `_ga`) and `items`. Personal fields are normalised and SHA-256 hashed before sending and are never stored. Test orders aren't forwarded unless `forwardTestEvents: true`. GA4 is skipped without a client id. Per-platform results come back as `result.conversions`; forwarding never throws.

### Multi-touch attribution

The tracker posts a touch to `POST /api/md/touch` whenever a visitor lands with UTM tags, `gclid`/`fbclid`/`ttclid`/`msclkid`, a creator code or an outside referrer, and keeps a random visitor id in the `md_vid` cookie (also copied to Shopify cart attributes). Pass `visitorId` (`connector.visitorIdFromRequest(request)` or the `md_vid` cart attribute) to `recordCheckout` / `recordOrder`; each order stores its journey (touches in the last `journeyLookbackDays`, default 30). `GET /api/md/attribution?range=30d` (admins) or `getAttribution(range)` returns revenue by channel under first-touch, last-touch, linear, position-based (40/20/40) and time-decay models, plus top paths, UTM campaigns and per-creator opened/closed/assisted counts. Global Privacy Control is honoured; set `window.MD_WAIT_FOR_CONSENT = true` and call `MediaDashboard.grantConsent()` to wait for a consent banner.

### Failed & abandoned checkouts, Microsoft Clarity

Every checkout is kept in `md_checkout_watch`. `recordCheckoutStep({ checkoutId, step })` records how far the shopper got. `GET /api/md/checkouts?range=30d&status=failed,abandoned&code=CODE` (admins) or `listCheckouts()` returns them per creator code with the visitor id, which the tracker also sets as the Clarity custom tag `md_vid` (plus `md_ref`, and `md_checkout_step` via `MediaDashboard.checkoutStep(step, checkoutId)`). The admin sales screen shows both lists with a "Copy Clarity filter" button.

### Shopper emails and cart-recovery emails (Resend)

Pass `customer.email` to `recordCheckout` (ideally when the shopper types it on your own site, keyed by `shopifyCartToken(cart.id)`) and the address is kept permanently in `md_checkout_watch`, your own record of the checkout. A paid order closes that checkout, and any other open checkout with the same email. With `recoveryEmails: { resendApiKey, from, brandName }` (and `siteOrigin`) the connector emails unpaid checkouts through your Resend account using the wording and delay set in the media dashboard: automatically when the dashboard's switch is on, or one at a time with `sendRecoveryEmail(checkoutId)` / `POST /api/md/checkouts/send-recovery` (admins; the sales screen's "Send recovery email" button). Once per checkout. Every email carries an unsubscribe link (`/api/md/unsubscribe`) and RFC 8058 one-click headers; unsubscribed addresses go to `md_email_suppressions` and are never emailed again. `requireMarketingConsent: true` limits sending to shoppers who ticked Shopify's marketing box.

### Webhooks

```ts
createConnector({
  // ...
  webhooks: { endpoints: [{ url: "https://hooks.example.com/md", secret: process.env.MD_WEBHOOK_SECRET!, events: ["checkout.abandoned"] }] },
  abandonAfterMinutes: 60,
  waitUntil, // serverless hosts only
});
```

Events: `checkout.started`, `checkout.failed`, `checkout.abandoned`, `order.created`, `order.refunded`. `checkout.abandoned` is sent once per checkout by `runScheduledTasks()`, which runs every minute on long-running servers; with `configRefresh: "manual"` call it from your cron. Each POST carries `md-webhook-id`, `md-webhook-timestamp` and `md-webhook-signature: v1=<hex HMAC-SHA256 of "id.timestamp.body">`; check them with `verifyWebhook({ secret, body, headers })`. Checkout payloads include your `customerRef` and `recoveryUrl`, never an email address. Failed deliveries are retried up to 3 times.

## Attribution rules

- **Last click wins.** The candidate clicks are the order's `clickId` and its checkout's click. The most recent one that is still eligible gets the credit.
- A click is eligible when it happened at most `cookie_window_days` before the order (and not after it; 5 minutes of clock skew is allowed) and its affiliate is `active` in the **current** config.
- **Code fallback.** With no eligible click, a code the customer typed (passed to `recordOrder`, or to `recordCheckout` for that checkout) credits that affiliate if it is active (case-insensitive). The code a checkout was *credited* to through a click is not a typed code, so an expired click never gets credit that way.
- **Campaign.** An explicit `campaignId` wins; otherwise the credited click's campaign.
- **Commission** = the affiliate's `commission_bps` at order time × amount, rounded to 2 decimals and stored on the order.
- **Refunds** mark the whole order refunded. It still counts in `orders` and `refunds` but leaves `revenue` and `commission`.
- **Test checkouts and orders** (`test: true`) never count in totals. Test orders are reported as `test_orders`.
- **Abandoned checkout**: started (with a click or code), no order and not failed within 24 hours.

## Stats response

`GET /api/md/stats` and `connector.getStats(viewer, range)` return `StatsResponse` (exported type):

```ts
type Metrics = {
  clicks: number;
  checkouts_started: number;
  checkouts_failed: number;
  checkouts_abandoned: number;
  orders: number;           // non-test orders placed in the range (refunded ones included)
  revenue: number;          // non-test, non-refunded, in `currency`
  commission: number;       // same basis as revenue
  refunds: number;
  conversion_rate: number;  // orders / clicks; can exceed 1 when typed codes bring orders without clicks
  test_orders: number;
};

type StatsResponse = {
  range: "7d" | "30d" | "90d";
  generated_at: string;                 // ISO
  role: "admin" | "creator";
  linked: boolean;                      // creator: false until an admin approved their login (admins: true)
  link_pending: boolean;                // creator: the dashboard proposed their login, waiting for approval
  currency: string | null;              // dominant currency in the range
  totals: Metrics;
  by_creator: (Metrics & { creator_id: string; username: string; display_name: string | null })[];
  by_code: (Metrics & { affiliate_id: string; code: string; creator_id: string | null; status: "pending" | "active" | "suspended" | null })[];
  by_link: (Metrics & { link_id: string; affiliate_id: string; code: string; label: string; target_path: string })[];
  by_campaign: (Metrics & { campaign_id: string | null; title: string })[];
  daily: { date: string; clicks: number; orders: number; revenue: number }[];   // UTC days, zero-filled
  other_currencies: { currency: string; orders: number; revenue: number; commission: number }[];
  share_links: { affiliate_id: string; code: string; label: string; url: string }[];  // creator only
  creator_links: CreatorLinkRow[];      // admin only: approved, pending and blocked creator logins
  config_warning: string | null;        // admin only: why the latest dashboard config was refused
};
```

Ranges are whole UTC days ending today. For a creator, every list holds only the codes approved for their login: `by_creator` holds just them, and `by_code` lists all of those codes even with no activity yet. An unlinked creator gets `linked: false` and zeros; the sales screen shows "waiting for approval" or "not linked yet" instead of numbers. `share_links` are built by this server from your storefront origin (the config's `storefront_url` only when it is one of your origins). A link gets a click when the landing path, without the storefront's path prefix and percent-decoded, equals the link's `target_path`.

## The sales screen and the bridge (protocol v1)

`mountMediaDashboard({ container, src, dashboardOrigin, statsUrl?, title?, iframe?, nonce?, panelHeight? })` creates the iframe (`border: 0`, `width: 100%`, `allow="clipboard-write"`, `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`, `referrerpolicy="strict-origin"`) and resizes it to its content. When the dashboard reports its placeholder slot, it draws your sales screen absolutely positioned over it, at the fixed `panelHeight` (default 960 px, scrolling inside), clipped to the iframe's box and hidden while the slot is scrolled out of view. The screen fetches `statsUrl` (same origin only, default `/api/md/stats`, `credentials: "include"`) and shows a 7/30/90 day selector, KPI tiles, a daily bar chart (clicks, orders or revenue), tables by creator (admins), code, link and campaign, the creator's own share links, the admins' **Creator logins** list with Approve / Unlink, plus loading, empty, error, signed-out and not-yet-approved states. It makes no other requests, injects one scoped `<style id="mdc-styles">` (all classes prefixed `mdc-`; pass `nonce` for a strict CSP) and follows the dashboard's light or dark theme. `destroy()` removes everything; removing the iframe from the page does the same.

If you render the iframe yourself and pass it as `iframe`, give it `sandbox={IFRAME_SANDBOX}` and `referrerpolicy="strict-origin"` (both exported from `/host`) **before it loads**; `mountMediaDashboard` throws for an iframe without a sandbox or with any `allow-top-navigation` token.

Messages (all `window.postMessage`, no data ever crosses):

| Direction | Payload |
|---|---|
| dashboard → page | `{ source: "media-dashboard", v: 1, type: "resize", height }` |
| dashboard → page | `{ source: "media-dashboard", v: 1, type: "panel", panel: "affiliate-data", state: "open", role, rect: { top, left, width, height }, theme }`: sent when the slot mounts and whenever its rect changes. `rect` is in CSS px relative to the iframe's viewport; `rect.height` is ignored. |
| dashboard → page | `{ source: "media-dashboard", v: 1, type: "panel", panel: "affiliate-data", state: "closed" }` |
| page → dashboard | `{ source: "media-dashboard-host", v: 1, type: "panel-ready", panel: "affiliate-data", height }`: `height` is always your `panelHeight`. Sent only in reply to each `open`, never when data, range, width or state change. The dashboard sets the slot's `min-height` to it. |

The page only accepts messages whose `event.origin` is `dashboardOrigin` **and** whose `event.source` is its own iframe's window, and it posts only to `dashboardOrigin`. The pure helpers are exported from `/host` for your own integrations and tests: `parseChildMessage`, `isTrustedChildEvent`, `panelReadyMessage`, `overlayPlacement`, `resolvePanelHeight`, `assertSandboxed`, `normalizeOrigin`, `IFRAME_SANDBOX`. If you send a CSP, allow `frame-src <dashboard origin>`. The screen itself only needs `connect-src 'self'`.

## Config pull (protocol v1)

The connector fetches `GET {dashboardUrl}/api/brand/{brand}/config` with:

- `x-md-timestamp`: unix seconds
- `x-md-signature`: base64 Ed25519 signature of `"{timestamp}.GET./api/brand/{brand}/config"`

Only on its schedule (see [Config refresh](#config-refresh)): never from a request handler or `record*` call. Rows that don't match the protocol are dropped, and a config for another brand is refused. With `siteOrigin` or `storefrontOrigins` set, a config whose `storefront_url` origin isn't one of them, or whose `allowed_deep_link_domains` include a host you didn't declare (`deepLinkDomains`, default the hosts of your storefront origins), is refused too. A refused or failed pull keeps the last accepted config in use.

## API

```ts
createConnector(options: {
  brand: string;
  dashboardUrl: string;
  privateKey: string | KeyObject;          // base64 PKCS8 PEM, PEM, or KeyObject (Ed25519)
  store: Store;
  getViewer: (request: Request) => Promise<{ role: "admin" } | { role: "creator"; userRef: string } | null>;
  mountPath?: string;                      // default "/api/md"
  configRefresh?: "interval" | "manual";   // default "interval"; "manual" on serverless + cron
  configRefreshSeconds?: number;           // default 60, at least 10
  fetch?: typeof fetch;
  now?: () => Date;
  siteOrigin?: string | string[];
  storefrontOrigins?: string | string[];   // default siteOrigin
  deepLinkDomains?: string[];              // default the hosts of storefrontOrigins; "*.domain" allowed
  trustedIpHeader?: string;                // default none
  getClientIp?: (request: Request) => string | null;
}): {
  handle(request: Request): Promise<Response>;
  routeHandlers(): { GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response> };
  recordCheckout(input): Promise<CheckoutResult>;
  recordCheckoutFailed(input): Promise<CheckoutFailedResult>;
  recordOrder(input): Promise<OrderResult>;
  recordRefund(input): Promise<RefundResult>;
  clickIdFromRequest(request: Request | { headers: Headers }): string | null;
  getStats(viewer, range?: "7d" | "30d" | "90d"): Promise<StatsResponse>;
  getConfig(): Promise<ProgramConfig>;              // the last accepted config; never pulls
  refreshConfig(): Promise<ProgramConfig>;          // pulls now
  listCreatorLinks(): Promise<CreatorLinkRow[]>;
  approveCreatorLink({ creatorId, userRef, affiliateIds? }): Promise<{ status: "approved" | "changed" | "conflict" }>;
  unlinkCreator(creatorId): Promise<{ status: "unlinked" | "not_found" }>;
  mintCreatorPass({ userRef, name? }): string;       // EdDSA JWT, 5 minutes, single use
  mintAdminPass({ userRef, name }): string;
  creatorEmbedUrl({ userRef, name? }): string;      // {dashboardUrl}/embed?pass=…
  adminEntryUrl({ userRef, name }): string;         // {dashboardUrl}/enter/admin?pass=…
  close(): void;                                    // stops the refresh timer
};

memoryStore(): Store;
postgresStore({ connectionString, ssl?, max? } | { pool }): Store;
```

Passes are EdDSA JWTs (`{"alg":"EdDSA"}`) with `iss` = brand, `aud` = `"media-dashboard"`, `role`, `sub` = your user id, optional `name` (at most 80 characters), a random `jti`, `iat` set 30 seconds in the past (so a dashboard clock slightly behind yours never sees it in the future) and `exp = iat + 300`.

`Store` is an interface (`insertClick`, `getClick`, `getCheckout`, `upsertCheckout`, `setCheckoutStatus`, `insertOrder`, `getOrder`, `markOrderRefunded`, `savePendingRefund`, `takePendingRefund`, `aggregate`, `listCreatorLinks`, `getCreatorLinkByUserRef`, `approveCreatorLink`, `deleteCreatorLink`, `loadConfig`, `saveConfig`) if you'd rather keep the rows in another database.

## Development

```sh
npm run build   # tsc -p .
npm test        # node --test dist/test
```
