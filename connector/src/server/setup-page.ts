import { APP_SERVICES, mask, type AppService, type SavedServices } from "./app-services.js";

export type CheckResult = { id: string; label: string; state: "ok" | "warn" | "fail"; detail: string };

type SetupInput =
  | { kind: "missing"; missing: string[] }
  | { kind: "locked"; brandName: string }
  | {
      kind: "setup";
      brandName: string;
      dashboardUrl: string;
      siteOrigin: string;
      connectorOrigin: string;
      registered: boolean;
      services: SavedServices;
      checks: CheckResult[];
    };

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const STYLE = `
:root{--bg:#f6f6f7;--card:#fff;--fg:#111114;--muted:#62626b;--line:#e3e3e8;--ok:#127a3f;--warn:#a15c00;--fail:#c22b2b;--btn:#111114;--btnfg:#fff;--code:#f1f1f4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--card:#141418;--fg:#f2f2f4;--muted:#a3a3ad;--line:#26262c;--ok:#4fd18b;--warn:#f0b04d;--fail:#ff7a7a;--btn:#f2f2f4;--btnfg:#111114;--code:#1c1c22;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:32px 16px 64px;display:grid;gap:16px}
h1{font-size:24px;margin:0;letter-spacing:-.01em}
h2{font-size:17px;margin:0}
p{margin:0}
.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;display:grid;gap:12px;min-width:0}
.step{display:flex;gap:10px;align-items:baseline}
.n{flex:none;width:24px;height:24px;border-radius:50%;background:var(--btn);color:var(--btnfg);font-size:13px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}
ul.checks{list-style:none;margin:0;padding:0;display:grid;gap:6px}
ul.checks li{display:flex;gap:8px;align-items:flex-start}
.dot{flex:none;width:18px;text-align:center;font-weight:700}
.ok .dot{color:var(--ok)}.warn .dot{color:var(--warn)}.fail .dot{color:var(--fail)}
label{display:grid;gap:4px;font-size:13px;font-weight:500}
input{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);width:100%}
button{appearance:none;font:inherit;font-weight:600;border-radius:8px;padding:8px 14px;cursor:pointer;border:0;background:var(--btn);color:var(--btnfg);width:fit-content}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line);font-weight:500}
pre{margin:0;background:var(--code);border-radius:8px;padding:12px;overflow-x:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
details{border-top:1px solid var(--line);padding-top:10px}
summary{cursor:pointer;font-weight:600}
summary .muted{font-weight:400}
.grid{display:grid;gap:10px}
.err{color:var(--fail);font-size:13px;min-height:1em}
.pill{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
ol{margin:0;padding-left:20px;display:grid;gap:4px}
code{background:var(--code);border-radius:4px;padding:0 4px;font-size:.9em}
`;

const SCRIPT = `
const post = async (path, body) => {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return { ok: false, error: "Couldn't reach this app. Try again." };
  const data = await r.json().catch(() => ({}));
  return r.ok ? { ok: true } : { ok: false, error: data.error || ("Error " + r.status) };
};
document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
  const text = document.getElementById(b.dataset.copy).textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; } catch { b.textContent = "Select and copy (Ctrl+C)"; }
}));
document.querySelectorAll("form[data-action]").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = form.querySelector(".err");
  if (err) err.textContent = "";
  const values = Object.fromEntries(new FormData(form).entries());
  const action = form.dataset.action;
  let body;
  if (action === "unlock") body = { key: values.key };
  else if (action === "connect") body = { code: values.code };
  else body = { service: form.dataset.service, values, remove: event.submitter && event.submitter.value === "remove" };
  const path = action === "unlock" ? "/api/md/owner/unlock" : action === "connect" ? "/setup/connect" : "/setup/service";
  const result = await post(path, body);
  if (result.ok) location.reload();
  else if (err) err.textContent = action === "unlock" && result.error === "wrong_key" ? "That key isn't right." : result.error;
}));
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${body}</div><script>${SCRIPT}</script></body></html>`;
}

function checks(list: CheckResult[], ids: string[]): string {
  const items = list.filter((c) => ids.includes(c.id));
  if (!items.length) return "";
  return `<ul class="checks">${items
    .map((c) => `<li class="${c.state}"><span class="dot">${c.state === "ok" ? "✓" : c.state === "warn" ? "!" : "✗"}</span><span><strong>${esc(c.label)}</strong> <span class="muted">${esc(c.detail)}</span></span></li>`)
    .join("")}</ul>`;
}

