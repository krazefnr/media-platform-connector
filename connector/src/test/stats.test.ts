import { test } from "node:test";
import assert from "node:assert/strict";
import { adminRequest, approve, click, DAY, IDS, setup, SITE, stats, statsRequest, type ConfigFixture } from "./helpers.js";

async function seed(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  const { connector, clock } = ctx;
  const anna = await click(connector, "ANNA10", { landing_path: "/products/hoodie/" });
  await click(connector, "ANNA10");
  const ben = await click(connector, "BEN15", { campaign: IDS.campaign });
  await connector.recordOrder({ orderId: "a-1", clickId: anna, amount: 100, currency: "GBP" });
  await connector.recordOrder({ orderId: "b-1", clickId: ben, amount: 50, currency: "GBP" });
  clock.advance(DAY);
  await connector.recordOrder({ orderId: "b-2", code: "BEN15", amount: 30, currency: "GBP" });
  return ctx;
}

test("admins see every creator", async () => {
  const { connector } = await seed();
  const s = await stats(connector, "7d");
  assert.equal(s.role, "admin");
  assert.equal(s.linked, true);
  assert.equal(s.currency, "GBP");
  assert.equal(s.totals.clicks, 3);
  assert.equal(s.totals.orders, 3);
  assert.equal(s.totals.revenue, 180);
  assert.equal(s.totals.commission, 22);
  assert.equal(s.totals.conversion_rate, 1);
  assert.deepEqual(
    s.by_creator.map((c) => [c.creator_id, c.username, c.orders]),
    [
      [IDS.creatorA, "anna", 1],
      [IDS.creatorB, "ben", 2],
    ]
  );
  assert.equal(s.by_code.length, 2);
  assert.equal(s.by_link.length, 1);
  assert.equal(s.by_link[0]?.label, "Hoodie");
  assert.equal(s.by_link[0]?.clicks, 1);
  assert.equal(s.by_link[0]?.orders, 1);
  assert.equal(s.by_campaign.find((c) => c.campaign_id === IDS.campaign)?.revenue, 50);
  assert.equal(s.by_campaign.find((c) => c.campaign_id === null)?.title, "No campaign");
  assert.deepEqual(s.share_links, []);
});

test("a creator sees nothing until an admin of the site approves the login the dashboard proposes", async () => {
  const { connector, state } = await seed();
  state.viewer = { role: "creator", userRef: "user-a" };
  const before = await stats(connector, "7d");
  assert.equal(before.linked, false);
  assert.equal(before.link_pending, true);
  assert.equal(before.totals.clicks, 0);
  assert.deepEqual(before.by_creator, []);
  assert.deepEqual(before.by_code, []);
  assert.deepEqual(before.share_links, []);

  state.viewer = { role: "creator", userRef: "nobody-proposed" };
  const unknown = await stats(connector);
  assert.equal(unknown.linked, false);
  assert.equal(unknown.link_pending, false);
});

test("an approved creator only sees rows for their own pinned codes", async () => {
  const { connector, state } = await seed();
  await approve(connector, IDS.creatorA, "user-a");
  await approve(connector, IDS.creatorB, "user-b");
  state.viewer = { role: "creator", userRef: "user-a" };
  const s = await stats(connector, "7d");
  assert.equal(s.role, "creator");
  assert.equal(s.linked, true);
  assert.equal(s.totals.clicks, 2);
  assert.equal(s.totals.orders, 1);
  assert.equal(s.totals.revenue, 100);
  assert.deepEqual(s.by_creator.map((c) => c.creator_id), [IDS.creatorA]);
  assert.deepEqual(s.by_code.map((c) => c.affiliate_id), [IDS.affA]);
  assert.ok(s.by_campaign.every((c) => c.campaign_id !== IDS.campaign));
  assert.equal(s.daily.reduce((sum, d) => sum + d.clicks, 0), 2);
  assert.deepEqual(s.creator_links, [], "creators never get the admin list");

  state.viewer = { role: "creator", userRef: "user-b" };
  const b = await stats(connector, "7d");
  assert.equal(b.totals.orders, 2);
  assert.deepEqual(b.by_creator.map((c) => c.creator_id), [IDS.creatorB]);
  assert.deepEqual(new Set(b.by_code.map((c) => c.code)), new Set(["BEN15", "OLD5"]));
});

