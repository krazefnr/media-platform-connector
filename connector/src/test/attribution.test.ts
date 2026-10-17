import { test } from "node:test";
import assert from "node:assert/strict";
import { click, DAY, IDS, setup, stats, type ConfigFixture } from "./helpers.js";

test("a click inside the cookie window is credited", async () => {
  const { connector, clock } = await setup();
  const clickId = await click(connector, "ANNA10");
  clock.advance(29 * DAY);
  const result = await connector.recordOrder({ orderId: "o-1", clickId, amount: "100.00", currency: "gbp" });
  assert.equal(result.status, "recorded");
  assert.equal(result.order?.affiliateId, IDS.affA);
  assert.equal(result.order?.creatorId, IDS.creatorA);
  assert.equal(result.order?.attributedVia, "click");
  assert.equal(result.order?.currency, "GBP");
  assert.equal(result.order?.commissionBps, 1000);
  assert.equal(result.order?.commission, 10);
});

test("a click older than the cookie window is not credited", async () => {
  const { connector, clock } = await setup();
  const clickId = await click(connector, "ANNA10");
  clock.advance(31 * DAY);
  const result = await connector.recordOrder({ orderId: "o-1", clickId, amount: 100, currency: "GBP" });
  assert.equal(result.status, "not_attributed");
  assert.equal((await stats(connector)).totals.orders, 0);
});

test("a click whose affiliate is no longer active is not credited", async () => {
  const { connector, state } = await setup();
  const clickId = await click(connector, "ANNA10");
  const config = state.config as ConfigFixture;
  config.affiliates[0]!.status = "suspended";
  await connector.refreshConfig();
  const result = await connector.recordOrder({ orderId: "o-1", clickId, amount: 100, currency: "GBP" });
  assert.equal(result.status, "not_attributed");
});

test("an inactive code cannot record a click", async () => {
  const { connector } = await setup();
  await assert.rejects(click(connector, "OLD5"), /404/);
  await assert.rejects(click(connector, "NOPE"), /404/);
});

test("last click wins between the order's and the checkout's click", async () => {
  const { connector, clock } = await setup();
  const older = await click(connector, "ANNA10");
  clock.advance(DAY);
  const newer = await click(connector, "BEN15");
  clock.advance(DAY);

  await connector.recordCheckout({ checkoutId: "c-1", clickId: newer, cartTotal: 80, currency: "GBP" });
  const first = await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", clickId: older, amount: 80, currency: "GBP" });
  assert.equal(first.order?.affiliateId, IDS.affB);
  assert.equal(first.order?.clickId, newer);

  await connector.recordCheckout({ checkoutId: "c-2", clickId: older, cartTotal: 50, currency: "GBP" });
  const second = await connector.recordOrder({ orderId: "o-2", checkoutId: "c-2", clickId: newer, amount: 50, currency: "GBP" });
  assert.equal(second.order?.affiliateId, IDS.affB);
});

test("a newer click for a suspended affiliate loses to an older eligible click", async () => {
  const { connector, clock, state } = await setup();
  const anna = await click(connector, "ANNA10");
  clock.advance(DAY);
  const ben = await click(connector, "BEN15");
  (state.config as ConfigFixture).affiliates[1]!.status = "suspended";
  await connector.refreshConfig();
  await connector.recordCheckout({ checkoutId: "c-1", clickId: anna, cartTotal: 10, currency: "GBP" });
  const result = await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", clickId: ben, amount: 10, currency: "GBP" });
  assert.equal(result.order?.affiliateId, IDS.affA);
});

test("a code typed at checkout is the fallback when there is no creditable click", async () => {
  const { connector, clock } = await setup();
  const byCode = await connector.recordOrder({ orderId: "o-1", code: " ben15 ", amount: 200, currency: "EUR" });
  assert.equal(byCode.status, "recorded");
  assert.equal(byCode.order?.attributedVia, "code");
  assert.equal(byCode.order?.affiliateId, IDS.affB);
  assert.equal(byCode.order?.commission, 30);

  const expired = await click(connector, "ANNA10");
  clock.advance(40 * DAY);
  const fallback = await connector.recordOrder({ orderId: "o-2", clickId: expired, code: "BEN15", amount: 10, currency: "EUR" });
  assert.equal(fallback.order?.affiliateId, IDS.affB);
  assert.equal(fallback.order?.attributedVia, "code");

  const live = await click(connector, "ANNA10");
  const clickBeatsCode = await connector.recordOrder({ orderId: "o-3", clickId: live, code: "BEN15", amount: 10, currency: "EUR" });
  assert.equal(clickBeatsCode.order?.affiliateId, IDS.affA);

  const suspended = await connector.recordOrder({ orderId: "o-4", code: "OLD5", amount: 10, currency: "EUR" });
  assert.equal(suspended.status, "not_attributed");
});