function serviceForm(service: AppService, saved: Record<string, string> | undefined): string {
  return `<form class="grid" data-action="service" data-service="${service.id}">
    <ol class="muted">${service.howTo.map((h) => `<li>${esc(h)}</li>`).join("")}</ol>
    ${service.fields
      .map(
        (f) => `<label>${esc(f.label)}<input name="${f.name}" ${f.secret ? 'type="password" autocomplete="off"' : ""} placeholder="${esc(saved?.[f.name] ? (f.secret ? `Saved ${mask(saved[f.name]!)} (type again to change)` : saved[f.name]!) : f.placeholder ?? "")}" ${!f.secret && saved?.[f.name] ? `value="${esc(saved[f.name]!)}"` : ""} required></label>`
      )
      .join("")}
    <p class="err" role="alert"></p>
    <div class="row"><button type="submit" value="save">Save</button>${saved ? '<button class="ghost" type="submit" value="remove" formnovalidate>Turn off</button>' : ""}</div>
  </form>`;
}

export function sitePrompt(connectorOrigin: string): string {
  return `Connect this website to our Media Platform connector app. It's 3 small changes. Don't change anything else, and don't add any other Media Platform code: the connector app does the rest.

1. Rewrites. In next.config (js, mjs or ts), add these to async rewrites() (merge with any that exist):
   { source: "/api/md/:path*", destination: "${connectorOrigin}/api/md/:path*" },
   { source: "/media", destination: "${connectorOrigin}/media" },
   If the site has middleware/proxy, auth or i18n that runs on every path, make sure /api/md/* and /media pass through untouched. (If the site uses vercel.json rewrites instead, add the same two there.)

2. Tracker. In the root layout (app/layout.tsx), inside <body>, add:
   <Script src="/api/md/t.js" strategy="afterInteractive" />   (import Script from "next/script")

3. Email step. Find where the shopper types their email before being sent to Shopify's checkout. In the browser, right before redirecting to the Shopify checkout URL, add:
   await window.MediaDashboard?.checkoutStarted({ email, cartId });
   email = what they typed, cartId = the Shopify Storefront cart id (gid://shopify/Cart/...). It finishes within 1.5 seconds and never throws, so it can't block a sale. Add a TypeScript declaration for window.MediaDashboard if needed.

Optional, recommended: on product pages call window.MediaDashboard?.track("view_item", { id, name, price, currency }) once, and window.MediaDashboard?.track("add_to_cart", { id, name, price, currency, quantity }) when something is added (id = variant SKU or id).
Optional: add a "Creators" link to /media in the footer.

Commit and deploy. Then tell me to open ${connectorOrigin}/ and press "Check again".`;
}

function pixelCode(connectorOrigin: string): string {
  return `const URL = "${connectorOrigin}/api/md/shopify/step";
const send = (step, e) => {
  const c = e && e.data && e.data.checkout;
  const token = ((c && c.attributes) || []).find((a) => a.key === "md_cart")?.value || (c && c.token);
  if (token) fetch(URL, { method: "POST", keepalive: true, headers: { "content-type": "text/plain" }, body: JSON.stringify({ token, step }) });
};
analytics.subscribe("checkout_started", (e) => send("information", e));
analytics.subscribe("checkout_contact_info_submitted", (e) => send("shipping", e));
analytics.subscribe("checkout_shipping_info_submitted", (e) => send("payment", e));
analytics.subscribe("payment_info_submitted", (e) => send("paying", e));`;
}

export function updatePrompt(dashboardUrl: string): string {
  return `I'm about to update my Media Platform connector app (this repository). Before I accept it, compare my current code with the update (the pull request, or git diff between my version and the new one) and tell me in plain words:
1. Does anything in the update send data (sales, orders, customers, emails, visitors, recordings, settings or keys) anywhere it didn't before, especially to ${dashboardUrl}?
2. Does it change how the owner key or creator sign-in is checked, or who can see the sales screen?
List anything that touches those, with the file and line, and say whether it's safe to accept.`;
}

