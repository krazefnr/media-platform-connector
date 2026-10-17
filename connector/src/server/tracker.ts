import { tagLoader, type BrowserTags } from "./tags.js";

export const CLICK_COOKIE = "md_click";
export const VISITOR_COOKIE = "md_vid";
export const TTCLID_COOKIE = "md_ttclid";

const js = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * GET {mountPath}/t.js. On every page:
 * - records a creator click when the URL carries ?{refParam}= (md_click cookie),
 * - records a marketing touch when the URL carries UTM tags or an ad click id,
 *   or the visitor came from another site (md_vid cookie, multi-touch attribution),
 * - keeps TikTok/Meta click ids for server-side conversions,
 * - tags the Microsoft Clarity session (md_vid, md_ref) so recordings can be
 *   found from the failed/abandoned checkout list,
 * - on Shopify themes, copies md_click and md_vid into cart attributes.
 * Honours Global Privacy Control, and waits for MediaDashboard.grantConsent()
 * when window.MD_WAIT_FOR_CONSENT is true. The endpoint base is taken from the
 * script's own URL, so it also works behind a proxy path.
 */
export function trackerScript(options: { refParam: string; mountPath: string; cookieWindowDays: number; tags?: BrowserTags }): string {
  const maxAge = Math.round(options.cookieWindowDays * 86_400);
  const tags = tagLoader(options.tags ?? {});
  return `(function () {
  "use strict";
  var REF = ${js(options.refParam)}, COOKIE = ${js(CLICK_COOKIE)}, VID = ${js(VISITOR_COOKIE)}, TTCLID = ${js(TTCLID_COOKIE)};
  var MAX_AGE = ${maxAge};
  var BASE = ${js(options.mountPath)};
  try {
    var own = document.currentScript && document.currentScript.src ? new URL(document.currentScript.src) : null;
    if (own && own.origin === location.origin) BASE = own.pathname.replace(/\\/t\\.js$/, "");
  } catch (e) {}
  var md = (window.MediaDashboard = window.MediaDashboard || {});
  if (md.__tracker) return;
  md.__tracker = true;

  // Clarity's own queue stub: tags set before Clarity loads are kept for it.
  function clarity() {
    window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    try { window.clarity.apply(null, arguments); } catch (e) {}
  }

  function readCookie(name, pattern) {
    var m = document.cookie.match(new RegExp("(?:^|;\\\\s*)" + name + "=(" + pattern + ")(?:;|$)"));
    return m ? m[1] : null;
  }
  function writeCookie(name, value, maxAge) {
    document.cookie = name + "=" + value + "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "");
  }
  var UUID = "[0-9a-fA-F-]{36}";
  function clickId() { return readCookie(COOKIE, UUID); }
  function visitorId() { return readCookie(VID, UUID); }
  function remember(id) {
    if (!id || clickId() === id) return;
    writeCookie(COOKIE, id, MAX_AGE);
  }
  function syncCart() {
    var attrs = {}, any = false, c = clickId(), v = visitorId();
    if (c) { attrs.md_click = c; any = true; }
    if (v) { attrs.md_vid = v; any = true; }
    if (!any || !window.Shopify || !window.fetch) return;
    fetch("/cart.js", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cart) {
        var a = (cart && cart.attributes) || {};
        if (!cart || (a.md_click === attrs.md_click && a.md_vid === attrs.md_vid)) return;
        return fetch("/cart/update.js", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ attributes: attrs })
        });
      })
      .catch(function () {});
  }
  function post(path, body) {
    return fetch(BASE + path, {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) { return r.ok && r.status !== 204 ? r.json() : null; });
  }

  md.clickId = clickId;
  md.visitorId = visitorId;
  md.syncCart = syncCart;
  /** Call on each checkout step (e.g. "information", "shipping", "payment") to tag the Clarity recording. */
  /**
   * Call where the shopper types their email, just before sending them to Shopify's checkout:
   *   await window.MediaDashboard?.checkoutStarted({ email, cartId })
   * Never takes longer than 1.5 seconds and never throws, so it can't hold up a sale.
   */
  md.checkoutStarted = function (input) {
    var data = input || {};
    if (!data.email || !data.cartId || !window.fetch) return Promise.resolve(false);
    clarity("set", "md_checkout_step", "email");
    var done = post("/checkout-started", { email: String(data.email).slice(0, 254), cart_id: String(data.cartId).slice(0, 300), first_name: data.firstName ? String(data.firstName).slice(0, 80) : undefined })
      .then(function () { return true; }, function () { return false; });
    return Promise.race([done, new Promise(function (r) { setTimeout(function () { r(false); }, 1500); })]);
  };

  /** Product page and add-to-cart events for the ad pixels: MediaDashboard.track("view_item" | "add_to_cart", { id, name, price, currency, quantity }). */
  md.track = function (event, item) {
    var i = item || {};
    var qty = Number(i.quantity) || 1, price = Number(i.price) || 0, value = Math.round(price * qty * 100) / 100, cur = i.currency || undefined;
    var add = event === "add_to_cart";
    if (event !== "view_item" && !add) return;
    try { if (window.ttq) window.ttq.track(add ? "AddToCart" : "ViewContent", { contents: [{ content_id: String(i.id), content_name: i.name, quantity: qty, price: price }], content_type: "product", value: value, currency: cur }); } catch (e) {}
    try { if (window.fbq) window.fbq("track", add ? "AddToCart" : "ViewContent", { content_ids: [String(i.id)], content_type: "product", value: value, currency: cur }); } catch (e) {}
    try { if (window.gtag) window.gtag("event", add ? "add_to_cart" : "view_item", { currency: cur, value: value, items: [{ item_id: String(i.id), item_name: i.name, price: price, quantity: qty }] }); } catch (e) {}
    try { if (window.pintrk) window.pintrk("track", add ? "addtocart" : "pagevisit", { value: value, currency: cur, line_items: [{ product_id: String(i.id), product_price: price, product_quantity: qty }] }); } catch (e) {}
    try { if (window.snaptr) window.snaptr("track", add ? "ADD_CART" : "VIEW_CONTENT", { item_ids: [String(i.id)], price: value, currency: cur }); } catch (e) {}
    clarity("event", "md_" + event);
  };

  function loadTags() {
${tags}
    // Single-page sites change pages without reloading: count each one as a page view.
    var last = location.pathname + location.search;
    function changed() {
      var now = location.pathname + location.search;
      if (now === last) return;
      last = now;
      try { if (window.ttq) window.ttq.page(); } catch (e) {}
      try { if (window.fbq) window.fbq("track", "PageView"); } catch (e) {}
      try { if (window.gtag) window.gtag("event", "page_view", { page_location: location.href }); } catch (e) {}
      try { if (window.pintrk) window.pintrk("page"); } catch (e) {}
      try { if (window.snaptr) window.snaptr("track", "PAGE_VIEW"); } catch (e) {}
    }
    ["pushState", "replaceState"].forEach(function (name) {
      var original = history[name];
      if (typeof original !== "function") return;
      history[name] = function () { var r = original.apply(this, arguments); setTimeout(changed, 0); return r; };
    });
    window.addEventListener("popstate", changed);
  }

  md.checkoutStep = function (step, checkoutId) {
    if (!step) return;
    clarity("set", "md_checkout_step", String(step).slice(0, 40));
    if (checkoutId) clarity("set", "md_checkout", String(checkoutId).slice(0, 100));
    clarity("event", "md_checkout_" + String(step).slice(0, 40));
  };

  function run() {
    if (navigator.globalPrivacyControl === true) return;
    loadTags();
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return; }
    if (!window.fetch) return;
    var ref = params.get(REF);
    var referrerHost = null;
    try {
      if (document.referrer) {
        var host = new URL(document.referrer).hostname;
        if (host && host !== location.hostname) referrerHost = host;
      }
    } catch (e) {}

    var ttclid = params.get("ttclid");
    if (ttclid) writeCookie(TTCLID, encodeURIComponent(ttclid.slice(0, 200)), 7 * 86400);
    var fbclid = params.get("fbclid");
    // Meta's documented _fbc format, for server-side conversions when the Meta pixel isn't installed.
    if (fbclid && !readCookie("_fbc", "[^;]+")) writeCookie("_fbc", "fb.1." + Date.now() + "." + encodeURIComponent(fbclid.slice(0, 200)), 90 * 86400);

    var touch = { landing_path: location.pathname };
    var signal = false;
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach(function (k) {
      var v = params.get(k);
      if (v) { touch[k] = v.slice(0, 120); signal = true; }
    });
    ["gclid", "fbclid", "ttclid", "msclkid"].forEach(function (k) {
      if (params.get(k)) { touch[k] = true; signal = true; }
    });
    if (ref) { touch.ref = ref.slice(0, 64); signal = true; clarity("set", "md_ref", ref.slice(0, 64)); }
    if (referrerHost) { touch.referrer_host = referrerHost; signal = true; }

    var v = visitorId();
    if (v) clarity("set", "md_vid", v);
    var pending = [];
    if (signal || !v) {
      pending.push(post("/touch", touch).then(function (data) {
        var id = data && typeof data.visitor_id === "string" ? data.visitor_id : null;
        if (id) clarity("set", "md_vid", id);
      }).catch(function () {}));
    }
    if (ref) {
      var body = { ref: ref.slice(0, 64), landing_path: location.pathname };
      var campaign = params.get("campaign");
      if (campaign) body.campaign = campaign.slice(0, 64);
      if (referrerHost) body.referrer_host = referrerHost;
      pending.push(post("/click", body).then(function (data) {
        remember(data && typeof data.click_id === "string" ? data.click_id : null);
      }).catch(function () {}));
    }
    Promise.all(pending).then(syncCart);
  }

  if (window.MD_WAIT_FOR_CONSENT === true) {
    var started = false;
    md.grantConsent = function () { if (!started) { started = true; run(); } };
  } else {
    md.grantConsent = function () {};
    run();
  }
})();
`;
}
