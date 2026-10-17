import { randomBytes } from "node:crypto";

/*
 * GET /media on the brand's own domain: the media platform's dashboard in an
 * iframe, with this site's private data drawn over it by /api/md/host.js.
 * Plain HTML (no framework assets), so it works behind the main site's rewrite.
 * The owner's key is only ever typed into THIS page's top bar, which belongs
 * to the brand's own site; the platform's iframe never sees it.
 */

const esc = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const js = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, " ");

export type MediaPageInput = {
  brandName: string;
  dashboardOrigin: string;
  /** iframe src: an admin entry link for the owner, a creator embed link otherwise. */
  src: string;
  /** Owner only: a second, separately minted entry link for "open in a new tab". */
  newTabSrc: string | null;
  owner: boolean;
  mountPath: string;
};

export function mediaPage(input: MediaPageInput): { html: string; headers: Record<string, string> } {
  const nonce = randomBytes(16).toString("base64");
  const { brandName, owner, mountPath } = input;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(brandName)} · Media Platform</title>
<style nonce="${nonce}">
  :root{--bg:#f6f6f7;--bar:#ffffff;--fg:#111114;--muted:#6b6b73;--line:#e4e4e8;--ok:#127a3f;--btn:#111114;--btnfg:#fff;color-scheme:light}
  @media (prefers-color-scheme:dark){:root{--bg:#0b0b0d;--bar:#141418;--fg:#f2f2f4;--muted:#a0a0aa;--line:#26262c;--ok:#4fd18b;--btn:#f2f2f4;--btnfg:#111114;color-scheme:dark}}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .bar{position:sticky;top:0;z-index:10;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding:10px 16px;background:var(--bar);border-bottom:1px solid var(--line)}
  .brand{font-weight:600}
  .state{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--muted)}
  .ok{color:var(--ok);font-weight:500}
  button,.link{appearance:none;font:inherit;font-weight:500;border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none}
  .primary{background:var(--btn);color:var(--btnfg);border:0}
  .ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
  main{padding:0}
  #md{min-height:calc(100vh - 54px)}
  dialog{border:1px solid var(--line);border-radius:12px;padding:20px;max-width:380px;width:calc(100% - 32px);background:var(--bar);color:var(--fg)}
  dialog::backdrop{background:rgba(0,0,0,.45)}
  dialog h2{margin:0 0 6px;font-size:17px}
  dialog p{margin:0 0 12px;color:var(--muted)}
  input{width:100%;font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);margin-bottom:10px}
  .row{display:flex;gap:8px;justify-content:flex-end}
  .err{color:#d33;min-height:1.2em;margin:0 0 8px}
</style>
</head>
<body>
<header class="bar">
  <span class="brand">${esc(brandName)}</span>
  <span class="state">
    ${
      owner
        ? `<span class="ok">&#128275; Owner view, unlocked on this device</span>
    ${input.newTabSrc ? `<a class="link ghost" href="${esc(input.newTabSrc)}" target="_blank" rel="noreferrer">Open in a new tab</a>` : ""}
    <button class="ghost" id="lock" type="button">Lock</button>`
        : `<span>Creators: sign in below.</span>
    <button class="primary" id="unlock" type="button">I'm the owner</button>`
    }
  </span>
</header>
<main><div id="md"></div></main>
${
  owner
    ? ""
    : `<dialog id="keyDialog">
  <form method="dialog" id="keyForm">
    <h2>Unlock the owner view</h2>
    <p>Type your owner key. It's checked by ${esc(brandName)}'s own app and never sent to the Media Platform. Only ever type it here, in this top bar, never inside the dashboard.</p>
    <input id="key" type="password" autocomplete="current-password" placeholder="Owner key" required minlength="12" maxlength="512">
    <p class="err" id="keyErr" role="alert"></p>
    <div class="row"><button class="ghost" value="cancel" type="button" id="cancel">Cancel</button><button class="primary" type="submit">Unlock</button></div>
  </form>
</dialog>`
}
<script type="module" nonce="${nonce}">
  import { mountMediaDashboard } from ${js(`${mountPath}/host.js`)};
  mountMediaDashboard({ container: document.getElementById("md"), src: ${js(input.src)}, dashboardOrigin: ${js(input.dashboardOrigin)}, title: ${js(`${brandName} · Media Platform`)}, nonce: ${js(nonce)} });
  const post = (path, body) => fetch(${js(mountPath)} + path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const lock = document.getElementById("lock");
  if (lock) lock.addEventListener("click", async () => { await post("/owner/lock"); location.reload(); });
  const dialog = document.getElementById("keyDialog");
  if (dialog) {
    document.getElementById("unlock").addEventListener("click", () => { dialog.showModal(); document.getElementById("key").focus(); });
    document.getElementById("cancel").addEventListener("click", () => dialog.close());
    document.getElementById("keyForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const err = document.getElementById("keyErr");
      err.textContent = "";
      const response = await post("/owner/unlock", { key: document.getElementById("key").value }).catch(() => null);
      if (response && response.ok) { location.reload(); return; }
      const status = response ? response.status : 0;
      err.textContent = status === 401 ? "That key isn't right." : status === 429 ? "Too many tries. Wait a minute and try again." : "Couldn't check the key. Try again.";
    });
  }
</script>
</body>
</html>`;
  return {
    html,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "strict-origin",
      "x-frame-options": "DENY",
      "content-security-policy": [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}'`,
        `frame-src ${input.dashboardOrigin}`,
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join("; "),
    },
  };
}