export function setupPage(input: SetupInput): string {
  if (input.kind === "missing") {
    return page(
      "Connector setup",
      `<h1>Almost there</h1>
      <div class="card"><p>These settings are missing in Vercel (Project → Settings → Environment Variables). Add them, then redeploy:</p>
      <ul>${input.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`
    );
  }
  if (input.kind === "locked") {
    return page(
      `${input.brandName} connector`,
      `<h1>${esc(input.brandName)} connector</h1>
      <div class="card"><h2>Owner sign-in</h2><p class="muted">Type the OWNER_KEY you set in Vercel. It's checked here, by your own app, and never sent to the Media Platform.</p>
      <form class="grid" data-action="unlock"><label>Owner key<input name="key" type="password" autocomplete="current-password" required minlength="12"></label><p class="err" role="alert"></p><button type="submit">Unlock</button></form></div>`
    );
  }
  const { checks: list, connectorOrigin, services } = input;
  const failing = list.filter((c) => c.state !== "ok").length;
  const optional = APP_SERVICES.filter((s) => s.optional);
  const shopify = APP_SERVICES.find((s) => s.id === "shopify")!;
  return page(
    `${input.brandName} connector`,
    `<div class="row" style="justify-content:space-between"><h1>${esc(input.brandName)} connector</h1>
      <span class="pill">${failing ? `${failing} to finish` : "All set ✓"}</span></div>
    <p class="muted">Your private data (sales, shoppers, emails, recordings) lives only in this app. Owners and creators use it at <a href="${esc(input.siteOrigin)}/media">${esc(input.siteOrigin)}/media</a>.</p>

    <div class="card"><div class="step"><span class="n">1</span><h2>Connect to the Media Platform</h2></div>
      ${checks(list, ["database", "platform"])}
      ${
        input.registered
          ? ""
          : `<p class="muted">On the Media Platform, open Integration and click "Get connect code". Paste it here.</p>
      <form class="grid" data-action="connect"><label>Connect code<input name="code" required autocomplete="off"></label><p class="err" role="alert"></p><button type="submit">Connect</button></form>`
      }
    </div>

    <div class="card"><div class="step"><span class="n">2</span><h2>Add it to your website</h2></div>
      <p class="muted">Paste this into Claude Code (or your AI) in your website's project. It's three small changes.</p>
      <pre id="sitePrompt">${esc(sitePrompt(connectorOrigin))}</pre>
      <div class="row"><button class="ghost" data-copy="sitePrompt" type="button">Copy prompt</button></div>
      ${checks(list, ["website", "media_page", "tracker", "checkout_email"])}
    </div>

    <div class="card"><div class="step"><span class="n">3</span><h2>Connect Shopify</h2></div>
      <ol>
        <li>Shopify admin → Settings → Notifications → Webhooks → <strong>Create webhook</strong> four times, format JSON, latest API version, URL:<pre id="hookUrl">${esc(connectorOrigin)}/api/md/shopify/webhook</pre>Events: <strong>Checkout creation</strong>, <strong>Checkout update</strong>, <strong>Order payment</strong>, <strong>Order update</strong>.</li>
        <li>Shopify admin → Settings → Customer events → <strong>Add custom pixel</strong> → name it "Media Platform", paste this code, set Permission to "Not required", Save, then Connect:<pre id="pixel">${esc(pixelCode(connectorOrigin))}</pre><button class="ghost" data-copy="pixel" type="button">Copy pixel code</button></li>
        <li>Fill in below.</li>
      </ol>
      ${serviceForm(shopify, services.shopify)}
      ${checks(list, ["shopify", "shopify_pixel"])}
    </div>

    <div class="card"><div class="step"><span class="n">4</span><h2>Optional services</h2></div>
      <p class="muted">Switch any on by pasting its key. No website changes needed: the tracker loads them for you.</p>
      ${optional
        .map(
          (s) => `<details${services[s.id] ? " open" : ""}><summary>${services[s.id] ? "✓ " : ""}${esc(s.name)} <span class="muted">· ${esc(s.summary)}</span></summary>${serviceForm(s, services[s.id])}</details>`
        )
        .join("")}
    </div>

    <div class="card"><h2>Status</h2>${checks(list, list.map((c) => c.id))}<div class="row"><button class="ghost" type="button" onclick="location.reload()">Check again</button></div></div>

    <div class="card"><h2>Updates</h2>
      <p class="muted">This app only changes when you choose to update it. Before accepting an update, paste this into your AI so it checks nothing sends your data anywhere new:</p>
      <pre id="updatePrompt">${esc(updatePrompt(input.dashboardUrl))}</pre>
      <div class="row"><button class="ghost" data-copy="updatePrompt" type="button">Copy prompt</button></div>
    </div>`
  );
}
