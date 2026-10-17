/*
 * The services an owner can switch on from the connector app's setup page by
 * pasting a key. Saved in the brand's own database; never sent to the media
 * platform (only the service NAMES are reported, so the platform can show a tick).
 */

export type ServiceField = {
  name: string;
  label: string;
  /** Shown masked, never echoed back in full. */
  secret?: boolean;
  placeholder?: string;
  pattern: RegExp;
  error: string;
};

export type AppService = {
  id: string;
  name: string;
  /** One line on what it does. */
  summary: string;
  /** Where to find the values, step by step. */
  howTo: string[];
  fields: ServiceField[];
  optional: boolean;
};

const field = (f: ServiceField) => f;

export const APP_SERVICES: AppService[] = [
  {
    id: "shopify",
    name: "Shopify",
    summary: "Ties checkouts and orders to creators and ads, and logs who didn't pay.",
    howTo: [
      "Store domain: Shopify admin → Settings → Domains. Use the one ending in .myshopify.com.",
      "Storefront token: the Storefront API token your website already uses (in your website's Vercel environment variables). Or Shopify admin → Settings → Apps → Headless → your storefront → Storefront API → Public access token.",
      "Webhook secret: after creating the webhooks below, Shopify admin → Settings → Notifications → Webhooks shows \"Your webhooks will be signed with …\". Paste that value.",
    ],
    optional: false,
    fields: [
      field({ name: "storeDomain", label: "Store domain", placeholder: "kraze.myshopify.com", pattern: /^[a-z0-9-]+\.myshopify\.com$|^(localhost|127\.0\.0\.1):\d+$/i, error: "Use the domain ending in .myshopify.com." }),
      field({ name: "storefrontToken", label: "Storefront token", secret: true, pattern: /^[A-Za-z0-9_-]{16,200}$/, error: "That doesn't look like a Storefront API token." }),
      field({ name: "webhookSecret", label: "Webhook signing secret", secret: true, pattern: /^[A-Za-z0-9_+/=-]{16,200}$/, error: "Paste the signing secret from the Webhooks page." }),
    ],
  },
  {
    id: "resend",
    name: "Resend (cart-recovery emails)",
    summary: "Emails shoppers who didn't pay, from your own address.",
    howTo: [
      "Sign up at resend.com → Domains → Add domain (your shop's domain) → add the DNS records it shows → wait for Verified.",
      "API Keys → Create API key with Sending access. Paste it below.",
      "Turn off Shopify's own abandoned-checkout email (Shopify admin → Marketing → Automations) so shoppers don't get two.",
      "Write the email in the Media Platform → Integration → Cart recovery email.",
    ],
    optional: true,
    fields: [
      field({ name: "apiKey", label: "Resend API key", secret: true, placeholder: "re_…", pattern: /^re_[A-Za-z0-9_-]{8,200}$/, error: "A Resend key starts with re_." }),
      field({ name: "from", label: "Send from", placeholder: "Kraze <hello@kraze.com>", pattern: /^[^<>\n]{0,80}<[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>$|^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i, error: "Use an address like Kraze <hello@kraze.com>." }),
    ],
  },
  {
    id: "tiktok",
    name: "TikTok Pixel + Events API",
    summary: "Tracks TikTok ads; purchases are sent from the server so none go missing.",
    howTo: [
      "TikTok Ads Manager → Tools → Events → Web events → your pixel. Copy the pixel code (looks like C4ABC…).",
      "Same pixel → Settings → Events API → Generate access token.",
      "If the TikTok app in Shopify shares purchase data, switch that off so purchases aren't counted twice.",
    ],
    optional: true,
    fields: [
      field({ name: "pixelCode", label: "Pixel code", placeholder: "C4ABCDEF123456", pattern: /^[A-Z0-9]{10,30}$/, error: "The pixel code is letters and numbers, like C4ABC123…" }),
      field({ name: "accessToken", label: "Events API token", secret: true, pattern: /^[A-Za-z0-9_-]{16,300}$/, error: "That doesn't look like an Events API token." }),
    ],
  },
  {
    id: "meta",
    name: "Meta Pixel + Conversions API",
    summary: "Tracks Facebook & Instagram ads; purchases sent from the server.",
    howTo: [
      "Meta Events Manager → your dataset (pixel) → copy the ID.",
      "Settings → Conversions API → Generate access token.",
      "If the Facebook & Instagram app in Shopify shares data at Maximum, lower it so purchases aren't counted twice.",
    ],
    optional: true,
    fields: [
      field({ name: "pixelId", label: "Pixel ID", placeholder: "1234567890", pattern: /^\d{5,25}$/, error: "The pixel ID is all numbers." }),
      field({ name: "accessToken", label: "Conversions API token", secret: true, pattern: /^[A-Za-z0-9_-]{20,500}$/, error: "That doesn't look like a Conversions API token." }),
    ],
  },
  {
    id: "ga4",
    name: "Google Analytics 4",
    summary: "Traffic and sales reports; purchases sent from the server.",
    howTo: [
      "analytics.google.com → Admin → Data streams → your website stream. Copy the Measurement ID (G-…).",
      "Same stream → Measurement Protocol API secrets → Create.",
    ],
    optional: true,
    fields: [
      field({ name: "measurementId", label: "Measurement ID", placeholder: "G-ABC123", pattern: /^G-[A-Z0-9]{4,20}$/, error: "The Measurement ID starts with G-." }),
      field({ name: "apiSecret", label: "API secret", secret: true, pattern: /^[A-Za-z0-9_-]{8,200}$/, error: "That doesn't look like an API secret." }),
    ],
  },
  {
    id: "clarity",
    name: "Microsoft Clarity",
    summary: "Recordings of shoppers using your site; lost checkouts link to them.",
    howTo: ["clarity.microsoft.com → New project → your site. Settings → Overview → copy the Project ID. Keep Masking on Balanced or Strict."],
    optional: true,
    fields: [field({ name: "projectId", label: "Project ID", placeholder: "abc123xyz", pattern: /^[a-z0-9]{6,20}$/i, error: "The Project ID is letters and numbers." })],
  },
  {
    id: "pinterest",
    name: "Pinterest Tag",
    summary: "Only if you run Pinterest ads.",
    howTo: ["Pinterest Business → Ads → Conversions → Pinterest Tag. Copy the Tag ID."],
    optional: true,
    fields: [field({ name: "tagId", label: "Tag ID", pattern: /^\d{5,25}$/, error: "The Tag ID is all numbers." })],
  },
  {
    id: "snap",
    name: "Snapchat Pixel",
    summary: "Only if you run Snapchat ads.",
    howTo: ["Snapchat Ads Manager → Events Manager → your pixel. Copy the Pixel ID."],
    optional: true,
    fields: [field({ name: "pixelId", label: "Pixel ID", pattern: /^[a-f0-9-]{20,60}$/i, error: "Copy the Pixel ID exactly." })],
  },
  {
    id: "webhook",
    name: "Alerts to other apps (Zapier, Make, Slack)",
    summary: "Signed messages when checkouts fail or are abandoned and orders are paid.",
    howTo: ["Create a Catch Hook in Zapier (Webhooks by Zapier) or a custom webhook in Make. Paste its URL, and make up a secret of 16+ characters."],
    optional: true,
    fields: [
      field({ name: "url", label: "Webhook URL", placeholder: "https://hooks.zapier.com/…", pattern: /^https:\/\/[^\s]{4,500}$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/, error: "Use the full https:// URL." }),
      field({ name: "secret", label: "Secret", secret: true, pattern: /^.{16,200}$/, error: "Make up a secret of at least 16 characters." }),
    ],
  },
];

export const APP_SERVICE_BY_ID = new Map(APP_SERVICES.map((s) => [s.id, s]));

export type SavedServices = Record<string, Record<string, string>>;

/** Validates a form for one service. Returns the clean values, or the first error. */
export function validateService(id: string, input: unknown): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
  const service = APP_SERVICE_BY_ID.get(id);
  if (!service) return { ok: false, error: "Unknown service." };
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const values: Record<string, string> = {};
  for (const f of service.fields) {
    const v = typeof raw[f.name] === "string" ? (raw[f.name] as string).trim() : "";
    if (!f.pattern.test(v)) return { ok: false, error: `${f.label}: ${f.error}` };
    values[f.name] = v;
  }
  return { ok: true, values };
}

/** "••••1a2b" for a saved secret. */
export function mask(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