test("orders are idempotent by orderId", async () => {
  const { connector } = await setup();
  const clickId = await click(connector, "ANNA10");
  const first = await connector.recordOrder({ orderId: "1001", clickId, amount: 100, currency: "GBP" });
  const again = await connector.recordOrder({ orderId: "1001", clickId, amount: 999, currency: "GBP" });
  assert.equal(first.status, "recorded");
  assert.equal(again.status, "duplicate");
  assert.equal(again.order?.amount, 100);
  const s = await stats(connector);
  assert.equal(s.totals.orders, 1);
  assert.equal(s.totals.revenue, 100);
});

test("a refund removes the order from revenue and commission", async () => {
  const { connector } = await setup();
  const clickId = await click(connector, "ANNA10");
  await connector.recordOrder({ orderId: "o-1", clickId, amount: 100, currency: "GBP" });
  await connector.recordOrder({ orderId: "o-2", clickId, amount: 40, currency: "GBP" });

  assert.deepEqual(await connector.recordRefund({ orderId: "o-1" }), { status: "refunded" });
  assert.deepEqual(await connector.recordRefund({ orderId: "o-1" }), { status: "already_refunded" });
  assert.deepEqual(await connector.recordRefund({ orderId: "missing" }), { status: "pending" });

  const s = await stats(connector);
  assert.equal(s.totals.orders, 2);
  assert.equal(s.totals.refunds, 1);
  assert.equal(s.totals.revenue, 40);
  assert.equal(s.totals.commission, 4);
});

test("test orders are excluded from totals but counted separately", async () => {
  const { connector } = await setup();
  const clickId = await click(connector, "ANNA10");
  await connector.recordOrder({ orderId: "t-1", clickId, amount: 500, currency: "GBP", test: true });
  await connector.recordOrder({ orderId: "o-1", clickId, amount: 20, currency: "GBP" });
  const s = await stats(connector);
  assert.equal(s.totals.test_orders, 1);
  assert.equal(s.totals.orders, 1);
  assert.equal(s.totals.revenue, 20);
  assert.equal(s.totals.commission, 2);
  assert.equal(s.by_creator[0]?.test_orders, 1);
});

test("checkouts: started, failed, abandoned after 24 hours, completed by an order", async () => {
  const { connector, clock } = await setup();
  const clickId = await click(connector, "ANNA10");

  assert.equal((await connector.recordCheckout({ checkoutId: "c-old", clickId, cartTotal: 10, currency: "GBP" })).status, "recorded");
  clock.advance(25 * 60 * 60_000);
  await connector.recordCheckout({ checkoutId: "c-paid", clickId, cartTotal: 20, currency: "GBP" });
  await connector.recordCheckout({ checkoutId: "c-failed", code: "ANNA10", cartTotal: 30, currency: "GBP" });
  await connector.recordCheckout({ checkoutId: "c-fresh", clickId, cartTotal: 40, currency: "GBP" });
  assert.deepEqual(await connector.recordCheckoutFailed({ checkoutId: "c-failed", reason: "card_declined" }), { status: "failed" });
  assert.deepEqual(await connector.recordCheckoutFailed({ checkoutId: "unknown" }), { status: "not_found" });
  await connector.recordOrder({ orderId: "o-1", checkoutId: "c-paid", amount: 20, currency: "GBP" });
  clock.advance(60 * 60_000);

  const s = await stats(connector);
  assert.equal(s.totals.checkouts_started, 4);
  assert.equal(s.totals.checkouts_failed, 1);
  assert.equal(s.totals.checkouts_abandoned, 1);
  assert.equal(s.totals.orders, 1);

  const none = await connector.recordCheckout({ checkoutId: "c-anon", cartTotal: 5, currency: "GBP" });
  assert.equal(none.status, "not_attributed");
});

