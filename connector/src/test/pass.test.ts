import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { createConnector, memoryStore } from "../server/index.js";
import { BRAND, DASHBOARD, decodeJwt, keyPair, setup } from "./helpers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Jose = {
  jwtVerify: (token: string, key: unknown, options: Record<string, unknown>) => Promise<{ payload: Record<string, unknown> }>;
};

async function loadJose(): Promise<Jose | null> {
  const specifier = "jose";
  return (await import(specifier).catch(() => null)) as Jose | null;
}

/** Exactly what the dashboard's verifyBrandPass passes to jose (no clockTolerance). */
const DASHBOARD_CHECKS = {
  algorithms: ["EdDSA"],
  issuer: BRAND,
  audience: "media-dashboard",
  maxTokenAge: 300,
  requiredClaims: ["iat", "exp", "jti"],
};

test("creator passes are EdDSA JWTs the dashboard can verify", async () => {
  const { connector, keys, clock } = await setup();
  const token = connector.mintCreatorPass({ userRef: "user-42", name: "Anna" });
  const { header, payload, signingInput, signature } = decodeJwt(token);
  assert.deepEqual(header, { alg: "EdDSA" });
  assert.ok(verify(null, Buffer.from(signingInput), keys.publicKey, signature));
  const iat = Math.floor(clock.t / 1000) - 30;
  assert.equal(payload.iss, BRAND);
  assert.equal(payload.aud, "media-dashboard");
  assert.equal(payload.role, "creator");
  assert.equal(payload.sub, "user-42");
  assert.equal(payload.name, "Anna");
  assert.match(String(payload.jti), UUID);
  assert.equal(payload.iat, iat);
  assert.equal(payload.exp, iat + 300);

  const other = generateKeyPairSync("ed25519").publicKey;
  assert.ok(!verify(null, Buffer.from(signingInput), other, signature));
  assert.notEqual(decodeJwt(connector.mintCreatorPass({ userRef: "user-42" })).payload.jti, payload.jti);
  assert.equal("name" in decodeJwt(connector.mintCreatorPass({ userRef: "user-42" })).payload, false);
});

test("admin passes carry the admin's id and name", async () => {
  const { connector, keys } = await setup();
  const { payload, signingInput, signature } = decodeJwt(connector.mintAdminPass({ userRef: "admin-7", name: "Sam" }));
  assert.ok(verify(null, Buffer.from(signingInput), keys.publicKey, signature));
  assert.equal(payload.role, "admin");
  assert.equal(payload.sub, "admin-7");
  assert.equal(payload.name, "Sam");
  assert.throws(() => connector.mintAdminPass({ userRef: "admin-7", name: "" }), /name/);
  assert.equal(decodeJwt(connector.mintCreatorPass({})).payload.sub, "", "creators may sign in with their platform login alone");
  assert.throws(() => connector.mintCreatorPass({ userRef: "x".repeat(129) }), /userRef/);
});

test("entry URLs point at the dashboard with the pass encoded", async () => {
  const { connector } = await setup();
  const embed = new URL(connector.creatorEmbedUrl({ userRef: "user-1" }));
  assert.equal(embed.origin + embed.pathname, `${DASHBOARD}/embed`);
  assert.equal(decodeJwt(embed.searchParams.get("pass")!).payload.role, "creator");
  const admin = new URL(connector.adminEntryUrl({ userRef: "admin-1", name: "Sam" }));
  assert.equal(admin.origin + admin.pathname, `${DASHBOARD}/enter/admin`);
  assert.equal(decodeJwt(admin.searchParams.get("pass")!).payload.role, "admin");
});

test("passes verify with jose exactly as the dashboard checks them", async (t) => {
  const jose = await loadJose();
  if (!jose) {
    t.skip("jose is not installed");
    return;
  }
  const keys = keyPair();
  const connector = createConnector({
    brand: BRAND,
    dashboardUrl: DASHBOARD,
    privateKey: keys.base64,
    store: memoryStore(),
    getViewer: async () => null,
    configRefresh: "manual",
  });
  const { payload } = await jose.jwtVerify(connector.mintCreatorPass({ userRef: "user-9", name: "Kim" }), keys.publicKey, DASHBOARD_CHECKS);
  assert.equal(payload.sub, "user-9");
});

test("passes still verify when the brand server's clock runs ahead of the dashboard's", async (t) => {
  const jose = await loadJose();
  if (!jose) {
    t.skip("jose is not installed");
    return;
  }
  const keys = keyPair();
  for (const aheadMs of [300, 2_000, 5_000, 25_000]) {
    const connector = createConnector({
      brand: BRAND,
      dashboardUrl: DASHBOARD,
      privateKey: keys.base64,
      store: memoryStore(),
      getViewer: async () => null,
      configRefresh: "manual",
      now: () => new Date(Date.now() + aheadMs),
    });
    const { payload } = await jose.jwtVerify(connector.mintAdminPass({ userRef: "admin-1", name: "Sam" }), keys.publicKey, DASHBOARD_CHECKS);
    assert.equal(payload.sub, "admin-1", `clock ${aheadMs} ms ahead`);
  }
});

test("the private key is accepted as base64 PEM, PEM, escaped PEM or KeyObject, and must be Ed25519", () => {
  const keys = keyPair();
  const make = (privateKey: Parameters<typeof createConnector>[0]["privateKey"]) =>
    createConnector({ brand: BRAND, dashboardUrl: DASHBOARD, privateKey, store: memoryStore(), getViewer: async () => null, configRefresh: "manual" });
  for (const form of [keys.base64, keys.pem, keys.pem.replace(/\n/g, "\\n"), keys.privateKey]) {
    const { signingInput, signature } = decodeJwt(make(form).mintCreatorPass({ userRef: "u" }));
    assert.ok(verify(null, Buffer.from(signingInput), keys.publicKey, signature));
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(() => make(rsa), /Ed25519/);
  assert.throws(() => make(""), /empty/);
  assert.throws(
    () => make("bm90IGEga2V5"),
    (error: Error) => /could not be parsed/.test(error.message) && !error.message.includes("bm90IGEga2V5")
  );
});