test("changing brand_user_ref or moving codes in the dashboard's config changes nothing a creator sees", async () => {
  const { connector, state } = await seed();
  await approve(connector, IDS.creatorA, "user-a");
  const config = state.config as ConfigFixture;

  // The operator points every creator at a login they control, and moves Anna's code to Ben.
  for (const a of config.affiliates) a.creator.brand_user_ref = "operator-sock";
  config.affiliates[0]!.creator = { ...config.affiliates[1]!.creator };
  await connector.refreshConfig();

  state.viewer = { role: "creator", userRef: "operator-sock" };
  const sock = await stats(connector, "7d");
  assert.equal(sock.linked, false);
  assert.equal(sock.totals.orders, 0);

  state.viewer = { role: "creator", userRef: "user-a" };
  const anna = await stats(connector, "7d");
  assert.equal(anna.totals.orders, 1, "Anna's pinned code still counts for Anna");
  assert.equal(anna.totals.revenue, 100);

  // Ben's login is approved by the admin after the move: only the codes shown at approval are pinned.
  const rows = await connector.listCreatorLinks();
  const benRow = rows.find((r) => r.creator_id === IDS.creatorB)!;
  assert.equal(benRow.status, "pending");
  assert.equal(benRow.user_ref, "operator-sock");
  assert.deepEqual(await connector.approveCreatorLink({ creatorId: IDS.creatorB, userRef: "operator-sock", affiliateIds: [IDS.affB] }), {
    status: "approved",
  });
  state.viewer = { role: "creator", userRef: "operator-sock" };
  const ben = await stats(connector, "7d");
  assert.equal(ben.totals.orders, 2);
  assert.equal(ben.totals.revenue, 80, "Anna's moved code isn't included");

  const approvedAnna = (await connector.listCreatorLinks()).find((r) => r.creator_id === IDS.creatorA)!;
  assert.equal(approvedAnna.status, "approved");
  assert.equal(approvedAnna.user_ref, "user-a");
  assert.equal(approvedAnna.dashboard_user_ref, null, "Anna's creator no longer appears in the config");
});

test("one login can't be approved for two creators, and a creator's login can't be swapped without unlinking", async () => {
  const { connector, state } = await seed();
  await approve(connector, IDS.creatorA, "user-a");
  const config = state.config as ConfigFixture;
  config.affiliates[1]!.creator.brand_user_ref = "user-a";
  config.affiliates[2]!.creator.brand_user_ref = "user-a";
  await connector.refreshConfig();
  assert.equal((await connector.listCreatorLinks()).find((r) => r.creator_id === IDS.creatorB)?.status, "blocked");
  assert.deepEqual(await connector.approveCreatorLink({ creatorId: IDS.creatorB, userRef: "user-a" }), { status: "conflict" });

  config.affiliates[0]!.creator.brand_user_ref = "user-z";
  await connector.refreshConfig();
  assert.deepEqual(await connector.approveCreatorLink({ creatorId: IDS.creatorA, userRef: "user-z" }), { status: "conflict" });
  assert.deepEqual(await connector.unlinkCreator(IDS.creatorA), { status: "unlinked" });
  assert.deepEqual(await connector.unlinkCreator(IDS.creatorA), { status: "not_found" });
  assert.deepEqual(await connector.approveCreatorLink({ creatorId: IDS.creatorA, userRef: "user-z" }), { status: "approved" });
  assert.deepEqual(await connector.approveCreatorLink({ creatorId: IDS.creatorB, userRef: "user-q" }), { status: "changed" });
  assert.deepEqual(
    await connector.approveCreatorLink({ creatorId: IDS.creatorB, userRef: "user-a", affiliateIds: [IDS.affA] }),
    { status: "changed" },
    "only codes the dashboard lists for that creator can be pinned"
  );
});