test("an order uses the checkout's click when it has none of its own", async () => {
  const { connector } = await setup();
  const clickId = await click(connector, "BEN15");
  await connector.recordCheckout({ checkoutId: "c-1", clickId, cartTotal: 60, currency: "GBP" });
  const result = await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", amount: 60, currency: "GBP" });
  assert.equal(result.order?.affiliateId, IDS.affB);
  assert.equal(result.order?.clickId, clickId);
});

test("campaign comes from the click unless the order names one", async () => {
  const { connector } = await setup();
  const withCampaign = await click(connector, "ANNA10", { campaign: IDS.campaign.toUpperCase() });
  const fromClick = await connector.recordOrder({ orderId: "o-1", clickId: withCampaign, amount: 10, currency: "GBP" });
  assert.equal(fromClick.order?.campaignId, IDS.campaign);

  const plain = await click(connector, "BEN15", { campaign: "not-a-uuid" });
  const explicit = await connector.recordOrder({ orderId: "o-2", clickId: plain, amount: 10, currency: "GBP", campaignId: IDS.campaign });
  assert.equal(explicit.order?.campaignId, IDS.campaign);
  const none = await connector.recordOrder({ orderId: "o-3", clickId: plain, amount: 10, currency: "GBP" });
  assert.equal(none.order?.campaignId, null);

  const s = await stats(connector);
  assert.equal(s.by_campaign.find((c) => c.campaign_id === IDS.campaign)?.orders, 2);
});

test("a click that expires between checkout and order isn't credited through the checkout's code", async () => {
  const { connector, clock, state } = await setup();
  (state.config as ConfigFixture).program.cookie_window_days = 14;
  await connector.refreshConfig();
  const clickId = await click(connector, "ANNA10");
  clock.advance(13.9 * DAY);
  const checkout = await connector.recordCheckout({ checkoutId: "c-1", clickId, cartTotal: 50, currency: "GBP" });
  assert.equal(checkout.checkout?.code, "ANNA10");
  assert.equal(checkout.checkout?.typedCode, null);
  clock.advance(0.2 * DAY);
  const order = await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", amount: 50, currency: "GBP" });
  assert.equal(order.status, "not_attributed");
});

test("a code typed at checkout is kept even when a click wins there", async () => {
  const { connector, state } = await setup();
  const clickId = await click(connector, "ANNA10");
  const checkout = await connector.recordCheckout({ checkoutId: "c-1", clickId, code: "ben15", cartTotal: 50, currency: "GBP" });
  assert.equal(checkout.checkout?.affiliateId, IDS.affA);
  assert.equal(checkout.checkout?.typedCode, "ben15");
  (state.config as ConfigFixture).affiliates[0]!.status = "suspended";
  await connector.refreshConfig();
  const order = await connector.recordOrder({ orderId: "o-1", checkoutId: "c-1", amount: 50, currency: "GBP" });
  assert.equal(order.order?.affiliateId, IDS.affB);
  assert.equal(order.order?.attributedVia, "code");

  await connector.recordCheckout({ checkoutId: "c-2", code: "BEN15", cartTotal: 5, currency: "GBP" });
  const kept = await connector.recordCheckout({ checkoutId: "c-2", cartTotal: 6, currency: "GBP" });
  assert.equal(kept.status, "updated");
  assert.equal(kept.checkout?.typedCode, "BEN15");
  const changed = await connector.recordCheckout({ checkoutId: "c-2", code: "OLD5", cartTotal: 6, currency: "GBP" });
  assert.equal(changed.checkout?.typedCode, "OLD5");
});

