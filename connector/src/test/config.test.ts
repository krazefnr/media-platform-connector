import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { ConfigUnavailableError, createConnector, memoryStore, parseConfig } from "../server/index.js";
import { BRAND, click, configFixture, DASHBOARD, IDS, keyPair, setup, setupSync, SITE, stats, type ConfigFixture } from "./helpers.js";

async function health(connector: Awaited<ReturnType<typeof setup>>["connector"]) {
  return (await (await connector.handle(new Request(`${SITE}/api/md/health`))).json()) as Record<string, unknown>;
}

test("the config request is signed over {ts}.GET./api/brand/{brand}/config", async () => {
  const { calls, keys, clock } = await setup();
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${DASHBOARD}/api/brand/${BRAND}/config`);
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.cache, "no-store");
  const headers = new Headers(call.init?.headers);
  const ts = headers.get("x-md-timestamp")!;
  assert.equal(ts, String(Math.floor(clock.t / 1000)));
  const signature = Buffer.from(headers.get("x-md-signature")!, "base64");
  assert.equal(signature.length, 64);
  assert.ok(verify(null, Buffer.from(`${ts}.GET./api/brand/${BRAND}/config`), keys.publicKey, signature));
  assert.ok(!verify(null, Buffer.from(`${ts}.GET./api/brand/edner/config`), keys.publicKey, signature));
  assert.ok(!verify(null, Buffer.from(`${Number(ts) + 1}.GET./api/brand/${BRAND}/config`), keys.publicKey, signature));
});

test("request paths and record functions never pull the config, however old it is", async () => {
  const { connector, calls, clock, state } = await setup();
  assert.equal(calls.length, 1);
  clock.advance(7 * 86_400_000);
  const id = await click(connector, "ANNA10");
  await connector.recordCheckout({ checkoutId: "c-1", clickId: id, cartTotal: 10, currency: "GBP" });
  await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", amount: 10, currency: "GBP" });
  await connector.recordRefund({ orderId: "o-1" });
  await stats(connector);
  state.viewer = { role: "creator", userRef: "user-a" };
  await stats(connector);
  await connector.handle(new Request(`${SITE}/api/md/t.js`));
  await connector.handle(new Request(`${SITE}/api/md/health`));
  await connector.getConfig();
  assert.equal(calls.length, 1, "only refreshConfig() and the timer contact the dashboard");
  await connector.refreshConfig();
  assert.equal(calls.length, 2);
});

test("the accepted config is kept in the brand's store, so another instance doesn't pull it", async () => {
  const first = await setup();
  const second = setupSync({ store: first.store });
  assert.equal((await second.connector.getConfig()).affiliates.length, 3);
  await click(second.connector, "ANNA10");
  assert.equal(second.calls.length, 0);

  (first.state.config as ConfigFixture).affiliates[0]!.status = "suspended";
  first.clock.advance(1_000);
  await first.connector.refreshConfig();
  second.clock.advance(31_000);
  assert.equal((await second.connector.getConfig()).affiliates[0]!.status, "suspended");
  assert.equal(second.calls.length, 0);
});

test("the last good config is kept while the dashboard is unreachable", async () => {
  const { connector, state } = await setup();
  const first = await connector.getConfig();
  state.fail = "network";
  await assert.rejects(connector.refreshConfig(), ConfigUnavailableError);
  assert.deepEqual(await connector.getConfig(), first);
  const down = await health(connector);
  assert.equal(down.ok, true);
  assert.equal(down.dashboard_reachable, false);
  assert.equal(typeof down.config_loaded_at, "string");

  state.fail = 503;
  await assert.rejects(connector.refreshConfig(), /HTTP 503/);
  assert.deepEqual(await connector.getConfig(), first);

  state.fail = null;
  await connector.refreshConfig();
  assert.equal((await health(connector)).dashboard_reachable, true);
});

test("without any config, routes answer 503 and order recording throws, without pulling inline", async () => {
  const { connector, calls, state } = await setup({ load: false });
  const clickRequest = () =>
    new Request(`${SITE}/api/md/click`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: "ANNA10" }) });
  assert.equal((await connector.handle(clickRequest())).status, 503);
  await assert.rejects(connector.recordOrder({ orderId: "o", code: "ANNA10", amount: 1, currency: "GBP" }), ConfigUnavailableError);
  const h = (await health(connector)) as Record<string, unknown>;
  assert.match(String(h.app_id), /^[0-9a-f]{16}$/);
  delete h.app_id;
  assert.deepEqual(h, { ok: false, config_loaded_at: null, dashboard_reachable: null, config_rejected: null });
  assert.equal(calls.length, 0);

  state.fail = 401;
  await assert.rejects(connector.refreshConfig(), ConfigUnavailableError);
  await assert.rejects(connector.getConfig(), ConfigUnavailableError);
  assert.equal((await health(connector)).dashboard_reachable, false);
});

test("a config for another brand is refused", async () => {
  const { connector, state } = await setup({ load: false });
  state.config = { ...configFixture(), brand: "edner" };
  await assert.rejects(connector.refreshConfig(), ConfigUnavailableError);
  await assert.rejects(connector.getConfig(), ConfigUnavailableError);
});

test("a config that points creator links away from the brand's storefront is refused", async () => {
  const { connector, state } = await setup({ siteOrigin: SITE });
  const config = state.config as ConfigFixture;

  config.program.storefront_url = "https://go.operator.example/kraze";
  await assert.rejects(connector.refreshConfig(), /storefront_url/);
  assert.equal((await connector.getConfig()).program.storefront_url, SITE, "the last accepted config stays in use");
  const rejected = await health(connector);
  assert.equal(rejected.config_rejected, "storefront_url");
  assert.equal(rejected.ok, true);
  assert.match((await stats(connector)).config_warning ?? "", /storefront URL points outside this site/);

  config.program.storefront_url = `${SITE}/shop`;
  config.program.allowed_deep_link_domains = ["evil.example"];
  await assert.rejects(connector.refreshConfig(), /allowed_deep_link_domains/);
  config.program.allowed_deep_link_domains = ["*.shop.example"];
  await assert.rejects(connector.refreshConfig(), /allowed_deep_link_domains/);

  config.program.allowed_deep_link_domains = ["https://Shop.Example/"];
  await connector.refreshConfig();
  assert.equal((await connector.getConfig()).program.storefront_url, `${SITE}/shop`);
  assert.equal((await health(connector)).config_rejected, null);
  assert.equal((await stats(connector)).config_warning, null);
});

test("declared storefront origins and deep-link domains can be widened by the brand", async () => {
  const { connector, state } = await setup({
    siteOrigin: SITE,
    connector: { storefrontOrigins: [SITE, "https://www.shop.example"], deepLinkDomains: ["*.shop.example", "shop.example"] },
  });
  const config = state.config as ConfigFixture;
  config.program.storefront_url = "https://www.shop.example";
  config.program.allowed_deep_link_domains = ["*.shop.example", "blog.shop.example"];
  await connector.refreshConfig();
  assert.equal((await connector.getConfig()).program.storefront_url, "https://www.shop.example");
});

test("with no site or storefront origin declared, storefront settings aren't checked", async () => {
  const { connector, state } = await setup();
  (state.config as ConfigFixture).program.storefront_url = "https://elsewhere.example";
  await connector.refreshConfig();
});

test("interval mode refreshes on its own timer and close() stops it", async () => {
  const keys = keyPair();
  let pulls = 0;
  const connector = createConnector({
    brand: BRAND,
    dashboardUrl: DASHBOARD,
    privateKey: keys.base64,
    store: memoryStore(),
    getViewer: async () => null,
    configRefreshSeconds: 10,
    fetch: async () => {
      pulls++;
      return new Response(JSON.stringify(configFixture()));
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pulls, 1, "the timer pulls once at start-up");
    assert.equal((await connector.getConfig()).affiliates.length, 3);
    await connector.getConfig();
    assert.equal(pulls, 1);
  } finally {
    connector.close();
  }
});

test("parseConfig drops rows that don't match the protocol", () => {
  const raw = configFixture();
  const config = parseConfig(
    {
      ...raw,
      program: { ...raw.program, ref_param: "bad param!", cookie_window_days: 0 },
      affiliates: [...raw.affiliates, { id: "nope", code: "X" }, { ...raw.affiliates[0], id: IDS.campaign, status: "weird" }],
      links: [...raw.links, { id: IDS.link, affiliate_id: "x", label: "y", target_path: "/" }],
    },
    BRAND
  );
  assert.equal(config.affiliates.length, 3);
  assert.equal(config.links.length, 1);
  assert.equal(config.program.ref_param, "ref");
  assert.equal(config.program.cookie_window_days, 30);
  assert.throws(() => parseConfig({ ...raw, version: 2 }, BRAND), ConfigUnavailableError);
});

test("the dashboard URL must be https outside local development", async () => {
  const { keys } = await setup();
  const make = (dashboardUrl: string) =>
    createConnector({ brand: BRAND, dashboardUrl, privateKey: keys.base64, store: memoryStore(), getViewer: async () => null, configRefresh: "manual" });
  assert.throws(() => make("http://dash.example"), /https/);
  assert.doesNotThrow(() => make("http://localhost:3000"));
  assert.throws(
    () => createConnector({ brand: "Bad Brand", dashboardUrl: DASHBOARD, privateKey: keys.base64, store: memoryStore(), getViewer: async () => null }),
    /brand/
  );
});
