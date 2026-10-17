import type { Aggregate, CreatorLink, GroupKey } from "./store.js";
import { utcDay } from "./store.js";
import type {
  CampaignStatsRow,
  CodeStatsRow,
  ConfigCreator,
  CreatorLinkCode,
  CreatorLinkRow,
  CreatorStatsRow,
  CurrencyStatsRow,
  DailyStatsRow,
  LinkStatsRow,
  Metrics,
  ProgramConfig,
  ShareLink,
  StatsRange,
  StatsResponse,
} from "./types.js";
import { round2 } from "./validate.js";

export const STATS_RANGES: Record<StatsRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000;

export function isStatsRange(value: unknown): value is StatsRange {
  return value === "7d" || value === "30d" || value === "90d";
}

/** Whole UTC days: "7d" is today plus the six days before it. */
export function rangeBounds(range: StatsRange, now: Date): { from: Date; to: Date; days: string[] } {
  const days = STATS_RANGES[range];
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = new Date(startOfToday - (days - 1) * 86_400_000);
  const list: string[] = [];
  for (let i = 0; i < days; i++) list.push(utcDay(new Date(from.getTime() + i * 86_400_000)));
  return { from, to: now, days: list };
}

function creatorsInConfig(config: ProgramConfig) {
  const creators = new Map<string, { creator: ConfigCreator; codes: CreatorLinkCode[] }>();
  for (const a of config.affiliates) {
    const entry = creators.get(a.creator.id) ?? { creator: a.creator, codes: [] };
    entry.codes.push({ affiliate_id: a.id, code: a.code });
    creators.set(a.creator.id, entry);
  }
  return creators;
}

/** Approved logins (pinned in the brand's store) and the logins the dashboard proposes, pending first. */
export function creatorLinkRows(config: ProgramConfig, links: CreatorLink[]): CreatorLinkRow[] {
  const creators = creatorsInConfig(config);
  const codeOf = new Map(config.affiliates.map((a) => [a.id, a.code]));
  const approvedCreators = new Set(links.map((l) => l.creatorId));
  const approvedRefs = new Set(links.map((l) => l.userRef));
  const rows: CreatorLinkRow[] = links.map((link) => {
    const entry = creators.get(link.creatorId);
    return {
      creator_id: link.creatorId,
      username: entry?.creator.username ?? "unknown",
      display_name: entry?.creator.display_name ?? null,
      status: "approved",
      user_ref: link.userRef,
      codes: link.affiliateIds.map((id) => ({ affiliate_id: id, code: codeOf.get(id) ?? "" })),
      approved_at: link.approvedAt.toISOString(),
      dashboard_user_ref: entry?.creator.brand_user_ref ?? null,
      dashboard_codes: entry?.codes ?? [],
    };
  });
  for (const [id, entry] of creators) {
    const ref = entry.creator.brand_user_ref;
    if (ref === null || approvedCreators.has(id)) continue;
    rows.push({
      creator_id: id,
      username: entry.creator.username,
      display_name: entry.creator.display_name,
      status: approvedRefs.has(ref) ? "blocked" : "pending",
      user_ref: ref,
      codes: entry.codes,
      approved_at: null,
      dashboard_user_ref: ref,
      dashboard_codes: entry.codes,
    });
  }
  const order = { pending: 0, blocked: 1, approved: 2 };
  return rows.sort((a, b) => order[a.status] - order[b.status] || a.username.localeCompare(b.username));
}

function shareUrl(base: string, path: string, refParam: string, code: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  try {
    const b = new URL(base);
    const url = new URL(`${b.origin}${b.pathname.replace(/\/+$/, "")}${path}`);
    if (url.origin !== b.origin) return null;
    url.searchParams.set(refParam, code);
    return url.href;
  } catch {
    return null;
  }
}

