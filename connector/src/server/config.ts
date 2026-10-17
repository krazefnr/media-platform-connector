import type { KeyObject } from "node:crypto";
import { signBase64 } from "./keys.js";
import type { Store } from "./store.js";
import type {
  AffiliateStatus,
  ConfigAffiliate,
  ConfigCampaign,
  ConfigLink,
  ConfigRejection,
  ProgramConfig,
  ProgramSettings,
  RecoveryEmailTemplate,
} from "./types.js";
import { isUuid } from "./validate.js";

export class ConfigUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigUnavailableError";
  }
}

export function configPath(brand: string): string {
  return `/api/brand/${brand}/config`;
}

/** Protocol A: x-md-signature = base64(Ed25519("{ts}.GET./api/brand/{brand}/config")). */
export function signConfigRequest(key: KeyObject, brand: string, now: Date): Record<string, string> {
  const ts = Math.floor(now.getTime() / 1000).toString();
  return {
    "x-md-timestamp": ts,
    "x-md-signature": signBase64(key, `${ts}.GET.${configPath(brand)}`),
  };
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}

function int(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

const STATUSES: AffiliateStatus[] = ["pending", "active", "suspended"];

function parseProgram(value: unknown): ProgramSettings {
  const p = obj(value);
  if (!p) throw new ConfigUnavailableError("config.program is missing");
  const storefront = str(p.storefront_url, 500);
  const refParam = str(p.ref_param, 32);
  return {
    storefront_url: storefront && /^https?:\/\//i.test(storefront) ? storefront.replace(/\/+$/, "") : null,
    ref_param: refParam && /^[A-Za-z0-9_-]{1,32}$/.test(refParam) ? refParam : "ref",
    cookie_window_days: int(p.cookie_window_days, 1, 365, 30),
    attribution_model: "last_click",
    default_commission_bps: int(p.default_commission_bps, 0, 10000, 0),
    default_customer_discount_bps: int(p.default_customer_discount_bps, 0, 10000, 0),
    allowed_deep_link_domains: Array.isArray(p.allowed_deep_link_domains)
      ? p.allowed_deep_link_domains.filter((d): d is string => typeof d === "string" && d.length <= 253)
      : [],
  };
}

function parseAffiliate(value: unknown, program: ProgramSettings): ConfigAffiliate | null {
  const a = obj(value);
  const c = obj(a?.creator);
  if (!a || !c || !isUuid(a.id) || !isUuid(c.id)) return null;
  const code = str(a.code, 64);
  const username = str(c.username, 200);
  if (!code?.trim() || username === null) return null;
  const status = STATUSES.includes(a.status as AffiliateStatus) ? (a.status as AffiliateStatus) : null;
  if (!status) return null;
  const discount = a.customer_discount_bps;
  return {
    id: a.id.toLowerCase(),
    code: code.trim(),
    status,
    commission_bps: int(a.commission_bps, 0, 10000, program.default_commission_bps),
    customer_discount_bps: typeof discount === "number" ? int(discount, 0, 10000, 0) : null,
    creator: {
      id: c.id.toLowerCase(),
      username,
      display_name: str(c.display_name, 200),
      brand_user_ref: str(c.brand_user_ref, 128) || null,
    },
  };
}

function parseCampaign(value: unknown): ConfigCampaign | null {
  const c = obj(value);
  if (!c || !isUuid(c.id)) return null;
  return {
    id: c.id.toLowerCase(),
    title: str(c.title, 300) ?? "Untitled campaign",
    type: c.type === "live" ? "live" : "video",
    start_date: str(c.start_date, 40),
    end_date: str(c.end_date, 40),
    is_active: c.is_active === true,
  };
}

function parseLink(value: unknown): ConfigLink | null {
  const l = obj(value);
  if (!l || !isUuid(l.id) || !isUuid(l.affiliate_id)) return null;
  const target = str(l.target_path, 500);
  if (target === null) return null;
  return {
    id: l.id.toLowerCase(),
    affiliate_id: l.affiliate_id.toLowerCase(),
    label: str(l.label, 200) ?? "",
    target_path: target,
  };
}

function parseRecovery(value: unknown): RecoveryEmailTemplate | null {
  const r = obj(value);
  if (!r) return null;
  const subject = str(r.subject, 200);
  const body = str(r.body, 4000);
  if (!subject?.trim() || !body?.trim()) return null;
  return {
    enabled: r.enabled === true,
    delay_minutes: int(r.delay_minutes, 5, 10080, 60),
    subject: subject.trim(),
    heading: str(r.heading, 200)?.trim() ?? "",
    body: body.trim(),
    button_label: str(r.button_label, 60)?.trim() || "Finish checkout",
    footer: str(r.footer, 1000)?.trim() ?? "",
  };
}

function list<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.map(parse).filter((item): item is T => item !== null);
}

