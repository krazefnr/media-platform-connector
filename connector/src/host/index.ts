import type {
  CampaignStatsRow,
  CodeStatsRow,
  CreatorLinkRow,
  CreatorStatsRow,
  DailyStatsRow,
  LinkStatsRow,
  Metrics,
  ShareLink,
  StatsRange,
  StatsResponse,
} from "../server/types.js";
import type { AttributionModel, AttributionReport, ChannelRow, CreatorAssistRow, PathRow } from "../server/journey.js";
import type { CheckoutListResponse, CheckoutListRow } from "../server/connector.js";

/*
 * Runs in the browser on the brand's own page. It embeds the media dashboard
 * iframe and draws the brand's sales screen over the placeholder slot the
 * dashboard reserves. Sales data is fetched from the brand's own server and
 * only ever lives in this page: the one thing sent into the iframe is a fixed
 * panel height the brand chose, which never depends on the data.
 */

export const CHILD_SOURCE = "media-dashboard";
export const HOST_SOURCE = "media-dashboard-host";
export const BRIDGE_VERSION = 1;
export const PANEL_ID = "affiliate-data";

/**
 * What the dashboard iframe may do. No allow-top-navigation*: dashboard code
 * can never navigate the brand's page (to a fake login, say). The rest is what
 * the dashboard uses: storage and cookies, forms, new tabs, confirm(), downloads.
 */
export const IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
export const IFRAME_REFERRER_POLICY = "strict-origin";
export const DEFAULT_PANEL_HEIGHT = 960;
const MIN_PANEL_HEIGHT = 240;
const MAX_PANEL_HEIGHT = 20_000;

export type PanelRole = "admin" | "creator";
export type PanelTheme = "light" | "dark";
/** CSS px, relative to the top-left of the iframe's document. */
export type PanelRect = { top: number; left: number; width: number; height: number };

export type ResizeMessage = { type: "resize"; height: number };
export type PanelOpenMessage = {
  type: "panel";
  panel: typeof PANEL_ID;
  state: "open";
  role: PanelRole;
  rect: PanelRect;
  theme: PanelTheme;
  /**
   * Creators only: a short-lived token, signed by the platform, naming who
   * signed in. Exchanged once with this site's own app (POST {mount}/session).
   * It names a person; it never carries data.
   */
  identity?: string;
};
export type PanelClosedMessage = { type: "panel"; panel: typeof PANEL_ID; state: "closed" };
export type ChildMessage = ResizeMessage | PanelOpenMessage | PanelClosedMessage;

export type PanelReadyMessage = {
  source: typeof HOST_SOURCE;
  v: typeof BRIDGE_VERSION;
  type: "panel-ready";
  panel: typeof PANEL_ID;
  height: number;
};

const MAX_PX = 1_000_000;

function px(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= MAX_PX ? value : null;
}

/** The panel height the page reports: the brand's choice, clamped, whole pixels. */
export function resolvePanelHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PANEL_HEIGHT;
  return Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(value)));
}

/** Throws unless the iframe is sandboxed without any way to navigate the brand's page. */
export function assertSandboxed(frame: { getAttribute(name: string): string | null }): void {
  const sandbox = frame.getAttribute("sandbox");
  if (sandbox === null) {
    throw new Error(`mountMediaDashboard: give the iframe sandbox="${IFRAME_SANDBOX}" before it loads.`);
  }
  if (/(^|\s)allow-top-navigation/i.test(sandbox)) {
    throw new Error("mountMediaDashboard: the iframe's sandbox must not allow top navigation.");
  }
}

export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Accepts only well-formed v1 messages from the dashboard iframe. "resize" without v is accepted for older dashboards. */
export function parseChildMessage(data: unknown): ChildMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.source !== CHILD_SOURCE) return null;
  if (m.type === "resize") {
    if (m.v !== undefined && m.v !== BRIDGE_VERSION) return null;
    const height = px(m.height, 0);
    return height === null ? null : { type: "resize", height: Math.ceil(height) };
  }
  if (m.v !== BRIDGE_VERSION || m.type !== "panel" || m.panel !== PANEL_ID) return null;
  if (m.state === "closed") return { type: "panel", panel: PANEL_ID, state: "closed" };
  if (m.state !== "open") return null;
  if (m.role !== "admin" && m.role !== "creator") return null;
  if (m.theme !== "light" && m.theme !== "dark") return null;
  const r = m.rect && typeof m.rect === "object" ? (m.rect as Record<string, unknown>) : null;
  if (!r) return null;
  // Negative when the slot is scrolled out of the iframe's view; the overlay is then hidden.
  const top = px(r.top, -MAX_PX);
  const left = px(r.left, -MAX_PX);
  const width = px(r.width, 1);
  const height = px(r.height, 0);
  if (top === null || left === null || width === null || height === null) return null;
  const identity =
    typeof m.identity === "string" && m.identity.length <= 4000 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(m.identity) ? m.identity : undefined;
  return {
    type: "panel",
    panel: PANEL_ID,
    state: "open",
    role: m.role,
    theme: m.theme,
    rect: { top, left, width, height },
    ...(identity ? { identity } : {}),
  };
}

/** The message must come from the dashboard origin AND from our own iframe's window. */
export function isTrustedChildEvent(
  event: { origin: string; source: unknown },
  dashboardOrigin: string,
  frameWindow: unknown
): boolean {
  return frameWindow !== null && frameWindow !== undefined && event.origin === dashboardOrigin && event.source === frameWindow;
}

export function panelReadyMessage(height: number): PanelReadyMessage {
  return {
    source: HOST_SOURCE,
    v: BRIDGE_VERSION,
    type: "panel-ready",
    panel: PANEL_ID,
    height: Math.max(0, Math.ceil(Number.isFinite(height) ? height : 0)),
  };
}

/**
 * Where the overlay goes inside the wrapper: the iframe's offset plus the slot
 * rect, kept inside the iframe's box, at most panelHeight tall. Null (hidden)
 * when the slot's corner is outside the iframe. rect.height is ignored.
 */
export function overlayPlacement(
  frameOffset: { top: number; left: number },
  frameBox: { width: number; height: number },
  rect: PanelRect,
  panelHeight: number
): { top: number; left: number; width: number; height: number } | null {
  if (rect.top < 0 || rect.left < 0 || rect.left >= frameBox.width || rect.top >= frameBox.height) return null;
  return {
    top: Math.round(frameOffset.top + rect.top),
    left: Math.round(frameOffset.left + rect.left),
    width: Math.floor(Math.min(rect.width, frameBox.width - rect.left)),
    height: Math.floor(Math.min(panelHeight, frameBox.height - rect.top)),
  };
}