test("test-mode checkouts are never counted, but still carry the click to a test order", async () => {
  const { connector } = await setup();
  const clickId = await click(connector, "ANNA10");
  await connector.recordCheckout({ checkoutId: "c-test", clickId, cartTotal: 10, currency: "GBP", test: true });
  await connector.recordCheckout({ checkoutId: "c-test-2", clickId, cartTotal: 10, currency: "GBP", test: true });
  await connector.recordCheckout({ checkoutId: "c-real", clickId, cartTotal: 10, currency: "GBP" });
  assert.deepEqual(await connector.recordCheckoutFailed({ checkoutId: "c-test-2" }), { status: "failed" });
  const order = await connector.recordOrder({ orderId: "t-1", checkoutId: "c-test", amount: 10, currency: "GBP", test: true });
  assert.equal(order.order?.clickId, clickId);
  const s = await stats(connector);
  assert.equal(s.totals.checkouts_started, 1);
  assert.equal(s.totals.checkouts_failed, 0);
  assert.equal(s.totals.test_orders, 1);
  assert.equal(s.totals.orders, 0);
});

test("a refund that arrives before its order is applied when the order is recorded", async () => {
  const { connector, clock } = await setup();
  const clickId = await click(connector, "ANNA10");
  assert.deepEqual(await connector.recordRefund({ orderId: "o-early" }), { status: "pending" });
  assert.deepEqual(await connector.recordRefund({ orderId: "o-early" }), { status: "pending" });
  const order = await connector.recordOrder({ orderId: "o-early", clickId, amount: 100, currency: "GBP" });
  assert.ok(order.order?.refundedAt instanceof Date);
  await connector.recordOrder({ orderId: "o-normal", clickId, amount: 40, currency: "GBP" });
  assert.deepEqual(await connector.recordRefund({ orderId: "o-early" }), { status: "already_refunded" });
  const s = await stats(connector);
  assert.equal(s.totals.orders, 2);
  assert.equal(s.totals.refunds, 1);
  assert.equal(s.totals.revenue, 40);

  await connector.recordRefund({ orderId: "o-unattributed" });
  assert.equal((await connector.recordOrder({ orderId: "o-unattributed", amount: 5, currency: "GBP" })).status, "not_attributed");
  assert.deepEqual(await connector.recordRefund({ orderId: "o-stale" }), { status: "pending" });
  clock.advance(31 * DAY);
  await connector.recordRefund({ orderId: "o-other" });
  const late = await connector.recordOrder({ orderId: "o-stale", code: "ANNA10", amount: 9, currency: "GBP" });
  assert.equal(late.order?.refundedAt, null, "pending refunds expire after 30 days");
});

test("links match under a storefront path prefix and with percent-encoded paths", async () => {
  const { connector, store, state } = await setup();
  const config = state.config as ConfigFixture;
  config.program.storefront_url = "https://shop.example/shop/";
  config.links.push({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", affiliate_id: IDS.affA, label: "Café", target_path: "/products/café?size=m" });
  await connector.refreshConfig();
  const prefixed = await store.getClick(await click(connector, "ANNA10", { landing_path: "/shop/products/hoodie/" }));
  assert.equal(prefixed?.linkId, IDS.link);
  const encoded = await store.getClick(await click(connector, "ANNA10", { landing_path: "/shop/products/caf%C3%A9" }));
  assert.equal(encoded?.linkId, "ffffffff-ffff-4fff-8fff-ffffffffffff");
  const unprefixed = await store.getClick(await click(connector, "ANNA10", { landing_path: "/products/hoodie" }));
  assert.equal(unprefixed?.linkId, IDS.link);
  const other = await store.getClick(await click(connector, "ANNA10", { landing_path: "/shop/products/other" }));
  assert.equal(other?.linkId, null);
  const wrongCreator = await store.getClick(await click(connector, "BEN15", { landing_path: "/shop/products/hoodie" }));
  assert.equal(wrongCreator?.linkId, null);
});

test("invalid inputs are rejected", async () => {
  const { connector } = await setup();
  await assert.rejects(connector.recordOrder({ orderId: "", amount: 1, currency: "GBP" }), /orderId/);
  await assert.rejects(connector.recordOrder({ orderId: "o", amount: -1, currency: "GBP" }), /amount/);
  await assert.rejects(connector.recordOrder({ orderId: "o", amount: 1, currency: "pounds" }), /currency/);
  await assert.rejects(connector.recordOrder({ orderId: "o", amount: 1, currency: "GBP", clickId: "x" }), /clickId/);
  await assert.rejects(connector.recordOrder({ orderId: "o", amount: 1, currency: "GBP", occurredAt: "nope" }), /occurredAt/);
});