/** Validates the dashboard's JSON; rows that don't match the protocol are dropped, not trusted. */
export function parseConfig(value: unknown, brand: string): ProgramConfig {
  const root = obj(value);
  if (!root || root.version !== 1) throw new ConfigUnavailableError("config version is not 1");
  if (root.brand !== brand) throw new ConfigUnavailableError("config is for a different brand");
  const program = parseProgram(root.program);
  return {
    version: 1,
    brand,
    generated_at: str(root.generated_at, 40) ?? new Date(0).toISOString(),
    program,
    affiliates: list(root.affiliates, (a) => parseAffiliate(a, program)),
    campaigns: list(root.campaigns, parseCampaign),
    links: list(root.links, parseLink),
    recovery_email: parseRecovery(root.recovery_email),
  };
}

function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Same normalisation as the dashboard: "https://Shop.Example.com/x" -> "shop.example.com", ".example.com" -> "*.example.com". */
export function normalizeDomain(pattern: string): string {
  const d = pattern
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return d.startsWith(".") ? `*${d}` : d;
}

function hostMatches(host: string, pattern: string): boolean {
  return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}

/**
 * Refuses programme settings that would send creator links anywhere but the
 * brand's own storefront: storefront_url must be on one of `origins`, and every
 * allowed deep-link domain must be one the brand declared. With nothing
 * declared, nothing is checked.
 */
export function storefrontCheck(origins: string[], domains: string[]): (config: ProgramConfig) => ConfigRejection | null {
  const declared = domains.map(normalizeDomain).filter(Boolean);
  return (config) => {
    const storefront = config.program.storefront_url;
    if (origins.length && storefront !== null) {
      const origin = originOf(storefront);
      if (!origin || !origins.includes(origin)) return "storefront_url";
    }
    if (declared.length) {
      for (const raw of config.program.allowed_deep_link_domains) {
        const d = normalizeDomain(raw);
        if (!d || declared.includes(d)) continue;
        if (d.startsWith("*.") || !declared.some((p) => hostMatches(d, p))) return "allowed_deep_link_domains";
      }
    }
    return null;
  };
}

const REJECTIONS: ConfigRejection[] = ["storefront_url", "allowed_deep_link_domains"];

type ConfigClientOptions = {
  brand: string;
  dashboardUrl: string;
  key: KeyObject;
  refreshSeconds: number;
  fetch: typeof fetch;
  now: () => Date;
  store: Pick<Store, "loadConfig" | "saveConfig">;
  check: (config: ProgramConfig) => ConfigRejection | null;
  /** Which connector features and site tools are set up, reported with each pull (names only, no data). */
  features?: () => string[];
  /** Setup checks and their state ("ok" | "warn" | "fail"), reported with each pull. Names only. */
  status?: () => Record<string, string>;
};

const REQUEST_TIMEOUT_MS = 8_000;
const STORE_RECHECK_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 15_000;

/**
 * Pulls the programme config on a schedule that ignores traffic (or when the
 * brand's cron calls refresh()) and keeps the last accepted copy in the
 * brand's own store. Request handlers only ever read that copy, so the
 * dashboard can't tell from its pulls when the site is busy.
 */
export class ConfigClient {
  private cached: { config: ProgramConfig; fetchedAt: number } | null = null;
  private rejected: ConfigRejection | null = null;
  private storeCheckedAt = Number.NEGATIVE_INFINITY;
  private storeRead: Promise<void> | null = null;
  private pull: Promise<ProgramConfig> | null = null;
  private ticking: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastError: ConfigUnavailableError | null = null;
  /** Whether this server instance's last pull worked; null before its first pull. */
  reachable: boolean | null = null;

  constructor(private readonly options: ConfigClientOptions) {}

  get loadedAt(): Date | null {
    return this.cached ? new Date(this.cached.fetchedAt) : null;
  }

  /** Why the dashboard's latest config was refused, if it was. */
  get rejection(): ConfigRejection | null {
    return this.rejected;
  }

