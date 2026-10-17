import pg from "pg";
import { after } from "next/server";
import { createConnectorApp, ensureSchema, postgresStore, type ConnectorApp } from "@media-dashboard/brand-connector";

let app: ConnectorApp | null = null;

const page = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connector setup</title>
<body style="font:15px/1.5 system-ui,sans-serif;max-width:620px;margin:10vh auto;padding:0 16px">
<h1>${title}</h1>${body}</body>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );

const HOW_TO = `<ol>
<li>In your Supabase project: <strong>Connect</strong> (top of the page) → <strong>Transaction pooler</strong> → copy the URI.</li>
<li>Put your database password in place of <code>[YOUR-PASSWORD]</code>. (Forgot it? <strong>Project Settings → Database → Reset database password</strong>.)</li>
<li>In Vercel: this project → <strong>Settings → Environment Variables</strong> → set <code>SUPABASE_DB_URL</code> to it → <strong>Deployments → Redeploy</strong>.</li>
</ol><p>This app makes its own <code>md_</code> tables in your Supabase and locks them so your website's public Supabase key can't read them.</p>`;

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Supabase only (any local Postgres is allowed for testing). Returns a page explaining what's wrong, or null. */
function checkUrl(url: string | undefined): Response | null {
  if (!url) return page("Connect your Supabase", `<p>This app keeps its data in your own Supabase.</p>${HOW_TO}`);
  if (url.includes("[YOUR-PASSWORD]")) return page("Add your password", `<p><code>SUPABASE_DB_URL</code> still says <code>[YOUR-PASSWORD]</code>.</p>${HOW_TO}`);
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return page("That database address doesn't look right", `<p>If your password has symbols like <code>@ # / ?</code>, reset it to one with only letters and numbers.</p>${HOW_TO}`);
  }
  if (LOCAL.has(host)) return null;
  if (!/\.supabase\.(co|com)$/.test(host)) return page("Use your Supabase", `<p><code>SUPABASE_DB_URL</code> must be your Supabase project's address.</p>${HOW_TO}`);
  if (/^db\./.test(host)) return page("Use the pooler address", `<p>Vercel can't reach Supabase's direct address. Copy the <strong>Transaction pooler</strong> one instead.</p>${HOW_TO}`);
  return null;
}

function dbProblem(error: unknown): Response {
  const code = (error as { code?: string })?.code;
  const why =
    code === "28P01" || code === "28000"
      ? "Supabase refused the password."
      : code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT"
        ? "Couldn't reach that Supabase address. Is the project paused? Restore it in Supabase, then reload."
        : "Couldn't connect to your Supabase.";
  return page("Can't reach your Supabase", `<p>${why}</p>${HOW_TO}`);
}

/** One app per server instance: its own database pool, built from this project's environment variables. */
export function getApp(): ConnectorApp {
  if (app) return app;
  const url = process.env.SUPABASE_DB_URL?.trim();
  const problem = checkUrl(url);
  if (problem) return { handle: async () => problem.clone() };
  const parsed = new URL(url!);
  const local = LOCAL.has(parsed.hostname);
  // Supabase's certificate isn't in Node's default trust list; the link is still encrypted.
  parsed.searchParams.delete("sslmode");
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 3,
  });
  pool.on("error", () => undefined);
  const inner = createConnectorApp({
    env: process.env,
    store: postgresStore({ pool }),
    ensureSchema: () => ensureSchema(pool),
    // Keeps background work (emails, config refresh) alive after the response on Vercel.
    waitUntil: (promise) => after(() => promise),
  });
  let reachable = false;
  app = {
    async handle(request) {
      if (!reachable) {
        try {
          await pool.query("select 1");
          reachable = true;
        } catch (error) {
          return dbProblem(error);
        }
      }
      return inner.handle(request);
    },
  };
  return app;
}
