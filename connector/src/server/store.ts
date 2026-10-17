import type { JourneyRecord, TouchRecord } from "./journey.js";

export type ClickRecord = {
  id: string;
  affiliateId: string;
  creatorId: string | null;
  code: string;
  campaignId: string | null;
  linkId: string | null;
  /** Path only, never the query string. */
  landingPath: string | null;
  referrerHost: string | null;
  /** Keyed hash of the visitor IP; the IP itself is never stored. */
  ipHash: string | null;
  createdAt: Date;
};

export type CheckoutStatus = "started" | "failed" | "completed";

export type CheckoutRecord = {
  id: string;
  clickId: string | null;
  affiliateId: string;
  creatorId: string | null;
  /** The credited affiliate's code. */
  code: string;
  /** The code the customer typed at checkout, if any. */
  typedCode: string | null;
  campaignId: string | null;
  linkId: string | null;
  cartTotal: number;
  currency: string;
  status: CheckoutStatus;
  failureReason: string | null;
  /** Test-mode checkouts are kept for attribution but never counted. */
  test: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type OrderRecord = {
  id: string;
  checkoutId: string | null;
  clickId: string | null;
  affiliateId: string;
  creatorId: string | null;
  code: string;
  campaignId: string | null;
  linkId: string | null;
  attributedVia: "click" | "code";
  amount: number;
  currency: string;
  commissionBps: number;
  commission: number;
  productRef: string | null;
  test: boolean;
  occurredAt: Date;
  refundedAt: Date | null;
  createdAt: Date;
};

export type AggregateQuery = {
  from: Date;
  to: Date;
  /** Checkouts still "started" and created before this are abandoned. */
  abandonedBefore: Date;
  /** null = every affiliate; [] = nobody. */
  affiliateIds: string[] | null;
};

export type GroupKey = {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  affiliateId: string;
  creatorId: string | null;
  code: string;
  campaignId: string | null;
  linkId: string | null;
};

export type ClickGroup = GroupKey & { clicks: number };
export type CheckoutGroup = GroupKey & { started: number; failed: number; abandoned: number };
export type OrderGroup = GroupKey & {
  currency: string;
  test: boolean;
  orders: number;
  refunded: number;
  /** Sum of non-refunded amounts. */
  revenue: number;
  /** Sum of non-refunded commission. */
  commission: number;
};

export type Aggregate = { clicks: ClickGroup[]; checkouts: CheckoutGroup[]; orders: OrderGroup[] };

/** A creator login approved by an admin of the brand's site, with the codes pinned at approval. */
export type CreatorLink = {
  creatorId: string;
  userRef: string;
  affiliateIds: string[];
  approvedAt: Date;
};

/** The last programme config the connector accepted, and why a newer one was refused (if it was). */
export type StoredConfig = {
  config: unknown;
  fetchedAt: Date | null;
  rejected: string | null;
};

export const PENDING_REFUND_TTL_MS = 30 * 86_400_000;

/**
 * Every checkout the site reports, credited to a creator or not: the source for
 * abandoned-checkout webhooks and the failed/abandoned checkout list.
 */
export type CheckoutWatch = {
  id: string;
  /** The md_vid visitor cookie, for finding the session in Clarity. */
  visitorId: string | null;
  clickId: string | null;
  affiliateId: string | null;
  creatorId: string | null;
  code: string | null;
  cartTotal: number;
  currency: string;
  status: CheckoutStatus;
  failureReason: string | null;
  /** The last checkout step the site reported, e.g. "shipping" or "payment". */
  step: string | null;
  /** The site's own customer reference, passed back in webhooks so it can look up who to contact. */
  customerRef: string | null;
  /** A link that reopens this cart, for recovery messages. */
  recoveryUrl: string | null;
  /**
   * The address the shopper typed on the brand's site or at checkout. Kept in
   * the brand's own database as its record of the checkout; only ever sent to
   * the brand's own email account.
   */
  email: string | null;
  firstName: string | null;
  /** The shopper ticked "email me offers" (Shopify: buyer_accepts_marketing). Informational unless the brand requires it. */
  marketingConsent: boolean;
  test: boolean;
  createdAt: Date;
  updatedAt: Date;
  abandonedNotifiedAt: Date | null;
  recoverySentAt: Date | null;
};

export type CheckoutListQuery = {
  from: Date;
  to: Date;
  /** "abandoned" = still "started" and created before abandonedBefore. null = all. */
  statuses: Array<"started" | "failed" | "abandoned" | "completed"> | null;
  abandonedBefore: Date;
  /** null = every checkout (credited or not); [] = nobody. */
  affiliateIds: string[] | null;
  limit: number;
};

/**
 * Where the connector keeps clicks, checkouts, orders, approved creator logins
 * and the last accepted programme config. Lives in the brand's own
 * infrastructure; nothing in it is ever sent to the media dashboard.
 */
export interface Store {
  insertClick(click: ClickRecord): Promise<void>;
  getClick(id: string): Promise<ClickRecord | null>;
  getCheckout(id: string): Promise<CheckoutRecord | null>;
  /** Inserts, or for an existing id updates cart total, currency and typed code and turns "failed" back into "started". Returns the stored row. */
  upsertCheckout(checkout: CheckoutRecord): Promise<CheckoutRecord>;
  /** "failed" only applies to "started" checkouts; "completed" to anything not already completed. */
  setCheckoutStatus(id: string, status: "failed" | "completed", reason: string | null, at: Date): Promise<boolean>;
  /** false when an order with this id already exists. */
  insertOrder(order: OrderRecord): Promise<boolean>;
  getOrder(id: string): Promise<OrderRecord | null>;
  /** false when the order doesn't exist or is already refunded. */
  markOrderRefunded(id: string, at: Date): Promise<boolean>;
  /** Keeps a refund that arrived before its order. Entries received more than 30 days earlier are dropped. */
  savePendingRefund(orderId: string, refundedAt: Date, receivedAt: Date): Promise<void>;
  /** Removes and returns the pending refund for this order, if any. */
  takePendingRefund(orderId: string): Promise<Date | null>;
  aggregate(query: AggregateQuery): Promise<Aggregate>;
  listCreatorLinks(): Promise<CreatorLink[]>;
  getCreatorLinkByUserRef(userRef: string): Promise<CreatorLink | null>;
  /** Inserts, or re-pins the codes of the same creator and login. false when either is already linked to another. */
  approveCreatorLink(link: CreatorLink): Promise<boolean>;
  deleteCreatorLink(creatorId: string): Promise<boolean>;
  loadConfig(brand: string): Promise<StoredConfig | null>;
  saveConfig(brand: string, state: StoredConfig): Promise<void>;

  insertTouch(touch: TouchRecord): Promise<void>;
  /** The visitor's most recent touch, for de-duplicating reloads. */
  lastTouch(visitorId: string): Promise<TouchRecord | null>;
  /** Oldest first, created in [from, to], at most `limit` (the most recent ones). */
  listTouches(visitorId: string, from: Date, to: Date, limit: number): Promise<TouchRecord[]>;
  /** false when a journey for this order already exists. */
  insertJourney(journey: JourneyRecord): Promise<boolean>;
  markJourneyRefunded(orderId: string, at: Date): Promise<boolean>;
  /** Journeys whose order occurred in [from, to]. */
  listJourneys(from: Date, to: Date): Promise<JourneyRecord[]>;

  /** Inserts, or updates totals/step/customer details of an existing checkout and turns "failed" back into "started". */
  upsertCheckoutWatch(watch: CheckoutWatch): Promise<{ created: boolean; row: CheckoutWatch }>;
  getCheckoutWatch(id: string): Promise<CheckoutWatch | null>;
  /** Same rules as setCheckoutStatus. */
  setCheckoutWatchStatus(id: string, status: "failed" | "completed", reason: string | null, at: Date): Promise<boolean>;
  setCheckoutWatchStep(id: string, step: string, at: Date): Promise<boolean>;
  /** Records that the recovery email went out. false when it already had. */
  markRecoverySent(id: string, at: Date): Promise<boolean>;
  /**
   * A paid order from this address closes its other open checkouts created
   * since `since` (the shopper paid from a different cart). Returns how many.
   */
  completeOpenCheckoutsByEmail(email: string, since: Date, at: Date): Promise<number>;
  /** Addresses that clicked unsubscribe: never emailed again (their checkouts stay recorded). */
  isEmailSuppressed(email: string): Promise<boolean>;
  suppressEmail(email: string, at: Date): Promise<void>;

  /** Small JSON values the connector app keeps for itself (its key pair, service keys, status timestamps). */
  getSetting(key: string): Promise<unknown>;
  setSetting(key: string, value: unknown, at: Date): Promise<void>;
  /** Every setting whose key starts with `prefix`. */
  listSettings(prefix: string): Promise<Record<string, unknown>>;
  /** true the first time an id is seen, false after (until it expires): stops a sign-in token being replayed. */
  useTokenOnce(id: string, expiresAt: Date, now: Date): Promise<boolean>;
  /**
   * Marks and returns up to `limit` non-test checkouts still "started", created
   * between notOlderThan and before, not yet notified. Each is returned once.
   */
  claimAbandoned(before: Date, notOlderThan: Date, at: Date, limit: number): Promise<CheckoutWatch[]>;
  /** Newest first. */
  listCheckoutWatch(query: CheckoutListQuery): Promise<CheckoutWatch[]>;
}

export function watchMatches(w: CheckoutWatch, q: CheckoutListQuery): boolean {
  const t = w.createdAt.getTime();
  if (w.test || t < q.from.getTime() || t > q.to.getTime()) return false;
  if (q.affiliateIds !== null && (w.affiliateId === null || !q.affiliateIds.includes(w.affiliateId))) return false;
  if (q.statuses === null) return true;
  const abandoned = w.status === "started" && t < q.abandonedBefore.getTime();
  return q.statuses.some((s) => (s === "abandoned" ? abandoned : s === "started" ? w.status === "started" && !abandoned : w.status === s));
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function keyOf(row: Omit<GroupKey, "day">, day: string): string {
  return [day, row.affiliateId, row.creatorId ?? "", row.code, row.campaignId ?? "", row.linkId ?? ""].join("|");
}

function inRange(date: Date, query: AggregateQuery, affiliateId: string): boolean {
  const t = date.getTime();
  if (t < query.from.getTime() || t > query.to.getTime()) return false;
  return query.affiliateIds === null || query.affiliateIds.includes(affiliateId);
}

function groupKey(row: Omit<GroupKey, "day">, day: string): GroupKey {
  return {
    day,
    affiliateId: row.affiliateId,
    creatorId: row.creatorId,
    code: row.code,
    campaignId: row.campaignId,
    linkId: row.linkId,
  };
}

/** Same grouping the Postgres store does in SQL. */
export function aggregateRows(
  clicks: Iterable<ClickRecord>,
  checkouts: Iterable<CheckoutRecord>,
  orders: Iterable<OrderRecord>,
  query: AggregateQuery
): Aggregate {
  const clickGroups = new Map<string, ClickGroup>();
  for (const click of clicks) {
    if (!inRange(click.createdAt, query, click.affiliateId)) continue;
    const day = utcDay(click.createdAt);
    const k = keyOf(click, day);
    const group = clickGroups.get(k) ?? { ...groupKey(click, day), clicks: 0 };
    group.clicks += 1;
    clickGroups.set(k, group);
  }

  const checkoutGroups = new Map<string, CheckoutGroup>();
  for (const checkout of checkouts) {
    if (checkout.test || !inRange(checkout.createdAt, query, checkout.affiliateId)) continue;
    const day = utcDay(checkout.createdAt);
    const k = keyOf(checkout, day);
    const group = checkoutGroups.get(k) ?? { ...groupKey(checkout, day), started: 0, failed: 0, abandoned: 0 };
    group.started += 1;
    if (checkout.status === "failed") group.failed += 1;
    if (checkout.status === "started" && checkout.createdAt.getTime() < query.abandonedBefore.getTime()) {
      group.abandoned += 1;
    }
    checkoutGroups.set(k, group);
  }

  const orderGroups = new Map<string, OrderGroup>();
  for (const order of orders) {
    if (!inRange(order.occurredAt, query, order.affiliateId)) continue;
    const day = utcDay(order.occurredAt);
    const k = `${keyOf(order, day)}|${order.currency}|${order.test ? 1 : 0}`;
    const group = orderGroups.get(k) ?? {
      ...groupKey(order, day),
      currency: order.currency,
      test: order.test,
      orders: 0,
      refunded: 0,
      revenue: 0,
      commission: 0,
    };
    group.orders += 1;
    if (order.refundedAt) {
      group.refunded += 1;
    } else {
      group.revenue += order.amount;
      group.commission += order.commission;
    }
    orderGroups.set(k, group);
  }

  return { clicks: [...clickGroups.values()], checkouts: [...checkoutGroups.values()], orders: [...orderGroups.values()] };
}

const copy = <T>(row: T): T => structuredClone(row);

/** In-process store for development and tests. Data is lost on restart and not shared between server instances. */
export function memoryStore(): Store {
  const clicks = new Map<string, ClickRecord>();
  const checkouts = new Map<string, CheckoutRecord>();
  const orders = new Map<string, OrderRecord>();
  const pendingRefunds = new Map<string, { refundedAt: Date; receivedAt: Date }>();
  const links = new Map<string, CreatorLink>();
  const configs = new Map<string, StoredConfig>();
  const touches = new Map<string, TouchRecord[]>();
  const journeys = new Map<string, JourneyRecord>();
  const watches = new Map<string, CheckoutWatch>();
  const suppressed = new Map<string, Date>();
  const settings = new Map<string, unknown>();
  const usedTokens = new Map<string, number>();

  return {
    async insertClick(click) {
      clicks.set(click.id, copy(click));
    },
    async getClick(id) {
      const row = clicks.get(id.toLowerCase());
      return row ? copy(row) : null;
    },
    async getCheckout(id) {
      const row = checkouts.get(id);
      return row ? copy(row) : null;
    },
    async upsertCheckout(checkout) {
      const existing = checkouts.get(checkout.id);
      if (!existing) {
        checkouts.set(checkout.id, copy(checkout));
        return copy(checkout);
      }
      existing.cartTotal = checkout.cartTotal;
      existing.currency = checkout.currency;
      existing.typedCode = checkout.typedCode;
      existing.updatedAt = new Date(checkout.updatedAt.getTime());
      if (existing.status === "failed") {
        existing.status = "started";
        existing.failureReason = null;
      }
      return copy(existing);
    },
    async setCheckoutStatus(id, status, reason, at) {
      const existing = checkouts.get(id);
      if (!existing) return false;
      if (status === "failed" && existing.status !== "started") return false;
      if (status === "completed" && existing.status === "completed") return false;
      existing.status = status;
      existing.failureReason = status === "failed" ? reason : null;
      existing.updatedAt = new Date(at.getTime());
      return true;
    },
    async insertOrder(order) {
      if (orders.has(order.id)) return false;
      orders.set(order.id, copy(order));
      return true;
    },
    async getOrder(id) {
      const row = orders.get(id);
      return row ? copy(row) : null;
    },
    async markOrderRefunded(id, at) {
      const existing = orders.get(id);
      if (!existing || existing.refundedAt) return false;
      existing.refundedAt = new Date(at.getTime());
      return true;
    },
    async savePendingRefund(orderId, refundedAt, receivedAt) {
      for (const [id, entry] of pendingRefunds) {
        if (receivedAt.getTime() - entry.receivedAt.getTime() > PENDING_REFUND_TTL_MS) pendingRefunds.delete(id);
      }
      if (!pendingRefunds.has(orderId)) pendingRefunds.set(orderId, { refundedAt: copy(refundedAt), receivedAt: copy(receivedAt) });
    },
    async takePendingRefund(orderId) {
      const entry = pendingRefunds.get(orderId);
      pendingRefunds.delete(orderId);
      return entry ? copy(entry.refundedAt) : null;
    },
    async aggregate(query) {
      return aggregateRows(clicks.values(), checkouts.values(), orders.values(), query);
    },
    async listCreatorLinks() {
      return [...links.values()].map(copy);
    },
    async getCreatorLinkByUserRef(userRef) {
      const row = [...links.values()].find((l) => l.userRef === userRef);
      return row ? copy(row) : null;
    },
    async approveCreatorLink(link) {
      const existing = links.get(link.creatorId);
      if (existing ? existing.userRef !== link.userRef : [...links.values()].some((l) => l.userRef === link.userRef)) {
        return false;
      }
      links.set(link.creatorId, copy(link));
      return true;
    },
    async deleteCreatorLink(creatorId) {
      return links.delete(creatorId);
    },
    async loadConfig(brand) {
      const row = configs.get(brand);
      return row ? copy(row) : null;
    },
    async saveConfig(brand, state) {
      configs.set(brand, copy(state));
    },
    async insertTouch(touch) {
      const list = touches.get(touch.visitorId) ?? [];
      list.push(copy(touch));
      touches.set(touch.visitorId, list);
    },
    async lastTouch(visitorId) {
      const row = touches.get(visitorId)?.at(-1);
      return row ? copy(row) : null;
    },
    async listTouches(visitorId, from, to, limit) {
      const rows = (touches.get(visitorId) ?? []).filter(
        (t) => t.createdAt.getTime() >= from.getTime() && t.createdAt.getTime() <= to.getTime()
      );
      return rows.slice(-limit).map(copy);
    },
    async insertJourney(journey) {
      if (journeys.has(journey.orderId)) return false;
      journeys.set(journey.orderId, copy(journey));
      return true;
    },
    async markJourneyRefunded(orderId, at) {
      const row = journeys.get(orderId);
      if (!row || row.refundedAt) return false;
      row.refundedAt = new Date(at.getTime());
      return true;
    },
    async listJourneys(from, to) {
      return [...journeys.values()]
        .filter((j) => j.occurredAt.getTime() >= from.getTime() && j.occurredAt.getTime() <= to.getTime())
        .map(copy);
    },
    async upsertCheckoutWatch(watch) {
      const existing = watches.get(watch.id);
      if (!existing) {
        watches.set(watch.id, copy(watch));
        return { created: true, row: copy(watch) };
      }
      existing.cartTotal = watch.cartTotal;
      existing.currency = watch.currency;
      existing.updatedAt = new Date(watch.updatedAt.getTime());
      existing.visitorId ??= watch.visitorId;
      existing.step = watch.step ?? existing.step;
      existing.customerRef = watch.customerRef ?? existing.customerRef;
      existing.recoveryUrl = watch.recoveryUrl ?? existing.recoveryUrl;
      existing.email = watch.email ?? existing.email;
      existing.firstName = watch.firstName ?? existing.firstName;
      existing.marketingConsent = watch.marketingConsent || existing.marketingConsent;
      if (existing.status === "failed") {
        existing.status = "started";
        existing.failureReason = null;
      }
      return { created: false, row: copy(existing) };
    },
    async getCheckoutWatch(id) {
      const row = watches.get(id);
      return row ? copy(row) : null;
    },
    async setCheckoutWatchStatus(id, status, reason, at) {
      const existing = watches.get(id);
      if (!existing) return false;
      if (status === "failed" && existing.status !== "started") return false;
      if (status === "completed" && existing.status === "completed") return false;
      existing.status = status;
      existing.failureReason = status === "failed" ? reason : null;
      existing.updatedAt = new Date(at.getTime());
      return true;
    },
    async markRecoverySent(id, at) {
      const existing = watches.get(id);
      if (!existing || existing.recoverySentAt) return false;
      existing.recoverySentAt = new Date(at.getTime());
      return true;
    },
    async completeOpenCheckoutsByEmail(email, since, at) {
      let n = 0;
      for (const w of watches.values()) {
        if (w.email !== email || w.status === "completed" || w.createdAt.getTime() < since.getTime()) continue;
        w.status = "completed";
        w.failureReason = null;
        w.updatedAt = new Date(at.getTime());
        n += 1;
      }
      return n;
    },
    async isEmailSuppressed(email) {
      return suppressed.has(email);
    },
    async suppressEmail(email, at) {
      if (!suppressed.has(email)) suppressed.set(email, new Date(at.getTime()));
    },
    async getSetting(key) {
      return settings.has(key) ? copy(settings.get(key)) : null;
    },
    async setSetting(key, value) {
      if (value === null || value === undefined) settings.delete(key);
      else settings.set(key, copy(value));
    },
    async listSettings(prefix) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of settings) if (k.startsWith(prefix)) out[k] = copy(v);
      return out;
    },
    async useTokenOnce(id, expiresAt, now) {
      for (const [k, exp] of usedTokens) if (exp < now.getTime()) usedTokens.delete(k);
      if (usedTokens.has(id)) return false;
      usedTokens.set(id, expiresAt.getTime());
      return true;
    },
    async setCheckoutWatchStep(id, step, at) {
      const existing = watches.get(id);
      if (!existing) return false;
      existing.step = step;
      existing.updatedAt = new Date(at.getTime());
      return true;
    },
    async claimAbandoned(before, notOlderThan, at, limit) {
      const claimed: CheckoutWatch[] = [];
      for (const w of watches.values()) {
        if (claimed.length >= limit) break;
        const t = w.createdAt.getTime();
        if (w.test || w.status !== "started" || w.abandonedNotifiedAt) continue;
        if (t >= before.getTime() || t < notOlderThan.getTime()) continue;
        w.abandonedNotifiedAt = new Date(at.getTime());
        claimed.push(copy(w));
      }
      return claimed;
    },
    async listCheckoutWatch(query) {
      return [...watches.values()]
        .filter((w) => watchMatches(w, query))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, query.limit)
        .map(copy);
    },
  };
}
