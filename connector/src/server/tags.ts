/*
 * Browser tags the tracker loads by itself, from ids the owner saved in the
 * connector app: adding Clarity or an ad pixel never needs a code change on
 * the brand's site. Official base snippets, minified. Purchases are sent from
 * the server (conversions), not from these tags, so nothing is counted twice.
 */

export type BrowserTags = {
  clarity?: string | null;
  tiktok?: string | null;
  meta?: string | null;
  ga4?: string | null;
  pinterest?: string | null;
  snap?: string | null;
};

const ID_RE: Record<keyof BrowserTags, RegExp> = {
  clarity: /^[a-z0-9]{6,20}$/i,
  tiktok: /^[A-Z0-9]{10,30}$/,
  meta: /^\d{5,25}$/,
  ga4: /^G-[A-Z0-9]{4,20}$/,
  pinterest: /^\d{5,25}$/,
  snap: /^[a-f0-9-]{20,60}$/i,
};

/** Only well-formed ids are kept, so nothing typed into a settings field can become script. */
export function cleanTags(input: BrowserTags | null | undefined): BrowserTags {
  const out: BrowserTags = {};
  for (const key of Object.keys(ID_RE) as (keyof BrowserTags)[]) {
    const value = typeof input?.[key] === "string" ? input[key]!.trim() : "";
    if (value && ID_RE[key].test(value)) out[key] = value;
  }
  return out;
}

const q = (value: string) => JSON.stringify(value);

/** JavaScript that loads the configured tags; runs inside the tracker after consent/GPC checks. */
export function tagLoader(tags: BrowserTags): string {
  const parts: string[] = [];
  if (tags.clarity) {
    parts.push(
      `(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${q(tags.clarity)});`
    );
  }
  if (tags.tiktok) {
    parts.push(
      `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e};ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=d.createElement("script");o.type="text/javascript",o.async=!0,o.src=r+"?sdkid="+e+"&lib="+t;var a=d.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load(${q(tags.tiktok)});ttq.page();}(window,document,"ttq");`
    );
  }
  if (tags.meta) {
    parts.push(
      `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version="2.0";n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq("init",${q(tags.meta)});fbq("track","PageView");`
    );
  }
  if (tags.ga4) {
    parts.push(
      `(function(){var s=document.createElement("script");s.async=true;s.src="https://www.googletagmanager.com/gtag/js?id="+encodeURIComponent(${q(tags.ga4)});document.head.appendChild(s);window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||function(){window.dataLayer.push(arguments)};gtag("js",new Date());gtag("config",${q(tags.ga4)});})();`
    );
  }
  if (tags.pinterest) {
    parts.push(
      `!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");pintrk("load",${q(tags.pinterest)});pintrk("page");`
    );
  }
  if (tags.snap) {
    parts.push(
      `(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s="script",r=t.createElement(s);r.async=!0;r.src=n;var u=t.getElementsByTagName(s)[0];u.parentNode.insertBefore(r,u)})(window,document,"https://sc-static.net/scevent.min.js");snaptr("init",${q(tags.snap)});snaptr("track","PAGE_VIEW");`
    );
  }
  return parts.map((p) => `try{${p}}catch(e){}`).join("\n");
}
