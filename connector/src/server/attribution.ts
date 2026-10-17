import type { ClickRecord } from "./store.js";
import type { ConfigAffiliate, ConfigLink, ProgramConfig } from "./types.js";
import { round2 } from "./validate.js";

const DAY_MS = 86_400_000;
/** Allows for small clock differences between the click server and the order's processor. */
const CLOCK_SKEW_MS = 5 * 60_000;

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

export function findAffiliateByCode(config: ProgramConfig, code: string | null | undefined): ConfigAffiliate | null {
  if (!code) return null;
  const wanted = normalizeCode(code);
  if (!wanted) return null;
  return config.affiliates.find((a) => normalizeCode(a.code) === wanted) ?? null;
}

export function activeAffiliate(config: ProgramConfig, affiliateId: string): ConfigAffiliate | null {
  return config.affiliates.find((a) => a.id === affiliateId && a.status === "active") ?? null;
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function safeDecodeURI(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function storefrontPrefix(config: ProgramConfig): string {
  if (!config.program.storefront_url) return "";
  try {
    return new URL(config.program.storefront_url).pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * The creator deep link whose target path is the page the visitor landed on.
 * Links are {storefront_url}{target_path}, so a storefront path prefix is
 * removed from the landing path, and both sides are compared percent-decoded.
 */
export function matchLink(config: ProgramConfig, affiliateId: string, landingPath: string | null): ConfigLink | null {
  if (!landingPath) return null;
  const prefix = storefrontPrefix(config);
  const candidates = new Set([trimSlash(safeDecodeURI(landingPath))]);
  if (prefix && (landingPath === prefix || landingPath.startsWith(`${prefix}/`))) {
    candidates.add(trimSlash(safeDecodeURI(landingPath.slice(prefix.length) || "/")));
  }
  return (
    config.links.find((l) => {
      if (l.affiliate_id !== affiliateId) return false;
      return candidates.has(trimSlash(safeDecodeURI(l.target_path.split(/[?#]/, 1)[0] ?? "")));
    }) ?? null
  );
}

/** The affiliate a click can still be credited to at `at`, or null. */
export function eligibleClickAffiliate(config: ProgramConfig, click: ClickRecord, at: Date): ConfigAffiliate | null {
  const age = at.getTime() - click.createdAt.getTime();
  if (age < -CLOCK_SKEW_MS) return null;
  if (age > config.program.cookie_window_days * DAY_MS) return null;
  return activeAffiliate(config, click.affiliateId);
}

export type Attribution =
  | { via: "click"; affiliate: ConfigAffiliate; click: ClickRecord }
  | { via: "code"; affiliate: ConfigAffiliate; click: null };

/**
 * Last click wins: of the candidate clicks still inside the cookie window whose
 * affiliate is active, the most recent one is credited. With no such click, an
 * active affiliate code typed at checkout is the fallback.
 */
export function attribute(
  config: ProgramConfig,
  clicks: Array<ClickRecord | null | undefined>,
  code: string | null | undefined,
  at: Date
): Attribution | null {
  let best: { affiliate: ConfigAffiliate; click: ClickRecord } | null = null;
  for (const click of clicks) {
    if (!click) continue;
    const affiliate = eligibleClickAffiliate(config, click, at);
    if (!affiliate) continue;
    if (!best || click.createdAt.getTime() > best.click.createdAt.getTime()) best = { affiliate, click };
  }
  if (best) return { via: "click", ...best };
  const byCode = findAffiliateByCode(config, code);
  if (byCode && byCode.status === "active") return { via: "code", affiliate: byCode, click: null };
  return null;
}

export function commissionFor(amount: number, bps: number): number {
  return round2((amount * bps) / 10_000);
}
