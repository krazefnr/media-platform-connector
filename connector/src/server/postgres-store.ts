import type {
  Aggregate,
  AggregateQuery,
  CheckoutGroup,
  CheckoutRecord,
  CheckoutStatus,
  CheckoutWatch,
  ClickGroup,
  ClickRecord,
  CreatorLink,
  OrderGroup,
  OrderRecord,
  Store,
} from "./store.js";
import type { Channel, JourneyRecord, TouchRecord } from "./journey.js";

/** The subset of a node-postgres Pool the store uses. */
export type PgQueryable = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

export type PostgresStoreOptions =
  | { connectionString: string; ssl?: boolean | Record<string, unknown>; max?: number }
  | { pool: PgQueryable };

type Row = Record<string, unknown>;

const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const d = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dn = (v: unknown): Date | null => (v === null || v === undefined ? null : d(v));

function toClick(r: Row): ClickRecord {
  return {
    id: String(r.id),
    affiliateId: String(r.affiliate_id),
    creatorId: s(r.creator_id),
    code: String(r.code),
    campaignId: s(r.campaign_id),
    linkId: s(r.link_id),
    landingPath: s(r.landing_path),
    referrerHost: s(r.referrer_host),
    ipHash: s(r.ip_hash),
    createdAt: d(r.created_at),
  };
}

function toCheckout(r: Row): CheckoutRecord {
  return {
    id: String(r.id),
    clickId: s(r.click_id),
    affiliateId: String(r.affiliate_id),
    creatorId: s(r.creator_id),
    code: String(r.code),
    typedCode: s(r.typed_code),
    campaignId: s(r.campaign_id),
    linkId: s(r.link_id),
    cartTotal: n(r.cart_total),
    currency: String(r.currency),
    status: String(r.status) as CheckoutStatus,
    failureReason: s(r.failure_reason),
    test: r.test === true,
    createdAt: d(r.created_at),
    updatedAt: d(r.updated_at),
  };
}

/** node-postgres parses uuid[] into an array; a raw "{a,b}" literal is handled too. */
function uuidList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.replace(/^\{|\}$/g, "").split(",").filter(Boolean);
  return [];
}

function toCreatorLink(r: Row): CreatorLink {
  return {
    creatorId: String(r.creator_id),
    userRef: String(r.user_ref),
    affiliateIds: uuidList(r.affiliate_ids),
    approvedAt: d(r.approved_at),
  };
}

const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === "23505";

function toOrder(r: Row): OrderRecord {
  return {
    id: String(r.id),
    checkoutId: s(r.checkout_id),
    clickId: s(r.click_id),
    affiliateId: String(r.affiliate_id),
    creatorId: s(r.creator_id),
    code: String(r.code),
    campaignId: s(r.campaign_id),
    linkId: s(r.link_id),
    attributedVia: r.attributed_via === "code" ? "code" : "click",
    amount: n(r.amount),
    currency: String(r.currency),
    commissionBps: n(r.commission_bps),
    commission: n(r.commission),
    productRef: s(r.product_ref),
    test: r.test === true,
    occurredAt: d(r.occurred_at),
    refundedAt: dn(r.refunded_at),
    createdAt: d(r.created_at),
  };
}

function groupKey(r: Row) {
  return {
    day: String(r.day),
    affiliateId: String(r.affiliate_id),
    creatorId: s(r.creator_id),
    code: String(r.code),
    campaignId: s(r.campaign_id),
    linkId: s(r.link_id),
  };
}

const DAY = `to_char(%s at time zone 'UTC', 'YYYY-MM-DD')`;
const KEYS = "affiliate_id, creator_id, code, campaign_id, link_id";
const AFFILIATE_FILTER = "($3::uuid[] is null or affiliate_id = any($3::uuid[]))";