/** The creator's links for their pinned, active codes, on `base` (one of the brand's own storefront URLs). */
export function shareLinks(config: ProgramConfig, affiliateIds: string[], base: string | null): ShareLink[] {
  if (!base) return [];
  const ref = config.program.ref_param;
  const out: ShareLink[] = [];
  for (const a of config.affiliates) {
    if (!affiliateIds.includes(a.id) || a.status !== "active") continue;
    const home = shareUrl(base, "/", ref, a.code);
    if (home) out.push({ affiliate_id: a.id, code: a.code, label: "Storefront", url: home });
    for (const l of config.links) {
      if (l.affiliate_id !== a.id) continue;
      const url = shareUrl(base, l.target_path, ref, a.code);
      if (url) out.push({ affiliate_id: a.id, code: a.code, label: l.label || l.target_path, url });
    }
  }
  return out;
}

type Acc = {
  clicks: number;
  started: number;
  failed: number;
  abandoned: number;
  orders: number;
  refunds: number;
  testOrders: number;
  revenue: number;
  commission: number;
};

const emptyAcc = (): Acc => ({
  clicks: 0,
  started: 0,
  failed: 0,
  abandoned: 0,
  orders: 0,
  refunds: 0,
  testOrders: 0,
  revenue: 0,
  commission: 0,
});

function toMetrics(acc: Acc): Metrics {
  return {
    clicks: acc.clicks,
    checkouts_started: acc.started,
    checkouts_failed: acc.failed,
    checkouts_abandoned: acc.abandoned,
    orders: acc.orders,
    revenue: round2(acc.revenue),
    commission: round2(acc.commission),
    refunds: acc.refunds,
    conversion_rate: acc.clicks > 0 ? Math.round((acc.orders / acc.clicks) * 10_000) / 10_000 : 0,
    test_orders: acc.testOrders,
  };
}

function bucket<K>(map: Map<K, Acc>, key: K): Acc {
  let acc = map.get(key);
  if (!acc) {
    acc = emptyAcc();
    map.set(key, acc);
  }
  return acc;
}

function dominantCurrency(aggregate: Aggregate): string | null {
  const counts = new Map<string, { orders: number; revenue: number }>();
  for (const g of aggregate.orders) {
    if (g.test) continue;
    const c = counts.get(g.currency) ?? { orders: 0, revenue: 0 };
    c.orders += g.orders;
    c.revenue += g.revenue;
    counts.set(g.currency, c);
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1].orders - a[1].orders || b[1].revenue - a[1].revenue || a[0].localeCompare(b[0])
  );
  if (ranked[0]) return ranked[0][0];
  return aggregate.orders[0]?.currency ?? null;
}

const byActivity = <T extends Metrics>(a: T, b: T) =>
  b.revenue - a.revenue || b.orders - a.orders || b.clicks - a.clicks;

const hasActivity = (m: Metrics) =>
  m.clicks + m.checkouts_started + m.orders + m.test_orders + m.refunds > 0;

