import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { renderRecoveryEmail, shopifyCartToken, shopifyCheckoutInput, shopifyOrderInput, verifyShopifyWebhook } from "../server/index.js";
import { click, configFixture, DASHBOARD, setup, SITE } from "./helpers.js";

const TEMPLATE = {
  enabled: true,
  delay_minutes: 30,
  subject: "{{first_name}}, your {{brand_name}} cart is waiting",
  heading: "Still thinking it over?",
  body: "Hi {{first_name}},\n\nYou left {{cart_total}} of goodies behind.\n\n<script>alert(1)</script>",
  button_label: "Finish checkout",
  footer: "You're getting this because you asked for offers from {{brand_name}}.",
};

type Call = { url: string; headers: Record<string, string>; body: any };

function network(template: unknown = TEMPLATE, status = 200) {
  const calls: Call[] = [];
  const configHeaders: Record<string, string>[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    if (url.startsWith(DASHBOARD)) {
      configHeaders.push(headers);
      return Response.json({ ...configFixture(), recovery_email: template });
    }
    calls.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ id: "email_1" }), { status });
  };
  return { calls, configHeaders, fetchImpl };
}

const recoveryOptions = { resendApiKey: "re_test_123", from: "Kraze <hello@kraze.example>", brandName: "Kraze" };

const withRecovery = (net: ReturnType<typeof network>) =>
  setup({ siteOrigin: SITE, connector: { fetch: net.fetchImpl, recoveryEmails: recoveryOptions } });

test("abandoned checkouts are emailed once through the brand's Resend account, with no consent tick needed, and the address is kept", async () => {
  const net = network();
  const { connector, clock, store } = await withRecovery(net);
  const clickId = await click(connector, "ANNA10");
  await connector.recordCheckout({
    checkoutId: "r-1",
    clickId,
    cartTotal: 49.99,
    currency: "GBP",
    customer: { email: "Jane@Example.com", firstName: "Jane" },
    recoveryUrl: `${SITE}/checkouts/r-1/recover`,
  });
  await connector.recordCheckout({ checkoutId: "no-email", cartTotal: 10, currency: "GBP", recoveryUrl: `${SITE}/r` });

  clock.advance(29 * 60_000);
  assert.deepEqual(await connector.runScheduledTasks(), { abandoned: 0, recovery_emails: 0 }, "the dashboard's 30 minute delay applies");
  clock.advance(2 * 60_000);
  assert.deepEqual(await connector.runScheduledTasks(), { abandoned: 2, recovery_emails: 1 });
  assert.deepEqual(await connector.runScheduledTasks(), { abandoned: 0, recovery_emails: 0 }, "never twice");

  assert.equal(net.calls.length, 1);
  const sent = net.calls[0]!;
  assert.equal(sent.url, "https://api.resend.com/emails");
  assert.equal(sent.headers.authorization, "Bearer re_test_123");
  assert.equal(sent.headers["idempotency-key"], "md-recovery-r-1");
  assert.deepEqual(sent.body.to, ["jane@example.com"]);
  assert.equal(sent.body.subject, "Jane, your Kraze cart is waiting");
  assert.match(sent.body.html, /£49\.99/);
  assert.match(sent.body.html, /href="https:\/\/shop\.example\/checkouts\/r-1\/recover"/);
  assert.ok(!sent.body.html.includes("<script>"), "dashboard wording is escaped, never markup");
  assert.match(sent.body.headers["List-Unsubscribe"], /^<https:\/\/shop\.example\/api\/md\/unsubscribe\?t=[\w-]+\.[\w-]+>$/);
  assert.equal(sent.body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(sent.body.html, />Unsubscribe</);

  const row = await store.getCheckoutWatch("r-1");
  assert.equal(row?.email, "jane@example.com", "the brand keeps the address");
  assert.ok(row?.recoverySentAt);

  await connector.recordOrder({ orderId: "o-r-1", checkoutId: "r-1", clickId, amount: 49.99, currency: "GBP" });
  assert.equal((await store.getCheckoutWatch("r-1"))?.email, "jane@example.com", "still kept after paying");
  const list = await connector.listCheckouts("7d");
  assert.deepEqual(list.recovery, { emails_sent: 1, recovered_orders: 1, recovered_value: 49.99 });
  assert.equal(list.abandon_after_minutes, 30);
  assert.equal(list.recovery_ready, true);
  assert.equal(list.recovery_automatic, true);
});

test("every shopper's address is logged even without recovery emails set up", async () => {
  const net = network();
  const { connector, store, clock } = await setup({ connector: { fetch: net.fetchImpl } });
  await connector.recordCheckout({ checkoutId: "p-1", cartTotal: 5, currency: "GBP", customer: { email: " A@Example.com " }, step: "email" });
  assert.equal((await store.getCheckoutWatch("p-1"))?.email, "a@example.com");
  clock.advance(2 * 60 * 60_000);
  const list = await connector.listCheckouts("7d");
  assert.deepEqual(list.checkouts.map((c) => [c.checkout_id, c.status, c.email]), [["p-1", "abandoned", "a@example.com"]]);
  assert.equal(list.recovery_ready, false);
  assert.equal((await connector.sendRecoveryEmail("p-1")).status, "not_configured");
});

test("with automatic sending off, an admin can still send one email per checkout from the sales screen", async () => {
  const net = network({ ...TEMPLATE, enabled: false });
  const ctx = await withRecovery(net);
  const { connector, clock } = ctx;
  await connector.recordCheckout({ checkoutId: "m-1", cartTotal: 20, currency: "GBP", customer: { email: "m@example.com" }, recoveryUrl: `${SITE}/r` });
  clock.advance(3 * 60 * 60_000);
  assert.equal((await connector.runScheduledTasks()).recovery_emails, 0, "nothing automatic");
  assert.equal(net.calls.length, 0);

  const send = (body: unknown) =>
    connector.handle(
      new Request(`${SITE}/api/md/checkouts/send-recovery`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE },
        body: JSON.stringify(body),
      })
    );
  const first = await send({ checkout_id: "m-1" });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { status: "sent" });
  assert.equal(net.calls.length, 1);
  assert.deepEqual(await (await send({ checkout_id: "m-1" })).json(), { status: "already_sent" });
  assert.equal((await send({ checkout_id: "nope" })).status, 404);

  ctx.state.viewer = { role: "creator", userRef: "user-a" };
  assert.equal((await send({ checkout_id: "m-1" })).status, 403, "creators can't send");
});