/** Clean axis ticks from 0 to at least max. */
export function niceTicks(max: number, integer: boolean, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10]
      .map((m) => m * pow)
      .filter((s) => !integer || Number.isInteger(Number(s.toPrecision(12))))
      .find((s) => s >= rough) ?? Math.max(1, Math.ceil(rough));
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

// ---------------------------------------------------------------------------
// Styles

const STYLE_ID = "mdc-styles";

const CSS = `
.mdc-root{position:relative;overflow:hidden;overflow:clip}
.mdc-frame{display:block;width:100%;border:0}
.mdc-overlay{position:absolute;top:0;left:0;z-index:2;width:0;height:0;overflow:auto;overscroll-behavior:contain}
.mdc-overlay[hidden]{display:none}
.mdc-overlay>.mdc-screen{min-width:320px;min-height:100%}
.mdc-screen{--mdc-bg:#ffffff;--mdc-card:#ffffff;--mdc-fg:#0a0a0a;--mdc-muted:#737373;--mdc-subtle:#f5f5f5;--mdc-border:#e5e5e5;--mdc-ring:#a3a3a3;--mdc-bar:#2a78d6;--mdc-grid:#ededed;--mdc-axis:#d4d4d4;--mdc-shadow:rgba(0,0,0,.08);
  color-scheme:light;display:grid;gap:16px;container-type:inline-size;background:var(--mdc-bg);color:var(--mdc-fg);text-align:left;
  font:400 14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.mdc-screen[data-theme=dark]{--mdc-bg:#0a0a0a;--mdc-card:#171717;--mdc-fg:#fafafa;--mdc-muted:#a1a1a1;--mdc-subtle:#262626;--mdc-border:rgba(255,255,255,.1);--mdc-ring:#737373;--mdc-bar:#3987e5;--mdc-grid:#262626;--mdc-axis:#404040;--mdc-shadow:rgba(0,0,0,.4);color-scheme:dark}
.mdc-screen *,.mdc-screen *::before,.mdc-screen *::after{box-sizing:border-box}
.mdc-screen h3,.mdc-screen h4,.mdc-screen p{margin:0}
.mdc-screen[aria-busy=true] .mdc-body{opacity:.6;transition:opacity .15s}
.mdc-body{display:grid;gap:16px;min-width:0}
.mdc-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}
.mdc-title{font-size:16px;font-weight:600;line-height:1.4}
.mdc-subtitle{margin-top:2px;font-size:13px;color:var(--mdc-muted)}
.mdc-seg{display:inline-flex;gap:2px;padding:3px;border-radius:8px;background:var(--mdc-subtle)}
.mdc-seg button{appearance:none;border:0;margin:0;background:transparent;color:var(--mdc-muted);font:inherit;font-size:13px;font-weight:500;line-height:1.4;padding:4px 10px;border-radius:6px;cursor:pointer}
.mdc-seg button:hover{color:var(--mdc-fg)}
.mdc-seg button[aria-pressed=true]{background:var(--mdc-bg);color:var(--mdc-fg);box-shadow:0 1px 2px var(--mdc-shadow)}
.mdc-screen button:focus-visible{outline:2px solid var(--mdc-ring);outline-offset:1px}
.mdc-card{border:1px solid var(--mdc-border);border-radius:10px;background:var(--mdc-card);min-width:0}
.mdc-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@container (max-width:640px){.mdc-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.mdc-kpi-value{font-size:20px}}
.mdc-kpi{padding:12px 14px}
.mdc-kpi-label{font-size:12px;font-weight:500;color:var(--mdc-muted)}
.mdc-kpi-value{margin-top:4px;font-size:22px;font-weight:600;line-height:1.2;letter-spacing:-.01em;overflow-wrap:anywhere}
.mdc-kpi-note{margin-top:2px;font-size:12px;color:var(--mdc-muted)}
.mdc-skel{height:76px;border-radius:10px;background:var(--mdc-subtle);animation:mdc-pulse 1.4s ease-in-out infinite}
.mdc-skel-tall{height:220px}
@keyframes mdc-pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.mdc-skel{animation:none}}
.mdc-section{padding:14px 16px}
.mdc-section-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.mdc-section-title{font-size:14px;font-weight:600}
.mdc-chart{position:relative;min-height:200px}
.mdc-chart svg{display:block;overflow:visible}
.mdc-tick{font-size:11px;fill:var(--mdc-muted);font-variant-numeric:tabular-nums}
.mdc-grid{stroke:var(--mdc-grid);stroke-width:1;shape-rendering:crispEdges}
.mdc-baseline{stroke:var(--mdc-axis);stroke-width:1;shape-rendering:crispEdges}
.mdc-bar{fill:var(--mdc-bar);transition:opacity .1s}
.mdc-hovering .mdc-bar:not(.mdc-active){opacity:.45}
.mdc-hit{fill:transparent}
.mdc-tip{position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,calc(-100% - 8px));padding:6px 8px;border:1px solid var(--mdc-border);border-radius:8px;background:var(--mdc-card);box-shadow:0 4px 12px var(--mdc-shadow);font-size:12px;line-height:1.35;white-space:nowrap}
.mdc-tip[hidden]{display:none}
.mdc-tip-label{color:var(--mdc-muted)}
.mdc-tip-value{font-weight:600}
.mdc-table-wrap{overflow-x:auto}
.mdc-table{width:100%;border-collapse:collapse;font-size:13px}
.mdc-table th{padding:8px 10px;border-bottom:1px solid var(--mdc-border);text-align:left;font-weight:500;color:var(--mdc-muted);white-space:nowrap}
.mdc-table td{padding:8px 10px;border-bottom:1px solid var(--mdc-border);vertical-align:top}
.mdc-table tr:last-child td{border-bottom:0}
.mdc-table th:first-child,.mdc-table td:first-child{padding-left:0}
.mdc-table th:last-child,.mdc-table td:last-child{padding-right:0}
.mdc-table .mdc-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mdc-name{font-weight:500;overflow-wrap:anywhere}
.mdc-sub{display:block;font-size:12px;color:var(--mdc-muted);overflow-wrap:anywhere}
.mdc-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.mdc-badge{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid var(--mdc-border);border-radius:999px;font-size:11px;font-weight:500;color:var(--mdc-muted);vertical-align:1px}
.mdc-state{padding:32px 16px;text-align:center;color:var(--mdc-muted)}
.mdc-state-title{margin-bottom:4px;font-weight:600;color:var(--mdc-fg)}
.mdc-btn{appearance:none;margin-top:12px;padding:6px 12px;border:1px solid var(--mdc-border);border-radius:8px;background:var(--mdc-card);color:var(--mdc-fg);font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.mdc-btn:hover{background:var(--mdc-subtle)}
.mdc-empty{padding:24px 0 8px;text-align:center;color:var(--mdc-muted)}
.mdc-notes{display:grid;gap:2px;font-size:12px;color:var(--mdc-muted)}
.mdc-warn{padding:12px 14px;border-color:#d97706;font-size:13px}
.mdc-section-note{margin:-6px 0 10px;font-size:12px;color:var(--mdc-muted)}
.mdc-url{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--mdc-muted);overflow-wrap:anywhere}
.mdc-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
.mdc-actions .mdc-btn{margin-top:0}
`;

