import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_COOKIE } from "../server/index.js";
import { click, clickRequest, IDS, setup, SITE, type ConfigFixture } from "./helpers.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

async function storedClick(store: Awaited<ReturnType<typeof setup>>["store"], id: string) {
  const row = await store.getClick(id);
  assert.ok(row, "click should be stored");
  return row;
}

test("a click sets the first-party md_click cookie", async () => {
  const { connector, store } = await setup();
  const response = await connector.handle(clickRequest({ ref: "anna10" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const { click_id } = (await response.json()) as { click_id: string };
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, new RegExp(`^${CLICK_COOKIE}=${UUID}; Path=/; Max-Age=2592000; SameSite=Lax; Secure$`));
  assert.ok(cookie.startsWith(`md_click=${click_id};`));
  assert.ok(!/httponly/i.test(cookie));
  assert.equal((await storedClick(store, click_id)).affiliateId, IDS.affA);
});

test("the cookie window follows the programme config and Secure follows the scheme", async () => {
  const { connector, state } = await setup();
  (state.config as ConfigFixture).program.cookie_window_days = 7;
  await connector.refreshConfig();
  const response = await connector.handle(clickRequest({ ref: "ANNA10" }, {}, "http://localhost:3000/api/md/click"));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /Max-Age=604800/);
  assert.ok(!cookie.includes("Secure"));
});

test("cross-origin clicks are refused", async () => {
  const { connector } = await setup();
  assert.equal((await connector.handle(clickRequest({ ref: "ANNA10" }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await connector.handle(clickRequest({ ref: "ANNA10" }, { "sec-fetch-site": "cross-site" }))).status, 403);
  const noOrigin = new Request(`${SITE}/api/md/click`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "ANNA10" }),
  });
  assert.equal((await connector.handle(noOrigin)).status, 200);
});

test("siteOrigin is used when the request URL is internal", async () => {
  const internal = "http://10.0.0.5:3000/api/md/click";
  const plain = await setup();
  assert.equal((await plain.connector.handle(clickRequest({ ref: "ANNA10" }, { origin: SITE }, internal))).status, 403);
  const proxied = await setup({ siteOrigin: SITE });
  const response = await proxied.connector.handle(clickRequest({ ref: "ANNA10" }, { origin: SITE }, internal));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie")!, /; Secure$/);
});

test("bad click requests are refused", async () => {
  const { connector } = await setup();
  assert.equal((await connector.handle(clickRequest({ ref: "NOPE" }))).status, 404);
  assert.equal((await connector.handle(clickRequest({ ref: "OLD5" }))).status, 404);
  assert.equal((await connector.handle(clickRequest({ ref: "" }))).status, 400);
  assert.equal((await connector.handle(clickRequest({ ref: "x".repeat(65) }))).status, 400);
  assert.equal((await connector.handle(clickRequest("not json"))).status, 400);
  assert.equal((await connector.handle(clickRequest({ ref: "ANNA10", pad: "x".repeat(3000) }))).status, 400);
  assert.equal((await connector.handle(clickRequest({ ref: "ANNA10" }, { "content-type": "text/plain" }))).status, 415);
});

test("a click body without Content-Length stops being read past the limit", async () => {
  const { connector } = await setup();
  let pulled = 0;
  const chunk = new TextEncoder().encode(`{"ref":"ANNA10","pad":"${"x".repeat(1000)}`);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
      if (pulled > 50_000_000) controller.close();
    },
  });
  const request = new Request(`${SITE}/api/md/click`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal(request.headers.get("content-length"), null);
  assert.equal((await connector.handle(request)).status, 400);
  assert.ok(pulled < 20_000, `read ${pulled} bytes`);

  const multibyte = clickRequest(`{"ref":"ANNA10","pad":"${"é".repeat(1100)}"}`);
  assert.equal((await connector.handle(multibyte)).status, 400, "the limit counts bytes, not characters");
});

test("only a hashed IP, the path and the referrer host are stored", async () => {
  const { connector, store } = await setup();
  const id = await click(connector, "ANNA10", {
    landing_path: "/products/hoodie?email=someone@example.com#top",
    referrer_host: "WWW.TikTok.com",
    campaign: IDS.campaign,
  });
  const row = await storedClick(store, id);
  assert.equal(row.landingPath, "/products/hoodie");
  assert.equal(row.referrerHost, "www.tiktok.com");
  assert.equal(row.campaignId, IDS.campaign);
  assert.equal(row.linkId, IDS.link);
  assert.match(row.ipHash!, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(row).includes("203.0.113.9"));

  const bad = await storedClick(store, await click(connector, "BEN15", { landing_path: "https://evil.example/x", referrer_host: "a b" }));
  assert.equal(bad.landingPath, null);
  assert.equal(bad.referrerHost, null);
});

