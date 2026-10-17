import { round2 } from "./validate.js";

/*
 * Multi-touch attribution. The tracker records a "touch" whenever a visitor
 * lands with a marketing signal (UTM tags, an ad click id, a creator code or an
 * outside referrer). When an order is recorded, the visitor's touches before it
 * become the order's journey, and the report splits each order's revenue across
 * its touches under several models. Visits with no signal are "direct".
 */

export type Channel =
  | "creator"
  | "paid_social"
  | "paid_search"
  | "organic_social"
  | "organic_search"
  | "email"
  | "sms"
  | "affiliate"
  | "referral"
  | "display"
  | "other"
  | "direct";

export const CHANNEL_LABEL: Record<Channel, string> = {
  creator: "Creator links",
  paid_social: "Paid social",
  paid_search: "Paid search",
  organic_social: "Organic social",
  organic_search: "Organic search",
  email: "Email",
  sms: "SMS",
  affiliate: "Other affiliates",
  referral: "Referral sites",
  display: "Display ads",
  other: "Other tagged",
  direct: "Direct / unknown",
};

export type TouchSignals = {
  ref: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  gclid: boolean;
  fbclid: boolean;
  ttclid: boolean;
  msclkid: boolean;
  referrerHost: string | null;
};

export type TouchRecord = {
  id: string;
  visitorId: string;
  channel: Channel;
  /** e.g. "tiktok", "google", "klaviyo", a referrer host, or the creator code. */
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  refCode: string | null;
  landingPath: string | null;
  createdAt: Date;
};

export type JourneyTouch = {
  channel: Channel;
  source: string | null;
  campaign: string | null;
  refCode: string | null;
  at: Date;
};

export type JourneyRecord = {
  orderId: string;
  visitorId: string | null;
  amount: number;
  currency: string;
  test: boolean;
  occurredAt: Date;
  refundedAt: Date | null;
  /** Oldest first, at most MAX_JOURNEY_TOUCHES. Empty = direct. */
  touches: JourneyTouch[];
};

export const MAX_JOURNEY_TOUCHES = 50;
export const TOUCH_DEDUPE_MS = 30 * 60_000;

const SEARCH = ["google.", "bing.com", "duckduckgo.com", "yahoo.", "ecosia.org", "baidu.com", "yandex.", "search.brave.com"];
const SOCIAL: Record<string, string> = {
  "tiktok.com": "tiktok",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "instagram.com": "instagram",
  "t.co": "x",
  "twitter.com": "x",
  "x.com": "x",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "reddit.com": "reddit",
  "pinterest.com": "pinterest",
  "pin.it": "pinterest",
  "snapchat.com": "snapchat",
  "linkedin.com": "linkedin",
  "lnkd.in": "linkedin",
  "threads.net": "threads",
  "twitch.tv": "twitch",
  "discord.com": "discord",
};
const SOCIAL_SOURCES = new Set([...Object.values(SOCIAL), "fb", "ig", "meta", "tt", "twitter", "yt"]);
const PAID_MEDIUMS = /^(cpc|ppc|paid|paidsocial|paid_social|paid-social|cpm|cpv|cpa|ad|ads|paidsearch|paid_search|sem)$/;

function socialName(host: string): string | null {
  for (const [domain, name] of Object.entries(SOCIAL)) {
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  }
  return null;
}

function searchName(host: string): string | null {
  const hit = SEARCH.find((s) => host.includes(s));
  return hit ? hit.replace(/^search\./, "").split(".")[0]! : null;
}