function injectStyles(nonce?: string) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  if (nonce) style.nonce = nonce;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// DOM helpers (text only; nothing is ever parsed as HTML)

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (name === "class") el.className = String(value);
      else el.setAttribute(name, value === true ? "" : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Formatting

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function formatCount(value: number, compact = false) {
  return new Intl.NumberFormat(undefined, compact && Math.abs(value) >= 100_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(value);
}

function formatMoney(value: number, currency: string | null, compact = false) {
  const opts: Intl.NumberFormatOptions =
    compact && Math.abs(value) >= 100_000 ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2, minimumFractionDigits: 2 };
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, { ...opts, style: "currency", currency }).format(value);
    } catch {
      /* unknown currency code: fall through to a plain number */
    }
  }
  return new Intl.NumberFormat(undefined, opts).format(value);
}

function formatPercent(value: number) {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? date
    : new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

const RANGES: Array<{ id: StatsRange; label: string; long: string }> = [
  { id: "7d", label: "7 days", long: "the last 7 days" },
  { id: "30d", label: "30 days", long: "the last 30 days" },
  { id: "90d", label: "90 days", long: "the last 90 days" },
];

type ChartMetric = "clicks" | "orders" | "revenue";
const CHART_METRICS: Array<{ id: ChartMetric; label: string }> = [
  { id: "clicks", label: "Clicks" },
  { id: "orders", label: "Orders" },
  { id: "revenue", label: "Revenue" },
];

function looksLikeStats(value: unknown): value is StatsResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    !!v.totals &&
    typeof v.totals === "object" &&
    Array.isArray(v.daily) &&
    Array.isArray(v.by_code) &&
    Array.isArray(v.by_creator) &&
    Array.isArray(v.by_campaign)
  );
}

// ---------------------------------------------------------------------------
// Daily bar chart (inline SVG, drawn to scale)

function barPath(x: number, y: number, w: number, base: number) {
  const r = Math.min(4, w / 2, base - y);
  return `M${x},${base}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${base}Z`;
}