test("new codes are only added to a creator's view when an admin approves them", async () => {
  const { connector, state } = await seed();
  const config = state.config as ConfigFixture;
  config.affiliates[2]!.status = "active";
  await connector.refreshConfig();
  await connector.approveCreatorLink({ creatorId: IDS.creatorB, userRef: "user-b", affiliateIds: [IDS.affB] });
  await connector.recordOrder({ orderId: "old-1", code: "OLD5", amount: 10, currency: "GBP" });
  state.viewer = { role: "creator", userRef: "user-b" };
  assert.equal((await stats(connector, "7d")).totals.orders, 2);

  const row = (await connector.listCreatorLinks()).find((r) => r.creator_id === IDS.creatorB)!;
  assert.deepEqual(row.codes.map((c) => c.code), ["BEN15"]);
  assert.deepEqual(row.dashboard_codes.map((c) => c.code), ["BEN15", "OLD5"]);
  await connector.approveCreatorLink({ creatorId: IDS.creatorB, userRef: "user-b", affiliateIds: row.dashboard_codes.map((c) => c.affiliate_id) });
  assert.equal((await stats(connector, "7d")).totals.orders, 3);
});

test("the approve and unlink routes are for the site's own admins, same-origin JSON only", async () => {
  const { connector, state } = await seed();
  const body = { creator_id: IDS.creatorA, user_ref: "user-a", affiliate_ids: [IDS.affA] };

  state.viewer = { role: "creator", userRef: "user-a" };
  assert.equal((await connector.handle(adminRequest("approve", body))).status, 403);
  state.viewer = null;
  assert.equal((await connector.handle(adminRequest("approve", body))).status, 401);
  state.viewer = { role: "admin" };
  assert.equal((await connector.handle(adminRequest("approve", body, { origin: "https://dash.example" }))).status, 403);
  assert.equal((await connector.handle(adminRequest("approve", body, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await connector.handle(adminRequest("approve", { ...body, creator_id: "x" }))).status, 400);
  const wrongMethod = await connector.handle(new Request(`${SITE}/api/md/creator-links/approve`));
  assert.equal(wrongMethod.status, 405);

  const ok = await connector.handle(adminRequest("approve", body));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "approved" });
  assert.equal((await connector.handle(adminRequest("approve", { ...body, user_ref: "user-z" }))).status, 409);

  const admin = await stats(connector);
  assert.deepEqual(
    admin.creator_links.map((r) => [r.username, r.status, r.user_ref, r.codes.map((c) => c.code)]),
    [
      ["ben", "pending", "user-b", ["BEN15", "OLD5"]],
      ["anna", "approved", "user-a", ["ANNA10"]],
    ]
  );

  state.viewer = { role: "creator", userRef: "user-a" };
  assert.equal((await stats(connector)).totals.orders, 1);
  state.viewer = { role: "admin" };
  assert.equal((await connector.handle(adminRequest("unlink", { creator_id: IDS.creatorA }))).status, 200);
  assert.equal((await connector.handle(adminRequest("unlink", { creator_id: IDS.creatorA }))).status, 404);
  state.viewer = { role: "creator", userRef: "user-a" };
  assert.equal((await stats(connector)).linked, false);
});

test("an approved creator gets share links on the brand's own storefront, never the dashboard's choice of host", async () => {
  const { connector, state } = await seed({ siteOrigin: SITE });
  await approve(connector, IDS.creatorA, "user-a");
  state.viewer = { role: "creator", userRef: "user-a" };
  assert.deepEqual(
    (await stats(connector)).share_links.map((l) => [l.label, l.url]),
    [
      ["Storefront", `${SITE}/?ref=ANNA10`],
      ["Hoodie", `${SITE}/products/hoodie?ref=ANNA10`],
    ]
  );

  const config = state.config as ConfigFixture;
  config.program.storefront_url = `${SITE}/shop`;
  config.program.ref_param = "via";
  await connector.refreshConfig();
  assert.equal((await stats(connector)).share_links[1]?.url, `${SITE}/shop/products/hoodie?via=ANNA10`);

  config.program.storefront_url = "https://go.operator.example";
  await connector.refreshConfig().catch(() => null);
  assert.ok((await stats(connector)).share_links.every((l) => l.url.startsWith(`${SITE}/`)));
});