export function buildStats(
  aggregate: Aggregate,
  config: ProgramConfig,
  options: {
    range: StatsRange;
    now: Date;
    role: "admin" | "creator";
    /** Creator: their approved link. The aggregate must already be limited to these codes. */
    scope?: { creatorId: string; affiliateIds: string[] } | null;
  }
): StatsResponse {
  const { days } = rangeBounds(options.range, options.now);
  const currency = dominantCurrency(aggregate);
  const scope = options.role === "creator" ? options.scope ?? null : null;

  const totals = emptyAcc();
  const creators = new Map<string, Acc>();
  const codes = new Map<string, Acc>();
  const codeLabels = new Map<string, { code: string; creatorId: string | null }>();
  if (scope) {
    bucket(creators, scope.creatorId);
    for (const id of scope.affiliateIds) bucket(codes, id);
  }
  const links = new Map<string, Acc>();
  const linkAffiliate = new Map<string, { affiliateId: string; code: string }>();
  const campaigns = new Map<string | null, Acc>();
  const daily = new Map<string, Acc>();
  const others = new Map<string, Acc>();

  const targets = (g: GroupKey): Acc[] => {
    const list = [totals, bucket(codes, g.affiliateId), bucket(campaigns, g.campaignId), bucket(daily, g.day)];
    if (!codeLabels.has(g.affiliateId)) codeLabels.set(g.affiliateId, { code: g.code, creatorId: g.creatorId });
    const creatorId = scope ? scope.creatorId : g.creatorId;
    if (creatorId) list.push(bucket(creators, creatorId));
    if (g.linkId) {
      list.push(bucket(links, g.linkId));
      if (!linkAffiliate.has(g.linkId)) linkAffiliate.set(g.linkId, { affiliateId: g.affiliateId, code: g.code });
    }
    return list;
  };

  for (const g of aggregate.clicks) for (const acc of targets(g)) acc.clicks += g.clicks;
  for (const g of aggregate.checkouts) {
    for (const acc of targets(g)) {
      acc.started += g.started;
      acc.failed += g.failed;
      acc.abandoned += g.abandoned;
    }
  }
  for (const g of aggregate.orders) {
    for (const acc of targets(g)) {
      if (g.test) {
        acc.testOrders += g.orders;
        continue;
      }
      acc.orders += g.orders;
      acc.refunds += g.refunded;
      if (g.currency === currency) {
        acc.revenue += g.revenue;
        acc.commission += g.commission;
      }
    }
    if (!g.test && g.currency !== currency) {
      const other = bucket(others, g.currency);
      other.orders += g.orders;
      other.revenue += g.revenue;
      other.commission += g.commission;
    }
  }

  const affiliateById = new Map(config.affiliates.map((a) => [a.id, a]));
  const creatorById = new Map(config.affiliates.map((a) => [a.creator.id, a.creator]));
  const campaignById = new Map(config.campaigns.map((c) => [c.id, c]));
  const linkById = new Map(config.links.map((l) => [l.id, l]));

  const by_creator: CreatorStatsRow[] = [...creators.entries()]
    .map(([id, acc]) => {
      const creator = creatorById.get(id);
      return {
        creator_id: id,
        username: creator?.username ?? "unknown",
        display_name: creator?.display_name ?? null,
        ...toMetrics(acc),
      };
    })
    .sort(byActivity);

  const by_code: CodeStatsRow[] = [...codes.entries()]
    .map(([id, acc]) => {
      const affiliate = affiliateById.get(id);
      const stored = codeLabels.get(id);
      return {
        affiliate_id: id,
        code: affiliate?.code ?? stored?.code ?? "",
        creator_id: scope?.creatorId ?? affiliate?.creator.id ?? stored?.creatorId ?? null,
        status: affiliate?.status ?? null,
        ...toMetrics(acc),
      };
    })
    .sort(byActivity);

  const by_link: LinkStatsRow[] = [...links.entries()]
    .map(([id, acc]) => {
      const link = linkById.get(id);
      const owner = linkAffiliate.get(id);
      const affiliateId = link?.affiliate_id ?? owner?.affiliateId ?? "";
      return {
        link_id: id,
        affiliate_id: affiliateId,
        code: affiliateById.get(affiliateId)?.code ?? owner?.code ?? "",
        label: link?.label || link?.target_path || "Removed link",
        target_path: link?.target_path ?? "",
        ...toMetrics(acc),
      };
    })
    .sort(byActivity);

  const by_campaign: CampaignStatsRow[] = [...campaigns.entries()]
    .map(([id, acc]) => ({
      campaign_id: id,
      title: id === null ? "No campaign" : campaignById.get(id)?.title ?? "Removed campaign",
      ...toMetrics(acc),
    }))
    .filter(hasActivity)
    .sort(byActivity);

  const dailyRows: DailyStatsRow[] = days.map((date) => {
    const acc = daily.get(date) ?? emptyAcc();
    return { date, clicks: acc.clicks, orders: acc.orders, revenue: round2(acc.revenue) };
  });

  const other_currencies: CurrencyStatsRow[] = [...others.entries()]
    .map(([code, acc]) => ({
      currency: code,
      orders: acc.orders,
      revenue: round2(acc.revenue),
      commission: round2(acc.commission),
    }))
    .sort((a, b) => b.orders - a.orders);

  return {
    range: options.range,
    generated_at: options.now.toISOString(),
    role: options.role,
    linked: options.role === "admin" || scope !== null,
    link_pending: false,
    currency,
    totals: toMetrics(totals),
    by_creator,
    by_code,
    by_link,
    by_campaign,
    daily: dailyRows,
    other_currencies,
    share_links: [],
    creator_links: [],
    config_warning: null,
  };
}
