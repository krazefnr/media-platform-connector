import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresStore, type PgQueryable } from "../server/index.js";

function fakePool(respond: (text: string, values: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number | null }) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool: PgQueryable = {
    async query(text, values = []) {
      calls.push({ text, values });
      return respond(text, values);
    },
  };
  return { pool, calls };
}

test("postgresStore sends parameterised SQL only", async () => {
  const hostile = "x'); drop table md_orders; --";
  const { pool, calls } = fakePool(() => ({ rows: [], rowCount: 0 }));
  const store = postgresStore({ pool });
  const at = new Date("2026-10-06T12:00:00Z");
  assert.equal(
    await store.insertOrder({
      id: hostile,
      checkoutId: null,
      clickId: null,
      affiliateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      creatorId: null,
      code: hostile,
      campaignId: null,
      linkId: null,
      attributedVia: "code",
      amount: 10,
      currency: "GBP",
      commissionBps: 1000,
      commission: 1,
      productRef: hostile,
      test: false,
      occurredAt: at,
      refundedAt: null,
      createdAt: at,
    }),
    false
  );
  await store.getOrder(hostile);
  await store.markOrderRefunded(hostile, at);
  await store.setCheckoutStatus(hostile, "failed", hostile, at);
  await store.aggregate({ from: at, to: at, abandonedBefore: at, affiliateIds: [hostile] });
  await store.savePendingRefund(hostile, at, at);
  await store.takePendingRefund(hostile);
  await store.getCreatorLinkByUserRef(hostile);
  await store.approveCreatorLink({ creatorId: hostile, userRef: hostile, affiliateIds: [hostile], approvedAt: at });
  await store.deleteCreatorLink(hostile);
  await store.loadConfig(hostile);
  await store.saveConfig(hostile, { config: { hostile }, fetchedAt: at, rejected: hostile });
  for (const call of calls) {
    assert.ok(!call.text.includes(hostile), call.text);
    assert.match(call.text, /\$1/);
  }
  assert.ok(calls.some((c) => c.values.includes(hostile)));
  assert.ok(calls.some((c) => c.values.some((v) => Array.isArray(v) && v.includes(hostile))));
  assert.ok(calls.some((c) => /from md_checkouts/.test(c.text) && /not test/.test(c.text)), "test checkouts are never counted");
});

test("postgresStore maps checkouts, creator links and the stored config", async () => {
  const at = new Date("2026-10-06T12:00:00Z");
  const { pool, calls } = fakePool((text, values) => {
    if (text.startsWith("insert into md_checkouts")) {
      return {
        rows: [
          {
            id: values[0],
            click_id: null,
            affiliate_id: values[2],
            creator_id: null,
            code: "ANNA10",
            typed_code: values[13],
            campaign_id: null,
            link_id: null,
            cart_total: "10.0000",
            currency: "GBP",
            status: "started",
            failure_reason: null,
            test: values[14],
            created_at: at,
            updated_at: at,
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("from md_creator_links")) {
      return {
        rows: [{ creator_id: "11111111-1111-4111-8111-111111111111", user_ref: "user-a", affiliate_ids: "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}", approved_at: at }],
        rowCount: 1,
      };
    }
    if (text.includes("from md_config")) return { rows: [{ config: '{"version":1}', fetched_at: at, rejected: null }], rowCount: 1 };
    if (text.startsWith("insert into md_creator_links")) throw Object.assign(new Error("duplicate key"), { code: "23505" });
    if (text.startsWith("delete from md_pending_refunds")) return { rows: [{ refunded_at: at }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const store = postgresStore({ pool });
  const checkout = await store.upsertCheckout({
    id: "c-1",
    clickId: null,
    affiliateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    creatorId: null,
    code: "ANNA10",
    typedCode: "anna10",
    campaignId: null,
    linkId: null,
    cartTotal: 10,
    currency: "GBP",
    status: "started",
    failureReason: null,
    test: true,
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(checkout.typedCode, "anna10");
  assert.equal(checkout.test, true);
  assert.match(calls[0]!.text, /typed_code = excluded\.typed_code/);

  assert.deepEqual(await store.getCreatorLinkByUserRef("user-a"), {
    creatorId: "11111111-1111-4111-8111-111111111111",
    userRef: "user-a",
    affiliateIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    approvedAt: at,
  });
  assert.equal(
    await store.approveCreatorLink({ creatorId: "x", userRef: "user-a", affiliateIds: [], approvedAt: at }),
    false,
    "a login taken by another creator is a refusal, not an error"
  );
  assert.deepEqual(await store.loadConfig("kraze"), { config: { version: 1 }, fetchedAt: at, rejected: null });
  assert.deepEqual(await store.takePendingRefund("o-1"), at);
});

test("postgresStore maps rows back to records", async () => {
  const { pool } = fakePool((text) => {
    if (text.includes("from md_orders where id")) {
      return {
        rows: [
          {
            id: "1001",
            checkout_id: null,
            click_id: "9b2f7c1e-3d4a-4b5c-8d6e-7f8091a2b3c4",
            affiliate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            creator_id: "11111111-1111-4111-8111-111111111111",
            code: "ANNA10",
            campaign_id: null,
            link_id: null,
            attributed_via: "click",
            amount: "49.9900",
            currency: "GBP",
            commission_bps: 1000,
            commission: "5.0000",
            product_ref: null,
            test: false,
            occurred_at: new Date("2026-10-01T10:00:00Z"),
            refunded_at: null,
            created_at: new Date("2026-10-01T10:00:01Z"),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("from md_orders")) {
      return {
        rows: [
          {
            day: "2026-10-01",
            affiliate_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            creator_id: null,
            code: "ANNA10",
            campaign_id: null,
            link_id: null,
            currency: "GBP",
            test: false,
            orders: 2,
            refunded: 1,
            revenue: 49.99,
            commission: 5,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = postgresStore({ pool });
  const order = await store.getOrder("1001");
  assert.equal(order?.amount, 49.99);
  assert.equal(order?.commission, 5);
  assert.equal(order?.attributedVia, "click");
  assert.equal(order?.refundedAt, null);
  const agg = await store.aggregate({ from: new Date(0), to: new Date(), abandonedBefore: new Date(), affiliateIds: null });
  assert.deepEqual(agg.orders[0], {
    day: "2026-10-01",
    affiliateId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    creatorId: null,
    code: "ANNA10",
    campaignId: null,
    linkId: null,
    currency: "GBP",
    test: false,
    orders: 2,
    refunded: 1,
    revenue: 49.99,
    commission: 5,
  });
});

test("postgresStore explains a missing pg package", async (t) => {
  const specifier = "pg";
  if (await import(specifier).then(() => true, () => false)) {
    t.skip("pg is installed");
    return;
  }
  const store = postgresStore({ connectionString: "postgres://localhost/none" });
  await assert.rejects(store.getOrder("x"), /pg/);
});
