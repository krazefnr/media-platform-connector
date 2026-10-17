import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSandboxed,
  DEFAULT_PANEL_HEIGHT,
  IFRAME_SANDBOX,
  isTrustedChildEvent,
  mountMediaDashboard,
  niceTicks,
  normalizeOrigin,
  overlayPlacement,
  panelReadyMessage,
  parseChildMessage,
  resolvePanelHeight,
} from "../host/index.js";
import { fakeDocument, fakeWindow, flush, installDom, type FakeElement, type Posted } from "./fake-dom.js";
import { approve, click, DAY, IDS, setup, stats } from "./helpers.js";

const DASH = "https://dash.example";

const open = {
  source: "media-dashboard",
  v: 1,
  type: "panel",
  panel: "affiliate-data",
  state: "open",
  role: "creator",
  rect: { top: 320, left: 24, width: 880, height: 400 },
  theme: "dark",
};

test("well-formed child messages are parsed", () => {
  assert.deepEqual(parseChildMessage(open), {
    type: "panel",
    panel: "affiliate-data",
    state: "open",
    role: "creator",
    theme: "dark",
    rect: { top: 320, left: 24, width: 880, height: 400 },
  });
  assert.deepEqual(parseChildMessage({ source: "media-dashboard", v: 1, type: "panel", panel: "affiliate-data", state: "closed" }), {
    type: "panel",
    panel: "affiliate-data",
    state: "closed",
  });
  assert.deepEqual(parseChildMessage({ source: "media-dashboard", v: 1, type: "resize", height: 1200.2 }), { type: "resize", height: 1201 });
  assert.deepEqual(parseChildMessage({ source: "media-dashboard", type: "resize", height: 900 }), { type: "resize", height: 900 });
  assert.equal(parseChildMessage({ ...open, rect: { ...open.rect, top: -5 } })?.type, "panel", "a slot scrolled out of view still parses");
});

test("malformed or foreign messages are ignored", () => {
  const bad: unknown[] = [
    null,
    "resize",
    42,
    [],
    { ...open, source: "media-dashboard-host" },
    { ...open, source: "other" },
    { ...open, v: 2 },
    { ...open, v: undefined },
    { ...open, panel: "payouts" },
    { ...open, state: "maybe" },
    { ...open, role: "owner" },
    { ...open, theme: "blue" },
    { ...open, rect: null },
    { ...open, rect: { ...open.rect, width: 0 } },
    { ...open, rect: { ...open.rect, top: -5_000_000 } },
    { ...open, rect: { ...open.rect, height: Number.NaN } },
    { ...open, rect: { ...open.rect, left: "24" } },
    { ...open, rect: { ...open.rect, top: Number.POSITIVE_INFINITY } },
    { source: "media-dashboard", v: 2, type: "resize", height: 100 },
    { source: "media-dashboard", v: 1, type: "resize", height: -1 },
    { source: "media-dashboard", v: 1, type: "resize", height: 5_000_000 },
    { source: "media-dashboard", v: 1, type: "panel-ready", panel: "affiliate-data", height: 10 },
  ];
  for (const message of bad) assert.equal(parseChildMessage(message), null, JSON.stringify(message));
});

test("only our own iframe on the dashboard origin is trusted", () => {
  const frameWindow = {};
  assert.equal(isTrustedChildEvent({ origin: DASH, source: frameWindow }, DASH, frameWindow), true);
  assert.equal(isTrustedChildEvent({ origin: "https://evil.example", source: frameWindow }, DASH, frameWindow), false);
  assert.equal(isTrustedChildEvent({ origin: DASH, source: {} }, DASH, frameWindow), false);
  assert.equal(isTrustedChildEvent({ origin: DASH, source: null }, DASH, null), false);
  assert.equal(isTrustedChildEvent({ origin: "https://dash.example.evil.example", source: frameWindow }, DASH, frameWindow), false);
});

test("panel-ready carries only the height, and the height is the brand's fixed choice", () => {
  assert.deepEqual(panelReadyMessage(612.3), {
    source: "media-dashboard-host",
    v: 1,
    type: "panel-ready",
    panel: "affiliate-data",
    height: 613,
  });
  assert.equal(panelReadyMessage(-4).height, 0);
  assert.equal(panelReadyMessage(Number.NaN).height, 0);
  assert.deepEqual(Object.keys(panelReadyMessage(1)).sort(), ["height", "panel", "source", "type", "v"]);
  assert.equal(resolvePanelHeight(undefined), DEFAULT_PANEL_HEIGHT);
  assert.equal(resolvePanelHeight(700.4), 700);
  assert.equal(resolvePanelHeight(5), 240);
  assert.equal(resolvePanelHeight(Number.POSITIVE_INFINITY), DEFAULT_PANEL_HEIGHT);
});

