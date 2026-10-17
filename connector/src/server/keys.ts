import { createHash, createHmac, createPrivateKey, KeyObject, randomUUID, sign } from "node:crypto";

/** Accepts a KeyObject, a PEM (literal "\n" allowed), base64 of a PEM, or base64 of PKCS8 DER. */
export function loadPrivateKey(input: string | KeyObject): KeyObject {
  let key: KeyObject;
  if (input instanceof KeyObject) {
    key = input;
  } else {
    const raw = typeof input === "string" ? input.trim() : "";
    if (!raw) throw new Error("privateKey is empty. Set MEDIA_DASHBOARD_PRIVATE_KEY.");
    try {
      if (raw.includes("BEGIN")) {
        key = createPrivateKey(raw.replace(/\\n/g, "\n"));
      } else {
        const bytes = Buffer.from(raw, "base64");
        const text = bytes.toString("utf8");
        key = text.includes("BEGIN")
          ? createPrivateKey(text)
          : createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
      }
    } catch {
      throw new Error("privateKey could not be parsed. Expected base64 of a PKCS8 PEM (MEDIA_DASHBOARD_PRIVATE_KEY).");
    }
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("privateKey must be an Ed25519 private key.");
  }
  return key;
}

export function signBase64(key: KeyObject, data: string): string {
  return sign(null, Buffer.from(data, "utf8"), key).toString("base64");
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

export const PASS_AUDIENCE = "media-dashboard";
export const PASS_TTL_SECONDS = 300;

export type PassClaims = {
  brand: string;
  role: "creator" | "admin";
  sub: string;
  name?: string | null;
  now: Date;
};

/** Dated back so a dashboard clock slightly behind this server's never sees an "iat" in the future. */
export const PASS_IAT_BACKDATE_SECONDS = 30;

/** EdDSA JWT accepted by the dashboard's /embed and /enter/admin. Single use, 5 minutes. */
export function mintPassToken(key: KeyObject, claims: PassClaims): string {
  const iat = Math.floor(claims.now.getTime() / 1000) - PASS_IAT_BACKDATE_SECONDS;
  const payload = {
    role: claims.role,
    ...(claims.name ? { name: claims.name } : {}),
    iss: claims.brand,
    aud: PASS_AUDIENCE,
    sub: claims.sub,
    jti: randomUUID(),
    iat,
    exp: iat + PASS_TTL_SECONDS,
  };
  const input = `${base64url(JSON.stringify({ alg: "EdDSA" }))}.${base64url(JSON.stringify(payload))}`;
  return `${input}.${base64url(sign(null, Buffer.from(input, "utf8"), key))}`;
}

/**
 * Keyed by the private key so hashes are stable across restarts and instances,
 * but can't be reversed or matched by anyone without that key.
 */
export function createIpHasher(key: KeyObject): (ip: string) => string {
  const der = key.export({ format: "der", type: "pkcs8" });
  const secret = createHash("sha256").update("md-ip-salt:v1:").update(der).digest();
  return (ip) => createHmac("sha256", secret).update(ip.trim().toLowerCase()).digest("hex").slice(0, 32);
}