test("clicks are rate limited per IP from the trusted header", async () => {
  const { connector, clock } = await setup();
  for (let i = 0; i < 20; i++) assert.equal((await connector.handle(clickRequest({ ref: "ANNA10" }))).status, 200);
  const limited = await connector.handle(clickRequest({ ref: "ANNA10" }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  const spoofed = await connector.handle(
    clickRequest({ ref: "ANNA10" }, { "x-forwarded-for": "198.51.100.77, 203.0.113.9", "cf-connecting-ip": "198.51.100.78" })
  );
  assert.equal(spoofed.status, 429, "only the right-most x-forwarded-for entry counts; other headers are ignored");
  assert.equal((await connector.handle(clickRequest({ ref: "ANNA10" }, { "x-forwarded-for": "198.51.100.4" }))).status, 200);
  clock.advance(3_000);
  assert.equal((await connector.handle(clickRequest({ ref: "ANNA10" }))).status, 200);
});

test("without a trusted IP header, client-set IP headers are ignored and visitors share a generous site-wide limit", async () => {
  const { connector, store } = await setup({ connector: { trustedIpHeader: undefined } });
  for (let i = 0; i < 100; i++) {
    const response = await connector.handle(
      clickRequest({ ref: "ANNA10" }, { "cf-connecting-ip": `198.51.100.${i}`, "x-real-ip": `192.0.2.${i}`, "x-forwarded-for": `203.0.113.${i}` })
    );
    assert.equal(response.status, 200, `click ${i}`);
    const { click_id } = (await response.json()) as { click_id: string };
    assert.equal((await storedClick(store, click_id)).ipHash, null);
  }
});

test("a repeat visit with the same link reuses the click for 30 minutes", async () => {
  const { connector, clock } = await setup();
  const first = await click(connector, "ANNA10");
  const cookie = { cookie: `other=1; ${CLICK_COOKIE}=${first}` };
  assert.equal(await click(connector, "ANNA10", {}, cookie), first);
  assert.notEqual(await click(connector, "BEN15", {}, cookie), first);
  clock.advance(31 * 60_000);
  assert.notEqual(await click(connector, "ANNA10", {}, cookie), first);
});

test("clickIdFromRequest reads the md_click cookie", async () => {
  const { connector } = await setup();
  const id = "9b2f7c1e-3d4a-4b5c-8d6e-7f8091a2b3c4";
  assert.equal(connector.clickIdFromRequest(new Request(SITE, { headers: { cookie: `a=1; md_click=${id.toUpperCase()}` } })), id);
  assert.equal(connector.clickIdFromRequest(new Request(SITE, { headers: { cookie: "md_click=not-a-uuid" } })), null);
  assert.equal(connector.clickIdFromRequest({ headers: new Headers() }), null);
});

test("the tracker script uses the programme's ref parameter", async () => {
  const { connector, state } = await setup();
  (state.config as ConfigFixture).program.ref_param = "via";
  await connector.refreshConfig();
  const response = await connector.handle(new Request(`${SITE}/api/md/t.js`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /javascript/);
  const script = await response.text();
  assert.ok(script.includes('var REF = "via"'));
  assert.ok(script.includes('var BASE = "/api/md"'));
  assert.ok(script.includes("md_click"));
  assert.ok(!script.includes("ANNA10"), "no affiliate data in the public script");
  new Function(script);
});

test("host.js, health and unknown routes", async () => {
  const { connector } = await setup();
  const host = await connector.handle(new Request(`${SITE}/api/md/host.js`));
  assert.equal(host.status, 200);
  assert.match(host.headers.get("content-type")!, /javascript/);
  const source = await host.text();
  assert.ok(source.includes("export function mountMediaDashboard"));
  assert.ok(!/^\s*import\s[^(]/m.test(source), "host.js must be a single self-contained module");
  const etag = host.headers.get("etag")!;
  assert.match(etag, /^"[\w-]+"$/);
  const revalidated = await connector.handle(new Request(`${SITE}/api/md/host.js`, { headers: { "if-none-match": etag } }));
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), "");

  const health = await connector.handle(new Request(`${SITE}/api/md/health`));
  const body = (await health.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.dashboard_reachable, true);
  assert.equal(body.config_rejected, null);
  assert.deepEqual(Object.keys(body).sort(), ["app_id", "config_loaded_at", "config_rejected", "dashboard_reachable", "ok"]);

  assert.equal((await connector.handle(new Request(`${SITE}/api/md/nope`))).status, 404);
  assert.equal((await connector.handle(new Request(`${SITE}/api/other/stats`))).status, 404);
  const wrongMethod = await connector.handle(new Request(`${SITE}/api/md/click`));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");
  const head = await connector.handle(new Request(`${SITE}/api/md/health`, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const { GET, POST } = connector.routeHandlers();
  assert.equal((await GET(new Request(`${SITE}/api/md/health`))).status, 200);
  assert.equal((await POST(clickRequest({ ref: "ANNA10" }))).status, 200);
});

test("a custom mount path", async () => {
  const { keys } = await setup();
  const { createConnector, memoryStore } = await import("../server/index.js");
  const { configFixture } = await import("./helpers.js");
  const connector = createConnector({
    brand: "kraze",
    dashboardUrl: "https://dash.example",
    privateKey: keys.base64,
    store: memoryStore(),
    getViewer: async () => null,
    mountPath: "/affiliates/",
    configRefresh: "manual",
    fetch: async () => new Response(JSON.stringify(configFixture())),
  });
  await connector.refreshConfig();
  assert.equal((await connector.handle(new Request(`${SITE}/affiliates/health`))).status, 200);
  assert.equal((await connector.handle(new Request(`${SITE}/api/md/health`))).status, 404);
  assert.ok((await (await connector.handle(new Request(`${SITE}/affiliates/t.js`))).text()).includes('"/affiliates"'));
});
