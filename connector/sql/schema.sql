-- Media dashboard brand connector: tables in the BRAND's own database.
-- Prefixed md_ so they can live next to the site's existing tables. Safe to re-run.
-- Nothing in these tables is ever sent to the media dashboard.

create table if not exists md_clicks (
  id            uuid primary key,
  affiliate_id  uuid not null,
  creator_id    uuid,
  code          text not null,
  campaign_id   uuid,
  link_id       uuid,
  landing_path  text,            -- path only, no query string
  referrer_host text,            -- host only
  ip_hash       text,            -- keyed hash, never the IP
  created_at    timestamptz not null default now()
);

create index if not exists md_clicks_created_at_idx on md_clicks (created_at);
create index if not exists md_clicks_affiliate_created_idx on md_clicks (affiliate_id, created_at);

create table if not exists md_checkouts (
  id             text primary key,  -- the site's own checkout / cart id
  click_id       uuid,
  affiliate_id   uuid not null,
  creator_id     uuid,
  code           text not null,     -- the credited affiliate's code
  typed_code     text,              -- the code the customer typed, if any
  campaign_id    uuid,
  link_id        uuid,
  cart_total     numeric(18, 4) not null default 0,
  currency       char(3) not null,
  status         text not null default 'started' check (status in ('started', 'failed', 'completed')),
  failure_reason text,
  test           boolean not null default false,  -- test-mode checkouts are never counted
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table md_checkouts add column if not exists typed_code text;
alter table md_checkouts add column if not exists test boolean not null default false;

create index if not exists md_checkouts_created_at_idx on md_checkouts (created_at);
create index if not exists md_checkouts_affiliate_created_idx on md_checkouts (affiliate_id, created_at);

create table if not exists md_orders (
  id             text primary key,  -- the site's own order id; makes recordOrder idempotent
  checkout_id    text,
  click_id       uuid,
  affiliate_id   uuid not null,
  creator_id     uuid,
  code           text not null,
  campaign_id    uuid,
  link_id        uuid,
  attributed_via text not null check (attributed_via in ('click', 'code')),
  amount         numeric(18, 4) not null check (amount >= 0),
  currency       char(3) not null,
  commission_bps integer not null check (commission_bps between 0 and 10000),
  commission     numeric(18, 4) not null check (commission >= 0),
  product_ref    text,
  test           boolean not null default false,
  occurred_at    timestamptz not null,
  refunded_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists md_orders_occurred_at_idx on md_orders (occurred_at);
create index if not exists md_orders_affiliate_occurred_idx on md_orders (affiliate_id, occurred_at);
create index if not exists md_orders_checkout_idx on md_orders (checkout_id);

-- Refunds whose order wasn't recorded yet (webhooks arrive out of order). Applied when the
-- order is recorded; dropped after 30 days (most belong to orders no creator gets credit for).
create table if not exists md_pending_refunds (
  order_id    text primary key,
  refunded_at timestamptz not null,
  received_at timestamptz not null default now()
);

-- Which login of this site sees which creator's numbers. The dashboard only proposes a login
-- (brand_user_ref in its config); a row exists once an admin of this site approves it, and the
-- creator's view is limited to the codes pinned here.
create table if not exists md_creator_links (
  creator_id    uuid primary key,
  user_ref      text not null unique,
  affiliate_ids uuid[] not null default '{}',
  approved_at   timestamptz not null default now()
);

-- The last programme config accepted from the dashboard, so request handlers and new server
-- instances never have to pull it. Configuration only, never activity.
create table if not exists md_config (
  brand      text primary key,
  config     jsonb,
  fetched_at timestamptz,
  rejected   text  -- why the dashboard's latest config was refused, if it was
);

-- Marketing touches for multi-touch attribution: one row when a visitor lands with UTM tags,
-- an ad click id, a creator code or an outside referrer. visitor_id is the random md_vid
-- cookie; no IP, no query string, no personal data.
create table if not exists md_touches (
  id           uuid primary key,
  visitor_id   uuid not null,
  channel      text not null,
  source       text,
  medium       text,
  campaign     text,
  content      text,
  ref_code     text,
  landing_path text,
  created_at   timestamptz not null default now()
);

create index if not exists md_touches_visitor_created_idx on md_touches (visitor_id, created_at);
create index if not exists md_touches_created_at_idx on md_touches (created_at);

-- Every order's journey (its touches before the order, oldest first), whether or not a
-- creator is credited. Also makes conversion forwarding idempotent per order id.
create table if not exists md_journeys (
  order_id    text primary key,
  visitor_id  uuid,
  amount      numeric(18, 4) not null check (amount >= 0),
  currency    char(3) not null,
  test        boolean not null default false,
  occurred_at timestamptz not null,
  refunded_at timestamptz,
  touches     jsonb not null default '[]'
);

create index if not exists md_journeys_occurred_at_idx on md_journeys (occurred_at);

-- Every checkout the site reports (credited or not): abandoned-checkout webhooks and the
-- failed / abandoned checkout list on the admin sales screen.
create table if not exists md_checkout_watch (
  id                    text primary key,
  visitor_id            uuid,
  click_id              uuid,
  affiliate_id          uuid,
  creator_id            uuid,
  code                  text,
  cart_total            numeric(18, 4) not null default 0,
  currency              char(3) not null,
  status                text not null default 'started' check (status in ('started', 'failed', 'completed')),
  failure_reason        text,
  step                  text,
  customer_ref          text,  -- the site's own customer reference, never sent anywhere but its own webhooks
  recovery_url          text,
  test                  boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  abandoned_notified_at timestamptz
);

create index if not exists md_checkout_watch_created_at_idx on md_checkout_watch (created_at);
create index if not exists md_checkout_watch_affiliate_created_idx on md_checkout_watch (affiliate_id, created_at);
create index if not exists md_checkout_watch_abandon_idx on md_checkout_watch (created_at)
  where status = 'started' and abandoned_notified_at is null and not test;

-- Shopper contact details for checkouts, kept in the brand's own database as its record of each checkout.
alter table md_checkout_watch add column if not exists email text;
alter table md_checkout_watch add column if not exists first_name text;
alter table md_checkout_watch add column if not exists marketing_consent boolean not null default false;
alter table md_checkout_watch add column if not exists recovery_sent_at timestamptz;
create index if not exists md_checkout_watch_email_idx on md_checkout_watch (email) where email is not null;

-- Shoppers who clicked "unsubscribe" in a recovery email. Never emailed again; their checkouts stay recorded.
create table if not exists md_email_suppressions (
  email           text primary key,
  unsubscribed_at timestamptz not null default now()
);

-- The connector app's own small settings: its key pair, the service keys the owner pasted in its
-- setup page, and status timestamps for the self-check. Never sent to the media dashboard.
create table if not exists md_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Sign-in tokens already used, so none can be replayed.
create table if not exists md_used_tokens (
  id         text primary key,
  expires_at timestamptz not null
);

-- On Supabase, tables in "public" are reachable through its Data API with the project's public
-- (anon) key, which a storefront ships to every browser. Row level security with no policies
-- shuts that door; this app connects as the tables' owner, which RLS doesn't apply to.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = current_schema() and tablename like 'md\_%' loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on table %I from anon', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on table %I from authenticated', t);
    end if;
  end loop;
end $$;