/** Decides a touch's channel and source from what the landing URL and referrer carried. */
export function classifyTouch(s: TouchSignals): { channel: Channel; source: string | null; medium: string | null } | null {
  const source = s.utmSource?.toLowerCase() ?? null;
  const medium = s.utmMedium?.toLowerCase() ?? null;
  const ref = s.referrerHost;
  if (s.ref) return { channel: "creator", source: s.ref, medium: medium ?? "creator" };
  const paid = medium !== null && PAID_MEDIUMS.test(medium);
  if (s.gclid || s.msclkid) return { channel: "paid_search", source: source ?? (s.gclid ? "google" : "bing"), medium: medium ?? "cpc" };
  if (s.ttclid) return { channel: "paid_social", source: source ?? "tiktok", medium: medium ?? "paid" };
  if (medium === "email") return { channel: "email", source, medium };
  if (medium === "sms" || medium === "text") return { channel: "sms", source, medium };
  if (medium === "affiliate" || medium === "partner") return { channel: "affiliate", source, medium };
  if (medium === "display" || medium === "banner") return { channel: "display", source, medium };
  if (paid) {
    const social = source !== null && SOCIAL_SOURCES.has(source);
    const search = source !== null && /google|bing|microsoft|yahoo/.test(source);
    return { channel: social ? "paid_social" : search ? "paid_search" : "other", source, medium };
  }
  // Meta adds fbclid to organic shares as well as ads, so on its own it means organic.
  if (s.fbclid) return { channel: "organic_social", source: source ?? "facebook", medium: medium ?? "social" };
  if (source || medium) {
    if (medium === "social" || medium === "organic_social" || (source && SOCIAL_SOURCES.has(source))) {
      return { channel: "organic_social", source, medium };
    }
    if (medium === "organic") return { channel: "organic_search", source, medium };
    if (medium === "referral") return { channel: "referral", source, medium };
    return { channel: "other", source, medium };
  }
  if (ref) {
    const social = socialName(ref);
    if (social) return { channel: "organic_social", source: social, medium: "referral" };
    const search = searchName(ref);
    if (search) return { channel: "organic_search", source: search, medium: "organic" };
    return { channel: "referral", source: ref, medium: "referral" };
  }
  return null;
}

export type AttributionModel = "first_touch" | "last_touch" | "linear" | "position_based" | "time_decay";
export const ATTRIBUTION_MODELS: AttributionModel[] = ["first_touch", "last_touch", "linear", "position_based", "time_decay"];

/** How much of one order each touch earns under a model. Weights sum to 1. */
export function touchWeights(touches: JourneyTouch[], model: AttributionModel, at: Date): number[] {
  const n = touches.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  switch (model) {
    case "first_touch":
      return touches.map((_, i) => (i === 0 ? 1 : 0));
    case "last_touch":
      return touches.map((_, i) => (i === n - 1 ? 1 : 0));
    case "linear":
      return touches.map(() => 1 / n);
    case "position_based": {
      // 40% first, 40% last, 20% shared by the middle (50/50 with two touches).
      if (n === 2) return [0.5, 0.5];
      const middle = 0.2 / (n - 2);
      return touches.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : middle));
    }
    case "time_decay": {
      // Half-life of 7 days before the order.
      const raw = touches.map((t) => Math.pow(0.5, Math.max(0, at.getTime() - t.at.getTime()) / (7 * 86_400_000)));
      const sum = raw.reduce((a, b) => a + b, 0);
      return raw.map((w) => w / sum);
    }
  }
}

export type ChannelRow = { channel: Channel; label: string; source: string | null; conversions: number; revenue: number };
export type PathRow = { path: Channel[]; orders: number; revenue: number };
export type CreatorAssistRow = { code: string; first_touch: number; last_touch: number; assisted: number; assisted_revenue: number };

export type AttributionReport = {
  range: string;
  generated_at: string;
  currency: string | null;
  orders: number;
  revenue: number;
  /** Orders with at least one touch. */
  tracked_orders: number;
  avg_touches: number;
  /** From the first touch to the order, for tracked orders. */
  avg_days_to_convert: number | null;
  /** Rows per model, keyed by channel and source, largest revenue first. */
  models: Record<AttributionModel, ChannelRow[]>;
  /** The same, rolled up by channel only. */
  channels: Record<AttributionModel, ChannelRow[]>;
  /** Most common channel sequences. */
  top_paths: PathRow[];
  /** Last-touch revenue per utm_campaign. */
  campaigns: { campaign: string; orders: number; revenue: number }[];
  /** How often each creator code opened, closed or assisted a sale. */
  creator_assists: CreatorAssistRow[];
};

function sortRows<T extends { revenue: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.revenue - a.revenue);
}

