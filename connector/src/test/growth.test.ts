import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { classifyTouch, touchWeights, verifyWebhook, type TouchSignals } from "../server/index.js";
import { trackerScript } from "../server/tracker.js";
import { click, configFixture, DASHBOARD, DAY, IDS, setup, SITE } from "./helpers.js";

const VID = "99999999-9999-4999-8999-999999999999";
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

type Call = { url: string; body: unknown; headers: Record<string, string> };

/** A fetch that serves the dashboard config and records every other request. */
function network(status = 200, answer: unknown = { ok: true }) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(DASHBOARD)) return new Response(JSON.stringify(configFixture()), { status: 200 });
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, headers });
    const body = url.includes("tiktok") ? { code: 0 } : answer;
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetchImpl };
}

function touchRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`${SITE}/api/md/touch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE, "x-forwarded-for": "203.0.113.9", ...headers },
    body: JSON.stringify({ landing_path: "/", ...body }),
  });
}

async function touch(connector: Awaited<ReturnType<typeof setup>>["connector"], body: Record<string, unknown>, vid = VID) {
  const response = await connector.handle(touchRequest(body, { cookie: `md_vid=${vid}` }));
  assert.equal(response.status, 200);
  return (await response.json()) as { visitor_id: string; recorded: boolean; channel: string | null };
}

const signals = (s: Partial<TouchSignals>): TouchSignals => ({
  ref: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  gclid: false,
  fbclid: false,
  ttclid: false,
  msclkid: false,
  referrerHost: null,
  ...s,
});

test("touches are classified into channels", () => {
  assert.equal(classifyTouch(signals({ ref: "ANNA10" }))?.channel, "creator");
  assert.equal(classifyTouch(signals({ ttclid: true }))?.channel, "paid_social");
  assert.equal(classifyTouch(signals({ gclid: true }))?.source, "google");
  assert.equal(classifyTouch(signals({ utmSource: "tiktok", utmMedium: "paid" }))?.channel, "paid_social");
  assert.equal(classifyTouch(signals({ utmSource: "google", utmMedium: "cpc" }))?.channel, "paid_search");
  assert.equal(classifyTouch(signals({ utmSource: "klaviyo", utmMedium: "email" }))?.channel, "email");
  assert.equal(classifyTouch(signals({ fbclid: true }))?.channel, "organic_social");
  assert.deepEqual(classifyTouch(signals({ referrerHost: "www.tiktok.com" })), { channel: "organic_social", source: "tiktok", medium: "referral" });
  assert.equal(classifyTouch(signals({ referrerHost: "www.google.co.uk" }))?.channel, "organic_search");
  assert.equal(classifyTouch(signals({ referrerHost: "blog.example.org" }))?.channel, "referral");
  assert.equal(classifyTouch(signals({})), null);
});

test("attribution weights always add up to one order", () => {
  const at = new Date("2026-10-10T00:00:00Z");
  const touches = [0, 3, 6, 9].map((d) => ({ channel: "creator" as const, source: null, campaign: null, refCode: null, at: new Date(at.getTime() - d * DAY) }));
  for (const model of ["first_touch", "last_touch", "linear", "position_based", "time_decay"] as const) {
    const w = touchWeights(touches, model, at);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9, model);
  }
  assert.deepEqual(touchWeights(touches, "position_based", at), [0.4, 0.1, 0.1, 0.4]);
});

test("the touch route sets a visitor cookie, records signals once, and respects GPC", async () => {
  const { connector } = await setup();
  const fresh = await connector.handle(touchRequest({ utm_source: "tiktok", utm_medium: "paid", utm_campaign: "launch" }));
  assert.equal(fresh.status, 200);
  assert.match(fresh.headers.get("set-cookie") ?? "", /^md_vid=[0-9a-f-]{36}; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/);

  assert.equal((await touch(connector, { ttclid: true })).channel, "paid_social");
  assert.equal((await touch(connector, { ttclid: true })).recorded, false, "a reload within 30 minutes is the same touch");
  assert.equal((await touch(connector, {})).recorded, false, "no signal, no touch");
  assert.equal((await touch(connector, { ref: "NOPE" })).recorded, false, "unknown codes are ignored");

  const gpc = await connector.handle(touchRequest({ gclid: true }, { "sec-gpc": "1" }));
  assert.equal(gpc.status, 204);
  assert.equal(gpc.headers.get("set-cookie"), null);

  const cross = await connector.handle(touchRequest({ gclid: true }, { origin: "https://evil.example" }));
  assert.equal(cross.status, 403);
});

test("orders get a journey and the report splits revenue across touches", async () => {
  const { connector, clock } = await setup();
  await touch(connector, { utm_source: "tiktok", utm_medium: "paid", utm_campaign: "launch" });
  clock.advance(DAY);
  await touch(connector, { ref: "ANNA10" });
  clock.advance(DAY);
  await touch(connector, { utm_source: "klaviyo", utm_medium: "email", utm_campaign: "winback" });
  clock.advance(60_000);
  await connector.recordOrder({ orderId: "j-1", visitorId: VID, code: "ANNA10", amount: 100, currency: "GBP" });
  await connector.recordOrder({ orderId: "j-2", amount: 40, currency: "GBP" });
  await connector.recordOrder({ orderId: "j-test", amount: 999, currency: "GBP", test: true });

  const report = await connector.getAttribution("7d");
  assert.equal(report.orders, 2);
  assert.equal(report.revenue, 140);
  assert.equal(report.tracked_orders, 1);
  assert.equal(report.avg_touches, 3);
  const channels = (model: keyof typeof report.channels) => Object.fromEntries(report.channels[model].map((r) => [r.channel, r.revenue]));
  assert.deepEqual(channels("first_touch"), { paid_social: 100, direct: 40 });
  assert.deepEqual(channels("last_touch"), { email: 100, direct: 40 });
  assert.deepEqual(channels("linear"), { paid_social: 33.33, creator: 33.33, email: 33.33, direct: 40 });
  assert.deepEqual(channels("position_based"), { paid_social: 40, email: 40, creator: 20, direct: 40 });
  assert.deepEqual(report.top_paths[0], { path: ["paid_social", "creator", "email"], orders: 1, revenue: 100 });
  assert.deepEqual(report.campaigns, [{ campaign: "winback", orders: 1, revenue: 100 }]);
  assert.deepEqual(report.creator_assists, [{ code: "ANNA10", first_touch: 0, last_touch: 0, assisted: 1, assisted_revenue: 100 }]);

  await connector.recordRefund({ orderId: "j-2" });
  assert.equal((await connector.getAttribution("7d")).revenue, 100);
});

test("the attribution route is for the site's admins only", async () => {
  const ctx = await setup();
  const get = () => ctx.connector.handle(new Request(`${SITE}/api/md/attribution?range=30d`));
  assert.equal((await get()).status, 200);
  ctx.state.viewer = { role: "creator", userRef: "user-a" };
  assert.equal((await get()).status, 403);
  ctx.state.viewer = null;
  assert.equal((await get()).status, 401);
});

test("purchases are forwarded to Meta, TikTok and GA4 once, with personal data hashed", async () => {
  const net = network();
  const { connector } = await setup({
    connector: {
      fetch: net.fetchImpl,
      conversions: {
        meta: { pixelId: "1234567890", accessToken: "meta-token" },
        tiktok: { pixelCode: "CABC123", accessToken: "tt-token" },
        ga4: { measurementId: "G-ABC123", apiSecret: "ga-secret" },
      },
    },
  });
  const order = {
    orderId: "p-1",
    amount: "49.99",
    currency: "gbp",
    customer: { email: " Jane@Example.com ", phone: "+44 7700 900123", ip: "203.0.113.9", userAgent: "UA", fbp: "fb.1.1.2", gaClientId: "GA1.1.111.222", ttclid: "tt-1" },
    items: [{ id: "HOODIE-M", name: "Hoodie", quantity: 1, price: 49.99 }],
    sourceUrl: `${SITE}/thank-you`,
  };
  const result = await connector.recordOrder(order);
  assert.deepEqual(
    result.conversions?.map((c) => [c.platform, c.status]),
    [
      ["meta", "sent"],
      ["tiktok", "sent"],
      ["ga4", "sent"],
    ]
  );
  const meta = net.calls.find((c) => c.url.includes("graph.facebook.com"))!;
  assert.match(meta.url, /\/v21\.0\/1234567890\/events\?access_token=meta-token$/);
  const metaEvent = (meta.body as { data: Record<string, any>[] }).data[0]!;
  assert.equal(metaEvent.event_name, "Purchase");
  assert.equal(metaEvent.event_id, "p-1");
  assert.deepEqual(metaEvent.user_data.em, [sha("jane@example.com")]);
  assert.deepEqual(metaEvent.user_data.ph, [sha("447700900123")]);
  assert.equal(metaEvent.custom_data.value, 49.99);
  assert.equal(metaEvent.custom_data.currency, "GBP");
  assert.ok(!JSON.stringify(meta.body).includes("Jane"), "no plain email leaves the server");

  const tiktok = net.calls.find((c) => c.url.includes("tiktok"))!;
  assert.equal(tiktok.headers["access-token"], "tt-token");
  const ttEvent = (tiktok.body as { data: Record<string, any>[] }).data[0]!;
  assert.equal(ttEvent.event, "CompletePayment");
  assert.equal(ttEvent.user.phone, sha("+447700900123"));
  assert.equal(ttEvent.user.ttclid, "tt-1");

  const ga = net.calls.find((c) => c.url.includes("google-analytics"))!;
  assert.equal((ga.body as { client_id: string }).client_id, "111.222");
  assert.equal((ga.body as { events: { name: string }[] }).events[0]!.name, "purchase");

  const again = await connector.recordOrder(order);
  assert.equal(again.conversions, undefined, "a retried webhook doesn't send the purchase twice");
  assert.equal(net.calls.length, 3);

  await connector.recordOrder({ orderId: "p-test", amount: 10, currency: "GBP", test: true });
  assert.equal(net.calls.length, 3, "test orders aren't forwarded");
});

test("GA4 is skipped without a client id, and platform errors are reported, never thrown", async () => {
  const net = network(400, { error: "bad" });
  const errors: string[] = [];
  const { connector } = await setup({
    connector: {
      fetch: net.fetchImpl,
      conversions: {
        meta: { pixelId: "1234567890", accessToken: "t" },
        ga4: { measurementId: "G-ABC123", apiSecret: "s" },
        onError: (platform) => errors.push(platform),
      },
    },
  });
  const result = await connector.recordOrder({ orderId: "e-1", amount: 5, currency: "GBP" });
  assert.deepEqual(result.conversions?.map((c) => c.status), ["failed", "skipped"]);
  assert.deepEqual(errors, ["meta"]);
});

test("browserContext reads the ad cookies and request details", async () => {
  const { connector } = await setup();
  const ctx = connector.browserContext(
    new Request(`${SITE}/checkout`, {
      headers: { cookie: "_fbp=fb.1.1.2; _fbc=fb.1.3.abc; _ttp=tt; _ga=GA1.1.555.666; md_ttclid=click%201", "user-agent": "UA", "x-forwarded-for": "198.51.100.7" },
    })
  );
  assert.deepEqual(ctx, { fbp: "fb.1.1.2", fbc: "fb.1.3.abc", ttp: "tt", gaClientId: "555.666", userAgent: "UA", ip: "198.51.100.7", ttclid: "click%201" });
});

test("webhooks: started, failed, abandoned once, order created and refunded, all signed", async () => {
  const net = network();
  const pending: Promise<unknown>[] = [];
  const secret = "whsec_0123456789abcdef";
  const { connector, clock } = await setup({
    connector: { fetch: net.fetchImpl, webhooks: { endpoints: [{ url: "https://hooks.example/md", secret }] }, waitUntil: (p) => pending.push(p) },
  });
  const flush = async () => {
    await Promise.all(pending.splice(0));
  };
  const clickId = await click(connector, "ANNA10");
  await connector.recordCheckout({ checkoutId: "c-1", clickId, cartTotal: 80, currency: "GBP", customerRef: "cust_42", recoveryUrl: `${SITE}/cart/recover/c-1` });
  await connector.recordCheckout({ checkoutId: "c-2", cartTotal: 20, currency: "GBP" });
  await connector.recordCheckoutStep({ checkoutId: "c-1", step: "payment" });
  await connector.recordCheckoutFailed({ checkoutId: "c-2", reason: "card_declined" });
  await flush();
  assert.deepEqual(
    net.calls.map((c) => (c.body as { type: string }).type),
    ["checkout.started", "checkout.started", "checkout.failed"]
  );
  const started = net.calls[0]!;
  assert.ok(verifyWebhook({ secret, body: JSON.stringify(started.body), headers: started.headers, now: clock.now() }));
  assert.ok(!verifyWebhook({ secret: "wrong-secret-000000", body: JSON.stringify(started.body), headers: started.headers, now: clock.now() }));
  assert.ok(!verifyWebhook({ secret, body: JSON.stringify(started.body), headers: started.headers, now: new Date(clock.t + 3600_000) }));
  assert.equal((started.body as { data: { customer_ref: string } }).data.customer_ref, "cust_42");

  assert.deepEqual(await connector.runScheduledTasks(), { abandoned: 0, recovery_emails: 0 }, "not abandoned yet");
  clock.advance(61 * 60_000);
  assert.deepEqual(await connector.runScheduledTasks(), { abandoned: 1, recovery_emails: 0 });
  assert.deepEqual(await connector.runScheduledTasks(), { abandoned: 0, recovery_emails: 0 }, "each checkout is announced once");
  const abandoned = net.calls.at(-1)!.body as { type: string; data: Record<string, any> };
  assert.equal(abandoned.type, "checkout.abandoned");
  assert.equal(abandoned.data.checkout_id, "c-1");
  assert.equal(abandoned.data.step, "payment");
  assert.equal(abandoned.data.code, "ANNA10");
  assert.equal(abandoned.data.creator.name, "Anna");
  assert.equal(abandoned.data.recovery_url, `${SITE}/cart/recover/c-1`);

  await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", clickId, amount: 80, currency: "GBP" });
  await connector.recordRefund({ orderId: "o-1" });
  await flush();
  const tail = net.calls.slice(-2).map((c) => c.body as { type: string; data: Record<string, any> });
  assert.equal(tail[0]!.type, "order.created");
  assert.equal(tail[0]!.data.code, "ANNA10");
  assert.equal(tail[1]!.type, "order.refunded");
});

test("webhook endpoints are validated", async () => {
  await assert.rejects(setup({ connector: { webhooks: { endpoints: [{ url: "http://hooks.example", secret: "0123456789abcdef" }] } } }), /https/);
  await assert.rejects(setup({ connector: { webhooks: { endpoints: [{ url: "https://hooks.example", secret: "short" }] } } }), /16 characters/);
});

test("admins can list failed and abandoned checkouts per creator code", async () => {
  const ctx = await setup();
  const { connector, clock } = ctx;
  const anna = await click(connector, "ANNA10");
  await connector.recordCheckout({ checkoutId: "f-1", clickId: anna, visitorId: VID, cartTotal: 60, currency: "GBP", step: "payment" });
  await connector.recordCheckoutFailed({ checkoutId: "f-1", reason: "card_declined" });
  await connector.recordCheckout({ checkoutId: "f-2", code: "BEN15", cartTotal: 30, currency: "GBP" });
  await connector.recordCheckout({ checkoutId: "f-3", cartTotal: 10, currency: "GBP" });
  await connector.recordCheckout({ checkoutId: "f-4", cartTotal: 99, currency: "GBP" });
  await connector.recordOrder({ orderId: "o-4", checkoutId: "f-4", amount: 99, currency: "GBP" });
  clock.advance(2 * 60 * 60_000);

  const all = await connector.listCheckouts("7d");
  assert.deepEqual(
    all.checkouts.map((c) => [c.checkout_id, c.status]).sort(),
    [
      ["f-1", "failed"],
      ["f-2", "abandoned"],
      ["f-3", "abandoned"],
    ]
  );
  const failed = all.checkouts.find((c) => c.checkout_id === "f-1")!;
  assert.equal(failed.creator_name, "Anna");
  assert.equal(failed.visitor_id, VID);
  assert.equal(failed.step, "payment");
  assert.equal(failed.failure_reason, "card_declined");
  assert.deepEqual(
    all.by_code.map((r) => [r.code, r.failed, r.abandoned, r.lost_value]).sort(),
    [
      ["ANNA10", 1, 0, 60],
      ["BEN15", 0, 1, 30],
    ]
  );

  const response = await connector.handle(new Request(`${SITE}/api/md/checkouts?range=7d&status=failed&code=anna10`));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { checkouts: { checkout_id: string }[] };
  assert.deepEqual(body.checkouts.map((c) => c.checkout_id), ["f-1"]);

  ctx.state.viewer = { role: "creator", userRef: "user-a" };
  assert.equal((await connector.handle(new Request(`${SITE}/api/md/checkouts`))).status, 403);
  void IDS;
});

test("the tracker script parses", () => {
  const script = trackerScript({ refParam: "ref", mountPath: "/api/md", cookieWindowDays: 30 });
  assert.doesNotThrow(() => new Function(script));
  assert.ok(script.includes('"/touch"'));
  assert.ok(script.includes("globalPrivacyControl"));
});