test("the overlay stays inside the iframe's box and ignores the slot's reported height", () => {
  const frame = { width: 1000, height: 2000 };
  assert.deepEqual(overlayPlacement({ top: 100, left: 16 }, frame, { top: 320.4, left: 24, width: 880.6, height: 400 }, 960), {
    top: 420,
    left: 40,
    width: 880,
    height: 960,
  });
  assert.deepEqual(overlayPlacement({ top: 0, left: 0 }, frame, { top: 1500, left: 600, width: 5000, height: 9 }, 960), {
    top: 1500,
    left: 600,
    width: 400,
    height: 500,
  });
  assert.equal(overlayPlacement({ top: 0, left: 0 }, frame, { top: -1, left: 0, width: 100, height: 10 }, 960), null);
  assert.equal(overlayPlacement({ top: 0, left: 0 }, frame, { top: 5000, left: 0, width: 100, height: 10 }, 960), null);
  assert.equal(overlayPlacement({ top: 0, left: 0 }, frame, { top: 0, left: 1000, width: 100, height: 10 }, 960), null);
});

test("the iframe must be sandboxed without top navigation", () => {
  assert.ok(!/allow-top-navigation/.test(IFRAME_SANDBOX));
  for (const token of ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups", "allow-popups-to-escape-sandbox", "allow-modals", "allow-downloads"]) {
    assert.ok(IFRAME_SANDBOX.split(" ").includes(token), token);
  }
  const frame = (sandbox: string | null) => ({ getAttribute: () => sandbox });
  assert.doesNotThrow(() => assertSandboxed(frame(IFRAME_SANDBOX)));
  assert.throws(() => assertSandboxed(frame(null)), /sandbox/);
  assert.throws(() => assertSandboxed(frame(`${IFRAME_SANDBOX} allow-top-navigation-by-user-activation`)), /top navigation/);
  assert.throws(() => assertSandboxed(frame("allow-scripts ALLOW-TOP-NAVIGATION")), /top navigation/);
});

async function statsSamples() {
  const ctx = await setup();
  const { connector, clock, state } = ctx;
  const emptyAdmin = await stats(connector);
  for (let i = 0; i < 6; i++) await click(connector, i % 2 ? "BEN15" : "ANNA10", { landing_path: "/products/hoodie", campaign: IDS.campaign });
  const anna = await click(connector, "ANNA10");
  for (let i = 0; i < 9; i++) await connector.recordOrder({ orderId: `o-${i}`, clickId: anna, amount: 1234567.89 + i, currency: "GBP" });
  await connector.recordOrder({ orderId: "t-1", clickId: anna, amount: 5, currency: "GBP", test: true });
  await connector.recordOrder({ orderId: "j-1", clickId: anna, amount: 500, currency: "JPY" });
  await connector.recordRefund({ orderId: "o-1" });
  clock.advance(DAY);
  await approve(connector, IDS.creatorA, "user-a");
  const fullAdmin = await stats(connector, "90d");
  state.viewer = { role: "creator", userRef: "user-a" };
  const creator = await stats(connector);
  state.viewer = { role: "creator", userRef: "user-b" };
  const pending = await stats(connector);
  assert.ok(fullAdmin.by_creator.length > 1 && fullAdmin.creator_links.length > 1 && creator.share_links.length > 0);
  return { emptyAdmin, fullAdmin, creator, pending };
}

function mount(panelHeight?: number) {
  const container = fakeDocument.createElement("div");
  fakeDocument.body.append(container);
  const handle = mountMediaDashboard({
    container: container as unknown as HTMLElement,
    src: `${DASH}/enter/admin?pass=x`,
    dashboardOrigin: DASH,
    ...(panelHeight === undefined ? {} : { panelHeight }),
  });
  const frame = handle.iframe as unknown as FakeElement;
  frame.box = { top: 0, left: 0, width: 1000, height: 3000 };
  const root = frame.parent!;
  root.box = { top: 0, left: 0, width: 1000, height: 3000 };
  const childWindow = frame.contentWindow as { posted: Posted[] };
  const overlay = root.find((el) => el.className.includes("mdc-overlay"))!;
  const send = (data: unknown, origin = DASH, source: unknown = childWindow) => fakeWindow.dispatch("message", { origin, source, data });
  return { handle, frame, overlay, posted: childWindow.posted, send };
}