/** Builds the attribution report from journeys in one currency (the one with most orders). */
export function buildAttribution(journeys: JourneyRecord[], range: string, now: Date): AttributionReport {
  const counted = journeys.filter((j) => !j.test && !j.refundedAt);
  const byCurrency = new Map<string, number>();
  for (const j of counted) byCurrency.set(j.currency, (byCurrency.get(j.currency) ?? 0) + 1);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const list = counted.filter((j) => j.currency === currency);

  const models = {} as Record<AttributionModel, ChannelRow[]>;
  const channels = {} as Record<AttributionModel, ChannelRow[]>;
  for (const model of ATTRIBUTION_MODELS) {
    const rows = new Map<string, ChannelRow>();
    const rollup = new Map<Channel, ChannelRow>();
    const add = (channel: Channel, source: string | null, share: number, revenue: number) => {
      const k = `${channel}|${source ?? ""}`;
      const row = rows.get(k) ?? { channel, label: CHANNEL_LABEL[channel], source, conversions: 0, revenue: 0 };
      row.conversions += share;
      row.revenue += revenue;
      rows.set(k, row);
      const r = rollup.get(channel) ?? { channel, label: CHANNEL_LABEL[channel], source: null, conversions: 0, revenue: 0 };
      r.conversions += share;
      r.revenue += revenue;
      rollup.set(channel, r);
    };
    for (const j of list) {
      if (!j.touches.length) {
        add("direct", null, 1, j.amount);
        continue;
      }
      const weights = touchWeights(j.touches, model, j.occurredAt);
      j.touches.forEach((t, i) => {
        const w = weights[i]!;
        if (w > 0) add(t.channel, t.source, w, j.amount * w);
      });
    }
    const finish = (r: ChannelRow) => ({ ...r, conversions: round2(r.conversions), revenue: round2(r.revenue) });
    models[model] = sortRows([...rows.values()].map(finish));
    channels[model] = sortRows([...rollup.values()].map(finish));
  }

  const paths = new Map<string, PathRow>();
  const campaigns = new Map<string, { campaign: string; orders: number; revenue: number }>();
  const assists = new Map<string, CreatorAssistRow>();
  let touchTotal = 0;
  let tracked = 0;
  let daysTotal = 0;
  for (const j of list) {
    const path: Channel[] = [];
    for (const t of j.touches) if (path.at(-1) !== t.channel) path.push(t.channel);
    const key = (path.length ? path : ["direct" as Channel]).join(">");
    const p = paths.get(key) ?? { path: path.length ? path : ["direct"], orders: 0, revenue: 0 };
    p.orders += 1;
    p.revenue += j.amount;
    paths.set(key, p);
    if (!j.touches.length) continue;
    tracked += 1;
    touchTotal += j.touches.length;
    daysTotal += (j.occurredAt.getTime() - j.touches[0]!.at.getTime()) / 86_400_000;
    const last = j.touches.at(-1)!;
    if (last.campaign) {
      const c = campaigns.get(last.campaign) ?? { campaign: last.campaign, orders: 0, revenue: 0 };
      c.orders += 1;
      c.revenue += j.amount;
      campaigns.set(last.campaign, c);
    }
    const codes = new Set(j.touches.map((t) => t.refCode).filter((c): c is string => !!c));
    for (const code of codes) {
      const a = assists.get(code) ?? { code, first_touch: 0, last_touch: 0, assisted: 0, assisted_revenue: 0 };
      const first = j.touches[0]!.refCode === code;
      const closed = last.refCode === code;
      if (first) a.first_touch += 1;
      if (closed) a.last_touch += 1;
      if (!closed) {
        a.assisted += 1;
        a.assisted_revenue += j.amount;
      }
      assists.set(code, a);
    }
  }

  const revenue = list.reduce((sum, j) => sum + j.amount, 0);
  return {
    range,
    generated_at: now.toISOString(),
    currency,
    orders: list.length,
    revenue: round2(revenue),
    tracked_orders: tracked,
    avg_touches: tracked ? round2(touchTotal / tracked) : 0,
    avg_days_to_convert: tracked ? round2(daysTotal / tracked) : null,
    models,
    channels,
    top_paths: sortRows([...paths.values()].map((p) => ({ ...p, revenue: round2(p.revenue) })))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10),
    campaigns: sortRows([...campaigns.values()].map((c) => ({ ...c, revenue: round2(c.revenue) }))).slice(0, 25),
    creator_assists: [...assists.values()]
      .map((a) => ({ ...a, assisted_revenue: round2(a.assisted_revenue) }))
      .sort((a, b) => b.first_touch + b.last_touch + b.assisted - (a.first_touch + a.last_touch + a.assisted)),
  };
}