  /** The last accepted config, from memory or the brand's store. Never contacts the dashboard. */
  async current(): Promise<ProgramConfig> {
    await this.syncFromStore();
    // A scheduled refresh already under way (server start) wasn't caused by this request, so it may be awaited.
    if (!this.cached && this.ticking) await this.ticking;
    if (!this.cached && this.pull) await this.pull.catch(() => null);
    if (this.cached) return this.cached.config;
    throw this.lastError ?? new ConfigUnavailableError("the programme config hasn't been loaded yet");
  }

  /** Pulls the config now. Rejects if the dashboard is unreachable or its settings are refused; the last accepted copy stays in use. */
  refresh(): Promise<ProgramConfig> {
    this.pull ??= this.pullOnce().finally(() => {
      this.pull = null;
    });
    return this.pull;
  }

  /** Background refresh about every refreshSeconds, starting now. The timer never keeps the process alive. */
  start(): void {
    if (this.timer || this.ticking || this.stopped) return;
    // First pull begins immediately, so anything read right after start can await it.
    this.ticking = this.tick().finally(() => {
      this.ticking = null;
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    const timer = setTimeout(() => {
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
      });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private async tick() {
    this.timer = null;
    const interval = this.options.refreshSeconds * 1000;
    let delay = interval * (0.8 + Math.random() * 0.4);
    try {
      await this.syncFromStore(true);
      const age = this.cached ? this.options.now().getTime() - this.cached.fetchedAt : Number.POSITIVE_INFINITY;
      // Another instance or the brand's cron may have pulled already.
      if (age >= interval * 0.75) await this.refresh();
    } catch {
      delay = RETRY_AFTER_FAILURE_MS;
    }
    if (!this.stopped) this.schedule(delay);
  }

  private async syncFromStore(force = false): Promise<void> {
    const { brand, check, now, store } = this.options;
    if (!force && now().getTime() - this.storeCheckedAt < STORE_RECHECK_MS) {
      if (this.storeRead) await this.storeRead;
      return;
    }
    this.storeCheckedAt = now().getTime();
    this.storeRead ??= (async () => {
      try {
        const stored = await store.loadConfig(brand);
        if (!stored) return;
        this.rejected = REJECTIONS.find((r) => r === stored.rejected) ?? null;
        const fetchedAt = stored.fetchedAt?.getTime() ?? null;
        if (stored.config === null || stored.config === undefined || fetchedAt === null) return;
        if (this.cached && this.cached.fetchedAt >= fetchedAt) return;
        const config = parseConfig(stored.config, brand);
        if (!check(config)) this.cached = { config, fetchedAt };
      } catch {
        // Store unreachable or the row unusable: keep what this instance has.
      } finally {
        this.storeRead = null;
      }
    })();
    await this.storeRead;
  }

  private reportHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    const features = this.options.features?.() ?? [];
    if (features.length) out["x-md-features"] = features.join(",").slice(0, 2000);
    const status = Object.entries(this.options.status?.() ?? {})
      .filter(([k, v]) => /^[a-z0-9_.-]{1,40}$/.test(k) && /^(ok|warn|fail)$/.test(v))
      .map(([k, v]) => `${k}=${v}`);
    if (status.length) out["x-md-checks"] = status.join(",").slice(0, 2000);
    return out;
  }

  private async pullOnce(): Promise<ProgramConfig> {
    const { brand, dashboardUrl, key, now, store, check } = this.options;
    await this.syncFromStore(true);
    let config: ProgramConfig;
    try {
      const response = await this.options.fetch(`${dashboardUrl}${configPath(brand)}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...signConfigRequest(key, brand, now()),
          ...this.reportHeaders(),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new ConfigUnavailableError(`dashboard config request failed with HTTP ${response.status}`);
      config = parseConfig(await response.json(), brand);
      this.reachable = true;
    } catch (error) {
      this.reachable = false;
      this.lastError =
        error instanceof ConfigUnavailableError ? error : new ConfigUnavailableError("dashboard is unreachable");
      throw this.lastError;
    }

    const rejection = check(config);
    if (rejection) {
      this.rejected = rejection;
      const kept = this.cached;
      await store.saveConfig(brand, {
        config: kept?.config ?? null,
        fetchedAt: kept ? new Date(kept.fetchedAt) : null,
        rejected: rejection,
      });
      this.lastError = new ConfigUnavailableError(
        `the dashboard's config was refused: its ${rejection} points outside this site's own storefront`
      );
      throw this.lastError;
    }
    const fetchedAt = now();
    this.cached = { config, fetchedAt: fetchedAt.getTime() };
    this.rejected = null;
    this.lastError = null;
    await store.saveConfig(brand, { config, fetchedAt, rejected: null });
    return config;
  }
}