test("whatever the sales screen shows, the dashboard only ever receives the same fixed height", async () => {
  const samples = await statsSamples();
  const responses: Array<[string, () => Response]> = [
    ["empty", () => Response.json(samples.emptyAdmin)],
    ["full", () => Response.json(samples.fullAdmin)],
    ["creator", () => Response.json(samples.creator)],
    ["pending", () => Response.json(samples.pending)],
    ["signed out", () => new Response("{}", { status: 401 })],
    ["error", () => new Response("{}", { status: 503 })],
  ];
  const seen = new Map<string, unknown[]>();
  for (const [name, respond] of responses) {
    const restore = installDom(() => respond());
    try {
      const { handle, overlay, posted, send } = mount(700);
      send({ type: "resize", height: 2400, source: "media-dashboard", v: 1 });
      assert.equal(posted.length, 0, "nothing answers a resize");
      for (const width of [880, 1, 40, 333, 5000]) {
        send({ ...open, role: name === "creator" || name === "pending" ? "creator" : "admin", rect: { ...open.rect, width, height: width } });
        await flush();
      }
      send({ ...open, rect: { ...open.rect, top: -50 } });
      await flush();
      assert.equal(overlay.hidden, true, "a slot scrolled out of view hides the overlay");
      send({ source: "media-dashboard", v: 1, type: "panel", panel: "affiliate-data", state: "closed" });
      send({ ...open }, "https://evil.example");
      send({ ...open }, DASH, {});
      await flush();
      assert.equal(posted.length, 6, `${name}: one answer per trusted "open", none on data or state changes`);
      assert.ok(posted.every((p) => p.targetOrigin === DASH));
      seen.set(name, posted.map((p) => p.message));
      handle.destroy();
    } finally {
      restore();
    }
  }
  const expected = Array.from({ length: 6 }, () => panelReadyMessage(700));
  for (const [name, messages] of seen) assert.deepEqual(messages, expected, name);
});

test("the sales screen renders over the slot inside the iframe's box, at the fixed height", async () => {
  const samples = await statsSamples();
  const restore = installDom(() => Response.json(samples.fullAdmin));
  try {
    const { handle, frame, overlay, send } = mount();
    assert.equal(frame.getAttribute("sandbox"), IFRAME_SANDBOX);
    assert.equal(frame.getAttribute("referrerpolicy"), "strict-origin");
    send({ ...open, role: "admin", rect: { top: 300, left: 20, width: 5000, height: 10 } });
    await flush();
    assert.equal(overlay.hidden, false);
    assert.deepEqual(
      [overlay.style.top, overlay.style.left, overlay.style.width, overlay.style.height],
      ["300px", "20px", "980px", `${DEFAULT_PANEL_HEIGHT}px`]
    );
    const text = overlay.textContent;
    assert.match(text, /Sales & performance/);
    assert.match(text, /Creator logins/);
    assert.match(text, /By creator/);
    handle.destroy();
    assert.equal(fakeWindow.listenerCount("message"), 0);
  } finally {
    restore();
  }

  const restoreCreator = installDom(() => Response.json(samples.creator));
  try {
    const { handle, overlay, send } = mount();
    send({ ...open });
    await flush();
    assert.match(overlay.textContent, /Your share links/);
    assert.match(overlay.textContent, /https:\/\/shop\.example\/\?ref=ANNA10/);
    handle.destroy();
  } finally {
    restoreCreator();
  }

  const restorePending = installDom(() => Response.json(samples.pending));
  try {
    const { handle, overlay, send } = mount();
    send({ ...open });
    await flush();
    assert.match(overlay.textContent, /Waiting for approval/);
    assert.doesNotMatch(overlay.textContent, /Conversion rate/);
    handle.destroy();
  } finally {
    restorePending();
  }
});