test("without declared origins, share links use the stats request's own origin", async () => {
  const { connector, state } = await seed();
  await approve(connector, IDS.creatorA, "user-a");
  (state.config as ConfigFixture).program.storefront_url = "https://go.operator.example";
  await connector.refreshConfig();
  state.viewer = { role: "creator", userRef: "user-a" };
  assert.ok((await stats(connector)).share_links.every((l) => l.url.startsWith(`${SITE}/`)));
});

test("stats need a signed-in viewer", async () => {
  const { connector, state } = await seed();
  state.viewer = null;
  const response = await connector.handle(statsRequest());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");

  state.viewer = { role: "creator", userRef: "" };
  assert.equal((await connector.handle(statsRequest())).status, 401);
});

test("stats refuse cross-origin requests", async () => {
  const { connector } = await seed();
  assert.equal((await connector.handle(statsRequest("30d", { origin: "https://evil.example" }))).status, 403);
  assert.equal((await connector.handle(statsRequest("30d", { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await connector.handle(statsRequest("30d", { origin: "null" }))).status, 403);
  const sameOrigin = await connector.handle(statsRequest("30d", { origin: SITE, "sec-fetch-site": "same-origin" }));
  assert.equal(sameOrigin.status, 200);
  assert.equal(sameOrigin.headers.get("cache-control"), "no-store");
});

test("ranges are whole UTC days, zero-filled", async () => {
  const { connector } = await seed();
  assert.equal((await connector.handle(statsRequest("1y"))).status, 400);
  for (const [range, days] of [["7d", 7], ["30d", 30], ["90d", 90]] as const) {
    const s = await stats(connector, range);
    assert.equal(s.range, range);
    assert.equal(s.daily.length, days);
    assert.equal(s.daily.at(-1)?.date, "2026-10-07");
  }
  const week = await stats(connector, "7d");
  assert.deepEqual(week.daily.at(-2), { date: "2026-10-06", clicks: 3, orders: 2, revenue: 150 });
  assert.deepEqual(week.daily.at(-1), { date: "2026-10-07", clicks: 0, orders: 1, revenue: 30 });
  assert.deepEqual(week.daily[0], { date: "2026-10-01", clicks: 0, orders: 0, revenue: 0 });
});

test("revenue stays in the dominant currency; others are listed apart", async () => {
  const { connector } = await setup();
  const id = await click(connector, "ANNA10");
  await connector.recordOrder({ orderId: "1", clickId: id, amount: 10, currency: "GBP" });
  await connector.recordOrder({ orderId: "2", clickId: id, amount: 20, currency: "GBP" });
  await connector.recordOrder({ orderId: "3", clickId: id, amount: 1000, currency: "JPY" });
  const s = await stats(connector);
  assert.equal(s.currency, "GBP");
  assert.equal(s.totals.orders, 3);
  assert.equal(s.totals.revenue, 30);
  assert.deepEqual(s.other_currencies, [{ currency: "JPY", orders: 1, revenue: 1000, commission: 100 }]);
});

test("getStats works server-side with the same filtering", async () => {
  const { connector } = await seed();
  assert.equal((await connector.getStats({ role: "creator", userRef: "user-a" }, "7d")).linked, false);
  await approve(connector, IDS.creatorA, "user-a");
  const s = await connector.getStats({ role: "creator", userRef: "user-a" }, "7d");
  assert.equal(s.totals.orders, 1);
  await assert.rejects(connector.getStats({ role: "creator", userRef: " " }), /viewer/);
});
