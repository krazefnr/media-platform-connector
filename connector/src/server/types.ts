export type AffiliateStatus = "pending" | "active" | "suspended";

export type ProgramSettings = {
  storefront_url: string | null;
  ref_param: string;
  cookie_window_days: number;
  attribution_model: "last_click";
  default_commission_bps: number;
  default_customer_discount_bps: number;
  allowed_deep_link_domains: string[];
};

export type ConfigCreator = {
  id: string;
  username: string;
  display_name: string | null;
  brand_user_ref: string | null;
};

export type ConfigAffiliate = {
  id: string;
  code: string;
  status: AffiliateStatus;
  commission_bps: number;
  customer_discount_bps: number | null;
  creator: ConfigCreator;
};

export type ConfigCampaign = {
  id: string;
  title: string;
  type: "video" | "live";
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
};

export type ConfigLink = {
  id: string;
  affiliate_id: string;
  label: string;
  target_path: string;
};

/**
 * Wording and timing for cart-recovery emails, edited in the dashboard. The
 * connector sends them itself, through the brand's own email account.
 * Placeholders: {{first_name}} {{brand_name}} {{cart_total}} {{creator_name}}.
 */
export type RecoveryEmailTemplate = {
  enabled: boolean;
  /** Minutes an unpaid checkout waits before the email (and the checkout counts as abandoned). */
  delay_minutes: number;
  subject: string;
  heading: string;
  body: string;
  button_label: string;
  footer: string;
};

/** What GET {dashboard}/api/brand/{brand}/config returns: configuration only, never activity. */
export type ProgramConfig = {
  version: 1;
  brand: string;
  generated_at: string;
  program: ProgramSettings;
  affiliates: ConfigAffiliate[];
  campaigns: ConfigCampaign[];
  links: ConfigLink[];
  /** Absent from older dashboards. */
  recovery_email?: RecoveryEmailTemplate | null;
};

export type ConfigRejection = "storefront_url" | "allowed_deep_link_domains";

/** Who is looking at the brand's site, decided by the brand's own session code. */
export type Viewer = { role: "admin" } | { role: "creator"; userRef: string };

export type StatsRange = "7d" | "30d" | "90d";

export type Metrics = {
  clicks: number;
  checkouts_started: number;
  checkouts_failed: number;
  checkouts_abandoned: number;
  /** Non-test orders placed in the range, including ones refunded later. */
  orders: number;
  /** Non-test, non-refunded order totals in the response currency. */
  revenue: number;
  commission: number;
  /** Non-test orders in the range that were refunded. */
  refunds: number;
  /** orders / clicks (0 when there are no clicks). Can exceed 1 when codes typed at checkout bring orders without clicks. */
  conversion_rate: number;
  test_orders: number;
};

export type CreatorStatsRow = Metrics & {
  creator_id: string;
  username: string;
  display_name: string | null;
};

export type CodeStatsRow = Metrics & {
  affiliate_id: string;
  code: string;
  creator_id: string | null;
  status: AffiliateStatus | null;
};

export type LinkStatsRow = Metrics & {
  link_id: string;
  affiliate_id: string;
  code: string;
  label: string;
  target_path: string;
};

export type CampaignStatsRow = Metrics & {
  campaign_id: string | null;
  title: string;
};

export type DailyStatsRow = {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  clicks: number;
  orders: number;
  revenue: number;
};

export type CurrencyStatsRow = {
  currency: string;
  orders: number;
  revenue: number;
  commission: number;
};

/** A creator's share link, built by this site from its own storefront origin and the creator's approved codes. */
export type ShareLink = {
  affiliate_id: string;
  code: string;
  label: string;
  url: string;
};

export type CreatorLinkCode = { affiliate_id: string; code: string };

/**
 * Admin only: which login of this site sees which creator's numbers. The
 * dashboard only proposes a login (brand_user_ref in its config); nothing is
 * shown to a creator until an admin of this site approves it here.
 */
export type CreatorLinkRow = {
  creator_id: string;
  username: string;
  display_name: string | null;
  /** approved: pinned here. pending: proposed by the dashboard. blocked: proposed, but that login is approved for another creator. */
  status: "approved" | "pending" | "blocked";
  /** approved: the pinned login. pending/blocked: the proposed one. */
  user_ref: string;
  /** approved: the pinned codes. pending/blocked: the codes the dashboard lists for this creator. */
  codes: CreatorLinkCode[];
  approved_at: string | null;
  /** What the dashboard's config says now; for an approved row it may differ from the pinned values. */
  dashboard_user_ref: string | null;
  dashboard_codes: CreatorLinkCode[];
};

/** GET {mountPath}/stats response. */
export type StatsResponse = {
  range: StatsRange;
  generated_at: string;
  role: "admin" | "creator";
  /** Creator: false until an admin of this site has approved their login (always true for admins). */
  linked: boolean;
  /** Creator: the dashboard proposed their login and it waits for an admin's approval. */
  link_pending: boolean;
  /** The currency with the most orders in the range; revenue and commission are in this currency only. */
  currency: string | null;
  totals: Metrics;
  /** Admin: every creator with activity. Creator: just them. */
  by_creator: CreatorStatsRow[];
  by_code: CodeStatsRow[];
  by_link: LinkStatsRow[];
  by_campaign: CampaignStatsRow[];
  daily: DailyStatsRow[];
  /** Orders in other currencies, kept out of revenue/commission above. Usually empty. */
  other_currencies: CurrencyStatsRow[];
  /** Creator only: links to share, on this site's own storefront. */
  share_links: ShareLink[];
  /** Admin only: approved and proposed creator logins. */
  creator_links: CreatorLinkRow[];
  /** Admin only: why the dashboard's latest programme settings were refused, if they were. */
  config_warning: string | null;
};
