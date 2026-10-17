import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { click, configFixture, DASHBOARD, IDS, setup, SITE } from "./helpers.js";

const OWNER_KEY = "correct-horse-battery-staple";
const identity = generateKeyPairSync("ed25519");
const IDENTITY_PUB = Buffer.from(identity.publicKey.export({ type: "spki", format: "pem" }).toString()).toString("base64");

function identityToken(claims: Record<string, unknown> = {}, opts: { kid?: string; key?: typeof identity.privateKey; now?: number } = {}) {
  const iat = Math.floor((opts.now ?? Date.parse("2026-10-06T12:00:00Z")) / 1000);
  const header = { alg: "EdDSA", kid: opts.kid ?? "k1" };
  const payload = { aud: "media-platform:kraze", brand: "kraze", role: "creator", sub: IDS.creatorA, jti: randomUUID(), iat, exp: iat + 120, ...claims };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${input}.${sign(null, Buffer.from(input), opts.key ?? identity.privateKey).toString("base64url")}`;
}

function net() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url === `${DASHBOARD}/api/identity/key`) return Response.json({ keys: [{ kid: "k1", public_key: IDENTITY_PUB }] });
    return Response.json(configFixture());
  };
  return { calls, fetchImpl };
}

async function app() {
  const n = net();
  const ctx = await setup({
    siteOrigin: SITE,
    connector: { getViewer: undefined, access: { ownerKey: OWNER_KEY, ownerName: "Sam" }, brandName: "Kraze", fetch: n.fetchImpl },
  });
  return { ...ctx, net: n };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${SITE}/api/md${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE, ...headers },
    body: JSON.stringify(body),
  });

const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0]!;
const statsAs = async (connector: Awaited<ReturnType<typeof app>>["connector"], cookie: string) =>
  connector.handle(new Request(`${SITE}/api/md/stats?range=7d`, { headers: { cookie } }));

test("the owner key unlocks the full view on this device; a wrong key doesn't", async () => {
  const { connector } = await app();
  assert.equal((await connector.handle(new Request(`${SITE}/api/md/stats`))).status, 401, "nobody is signed in");

  const wrong = await connector.handle(post("/owner/unlock", { key: "not-the-key-at-all" }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const right = await connector.handle(post("/owner/unlock", { key: OWNER_KEY }));
  assert.equal(right.status, 200);
  const setCookie = right.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^md_owner=\d+\.[\w-]+\.[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);

  const stats = await statsAs(connector, cookieOf(right));
  assert.equal(stats.status, 200);
  assert.equal(((await stats.json()) as { role: string }).role, "admin");

  const forged = cookieOf(right).replace(/\.[\w-]+$/, ".AAAA");
  assert.equal((await statsAs(connector, forged)).status, 401, "a tampered cookie is refused");

  const lock = await connector.handle(post("/owner/lock", {}, { cookie: cookieOf(right) }));
  assert.match(lock.headers.get("set-cookie") ?? "", /^md_owner=; Path=\/; Max-Age=0/);

  const cross = await connector.handle(post("/owner/unlock", { key: OWNER_KEY }, { origin: "https://evil.example" }));
  assert.equal(cross.status, 403, "another site can't try keys");
});

test("changing OWNER_KEY signs every remembered device out", async () => {
  const first = await app();
  const unlocked = await first.connector.handle(post("/owner/unlock", { key: OWNER_KEY }));
  const cookie = cookieOf(unlocked);
  const second = await setup({
    siteOrigin: SITE,
    store: first.store,
    connector: { getViewer: undefined, access: { ownerKey: "a-brand-new-owner-key" }, privateKey: first.keys.base64, fetch: first.net.fetchImpl },
  });
  assert.equal((await statsAs(second.connector, cookie)).status, 401);
});

test("key guessing is throttled", async () => {
  const { connector } = await app();
  let limited = 0;
  for (let i = 0; i < 25; i++) {
    const r = await connector.handle(post("/owner/unlock", { key: `guess-number-${i}` }));
    if (r.status === 429) limited += 1;
  }
  assert.ok(limited >= 5, `expected throttling, got ${limited} 429s`);
});

test("an OWNER_KEY that's too short is refused at start-up", async () => {
  await assert.rejects(setup({ connector: { getViewer: undefined, access: { ownerKey: "short" } } }), /at least 12/);
});

test("a creator signs in through the platform; the site checks the signature and uses each token once", async () => {
  const { connector } = await app();
  const token = identityToken();
  const exchange = await connector.handle(post("/session", { token }));
  assert.equal(exchange.status, 200);
  const cookie = cookieOf(exchange);
  assert.match(cookie, /^md_viewer=/);

  const before = (await (await statsAs(connector, cookie)).json()) as { role: string; linked: boolean; link_pending: boolean };
  assert.deepEqual([before.role, before.linked, before.link_pending], ["creator", false, true], "waiting for the owner's approval");

  assert.equal((await connector.handle(post("/session", { token }))).status, 401, "a token works once");

  const ownerCookie = cookieOf(await connector.handle(post("/owner/unlock", { key: OWNER_KEY })));
  const approve = await connector.handle(
    post("/creator-links/approve", { creator_id: IDS.creatorA, user_ref: IDS.creatorA, affiliate_ids: [IDS.affA] }, { cookie: ownerCookie })
  );
  assert.equal(approve.status, 200, "the owner approves the creator on the sales screen");
  await click(connector, "ANNA10");
  const after = (await (await statsAs(connector, cookie)).json()) as { role: string; linked: boolean; totals: { clicks: number } };
  assert.deepEqual([after.role, after.linked, after.totals.clicks], ["creator", true, 1]);
});

test("creator tokens for another brand, signed with another key, expired or malformed are refused", async () => {
  const { connector } = await app();
  const other = generateKeyPairSync("ed25519");
  const cases: Array<[string, string]> = [
    ["other brand", identityToken({ aud: "media-platform:edner", brand: "edner" })],
    ["wrong key", identityToken({}, { key: other.privateKey })],
    ["unknown kid", identityToken({}, { kid: "nope" })],
    ["expired", identityToken({}, { now: Date.parse("2026-10-06T11:00:00Z") })],
    ["not a creator", identityToken({ role: "admin" })],
    ["garbage", "a.b.c"],
  ];
  for (const [name, token] of cases) {
    const r = await connector.handle(post("/session", { token }));
    assert.equal(r.status, 401, name);
  }
});

test("the /media page gives creators the sign-in embed and an unlocked owner the admin panel", async () => {
  const { connector } = await app();
  const creatorPage = connector.mediaPage(new Request(`${SITE}/media`));
  const html = await creatorPage.text();
  assert.match(html, /I'm the owner/);
  assert.match(html, /https:\/\/dash\.example\/embed\?pass=/);
  assert.ok(!html.includes("/enter/admin"), "no admin link without the key");
  const csp = creatorPage.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-src https:\/\/dash\.example/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(creatorPage.headers.get("cache-control"), "no-store");

  const ownerCookie = cookieOf(await connector.handle(post("/owner/unlock", { key: OWNER_KEY })));
  const ownerHtml = await connector.mediaPage(new Request(`${SITE}/media`, { headers: { cookie: ownerCookie } })).text();
  assert.match(ownerHtml, /Owner view, unlocked on this device/);
  const entries = ownerHtml.match(/https:\/\/dash\.example\/enter\/admin\?pass=[\w%.-]+/g) ?? [];
  assert.equal(new Set(entries).size, 2, "the iframe and the new-tab link each get their own single-use pass");
  assert.ok(!ownerHtml.includes(OWNER_KEY), "the key never appears in the page");
});
