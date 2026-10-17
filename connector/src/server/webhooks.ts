import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/*
 * Signed webhooks from the connector to the brand's own tools (an email/SMS
 * provider, Zapier, Make, n8n, a Slack incoming webhook relay...). The main
 * use is abandoned-checkout recovery: "checkout.abandoned" fires once per
 * checkout left unpaid for abandonAfterMinutes.
 */

export type WebhookEvent = "checkout.started" | "checkout.failed" | "checkout.abandoned" | "order.created" | "order.refunded";
export const WEBHOOK_EVENTS: WebhookEvent[] = ["checkout.started", "checkout.failed", "checkout.abandoned", "order.created", "order.refunded"];

export type WebhookEndpoint = {
  url: string;
  /** Shared secret, at least 16 characters, used to sign every delivery. */
  secret: string;
  /** Default: every event. */
  events?: WebhookEvent[];
};

export type WebhooksOptions = {
  endpoints: WebhookEndpoint[];
  /** Delivery attempts per endpoint. Default 3. */
  attempts?: number;
  timeoutMs?: number;
  onError?: (event: WebhookEvent, url: string, error: Error) => void;
};

export type WebhookPayload = {
  id: string;
  type: WebhookEvent;
  created_at: string;
  data: Record<string, unknown>;
};

export const SIGNATURE_HEADER = "md-webhook-signature";
export const TIMESTAMP_HEADER = "md-webhook-timestamp";
export const ID_HEADER = "md-webhook-id";

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("hex")}`;
}

/**
 * For the receiving end: true when the delivery was signed with `secret` and is
 * at most toleranceSeconds old. Pass the raw request body, not re-serialised JSON.
 */
export function verifyWebhook(input: {
  secret: string;
  body: string;
  headers: Headers | Record<string, string | null | undefined>;
  toleranceSeconds?: number;
  now?: Date;
}): boolean {
  const get = (name: string) =>
    input.headers instanceof Headers ? input.headers.get(name) : (input.headers[name] ?? input.headers[name.toLowerCase()] ?? null);
  const id = get(ID_HEADER);
  const ts = Number(get(TIMESTAMP_HEADER));
  const signature = get(SIGNATURE_HEADER);
  if (!id || !signature || !Number.isFinite(ts)) return false;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(input.secret, id, ts, input.body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type Dispatcher = {
  wants(event: WebhookEvent): boolean;
  send(event: WebhookEvent, data: Record<string, unknown>): Promise<{ url: string; ok: boolean }[]>;
};

function checkUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`webhooks: "${value}" is not an absolute URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("webhooks: endpoint URLs must use https.");
  return url.href;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDispatcher(options: WebhooksOptions | undefined, fetchImpl: typeof fetch, now: () => Date): Dispatcher | null {
  if (!options?.endpoints?.length) return null;
  const endpoints = options.endpoints.map((e) => {
    if (typeof e.secret !== "string" || e.secret.length < 16) throw new Error("webhooks: each endpoint needs a secret of at least 16 characters.");
    const events = e.events ?? WEBHOOK_EVENTS;
    for (const ev of events) if (!WEBHOOK_EVENTS.includes(ev)) throw new Error(`webhooks: unknown event "${ev}".`);
    return { url: checkUrl(e.url), secret: e.secret, events: new Set(events) };
  });
  const attempts = Math.max(1, Math.min(5, options.attempts ?? 3));
  const timeoutMs = options.timeoutMs ?? 5000;

  async function deliver(endpoint: (typeof endpoints)[number], payload: WebhookPayload): Promise<boolean> {
    const body = JSON.stringify(payload);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await wait(500 * 4 ** (attempt - 1));
      const ts = Math.floor(now().getTime() / 1000);
      try {
        const response = await fetchImpl(endpoint.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "media-dashboard-connector",
            [ID_HEADER]: payload.id,
            [TIMESTAMP_HEADER]: String(ts),
            [SIGNATURE_HEADER]: signWebhook(endpoint.secret, payload.id, ts, body),
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return true;
        lastError = new Error(`answered ${response.status}`);
        // A 4xx other than 408/429 won't succeed on retry.
        if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    options!.onError?.(payload.type, endpoint.url, lastError ?? new Error("delivery failed"));
    return false;
  }

  return {
    wants: (event) => endpoints.some((e) => e.events.has(event)),
    async send(event, data) {
      const targets = endpoints.filter((e) => e.events.has(event));
      if (!targets.length) return [];
      const payload: WebhookPayload = { id: randomUUID(), type: event, created_at: now().toISOString(), data };
      return Promise.all(targets.map(async (e) => ({ url: e.url, ok: await deliver(e, payload) })));
    },
  };
}
