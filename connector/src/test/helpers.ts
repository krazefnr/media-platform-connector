import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createConnector, memoryStore, postgresStore, type Connector, type ConnectorOptions, type Store, type Viewer } from "../server/index.js";

type PGliteLike = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
};

// MD_TEST_PGLITE=<path to @electric-sql/pglite's dist/index.js> runs every test against a real Postgres
// (in-process, a fresh database per test, with sql/schema.sql applied) instead of the memory store.
const pglite = process.env.MD_TEST_PGLITE
  ? ((await import(pathToFileURL(process.env.MD_TEST_PGLITE).href)) as { PGlite: new () => PGliteLike })
  : null;
const SCHEMA = pglite ? readFileSync(new URL("../../sql/schema.sql", import.meta.url), "utf8") : "";

export function testStore(): Store {
  if (!pglite) return memoryStore();
  const db = new pglite.PGlite();
  const ready = db.exec(SCHEMA);
  return postgresStore({
    pool: {
      async query(text, values) {
        await ready;
        const result = await db.query(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    },
  });
}

export const BRAND = "kraze";
export const DASHBOARD = "https://dash.example";
export const SITE = "https://shop.example";
export const DAY = 86_400_000;

export const IDS = {
  creatorA: "11111111-1111-4111-8111-111111111111",
  creatorB: "22222222-2222-4222-8222-222222222222",
  affA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  affB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  affOld: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  campaign: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  link: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

export function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { privateKey, publicKey, pem, base64: Buffer.from(pem).toString("base64") };
}

export type ConfigFixture = ReturnType<typeof configFixture>;

export function configFixture() {
  return {
    version: 1,
    brand: BRAND,
    generated_at: "2026-10-06T00:00:00.000Z",
    program: {
      storefront_url: SITE,
      ref_param: "ref",
      cookie_window_days: 30,
      attribution_model: "last_click",
      default_commission_bps: 1000,
      default_customer_discount_bps: 0,
      allowed_deep_link_domains: ["shop.example"],
    },
    affiliates: [
      {
        id: IDS.affA,
        code: "ANNA10",
        status: "active",
        commission_bps: 1000,
        customer_discount_bps: 500,
        creator: { id: IDS.creatorA, username: "anna", display_name: "Anna", brand_user_ref: "user-a" },
      },
      {
        id: IDS.affB,
        code: "BEN15",
        status: "active",
        commission_bps: 1500,
        customer_discount_bps: null,
        creator: { id: IDS.creatorB, username: "ben", display_name: null, brand_user_ref: "user-b" },
      },
      {
        id: IDS.affOld,
        code: "OLD5",
        status: "suspended",
        commission_bps: 500,
        customer_discount_bps: null,
        creator: { id: IDS.creatorB, username: "ben", display_name: null, brand_user_ref: "user-b" },
      },
    ],
    campaigns: [
      { id: IDS.campaign, title: "Autumn drop", type: "video", start_date: "2026-10-01", end_date: null, is_active: true },
    ],
    links: [{ id: IDS.link, affiliate_id: IDS.affA, label: "Hoodie", target_path: "/products/hoodie" }],
  };
}

export class Clock {
  constructor(public t: number) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export type FetchCall = { url: string; init: RequestInit | undefined };

export type SetupOptions = {
  viewer?: Viewer | null;
  siteOrigin?: string;
  start?: number;
  store?: Store;
  connector?: Partial<ConnectorOptions>;
  /** Pull the config once before returning (as the brand's timer or cron would). Default true. */
  load?: boolean;
};

export async function setup(options: SetupOptions = {}) {
  const ctx = setupSync(options);
  if (options.load !== false) await ctx.connector.refreshConfig();
  return ctx;
}

/** Pins a creator's proposed login, as one of the brand's admins would. */
export async function approve(connector: Connector, creatorId: string, userRef: string) {
  const result = await connector.approveCreatorLink({ creatorId, userRef });
  if (result.status !== "approved") throw new Error(`approve failed: ${result.status}`);
}

export function setupSync(options: SetupOptions = {}) {
  const keys = keyPair();
  const clock = new Clock(options.start ?? Date.parse("2026-10-06T12:00:00Z"));
  const store = options.store ?? testStore();
  const state = {
    config: configFixture() as unknown,
    fail: null as null | "network" | number,
    viewer: (options.viewer === undefined ? { role: "admin" } : options.viewer) as Viewer | null,
  };
  const calls: FetchCall[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    if (state.fail === "network") throw new TypeError("fetch failed");
    if (typeof state.fail === "number") return new Response("{}", { status: state.fail });
    return new Response(JSON.stringify(state.config), { status: 200, headers: { "content-type": "application/json" } });
  };
  const connectorOptions: ConnectorOptions = {
    brand: BRAND,
    dashboardUrl: DASHBOARD,
    privateKey: keys.base64,
    store,
    getViewer: async () => state.viewer,
    fetch: fetchMock,
    now: clock.now,
    configRefresh: "manual",
    trustedIpHeader: "x-forwarded-for",
    ...(options.siteOrigin ? { siteOrigin: options.siteOrigin } : {}),
    ...options.connector,
  };
  const connector = createConnector(connectorOptions);
  return { connector, store, clock, keys, calls, state };
}

export function clickRequest(body: unknown, headers: Record<string, string> = {}, url = `${SITE}/api/md/click`) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, "x-forwarded-for": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export async function click(connector: Connector, ref: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await connector.handle(clickRequest({ ref, ...extra }, headers));
  if (response.status !== 200) throw new Error(`click failed with ${response.status}`);
  const body = (await response.json()) as { click_id: string };
  return body.click_id;
}

export function adminRequest(action: "approve" | "unlink", body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${SITE}/api/md/creator-links/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE, ...headers },
    body: JSON.stringify(body),
  });
}

export function statsRequest(range = "30d", headers: Record<string, string> = {}) {
  return new Request(`${SITE}/api/md/stats?range=${range}`, { headers });
}

export async function stats(connector: Connector, range = "30d") {
  const response = await connector.handle(statsRequest(range));
  if (response.status !== 200) throw new Error(`stats failed with ${response.status}`);
  return (await response.json()) as import("../server/index.js").StatsResponse;
}

export function decodeJwt(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature!, "base64url"),
  };
}

export type { KeyObject };