async function loadPool(options: { connectionString: string; ssl?: boolean | Record<string, unknown>; max?: number }) {
  const specifier = "pg";
  let mod: Record<string, unknown>;
  try {
    mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch {
    throw new Error('postgresStore needs the "pg" package. Install it with: npm install pg');
  }
  const Pool = (mod.Pool ?? (mod.default as Record<string, unknown> | undefined)?.Pool) as
    | (new (config: Record<string, unknown>) => PgQueryable)
    | undefined;
  if (!Pool) throw new Error('The "pg" package did not export Pool.');
  return new Pool({ connectionString: options.connectionString, ssl: options.ssl, max: options.max ?? 5 });
}

/** Stores rows in the brand's own Postgres (tables from sql/schema.sql). Uses the optional "pg" peer dependency. */
export function postgresStore(options: PostgresStoreOptions): Store {
  let poolPromise: Promise<PgQueryable> | null = "pool" in options ? Promise.resolve(options.pool) : null;
  const db = () => {
    if (!poolPromise && "connectionString" in options) {
      poolPromise = loadPool(options).catch((error) => {
        poolPromise = null;
        throw error;
      });
    }
    return poolPromise!;
  };
  const query = async (text: string, values: unknown[]) => (await db()).query(text, values);

  return {
    async insertClick(c) {
      await query(
        `insert into md_clicks (id, affiliate_id, creator_id, code, campaign_id, link_id, landing_path, referrer_host, ip_hash, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do nothing`,
        [c.id, c.affiliateId, c.creatorId, c.code, c.campaignId, c.linkId, c.landingPath, c.referrerHost, c.ipHash, c.createdAt]
      );
    },

    async getClick(id) {
      const { rows } = await query(`select * from md_clicks where id = $1`, [id]);
      return rows[0] ? toClick(rows[0]) : null;
    },

    async getCheckout(id) {
      const { rows } = await query(`select * from md_checkouts where id = $1`, [id]);
      return rows[0] ? toCheckout(rows[0]) : null;
    },

    async upsertCheckout(c) {
      const { rows } = await query(
        `insert into md_checkouts (id, click_id, affiliate_id, creator_id, code, campaign_id, link_id, cart_total, currency, status, failure_reason, created_at, updated_at, typed_code, test)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         on conflict (id) do update set
           cart_total = excluded.cart_total,
           currency = excluded.currency,
           typed_code = excluded.typed_code,
           updated_at = excluded.updated_at,
           status = case when md_checkouts.status = 'failed' then 'started' else md_checkouts.status end,
           failure_reason = case when md_checkouts.status = 'failed' then null else md_checkouts.failure_reason end
         returning *`,
        [
          c.id,
          c.clickId,
          c.affiliateId,
          c.creatorId,
          c.code,
          c.campaignId,
          c.linkId,
          c.cartTotal,
          c.currency,
          c.status,
          c.failureReason,
          c.createdAt,
          c.updatedAt,
          c.typedCode,
          c.test,
        ]
      );
      return toCheckout(rows[0]!);
    },

    async setCheckoutStatus(id, status, reason, at) {
      const guard = status === "failed" ? "status = 'started'" : "status <> 'completed'";
      const { rowCount } = await query(
        `update md_checkouts set status = $2, failure_reason = $3, updated_at = $4 where id = $1 and ${guard}`,
        [id, status, status === "failed" ? reason : null, at]
      );
      return (rowCount ?? 0) > 0;
    },

    async insertOrder(o) {
      const { rowCount } = await query(
        `insert into md_orders (id, checkout_id, click_id, affiliate_id, creator_id, code, campaign_id, link_id, attributed_via,
                                amount, currency, commission_bps, commission, product_ref, test, occurred_at, refunded_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         on conflict (id) do nothing`,
        [
          o.id,
          o.checkoutId,
          o.clickId,
          o.affiliateId,
          o.creatorId,
          o.code,
          o.campaignId,
          o.linkId,
          o.attributedVia,
          o.amount,
          o.currency,
          o.commissionBps,
          o.commission,
          o.productRef,
          o.test,
          o.occurredAt,
          o.refundedAt,
          o.createdAt,
        ]
      );
      return (rowCount ?? 0) > 0;
    },

    async getOrder(id) {
      const { rows } = await query(`select * from md_orders where id = $1`, [id]);
      return rows[0] ? toOrder(rows[0]) : null;
    },

    async markOrderRefunded(id, at) {
      const { rowCount } = await query(
        `update md_orders set refunded_at = $2 where id = $1 and refunded_at is null`,
        [id, at]
      );
      return (rowCount ?? 0) > 0;
    },

    async savePendingRefund(orderId, refundedAt, receivedAt) {
      await query(
        `with pruned as (delete from md_pending_refunds where received_at < $3::timestamptz - interval '30 days')
         insert into md_pending_refunds (order_id, refunded_at, received_at) values ($1, $2, $3)
         on conflict (order_id) do nothing`,
        [orderId, refundedAt, receivedAt]
      );
    },

    async takePendingRefund(orderId) {
      const { rows } = await query(`delete from md_pending_refunds where order_id = $1 returning refunded_at`, [orderId]);
      return rows[0] ? d(rows[0].refunded_at) : null;
    },

    async aggregate(q: AggregateQuery): Promise<Aggregate> {
      const base = [q.from, q.to, q.affiliateIds];
      const [clicks, checkouts, orders] = await Promise.all([
        query(
          `select ${DAY.replace("%s", "created_at")} as day, ${KEYS}, count(*)::int as clicks
           from md_clicks
           where created_at >= $1 and created_at <= $2 and ${AFFILIATE_FILTER}
           group by 1, ${KEYS}`,
          base
        ),
        query(
          `select ${DAY.replace("%s", "created_at")} as day, ${KEYS},
                  count(*)::int as started,
                  count(*) filter (where status = 'failed')::int as failed,
                  count(*) filter (where status = 'started' and created_at < $4)::int as abandoned
           from md_checkouts
           where created_at >= $1 and created_at <= $2 and not test and ${AFFILIATE_FILTER}
           group by 1, ${KEYS}`,
          [...base, q.abandonedBefore]
        ),
        query(
          `select ${DAY.replace("%s", "occurred_at")} as day, ${KEYS}, currency, test,
                  count(*)::int as orders,
                  count(*) filter (where refunded_at is not null)::int as refunded,
                  coalesce(sum(amount) filter (where refunded_at is null), 0)::float8 as revenue,
                  coalesce(sum(commission) filter (where refunded_at is null), 0)::float8 as commission
           from md_orders
           where occurred_at >= $1 and occurred_at <= $2 and ${AFFILIATE_FILTER}
           group by 1, ${KEYS}, currency, test`,
          base
        ),
      ]);
      return {
        clicks: clicks.rows.map((r): ClickGroup => ({ ...groupKey(r), clicks: n(r.clicks) })),
        checkouts: checkouts.rows.map(
          (r): CheckoutGroup => ({ ...groupKey(r), started: n(r.started), failed: n(r.failed), abandoned: n(r.abandoned) })
        ),
        orders: orders.rows.map(
          (r): OrderGroup => ({
            ...groupKey(r),
            currency: String(r.currency),
            test: r.test === true,
            orders: n(r.orders),
            refunded: n(r.refunded),
            revenue: n(r.revenue),
            commission: n(r.commission),
          })
        ),
      };
    },

    async listCreatorLinks() {
      const { rows } = await query(`select creator_id, user_ref, affiliate_ids, approved_at from md_creator_links order by approved_at`, []);
      return rows.map(toCreatorLink);
    },

    async getCreatorLinkByUserRef(userRef) {
      const { rows } = await query(
        `select creator_id, user_ref, affiliate_ids, approved_at from md_creator_links where user_ref = $1`,
        [userRef]
      );
      return rows[0] ? toCreatorLink(rows[0]) : null;
    },

    async approveCreatorLink(link) {
      try {
        const { rowCount } = await query(
          `insert into md_creator_links (creator_id, user_ref, affiliate_ids, approved_at)
           values ($1, $2, $3::uuid[], $4)
           on conflict (creator_id) do update set affiliate_ids = excluded.affiliate_ids, approved_at = excluded.approved_at
           where md_creator_links.user_ref = excluded.user_ref`,
          [link.creatorId, link.userRef, link.affiliateIds, link.approvedAt]
        );
        return (rowCount ?? 0) > 0;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async deleteCreatorLink(creatorId) {
      const { rowCount } = await query(`delete from md_creator_links where creator_id = $1`, [creatorId]);
      return (rowCount ?? 0) > 0;
    },

    async loadConfig(brand) {
      const { rows } = await query(`select config, fetched_at, rejected from md_config where brand = $1`, [brand]);
      const r = rows[0];
      if (!r) return null;
      return {
        config: typeof r.config === "string" ? (JSON.parse(r.config) as unknown) : r.config ?? null,
        fetchedAt: dn(r.fetched_at),
        rejected: s(r.rejected),
      };
    },

    async saveConfig(brand, state) {
      await query(
        `insert into md_config (brand, config, fetched_at, rejected) values ($1, $2::jsonb, $3, $4)
         on conflict (brand) do update set config = excluded.config, fetched_at = excluded.fetched_at, rejected = excluded.rejected`,
        [brand, state.config === null || state.config === undefined ? null : JSON.stringify(state.config), state.fetchedAt, state.rejected]
      );
    },

    async insertTouch(t) {
      await query(
        `insert into md_touches (id, visitor_id, channel, source, medium, campaign, content, ref_code, landing_path, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (id) do nothing`,
        [t.id, t.visitorId, t.channel, t.source, t.medium, t.campaign, t.content, t.refCode, t.landingPath, t.createdAt]
      );
    },

    async lastTouch(visitorId) {
      const { rows } = await query(`select * from md_touches where visitor_id = $1 order by created_at desc limit 1`, [visitorId]);
      return rows[0] ? toTouch(rows[0]) : null;
    },

    async listTouches(visitorId, from, to, limit) {
      const { rows } = await query(
        `select * from (
           select * from md_touches where visitor_id = $1 and created_at between $2 and $3
           order by created_at desc limit $4
         ) t order by created_at asc`,
        [visitorId, from, to, limit]
      );
      return rows.map(toTouch);
    },

    async insertJourney(j) {
      const { rowCount } = await query(
        `insert into md_journeys (order_id, visitor_id, amount, currency, test, occurred_at, refunded_at, touches)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         on conflict (order_id) do nothing`,
        [j.orderId, j.visitorId, j.amount, j.currency, j.test, j.occurredAt, j.refundedAt, JSON.stringify(j.touches)]
      );
      return (rowCount ?? 0) > 0;
    },

    async markJourneyRefunded(orderId, at) {
      const { rowCount } = await query(
        `update md_journeys set refunded_at = $2 where order_id = $1 and refunded_at is null`,
        [orderId, at]
      );
      return (rowCount ?? 0) > 0;
    },

    async listJourneys(from, to) {
      const { rows } = await query(`select * from md_journeys where occurred_at between $1 and $2`, [from, to]);
      return rows.map(toJourney);
    },

    async upsertCheckoutWatch(w) {
      const { rows } = await query(
        `insert into md_checkout_watch (id, visitor_id, click_id, affiliate_id, creator_id, code, cart_total, currency, status,
           failure_reason, step, customer_ref, recovery_url, test, created_at, updated_at, email, first_name, marketing_consent)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         on conflict (id) do update set
           cart_total = excluded.cart_total,
           currency = excluded.currency,
           updated_at = excluded.updated_at,
           visitor_id = coalesce(md_checkout_watch.visitor_id, excluded.visitor_id),
           step = coalesce(excluded.step, md_checkout_watch.step),
           customer_ref = coalesce(excluded.customer_ref, md_checkout_watch.customer_ref),
           recovery_url = coalesce(excluded.recovery_url, md_checkout_watch.recovery_url),
           email = coalesce(excluded.email, md_checkout_watch.email),
           first_name = coalesce(excluded.first_name, md_checkout_watch.first_name),
           marketing_consent = md_checkout_watch.marketing_consent or excluded.marketing_consent,
           status = case when md_checkout_watch.status = 'failed' then 'started' else md_checkout_watch.status end,
           failure_reason = case when md_checkout_watch.status = 'failed' then null else md_checkout_watch.failure_reason end
         returning *, (xmax = 0) as inserted`,
        [
          w.id, w.visitorId, w.clickId, w.affiliateId, w.creatorId, w.code, w.cartTotal, w.currency, w.status,
          w.failureReason, w.step, w.customerRef, w.recoveryUrl, w.test, w.createdAt, w.updatedAt,
          w.email, w.firstName, w.marketingConsent,
        ]
      );
      const r = rows[0]!;
      return { created: r.inserted === true, row: toWatch(r) };
    },

    async getCheckoutWatch(id) {
      const { rows } = await query(`select * from md_checkout_watch where id = $1`, [id]);
      return rows[0] ? toWatch(rows[0]) : null;
    },

    async setCheckoutWatchStatus(id, status, reason, at) {
      const guard = status === "failed" ? "status = 'started'" : "status <> 'completed'";
      const { rowCount } = await query(
        `update md_checkout_watch set status = $2, failure_reason = $3, updated_at = $4 where id = $1 and ${guard}`,
        [id, status, status === "failed" ? reason : null, at]
      );
      return (rowCount ?? 0) > 0;
    },

    async markRecoverySent(id, at) {
      const { rowCount } = await query(
        `update md_checkout_watch set recovery_sent_at = $2 where id = $1 and recovery_sent_at is null`,
        [id, at]
      );
      return (rowCount ?? 0) > 0;
    },

    async completeOpenCheckoutsByEmail(email, since, at) {
      const { rowCount } = await query(
        `update md_checkout_watch set status = 'completed', failure_reason = null, updated_at = $3
         where email = $1 and status <> 'completed' and created_at >= $2`,
        [email, since, at]
      );
      return rowCount ?? 0;
    },

    async isEmailSuppressed(email) {
      const { rows } = await query(`select 1 from md_email_suppressions where email = $1`, [email]);
      return rows.length > 0;
    },

    async getSetting(key) {
      const { rows } = await query(`select value from md_settings where key = $1`, [key]);
      return rows[0] ? unwrapSetting(rows[0].value) : null;
    },

    async setSetting(key, value, at) {
      if (value === null || value === undefined) {
        await query(`delete from md_settings where key = $1`, [key]);
        return;
      }
      await query(
        `insert into md_settings (key, value, updated_at) values ($1, $2::jsonb, $3)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        [key, JSON.stringify({ v: value }), at]
      );
    },

    async listSettings(prefix) {
      const { rows } = await query(`select key, value from md_settings where starts_with(key, $1)`, [prefix]);
      const out: Record<string, unknown> = {};
      for (const r of rows) out[String(r.key)] = unwrapSetting(r.value);
      return out;
    },

    async useTokenOnce(id, expiresAt, now) {
      if (Math.random() < 0.02) await query(`delete from md_used_tokens where expires_at < $1`, [now]);
      const { rowCount } = await query(
        `insert into md_used_tokens (id, expires_at) values ($1, $2) on conflict (id) do nothing`,
        [id, expiresAt]
      );
      return (rowCount ?? 0) > 0;
    },

    async suppressEmail(email, at) {
      await query(`insert into md_email_suppressions (email, unsubscribed_at) values ($1, $2) on conflict (email) do nothing`, [email, at]);
    },

    async setCheckoutWatchStep(id, step, at) {
      const { rowCount } = await query(`update md_checkout_watch set step = $2, updated_at = $3 where id = $1`, [id, step, at]);
      return (rowCount ?? 0) > 0;
    },

    async claimAbandoned(before, notOlderThan, at, limit) {
      // skip locked: two server instances sweeping at once never claim the same row.
      const { rows } = await query(
        `update md_checkout_watch set abandoned_notified_at = $3
         where id in (
           select id from md_checkout_watch
           where status = 'started' and not test and abandoned_notified_at is null
             and created_at < $1 and created_at >= $2
           order by created_at
           limit $4
           for update skip locked
         )
         returning *`,
        [before, notOlderThan, at, limit]
      );
      return rows.map(toWatch);
    },

    async listCheckoutWatch(q) {
      const statuses = q.statuses;
      const { rows } = await query(
        `select * from md_checkout_watch
         where not test and created_at between $1 and $2
           and ($3::uuid[] is null or affiliate_id = any($3::uuid[]))
           and (
             $4::text[] is null
             or (status = 'failed' and 'failed' = any($4::text[]))
             or (status = 'completed' and 'completed' = any($4::text[]))
             or (status = 'started' and created_at < $5 and 'abandoned' = any($4::text[]))
             or (status = 'started' and created_at >= $5 and 'started' = any($4::text[]))
           )
         order by created_at desc
         limit $6`,
        [q.from, q.to, q.affiliateIds, statuses, q.abandonedBefore, q.limit]
      );
      return rows.map(toWatch);
    },
  };
}

function toTouch(r: Row): TouchRecord {
  return {
    id: String(r.id),
    visitorId: String(r.visitor_id),
    channel: String(r.channel) as Channel,
    source: s(r.source),
    medium: s(r.medium),
    campaign: s(r.campaign),
    content: s(r.content),
    refCode: s(r.ref_code),
    landingPath: s(r.landing_path),
    createdAt: d(r.created_at),
  };
}

function toJourney(r: Row): JourneyRecord {
  const raw = typeof r.touches === "string" ? (JSON.parse(r.touches) as unknown) : r.touches;
  const touches = Array.isArray(raw)
    ? raw.map((t: Record<string, unknown>) => ({
        channel: String(t.channel) as Channel,
        source: s(t.source),
        campaign: s(t.campaign),
        refCode: s(t.refCode),
        at: d(t.at),
      }))
    : [];
  return {
    orderId: String(r.order_id),
    visitorId: s(r.visitor_id),
    amount: n(r.amount),
    currency: String(r.currency),
    test: r.test === true,
    occurredAt: d(r.occurred_at),
    refundedAt: dn(r.refunded_at),
    touches,
  };
}

function toWatch(r: Row): CheckoutWatch {
  return {
    id: String(r.id),
    visitorId: s(r.visitor_id),
    clickId: s(r.click_id),
    affiliateId: s(r.affiliate_id),
    creatorId: s(r.creator_id),
    code: s(r.code),
    cartTotal: n(r.cart_total),
    currency: String(r.currency),
    status: String(r.status) as CheckoutStatus,
    failureReason: s(r.failure_reason),
    step: s(r.step),
    customerRef: s(r.customer_ref),
    recoveryUrl: s(r.recovery_url),
    email: s(r.email),
    firstName: s(r.first_name),
    marketingConsent: r.marketing_consent === true,
    test: r.test === true,
    createdAt: d(r.created_at),
    updatedAt: d(r.updated_at),
    abandonedNotifiedAt: dn(r.abandoned_notified_at),
    recoverySentAt: dn(r.recovery_sent_at),
  };
}

/**
 * Settings are stored as {"v": value} so the column always holds an object: drivers return jsonb
 * already parsed, and a bare JSON string would be indistinguishable from raw text.
 */
function unwrapSetting(raw: unknown): unknown {
  const value = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return value && typeof value === "object" && "v" in value ? (value as { v: unknown }).v : null;
}

/** Creates or updates the connector's md_ tables (sql/schema.sql). Safe to run on every start. */
export async function ensureSchema(pool: PgQueryable): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(new URL("../../sql/schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
}