test("an iframe the brand rendered itself must already be sandboxed", () => {
  const restore = installDom(() => new Response("{}"));
  try {
    const container = fakeDocument.createElement("div");
    const frame = fakeDocument.createElement("iframe");
    container.append(frame);
    const options = { container: container as unknown as HTMLElement, iframe: frame as unknown as HTMLIFrameElement, src: `${DASH}/embed?pass=x`, dashboardOrigin: DASH };
    assert.throws(() => mountMediaDashboard(options), /sandbox/);
    frame.setAttribute("sandbox", `${IFRAME_SANDBOX} allow-top-navigation`);
    assert.throws(() => mountMediaDashboard(options), /top navigation/);
    frame.setAttribute("sandbox", IFRAME_SANDBOX);
    mountMediaDashboard(options).destroy();
  } finally {
    restore();
  }
});

test("origins are normalised", () => {
  assert.equal(normalizeOrigin("https://dash.example/some/path?x=1"), "https://dash.example");
  assert.equal(normalizeOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
  assert.equal(normalizeOrigin("not a url"), null);
});

test("chart ticks are clean numbers covering the max", () => {
  assert.deepEqual(niceTicks(3, true), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(9, true), [0, 5, 10]);
  assert.deepEqual(niceTicks(1, true), [0, 1]);
  assert.deepEqual(niceTicks(1234.5, false), [0, 500, 1000, 1500]);
  assert.deepEqual(niceTicks(0.3, false), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(0, true), [0, 1]);
  for (const max of [7, 42, 99, 1001, 58_000]) {
    const ticks = niceTicks(max, true);
    assert.ok(ticks.at(-1)! >= max);
    assert.ok(ticks.every(Number.isInteger));
  }
});

test("admins also see attribution and failed/abandoned checkouts on the sales screen", async () => {
  const ctx = await setup();
  const { connector, clock } = ctx;
  const vid = "99999999-9999-4999-8999-999999999999";
  const touch = (body: Record<string, unknown>) =>
    connector.handle(
      new Request("https://shop.example/api/md/touch", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://shop.example", cookie: `md_vid=${vid}` },
        body: JSON.stringify(body),
      })
    );
  await touch({ utm_source: "tiktok", utm_medium: "paid" });
  await touch({ ref: "ANNA10" });
  const anna = await click(connector, "ANNA10");
  await connector.recordCheckout({ checkoutId: "lost-1", clickId: anna, visitorId: vid, cartTotal: 60, currency: "GBP", step: "payment" });
  await connector.recordCheckoutFailed({ checkoutId: "lost-1", reason: "card_declined" });
  await connector.recordOrder({ orderId: "won-1", clickId: anna, visitorId: vid, amount: 100, currency: "GBP" });
  clock.advance(60_000);
  const statsBody = await stats(connector);
  const attribution = await connector.getAttribution("30d");
  const checkouts = await connector.listCheckouts("30d");

  const restore = installDom((url) =>
    url.includes("/attribution") ? Response.json(attribution) : url.includes("/checkouts") ? Response.json(checkouts) : Response.json(statsBody)
  );
  try {
    const { handle, overlay, posted, send } = mount();
    send({ ...open, role: "admin" });
    for (let i = 0; i < 5; i++) await flush();
    const text = overlay.textContent;
    assert.match(text, /Where sales come from/);
    assert.match(text, /Paid social/);
    assert.match(text, /Creator links/);
    assert.match(text, /Top journeys/);
    assert.match(text, /Creator influence/);
    assert.match(text, /Lost checkouts by creator/);
    assert.match(text, /Payment failed/);
    assert.match(text, /card_declined/);
    assert.match(text, /Copy Clarity filter/);
    assert.deepEqual(posted.map((p) => p.message), [panelReadyMessage(DEFAULT_PANEL_HEIGHT)], "still only the fixed height crosses into the iframe");
    handle.destroy();
  } finally {
    restore();
  }

  // An older connector without these routes: the rest of the screen still renders.
  const restoreOld = installDom((url) => (url.includes("/stats") ? Response.json(statsBody) : new Response("{}", { status: 404 })));
  try {
    const { handle, overlay, send } = mount();
    send({ ...open, role: "admin" });
    for (let i = 0; i < 5; i++) await flush();
    assert.match(overlay.textContent, /By creator/);
    assert.doesNotMatch(overlay.textContent, /Where sales come from/);
    handle.destroy();
  } finally {
    restoreOld();
  }
});