function renderChart(
  host: HTMLElement,
  daily: DailyStatsRow[],
  metric: ChartMetric,
  width: number,
  money: (n: number) => string,
  rangeLabel: string
) {
  host.replaceChildren();
  if (width < 40 || daily.length === 0) return;
  const values = daily.map((d) => num(d[metric]));
  const integer = metric !== "revenue";
  const fmt = (n: number) => (integer ? formatCount(n) : money(n));
  const tickFmt = (n: number) =>
    integer ? formatCount(n) : new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const ticks = niceTicks(Math.max(...values), integer);
  const top = ticks[ticks.length - 1] ?? 1;

  const height = 200;
  const margin = { top: 10, right: 4, bottom: 26, left: Math.max(...ticks.map((t) => tickFmt(t).length)) * 7 + 12 };
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const base = margin.top + plotH;
  const band = plotW / daily.length;
  const barW = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => base - (v / top) * plotH;

  const total = values.reduce((a, b) => a + b, 0);
  const label = CHART_METRICS.find((m) => m.id === metric)?.label ?? metric;
  const svg = s("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${label} per day over ${rangeLabel}. Total ${fmt(total)}.` });

  for (const t of ticks) {
    const ty = Math.round(y(t)) + 0.5;
    svg.append(
      s("line", { class: t === 0 ? "mdc-baseline" : "mdc-grid", x1: margin.left, x2: width - margin.right, y1: ty, y2: ty }),
      s("text", { class: "mdc-tick", x: margin.left - 8, y: ty, "text-anchor": "end", "dominant-baseline": "middle" }, tickFmt(t))
    );
  }

  const every = Math.max(1, Math.ceil(64 / band));
  const bars: SVGPathElement[] = [];
  const tip = h("div", { class: "mdc-tip", hidden: true });

  daily.forEach((day, i) => {
    const value = values[i] ?? 0;
    const cx = margin.left + i * band + band / 2;
    const bar = s("path", { class: "mdc-bar", d: value > 0 ? barPath(cx - barW / 2, y(value), barW, base) : "" });
    bars.push(bar);
    svg.append(bar);

    if ((daily.length - 1 - i) % every === 0) {
      const anchor = cx - 24 < margin.left ? "start" : cx + 24 > width ? "end" : "middle";
      const tx = anchor === "start" ? Math.max(margin.left, cx - band / 2) : anchor === "end" ? width - margin.right : cx;
      svg.append(s("text", { class: "mdc-tick", x: tx, y: base + 17, "text-anchor": anchor }, formatDay(day.date)));
    }

    const hit = s("rect", { class: "mdc-hit", x: margin.left + i * band, y: margin.top, width: band, height: plotH });
    hit.addEventListener("pointerenter", () => {
      svg.classList.add("mdc-hovering");
      bar.classList.add("mdc-active");
      tip.replaceChildren(h("div", { class: "mdc-tip-label" }, formatDay(day.date)), h("div", { class: "mdc-tip-value" }, `${fmt(value)} ${label.toLowerCase()}`));
      tip.hidden = false;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(cx, half), width - half)}px`;
      tip.style.top = `${value > 0 ? y(value) : base}px`;
    });
    hit.addEventListener("pointerleave", () => {
      svg.classList.remove("mdc-hovering");
      bar.classList.remove("mdc-active");
      tip.hidden = true;
    });
    svg.append(hit);
  });

  host.append(svg, tip);
}

// ---------------------------------------------------------------------------
// Sales screen

type ScreenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unauthorized" }
  | { status: "error"; title: string; detail: string; retry: boolean }
  | { status: "ready"; data: StatsResponse; attribution: AttributionReport | null; checkouts: CheckoutListResponse | null };

type Column<T> = { label: string; numeric?: boolean; cell: (row: T) => Node | string };

const MODELS: Array<{ id: AttributionModel; label: string }> = [
  { id: "first_touch", label: "First" },
  { id: "last_touch", label: "Last" },
  { id: "linear", label: "Linear" },
  { id: "position_based", label: "40/20/40" },
  { id: "time_decay", label: "Decay" },
];

const MODEL_NOTE: Record<AttributionModel, string> = {
  first_touch: "All credit to the touch that first brought the shopper in.",
  last_touch: "All credit to the last touch before the order.",
  linear: "Credit split evenly across every touch in the journey.",
  position_based: "40% to the first touch, 40% to the last, 20% shared by the ones between.",
  time_decay: "More credit to touches closer to the order (7-day half-life).",
};

const CHANNEL_NAME: Record<string, string> = {
  creator: "Creator links",
  paid_social: "Paid social",
  paid_search: "Paid search",
  organic_social: "Organic social",
  organic_search: "Organic search",
  email: "Email",
  sms: "SMS",
  affiliate: "Other affiliates",
  referral: "Referral sites",
  display: "Display ads",
  other: "Other tagged",
  direct: "Direct / unknown",
};

const STATUS_LABEL: Record<CheckoutListRow["status"], string> = {
  started: "In progress",
  failed: "Payment failed",
  abandoned: "Abandoned",
  completed: "Completed",
};

async function getJson<T>(url: URL, signal: AbortSignal, check: (v: unknown) => boolean): Promise<T | null> {
  try {
    const response = await fetch(url.href, { credentials: "include", cache: "no-store", headers: { accept: "application/json" }, signal });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return check(data) ? (data as T) : null;
  } catch {
    return null;
  }
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const STALE_MS = 60_000;

class SalesScreen {
  readonly el: HTMLDivElement;
  private range: StatsRange = "30d";
  private metric: ChartMetric = "clicks";
  private model: AttributionModel = "last_touch";
  private state: ScreenState = { status: "idle" };
  private busy = false;
  private notice: string | null = null;
  private controller: AbortController | null = null;
  private fetchedAt = 0;
  private width = 0;
  private chartHost: HTMLElement | null = null;

  constructor(
    private readonly statsUrl: URL,
    private readonly siteName: string
  ) {
    this.el = h("div", { class: "mdc-screen", "data-theme": "light" });
  }

  setTheme(theme: PanelTheme) {
    if (this.el.getAttribute("data-theme") !== theme) this.el.setAttribute("data-theme", theme);
  }

  setWidth(width: number) {
    if (Math.abs(width - this.width) < 1) return;
    this.width = width;
    this.drawChart();
  }

  activate() {
    if (this.controller) return;
    if (this.state.status === "idle" || Date.now() - this.fetchedAt > STALE_MS) void this.load();
  }

  /** Loads again now (e.g. after the viewer changed). */
  reload() {
    void this.load();
  }

  destroy() {
    this.controller?.abort();
  }

  private async load() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    if (this.state.status === "ready") this.busy = true;
    else this.state = { status: "loading" };
    this.render();

    const url = new URL(this.statsUrl.href);
    url.searchParams.set("range", this.range);
    let next: ScreenState;
    try {
      const response = await fetch(url.href, {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (response.status === 401) {
        next = { status: "unauthorized" };
      } else if (response.status === 403) {
        next = { status: "error", title: "Sales data can't be shown here.", detail: "This page isn't allowed to load it.", retry: false };
      } else if (response.status === 503) {
        next = { status: "error", title: "Sales data is temporarily unavailable.", detail: "Please try again in a minute.", retry: true };
      } else if (!response.ok) {
        next = { status: "error", title: "Couldn't load sales data.", detail: `The server answered ${response.status}.`, retry: true };
      } else {
        const data: unknown = await response.json();
        if (!looksLikeStats(data)) {
          next = { status: "error", title: "Couldn't load sales data.", detail: "The response wasn't in the expected format.", retry: true };
        } else if (data.role === "admin") {
          // Admin-only extras; either can be missing (older connector, or a failure) without hiding the rest.
          const extra = (path: string) => {
            const u = new URL(path, this.statsUrl);
            u.searchParams.set("range", this.range);
            return u;
          };
          const [attribution, checkouts] = await Promise.all([
            getJson<AttributionReport>(extra("attribution"), controller.signal, (v) => !!v && typeof v === "object" && "models" in v),
            getJson<CheckoutListResponse>(extra("checkouts"), controller.signal, (v) => !!v && typeof v === "object" && "checkouts" in v),
          ]);
          next = { status: "ready", data, attribution, checkouts };
        } else {
          next = { status: "ready", data, attribution: null, checkouts: null };
        }
      }
    } catch {
      if (controller.signal.aborted) return;
      next = { status: "error", title: "Couldn't load sales data.", detail: "Check your connection and try again.", retry: true };
    }
    if (controller.signal.aborted) return;
    this.controller = null;
    this.busy = false;
    this.fetchedAt = Date.now();
    this.state = next;
    this.render();
  }

  private setRange(range: StatsRange) {
    if (range === this.range && this.state.status !== "error") return;
    this.range = range;
    void this.load();
  }

  private segmented<T extends string>(label: string, items: Array<{ id: T; label: string }>, current: T, pick: (id: T) => void) {
    const group = h("div", { class: "mdc-seg", role: "group", "aria-label": label });
    for (const item of items) {
      const button = h("button", { type: "button", "aria-pressed": item.id === current ? "true" : "false" }, item.label);
      button.addEventListener("click", () => pick(item.id));
      group.append(button);
    }
    return group;
  }

  private header() {
    const role = this.state.status === "ready" ? this.state.data.role : null;
    const scope = role === "admin" ? "All creators. " : role === "creator" ? "Your links and codes. " : "";
    return h(
      "div",
      { class: "mdc-header" },
      h(
        "div",
        null,
        h("h3", { class: "mdc-title" }, "Sales & performance"),
        h("p", { class: "mdc-subtitle" }, `${scope}Data from ${this.siteName}, kept on this site.`)
      ),
      this.segmented("Date range", RANGES, this.range, (id) => this.setRange(id))
    );
  }

  private render() {
    this.chartHost = null;
    const body = h("div", { class: "mdc-body" });
    const state = this.state;
    if (state.status === "idle" || state.status === "loading") {
      body.append(
        h("div", { class: "mdc-kpis", "aria-hidden": "true" }, ...Array.from({ length: 8 }, () => h("div", { class: "mdc-skel" }))),
        h("div", { class: "mdc-skel mdc-skel-tall", "aria-hidden": "true" }),
        h("p", { class: "mdc-notes", role: "status" }, "Loading sales data…")
      );
    } else if (state.status === "unauthorized") {
      body.append(
        this.message("Sign in to see sales data.", `You need to be signed in to ${this.siteName} to see these numbers.`, false)
      );
    } else if (state.status === "error") {
      body.append(this.message(state.title, state.detail, state.retry));
    } else {
      this.ready(body, state.data, [
        state.attribution ? this.attribution(state.attribution) : null,
        state.checkouts ? this.lostCheckouts(state.checkouts, state.data.currency) : null,
      ]);
    }
    this.el.setAttribute("aria-busy", this.busy ? "true" : "false");
    this.el.replaceChildren(this.header(), body);
    this.drawChart();
  }

  private message(title: string, detail: string, retry: boolean) {
    const box = h("div", { class: "mdc-card mdc-state", role: "status" }, h("p", { class: "mdc-state-title" }, title), h("p", null, detail));
    if (retry) {
      const button = h("button", { type: "button", class: "mdc-btn" }, "Try again");
      button.addEventListener("click", () => void this.load());
      box.append(button);
    }
    return box;
  }

  private ready(body: HTMLElement, data: StatsResponse, extras: Array<HTMLElement | null> = []) {
    const t = data.totals;
    const currency = data.currency;
    const money = (n: number, compact = false) => formatMoney(num(n), currency, compact);
    const rangeLong = RANGES.find((r) => r.id === data.range)?.long ?? "this period";
    const admin = data.role === "admin";

    if (!admin && data.linked === false) {
      body.append(
        data.link_pending
          ? this.message(
              "Waiting for approval.",
              `An admin of ${this.siteName} has to confirm that this login belongs to your creator account. Your numbers appear here after that.`,
              false
            )
          : this.message(
              "Your creator account isn't linked to this login yet.",
              `Sign in inside the dashboard on this page, then an admin of ${this.siteName} confirms the link. Your numbers appear here after that.`,
              false
            )
      );
      return;
    }
    if (admin && data.config_warning) {
      body.append(h("div", { class: "mdc-card mdc-warn", role: "alert" }, data.config_warning));
    }

    const tile = (label: string, value: string, note?: string | null) =>
      h("div", { class: "mdc-card mdc-kpi" }, h("div", { class: "mdc-kpi-label" }, label), h("div", { class: "mdc-kpi-value" }, value), note ? h("div", { class: "mdc-kpi-note" }, note) : null);

    const refunds = num(t.refunds);
    body.append(
      h(
        "div",
        { class: "mdc-kpis" },
        tile("Clicks", formatCount(num(t.clicks), true)),
        tile("Checkouts started", formatCount(num(t.checkouts_started), true)),
        tile("Checkouts failed", formatCount(num(t.checkouts_failed), true)),
        tile("Checkouts abandoned", formatCount(num(t.checkouts_abandoned), true), "No order within 24 hours"),
        tile("Orders", formatCount(num(t.orders), true), refunds ? `${formatCount(refunds)} refunded` : null),
        tile("Revenue", money(t.revenue, true), refunds ? "After refunds" : null),
        tile("Commission", money(t.commission, true)),
        tile("Conversion rate", formatPercent(num(t.conversion_rate)), "Orders per click")
      )
    );

    const empty = num(t.clicks) + num(t.checkouts_started) + num(t.orders) + num(t.test_orders) === 0;
    if (empty) {
      body.append(
        h(
          "div",
          { class: "mdc-card mdc-section" },
          h("p", { class: "mdc-empty" }, admin ? `No creator clicks or orders in ${rangeLong}.` : `No clicks or orders from your links in ${rangeLong} yet.`)
        )
      );
    } else {
      this.chartHost = h("div", { class: "mdc-chart" });
      body.append(
        h(
          "section",
          { class: "mdc-card mdc-section" },
          h(
            "div",
            { class: "mdc-section-head" },
            h("h4", { class: "mdc-section-title" }, "Daily"),
            this.segmented("Chart metric", CHART_METRICS, this.metric, (id) => {
              this.metric = id;
              this.render();
            })
          ),
          this.chartHost
        )
      );
    }

    const metricColumns = <T extends Metrics>(): Column<T>[] => [
      { label: "Clicks", numeric: true, cell: (r) => formatCount(num(r.clicks)) },
      { label: "Checkouts", numeric: true, cell: (r) => formatCount(num(r.checkouts_started)) },
      { label: "Orders", numeric: true, cell: (r) => formatCount(num(r.orders)) },
      { label: "Revenue", numeric: true, cell: (r) => money(r.revenue) },
      { label: "Commission", numeric: true, cell: (r) => money(r.commission) },
      { label: "Conversion", numeric: true, cell: (r) => formatPercent(num(r.conversion_rate)) },
    ];

    if (!admin && Array.isArray(data.share_links) && data.share_links.length) {
      body.append(this.shareLinks(data.share_links));
    }
    if (admin && data.by_creator.length) {
      body.append(
        this.table<CreatorStatsRow>("By creator", data.by_creator, [
          {
            label: "Creator",
            cell: (r) =>
              h("span", null, h("span", { class: "mdc-name" }, r.display_name || `@${r.username}`), r.display_name ? h("span", { class: "mdc-sub" }, `@${r.username}`) : null),
          },
          ...metricColumns<CreatorStatsRow>(),
        ])
      );
    }
    if (data.by_code.length) {
      body.append(
        this.table<CodeStatsRow>(admin ? "By code" : "Your codes", data.by_code, [
          {
            label: "Code",
            cell: (r) =>
              h("span", null, h("span", { class: "mdc-code mdc-name" }, r.code), r.status && r.status !== "active" ? h("span", { class: "mdc-badge" }, r.status) : null),
          },
          ...metricColumns<CodeStatsRow>(),
        ])
      );
    }
    if (Array.isArray(data.by_link) && data.by_link.length) {
      body.append(
        this.table<LinkStatsRow>(admin ? "By link" : "Your links", data.by_link, [
          {
            label: "Link",
            cell: (r) => h("span", null, h("span", { class: "mdc-name" }, r.label), h("span", { class: "mdc-sub" }, `${r.target_path} · ${r.code}`)),
          },
          ...metricColumns<LinkStatsRow>(),
        ])
      );
    }
    if (data.by_campaign.length) {
      body.append(
        this.table<CampaignStatsRow>("By campaign", data.by_campaign, [
          { label: "Campaign", cell: (r) => h("span", { class: "mdc-name" }, r.title) },
          ...metricColumns<CampaignStatsRow>(),
        ])
      );
    }

    if (admin && Array.isArray(data.creator_links) && data.creator_links.length) {
      body.append(this.creatorLinks(data.creator_links));
    }
    for (const extra of extras) if (extra) body.append(extra);

    const notes: string[] = [];
    if (num(t.test_orders)) notes.push(`${formatCount(num(t.test_orders))} test order${num(t.test_orders) === 1 ? "" : "s"} not counted.`);
    for (const other of Array.isArray(data.other_currencies) ? data.other_currencies : []) {
      notes.push(`${formatCount(num(other.orders))} order(s) in ${other.currency} (${formatMoney(num(other.revenue), other.currency)}) are not included in revenue.`);
    }
    notes.push("Days are in UTC. Abandoned checkouts are started checkouts with no order within 24 hours.");
    body.append(h("div", { class: "mdc-notes" }, ...notes.map((n) => h("p", null, n))));
  }

  private attribution(report: AttributionReport) {
    const money = (n: number) => formatMoney(num(n), report.currency);
    const rows: ChannelRow[] = report.channels?.[this.model] ?? [];
    const total = num(report.revenue);
    const summary =
      report.orders === 0
        ? "No orders in this period yet."
        : `${formatCount(report.tracked_orders)} of ${formatCount(report.orders)} orders had a tracked journey` +
          (report.tracked_orders
            ? ` · ${report.avg_touches} touches on average` +
              (report.avg_days_to_convert !== null ? ` · ${report.avg_days_to_convert} days from first touch to order` : "")
            : "") +
          ".";
    const section = this.table<ChannelRow>(
      "Where sales come from",
      rows,
      [
        { label: "Channel", cell: (r) => h("span", { class: "mdc-name" }, CHANNEL_NAME[r.channel] ?? r.channel) },
        { label: "Orders", numeric: true, cell: (r) => String(num(r.conversions)) },
        { label: "Revenue", numeric: true, cell: (r) => money(r.revenue) },
        { label: "Share", numeric: true, cell: (r) => (total ? formatPercent(num(r.revenue) / total) : "–") },
      ],
      `${MODEL_NOTE[this.model]} ${summary} Every order counts here, credited to a creator or not.`
    );
    const head = section.firstChild as HTMLElement | null;
    head?.append(
      this.segmented("Attribution model", MODELS, this.model, (id) => {
        this.model = id;
        this.render();
      })
    );
    const wrap = h("div", { class: "mdc-body" }, section);
    if (report.top_paths?.length) {
      wrap.append(
        this.table<PathRow>("Top journeys", report.top_paths, [
          { label: "Path to purchase", cell: (r) => r.path.map((c) => CHANNEL_NAME[c] ?? c).join(" → ") },
          { label: "Orders", numeric: true, cell: (r) => formatCount(num(r.orders)) },
          { label: "Revenue", numeric: true, cell: (r) => money(r.revenue) },
        ])
      );
    }
    if (report.creator_assists?.length) {
      wrap.append(
        this.table<CreatorAssistRow>(
          "Creator influence",
          report.creator_assists,
          [
            { label: "Code", cell: (r) => h("span", { class: "mdc-code mdc-name" }, r.code) },
            { label: "Opened", numeric: true, cell: (r) => formatCount(num(r.first_touch)) },
            { label: "Closed", numeric: true, cell: (r) => formatCount(num(r.last_touch)) },
            { label: "Assisted", numeric: true, cell: (r) => formatCount(num(r.assisted)) },
            { label: "Assisted revenue", numeric: true, cell: (r) => money(r.assisted_revenue) },
          ],
          "Opened: the creator's link was the first touch. Closed: it was the last. Assisted: it was in the journey but something else closed the sale, so it earned no commission."
        )
      );
    }
    return wrap;
  }

  private lostCheckouts(list: CheckoutListResponse, fallbackCurrency: string | null) {
    const wrap = h("div", { class: "mdc-body" });
    const money = (n: number, cur?: string | null) => formatMoney(num(n), cur ?? fallbackCurrency);
    const rec = list.recovery;
    if (rec && num(rec.emails_sent) > 0) {
      const tile = (label: string, value: string) =>
        h("div", { class: "mdc-card mdc-kpi" }, h("div", { class: "mdc-kpi-label" }, label), h("div", { class: "mdc-kpi-value" }, value));
      wrap.append(
        h(
          "section",
          { class: "mdc-card mdc-section" },
          h("div", { class: "mdc-section-head" }, h("h4", { class: "mdc-section-title" }, "Cart recovery emails")),
          h(
            "div",
            { class: "mdc-kpis" },
            tile("Emails sent", formatCount(num(rec.emails_sent))),
            tile("Carts won back", formatCount(num(rec.recovered_orders))),
            tile("Recovery rate", formatPercent(num(rec.recovered_orders) / num(rec.emails_sent))),
            tile("Revenue recovered", money(rec.recovered_value))
          )
        )
      );
    }
    if (list.by_code.length) {
      wrap.append(
        this.table<CheckoutListResponse["by_code"][number]>(
          "Lost checkouts by creator",
          list.by_code,
          [
            {
              label: "Code",
              cell: (r) => h("span", null, h("span", { class: "mdc-code mdc-name" }, r.code), r.creator_name ? h("span", { class: "mdc-sub" }, r.creator_name) : null),
            },
            { label: "Payment failed", numeric: true, cell: (r) => formatCount(num(r.failed)) },
            { label: "Abandoned", numeric: true, cell: (r) => formatCount(num(r.abandoned)) },
            { label: "Cart value lost", numeric: true, cell: (r) => money(r.lost_value) },
          ],
          `Checkouts from each creator's shoppers that didn't become orders. Abandoned = unpaid after ${list.abandon_after_minutes} minutes.`
        )
      );
    }
    const rows = list.checkouts.slice(0, 50);
    if (!rows.length) {
      wrap.append(
        h(
          "section",
          { class: "mdc-card mdc-section" },
          h("div", { class: "mdc-section-head" }, h("h4", { class: "mdc-section-title" }, "Failed & abandoned checkouts")),
          h("p", { class: "mdc-empty" }, "None in this period.")
        )
      );
      return wrap;
    }
    wrap.append(
      this.table<CheckoutListRow>(
        "Failed & abandoned checkouts",
        rows,
        [
          { label: "When", cell: (r) => formatWhen(r.created_at) },
          { label: "Shopper", cell: (r) => (r.email ? h("span", { class: "mdc-name" }, r.email) : "–") },
          {
            label: "Status",
            cell: (r) =>
              h(
                "span",
                null,
                h("span", { class: "mdc-name" }, STATUS_LABEL[r.status] ?? r.status),
                r.failure_reason ? h("span", { class: "mdc-sub" }, r.failure_reason) : null,
                r.recovery_sent_at ? h("span", { class: "mdc-sub" }, `Recovery email sent ${formatWhen(r.recovery_sent_at)}`) : null
              ),
          },
          { label: "Reached", cell: (r) => r.step ?? "–" },
          { label: "Cart", numeric: true, cell: (r) => money(r.cart_total, r.currency) },
          {
            label: "Creator",
            cell: (r) => (r.code ? h("span", null, h("span", { class: "mdc-code" }, r.code), r.creator_name ? h("span", { class: "mdc-sub" }, r.creator_name) : null) : "–"),
          },
          {
            label: "",
            numeric: true,
            cell: (r) => {
              const actions = h("div", { class: "mdc-actions" });
              if (r.visitor_id) {
                actions.append(
                  this.button("Copy Clarity filter", () => {
                    void navigator.clipboard?.writeText(`md_vid = ${r.visitor_id}`).catch(() => undefined);
                  })
                );
              }
              if (list.recovery_ready && r.email && !r.recovery_sent_at && r.status !== "completed") {
                actions.append(this.button("Send recovery email", () => void this.sendRecovery(r.checkout_id, r.email!)));
              }
              return actions;
            },
          },
        ],
        h(
          "span",
          null,
          this.notice ? h("span", { class: "mdc-name" }, `${this.notice} `) : null,
          list.recovery_ready
            ? list.recovery_automatic
              ? `Recovery emails go out automatically after ${list.abandon_after_minutes} minutes; you can also send one now. `
              : "Automatic recovery emails are off: send them one by one here. "
            : "",
          "Copy Clarity filter, then in Microsoft Clarity open Recordings → Filters → Custom tags and paste it to watch where the shopper stopped. ",
          this.button("Copy all emails", () => {
            const emails = [...new Set(rows.map((r) => r.email).filter((e): e is string => !!e))];
            void navigator.clipboard?.writeText(emails.join("\n")).catch(() => undefined);
          })
        )
      )
    );
    return wrap;
  }

  private async sendRecovery(checkoutId: string, email: string) {
    if (!window.confirm(`Send the recovery email to ${email}?`)) return;
    this.busy = true;
    this.render();
    try {
      const response = await fetch(new URL("checkouts/send-recovery", this.statsUrl).href, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ checkout_id: checkoutId }),
      });
      const result = (await response.json().catch(() => ({}))) as { status?: string };
      const messages: Record<string, string> = {
        sent: `Recovery email sent to ${email}.`,
        already_sent: "A recovery email already went to this shopper.",
        paid: "This shopper has paid since; nothing sent.",
        unsubscribed: `${email} has unsubscribed; nothing sent.`,
        no_template: "Write the recovery email in the Media Dashboard (Integration page) first.",
        no_link: "This checkout has no link to reopen the cart, so nothing was sent.",
        failed: "Resend didn't accept the email. Check the API key and sending domain.",
      };
      this.notice = messages[result.status ?? ""] ?? `Couldn't send (the server answered ${response.status}).`;
    } catch {
      this.notice = "Couldn't send. Check your connection and try again.";
    }
    await this.load();
  }

  private table<T>(title: string, rows: T[], columns: Column<T>[], note?: Node | string | null) {
    const head = h("tr", null, ...columns.map((c) => h("th", { class: c.numeric ? "mdc-num" : null, scope: "col" }, c.label)));
    const bodyRows = rows.map((row) => h("tr", null, ...columns.map((c) => h("td", { class: c.numeric ? "mdc-num" : null }, c.cell(row)))));
    return h(
      "section",
      { class: "mdc-card mdc-section" },
      h("div", { class: "mdc-section-head" }, h("h4", { class: "mdc-section-title" }, title)),
      note ? h("p", { class: "mdc-section-note" }, note) : null,
      h("div", { class: "mdc-table-wrap" }, h("table", { class: "mdc-table" }, h("thead", null, head), h("tbody", null, ...bodyRows)))
    );
  }

  private button(label: string, onClick: () => void) {
    const button = h("button", { type: "button", class: "mdc-btn", disabled: this.busy }, label);
    button.addEventListener("click", onClick);
    return button;
  }

  private shareLinks(links: ShareLink[]) {
    return this.table<ShareLink>(
      "Your share links",
      links,
      [
        { label: "Link", cell: (r) => h("span", null, h("span", { class: "mdc-name" }, `${r.label} · ${r.code}`), h("span", { class: "mdc-url" }, r.url)) },
        {
          label: "",
          numeric: true,
          cell: (r) =>
            this.button("Copy", () => {
              void navigator.clipboard?.writeText(r.url).catch(() => undefined);
            }),
        },
      ],
      `These links go straight to ${this.siteName}. Share these rather than links copied from anywhere else.`
    );
  }

  private creatorLinks(rows: CreatorLinkRow[]) {
    const codes = (list: Array<{ code: string }>) => list.map((c) => c.code || "removed code").join(", ") || "no codes";
    const sameCodes = (r: CreatorLinkRow) =>
      r.codes.length === r.dashboard_codes.length && r.codes.every((c) => r.dashboard_codes.some((d) => d.affiliate_id === c.affiliate_id));
    const approve = (r: CreatorLinkRow, ids: string[]) =>
      this.button(r.status === "approved" ? "Approve codes" : "Approve", () =>
        void this.act("approve", { creator_id: r.creator_id, user_ref: r.user_ref, affiliate_ids: ids })
      );
    const unlink = (r: CreatorLinkRow) =>
      this.button("Unlink", () => {
        if (window.confirm(`Stop showing @${r.username}'s numbers to the login ${r.user_ref}?`)) {
          void this.act("unlink", { creator_id: r.creator_id });
        }
      });
    return this.table<CreatorLinkRow>(
      "Creator logins",
      rows,
      [
        {
          label: "Creator",
          cell: (r) => h("span", null, h("span", { class: "mdc-name" }, r.display_name || `@${r.username}`), r.display_name ? h("span", { class: "mdc-sub" }, `@${r.username}`) : null),
        },
        { label: "Login on this site", cell: (r) => h("span", { class: "mdc-code" }, r.user_ref) },
        { label: "Codes", cell: (r) => h("span", { class: "mdc-code" }, codes(r.codes)) },
        {
          label: "Status",
          cell: (r) => {
            if (r.status === "pending") return "Proposed by the dashboard";
            if (r.status === "blocked") return "This login is already approved for another creator";
            const notes = [`Approved${r.approved_at ? ` ${formatDay(r.approved_at.slice(0, 10))}` : ""}`];
            if (r.dashboard_user_ref !== r.user_ref) notes.push(`The dashboard now names ${r.dashboard_user_ref ?? "no login"}`);
            if (!sameCodes(r)) notes.push(`The dashboard now lists ${codes(r.dashboard_codes)}`);
            return h("span", null, ...notes.map((n, i) => h("span", { class: i ? "mdc-sub" : null }, n)));
          },
        },
        {
          label: "",
          numeric: true,
          cell: (r) => {
            const actions = h("div", { class: "mdc-actions" });
            if (r.status === "pending") actions.append(approve(r, r.codes.map((c) => c.affiliate_id)));
            if (r.status === "approved") {
              if (!sameCodes(r) && r.dashboard_user_ref === r.user_ref) actions.append(approve(r, r.dashboard_codes.map((c) => c.affiliate_id)));
              actions.append(unlink(r));
            }
            return actions;
          },
        },
      ],
      this.notice ??
        `A creator only sees their own numbers once you approve their login here. The dashboard proposes the link; check the login is really theirs.`
    );
  }

  private async act(action: "approve" | "unlink", body: Record<string, unknown>) {
    this.busy = true;
    this.render();
    try {
      const response = await fetch(new URL(`creator-links/${action}`, this.statsUrl).href, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      this.notice = response.ok
        ? null
        : response.status === 409
          ? "That changed in the meantime. The list below is up to date now; please check it again."
          : `Couldn't save that (the server answered ${response.status}).`;
    } catch {
      this.notice = "Couldn't save that. Check your connection and try again.";
    }
    await this.load();
  }

  private drawChart() {
    if (!this.chartHost || this.state.status !== "ready") return;
    const data = this.state.data;
    const width = this.chartHost.clientWidth || Math.max(0, this.width - 34);
    const rangeLong = RANGES.find((r) => r.id === data.range)?.long ?? "this period";
    renderChart(this.chartHost, data.daily, this.metric, width, (n) => formatMoney(n, data.currency), rangeLong);
  }
}

// ---------------------------------------------------------------------------
// Mount

export type MountOptions = {
  /** Element the dashboard goes into. */
  container: HTMLElement;
  /** iframe src from creatorEmbedUrl() / adminEntryUrl(), minted on the server for this page view. */
  src: string;
  /** The media dashboard's origin, e.g. https://media-dashboard.example.com */
  dashboardOrigin: string;
  /** Same-origin stats endpoint. Default "/api/md/stats". */
  statsUrl?: string;
  /** iframe title. Default "Media Dashboard". */
  title?: string;
  /**
   * Use an iframe you already rendered inside container instead of creating one
   * (it is not removed on destroy). It must already carry sandbox={IFRAME_SANDBOX}
   * (no top navigation), or this throws.
   */
  iframe?: HTMLIFrameElement;
  /** CSP nonce for the injected <style>. */
  nonce?: string;
  /**
   * Height in CSS px of the sales screen, which scrolls inside it. This fixed
   * number is all the dashboard ever learns about the screen. Default 960.
   */
  panelHeight?: number;
};

export type MountHandle = {
  readonly iframe: HTMLIFrameElement;
  destroy(): void;
};

export function mountMediaDashboard(options: MountOptions): MountHandle {
  const dashboardOrigin = normalizeOrigin(options.dashboardOrigin);
  if (!dashboardOrigin) throw new Error("mountMediaDashboard: dashboardOrigin must be an http(s) origin.");
  const src = new URL(options.src, window.location.href);
  if (src.origin !== dashboardOrigin) throw new Error("mountMediaDashboard: src must be a page on dashboardOrigin.");
  const statsUrl = new URL(options.statsUrl ?? "/api/md/stats", window.location.href);
  if (statsUrl.origin !== window.location.origin) throw new Error("mountMediaDashboard: statsUrl must be on this site's own origin.");

  const ownsFrame = !options.iframe;
  if (options.iframe) assertSandboxed(options.iframe);
  const panelHeight = resolvePanelHeight(options.panelHeight);
  injectStyles(options.nonce);
  const frame = options.iframe ?? document.createElement("iframe");
  const root = ownsFrame ? document.createElement("div") : options.container;
  root.classList.add("mdc-root");
  frame.classList.add("mdc-frame");
  if (ownsFrame) {
    frame.setAttribute("sandbox", IFRAME_SANDBOX);
    frame.setAttribute("referrerpolicy", IFRAME_REFERRER_POLICY);
  }
  if (!frame.title) frame.title = options.title ?? "Media Dashboard";
  if (!frame.getAttribute("allow")) frame.setAttribute("allow", "clipboard-write");

  const overlay = h("div", { class: "mdc-overlay", hidden: true });
  const screen = new SalesScreen(statsUrl, window.location.host);
  overlay.append(screen.el);
  root.append(overlay);

  let open: PanelOpenMessage | null = null;
  let destroyed = false;
  let lastIdentity: string | null = null;

  const place = () => {
    if (!open) return;
    const f = frame.getBoundingClientRect();
    const r = root.getBoundingClientRect();
    const pos = overlayPlacement(
      { top: f.top - r.top - root.clientTop + frame.clientTop, left: f.left - r.left - root.clientLeft + frame.clientLeft },
      { width: frame.clientWidth, height: frame.clientHeight },
      open.rect,
      panelHeight
    );
    overlay.hidden = pos === null;
    if (!pos) return;
    overlay.style.top = `${pos.top}px`;
    overlay.style.left = `${pos.left}px`;
    overlay.style.width = `${pos.width}px`;
    overlay.style.height = `${pos.height}px`;
    screen.setWidth(Math.max(pos.width, 320));
  };

  const close = () => {
    open = null;
    overlay.hidden = true;
  };

  const onMessage = (event: MessageEvent) => {
    if (!isTrustedChildEvent(event, dashboardOrigin, frame.contentWindow)) return;
    const message = parseChildMessage(event.data);
    if (!message) return;
    if (message.type === "resize") {
      frame.style.height = `${message.height}px`;
      place();
      return;
    }
    if (message.state === "closed") {
      close();
      return;
    }
    open = message;
    screen.setTheme(message.theme);
    place();
    if (message.identity && message.identity !== lastIdentity) {
      lastIdentity = message.identity;
      // Who signed in, proven by the platform's signature, checked by this site's own app; then the numbers load.
      void fetch(new URL("session", statsUrl).href, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: message.identity }),
      })
        .catch(() => null)
        .then(() => {
          if (!destroyed) screen.reload();
        });
    } else {
      screen.activate();
    }
    // Every "open" gets the same fixed number, so nothing the screen shows can reach the dashboard.
    if (!destroyed) frame.contentWindow?.postMessage(panelReadyMessage(panelHeight), dashboardOrigin);
  };

  const onResize = () => place();
  const removalObserver = new MutationObserver(() => {
    if (!frame.isConnected) destroy();
  });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener("message", onMessage);
    window.removeEventListener("resize", onResize);
    removalObserver.disconnect();
    screen.destroy();
    overlay.remove();
    if (ownsFrame) {
      root.remove();
    } else {
      root.classList.remove("mdc-root");
      frame.classList.remove("mdc-frame");
    }
  }

  window.addEventListener("message", onMessage);
  window.addEventListener("resize", onResize);

  if (ownsFrame) {
    frame.style.height = "720px";
    frame.src = src.href;
    root.insertBefore(frame, overlay);
    options.container.append(root);
  }
  removalObserver.observe(document.documentElement, { childList: true, subtree: true });

  return { iframe: frame, destroy };
}