test("the unsubscribe link asks first, then suppresses the address for good", async () => {
  const net = network();
  const { connector, clock } = await withRecovery(net);
  await connector.recordCheckout({ checkoutId: "u-1", cartTotal: 5, currency: "GBP", customer: { email: "u@example.com" }, recoveryUrl: `${SITE}/r` });
  clock.advance(31 * 60_000);
  await connector.runScheduledTasks();
  const link = net.calls[0]!.body.headers["List-Unsubscribe"].slice(1, -1) as string;

  const get = await connector.handle(new Request(link));
  assert.equal(get.status, 200);
  assert.match(await get.text(), /<form method="post">/, "a GET (link scanners) only shows a confirm button");
  const post = await connector.handle(new Request(link, { method: "POST", body: "List-Unsubscribe=One-Click" }));
  assert.match(await post.text(), /You're unsubscribed/);

  const forged = await connector.handle(new Request(`${SITE}/api/md/unsubscribe?t=${Buffer.from("x@example.com").toString("base64url")}.AAAA`, { method: "POST" }));
  assert.equal(forged.status, 400);

  await connector.recordCheckout({ checkoutId: "u-2", cartTotal: 5, currency: "GBP", customer: { email: "u@example.com" }, recoveryUrl: `${SITE}/r` });
  clock.advance(31 * 60_000);
  assert.equal((await connector.runScheduledTasks()).recovery_emails, 0);
  assert.equal((await connector.sendRecoveryEmail("u-2")).status, "unsubscribed");
  assert.equal(net.calls.length, 1);
});

test("a paid order from the same address closes the shopper's other open checkouts", async () => {
  const net = network();
  const { connector, store, clock } = await withRecovery(net);
  await connector.recordCheckout({ checkoutId: "cart-a", cartTotal: 30, currency: "GBP", customer: { email: "pay@example.com" }, recoveryUrl: `${SITE}/r` });
  clock.advance(10 * 60_000);
  await connector.recordOrder({ orderId: "o-x", checkoutId: "cart-b", amount: 30, currency: "GBP", customer: { email: "PAY@example.com" } });
  assert.equal((await store.getCheckoutWatch("cart-a"))?.status, "completed");
  clock.advance(60 * 60_000);
  assert.equal((await connector.runScheduledTasks()).recovery_emails, 0, "no reminder for something already bought");
});

test("recovery options are validated", async () => {
  await assert.rejects(setup({ siteOrigin: SITE, connector: { recoveryEmails: { ...recoveryOptions, resendApiKey: "sk_live_x" } } }), /Resend API key/);
  await assert.rejects(setup({ siteOrigin: SITE, connector: { recoveryEmails: { ...recoveryOptions, from: "not an address" } } }), /from must be/);
  await assert.rejects(setup({ connector: { recoveryEmails: recoveryOptions } }), /siteOrigin/);
});

test("cart ids and checkout URLs give the token Shopify's webhooks use", () => {
  assert.equal(shopifyCartToken("gid://shopify/Cart/Z2NwLWV1cm9wZS13ZXN0NDox?key=abc"), "Z2NwLWV1cm9wZS13ZXN0NDox");
  assert.equal(shopifyCartToken("https://kraze.myshopify.com/cart/c/Z2NwLWV1cm9wZS13ZXN0NDox?key=abc"), "Z2NwLWV1cm9wZS13ZXN0NDox");
  assert.equal(shopifyCartToken("nonsense"), null);
});

test("rendered emails fill placeholders and keep a plain-text part", () => {
  const email = renderRecoveryEmail(TEMPLATE, { first_name: "", brand_name: "Kraze", cart_total: "£10.00", creator_name: "" }, "https://shop.example/r");
  assert.equal(email.subject, "Your Kraze cart is waiting");
  assert.match(email.text, /Finish checkout: https:\/\/shop\.example\/r/);
  assert.match(email.html, /Hi,/);
});

test("the connector tells the dashboard which features are set up, by name only", async () => {
  const net = network();
  await setup({
    siteOrigin: SITE,
    connector: {
      fetch: net.fetchImpl,
      recoveryEmails: recoveryOptions,
      conversions: { tiktok: { pixelCode: "C123", accessToken: "t" } },
      installedTools: ["clarity", "tiktok_pixel", "BAD NAME!"],
    },
  });
  assert.equal(net.configHeaders[0]?.["x-md-features"], "connector,conversions.tiktok,recovery.resend,clarity,tiktok_pixel");
});

const shopifyCheckout = {
  token: "chk_tok_1",
  email: "Jane@Example.com",
  buyer_accepts_marketing: true,
  total_price: "49.99",
  currency: "GBP",
  abandoned_checkout_url: "https://shop.example/checkouts/chk_tok_1/recover?key=abc",
  discount_codes: [{ code: "ANNA10" }],
  note_attributes: [
    { name: "md_click", value: "not-a-uuid" },
    { name: "md_vid", value: "99999999-9999-4999-8999-999999999999" },
    { name: "md_fbp", value: "fb.1.1.2" },
    { name: "md_ga", value: "111.222" },
  ],
  customer: { id: 42, first_name: "Jane", last_name: "Doe" },
  shipping_address: { city: "Leeds", zip: "LS1 1AA", country_code: "GB" },
  client_details: { browser_ip: "203.0.113.9", user_agent: "UA" },
  line_items: [{ sku: "HOODIE-M", title: "Hoodie", quantity: 1, price: "49.99" }],
};

test("Shopify webhooks map straight onto the connector's inputs", async () => {
  const input = shopifyCheckoutInput(shopifyCheckout);
  assert.equal(input.checkoutId, "chk_tok_1");
  assert.equal(shopifyCheckoutInput({ ...shopifyCheckout, cart_token: "cart_1" }).checkoutId, "cart_1", "the cart token wins, matching the site's own record");
  assert.equal(shopifyOrderInput({ ...shopifyCheckout, id: 1, cart_token: "cart_1", checkout_token: "chk" }).checkoutId, "cart_1");
  assert.equal(input.clickId, null, "malformed attribute ids are dropped, not passed on");
  assert.equal(input.visitorId, "99999999-9999-4999-8999-999999999999");
  assert.equal(input.code, "ANNA10");
  assert.equal(input.customerRef, "42");
  assert.equal(input.marketingConsent, true);
  assert.equal(input.customer?.email, "Jane@Example.com");
  assert.equal(input.customer?.fbp, "fb.1.1.2");
  assert.equal(input.customer?.gaClientId, "111.222");
  assert.deepEqual(input.items, [{ id: "HOODIE-M", name: "Hoodie", quantity: 1, price: 49.99 }]);

  const order = shopifyOrderInput({ ...shopifyCheckout, id: 9001, checkout_token: "chk_tok_1", current_total_price: "49.99", processed_at: "2026-10-06T12:00:00Z", test: true });
  assert.equal(order.orderId, "9001");
  assert.equal(order.checkoutId, "chk_tok_1");
  assert.equal(order.test, true);

  const { connector } = await setup();
  assert.equal((await connector.recordCheckout(input)).status, "recorded");
  assert.equal((await connector.recordOrder(order)).status, "recorded");
});

test("Shopify webhook signatures are checked against the raw body", () => {
  const raw = JSON.stringify(shopifyCheckout);
  const hmac = createHmac("sha256", "test_secret").update(raw).digest("base64");
  assert.ok(verifyShopifyWebhook(raw, hmac, "test_secret"));
  assert.ok(!verifyShopifyWebhook(raw, hmac, "other"));
  assert.ok(!verifyShopifyWebhook(`${raw} `, hmac, "test_secret"));
  assert.ok(!verifyShopifyWebhook(raw, null, "test_secret"));
});

test("cartAttributes carries the visit and ad cookies to Shopify", async () => {
  const { connector } = await setup();
  const attrs = connector.cartAttributes(
    new Request(`${SITE}/cart`, {
      headers: { cookie: "md_click=11111111-1111-4111-8111-111111111111; md_vid=99999999-9999-4999-8999-999999999999; _fbp=fb.1.1.2; _ga=GA1.1.5.6; md_ttclid=tt1" },
    })
  );
  assert.deepEqual(attrs, [
    { key: "md_click", value: "11111111-1111-4111-8111-111111111111" },
    { key: "md_vid", value: "99999999-9999-4999-8999-999999999999" },
    { key: "md_fbp", value: "fb.1.1.2" },
    { key: "md_ttclid", value: "tt1" },
    { key: "md_ga", value: "5.6" },
  ]);
});
