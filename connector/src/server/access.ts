import { createHash, createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { TokenBucket } from "./rate-limit.js";
import type { Store } from "./store.js";
import type { Viewer } from "./types.js";

/*
 * Who may see this site's data, decided by this site alone:
 * - The OWNER proves it with OWNER_KEY, which lives only in this site's own
 *   environment and is typed only into this site's own pages. The media
 *   platform never sees it, so nothing it does can open the owner's view.
 *   Once unlocked, the device is remembered (a signed, httpOnly cookie).
 * - A CREATOR signs in inside the media platform's iframe. The platform hands
 *   this page a short-lived token naming the creator, signed with its own key;
 *   this site checks the signature, uses the token once, and remembers the
 *   creator for the session. A creator only ever sees their own numbers, and
 *   only once the owner has approved them on the sales screen.
 */

export type AccessOptions = {
  /** OWNER_KEY. At least 12 characters; a long random one is best. */
  ownerKey: string;
  /** Shown in the platform's admin panel. Default "Owner". */
  ownerName?: string;
  /** How long an unlocked device stays unlocked. Default 30. */
  rememberDays?: number;
  /** Where the platform publishes the public key creator tokens are signed with. Default {dashboardUrl}/api/identity/key. */
  identityKeyUrl?: string;
};

export const OWNER_COOKIE = "md_owner";
export const VIEWER_COOKIE = "md_viewer";
const CREATOR_SESSION_SECONDS = 12 * 3600;
const KEY_CACHE_MS = 10 * 60_000;
const MAX_TOKEN = 4000;

const b64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export type IdentityClaims = { sub: string; name: string | null; jti: string; exp: number };

export type Access = {
  /** The viewer this request's cookies prove, or null. */
  viewer(request: Request): Viewer | null;
  isOwner(request: Request): boolean;
  /** Checks a typed key. Returns the Set-Cookie value on success. */
  unlock(key: unknown, secure: boolean, now: Date): { ok: true; cookie: string } | { ok: false; reason: "wrong_key" | "rate_limited" };
  lockCookie(secure: boolean): string;
  /** Verifies and uses a creator token from the platform. Returns the Set-Cookie value. */
  exchange(token: unknown, secure: boolean, now: Date): Promise<{ ok: true; cookie: string; creatorId: string } | { ok: false; reason: string }>;
  readonly ownerName: string;
};

export function createAccess(
  options: AccessOptions,
  deps: { key: KeyObject; brand: string; dashboardUrl: string; fetch: typeof fetch; store: Store; now: () => Date }
): Access {
  const ownerKey = typeof options.ownerKey === "string" ? options.ownerKey : "";
  if (ownerKey.length < 12) throw new Error("OWNER_KEY must be at least 12 characters.");
  const rememberSeconds = Math.round(Math.max(1, Math.min(365, options.rememberDays ?? 30)) * 86_400);
  const der = deps.key.export({ format: "der", type: "pkcs8" });
  const macKey = createHash("sha256").update("md-access:v1:").update(der).digest();
  const mac = (data: string) => createHmac("sha256", macKey).update(data).digest("base64url").slice(0, 43);
  // Changing OWNER_KEY in the site's environment signs every remembered device out.
  const keyFingerprint = createHash("sha256").update(`md-owner-key:${ownerKey}`).digest("base64url").slice(0, 16);
  const ownerKeyHash = createHash("sha256").update(ownerKey).digest();
  // One bucket for the whole site: proxies can hide the visitor's IP, and a long key can't be guessed anyway.
  const attempts = new TokenBucket(20, 1 / 30);
  const audience = `media-platform:${deps.brand}`;
  const keyUrl = options.identityKeyUrl ?? `${deps.dashboardUrl}/api/identity/key`;
  let keys: { at: number; byKid: Map<string, KeyObject> } | null = null;

  const cookie = (name: string, value: string, maxAge: number, secure: boolean) =>
    [`${name}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax", ...(secure ? ["Secure"] : [])].join("; ");

  function ownerToken(exp: number) {
    const body = `${exp}.${keyFingerprint}`;
    return `${body}.${mac(`owner.${body}`)}`;
  }

  function validOwner(value: string | null, nowSec: number): boolean {
    const [exp, fp, sig] = (value ?? "").split(".");
    if (!exp || !fp || !sig || fp !== keyFingerprint || Number(exp) < nowSec) return false;
    const expected = Buffer.from(mac(`owner.${exp}.${fp}`));
    const given = Buffer.from(sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  function creatorFrom(value: string | null, nowSec: number): string | null {
    const [exp, id, sig] = (value ?? "").split(".");
    if (!exp || !id || !sig || Number(exp) < nowSec) return null;
    const expected = Buffer.from(mac(`creator.${exp}.${id}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const creatorId = Buffer.from(id, "base64url").toString("utf8");
    return /^[0-9a-f-]{36}$/i.test(creatorId) ? creatorId.toLowerCase() : null;
  }

  async function loadKeys(force: boolean): Promise<Map<string, KeyObject>> {
    if (keys && !force && deps.now().getTime() - keys.at < KEY_CACHE_MS) return keys.byKid;
    const response = await deps.fetch(keyUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`identity key request failed with ${response.status}`);
    const body = (await response.json()) as { keys?: Array<{ kid?: unknown; public_key?: unknown }> };
    const byKid = new Map<string, KeyObject>();
    for (const k of body.keys ?? []) {
      if (typeof k.kid !== "string" || typeof k.public_key !== "string") continue;
      try {
        const pem = Buffer.from(k.public_key, "base64").toString("utf8");
        const key = createPublicKey(pem.includes("BEGIN") ? pem : k.public_key);
        if (key.asymmetricKeyType === "ed25519") byKid.set(k.kid, key);
      } catch {
        // A key that doesn't parse is skipped, never trusted.
      }
    }
    keys = { at: deps.now().getTime(), byKid };
    return byKid;
  }

  async function verifyIdentity(token: string, nowSec: number): Promise<IdentityClaims | null> {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (header.alg !== "EdDSA" || typeof header.kid !== "string") return null;
    let byKid = await loadKeys(false);
    if (!byKid.has(header.kid)) byKid = await loadKeys(true);
    const key = byKid.get(header.kid);
    if (!key) return null;
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, "base64url"));
    if (!ok) return null;
    const exp = Number(payload.exp);
    const iat = Number(payload.iat);
    if (payload.aud !== audience || payload.brand !== deps.brand || payload.role !== "creator") return null;
    if (!Number.isFinite(exp) || exp < nowSec || !Number.isFinite(iat) || iat > nowSec + 60 || exp - iat > 600) return null;
    if (typeof payload.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(payload.sub)) return null;
    if (typeof payload.jti !== "string" || payload.jti.length < 8 || payload.jti.length > 128) return null;
    return {
      sub: payload.sub.toLowerCase(),
      name: typeof payload.name === "string" ? payload.name.slice(0, 80) : null,
      jti: payload.jti,
      exp,
    };
  }

  const nowSec = () => Math.floor(deps.now().getTime() / 1000);

  return {
    ownerName: (options.ownerName ?? "").trim().slice(0, 80) || "Owner",
    isOwner(request) {
      return validOwner(cookieValue(request.headers.get("cookie"), OWNER_COOKIE), nowSec());
    },
    viewer(request) {
      const header = request.headers.get("cookie");
      const at = nowSec();
      if (validOwner(cookieValue(header, OWNER_COOKIE), at)) return { role: "admin" };
      const creatorId = creatorFrom(cookieValue(header, VIEWER_COOKIE), at);
      return creatorId ? { role: "creator", userRef: creatorId } : null;
    },
    unlock(key, secure, now) {
      if (!attempts.take("owner", now.getTime())) return { ok: false, reason: "rate_limited" };
      const typed = typeof key === "string" ? key.trim() : "";
      const typedHash = createHash("sha256").update(typed).digest();
      if (!typed || typed.length > 512 || !timingSafeEqual(typedHash, ownerKeyHash)) return { ok: false, reason: "wrong_key" };
      const exp = Math.floor(now.getTime() / 1000) + rememberSeconds;
      return { ok: true, cookie: cookie(OWNER_COOKIE, ownerToken(exp), rememberSeconds, secure) };
    },
    lockCookie(secure) {
      return cookie(OWNER_COOKIE, "", 0, secure);
    },
    async exchange(token, secure, now) {
      if (typeof token !== "string" || !token || token.length > MAX_TOKEN) return { ok: false, reason: "invalid_token" };
      let claims: IdentityClaims | null;
      try {
        claims = await verifyIdentity(token, Math.floor(now.getTime() / 1000));
      } catch {
        return { ok: false, reason: "identity_unavailable" };
      }
      if (!claims) return { ok: false, reason: "invalid_token" };
      if (!(await deps.store.useTokenOnce(`identity:${claims.jti}`, new Date(claims.exp * 1000), now))) {
        return { ok: false, reason: "token_used" };
      }
      const exp = Math.floor(now.getTime() / 1000) + CREATOR_SESSION_SECONDS;
      const id = b64url(claims.sub);
      const value = `${exp}.${id}.${mac(`creator.${exp}.${id}`)}`;
      return { ok: true, cookie: cookie(VIEWER_COOKIE, value, CREATOR_SESSION_SECONDS, secure), creatorId: claims.sub };
    },
  };
}
