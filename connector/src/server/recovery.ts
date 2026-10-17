import type { CheckoutWatch } from "./store.js";
import type { RecoveryEmailTemplate } from "./types.js";

/*
 * Cart-recovery emails, sent by the connector from the brand's own server
 * through the brand's own Resend account. The dashboard only supplies the
 * wording and timing (configuration); the shopper's address never leaves the
 * brand except to its own email provider.
 */

export type RecoveryEmailsOptions = {
  /** RESEND_API_KEY from the brand's own Resend account. */
  resendApiKey: string;
  /** e.g. "Kraze <hello@kraze.com>" — the domain must be verified in Resend. */
  from: string;
  replyTo?: string;
  /** Shown in {{brand_name}}. */
  brandName: string;
  /**
   * Only email shoppers who ticked "email me offers". Default false: every
   * shopper with an address can get one, each email carries an unsubscribe
   * link, and unsubscribed addresses are never emailed again.
   */
  requireMarketingConsent?: boolean;
  onError?: (error: Error) => void;
  timeoutMs?: number;
};

export type RecoverySendResult = "sent" | "failed" | "no_email" | "no_link" | "no_consent" | "disabled";

export type RecoverySender = {
  readonly requireConsent: boolean;
  /**
   * Sends one recovery email. `manual` (an admin clicked send) ignores the
   * dashboard's automatic switch. The caller checks suppression and duplicates.
   */
  send(
    watch: CheckoutWatch,
    template: RecoveryEmailTemplate,
    extras: { creatorName: string | null; unsubscribeUrl: string; manual?: boolean }
  ): Promise<RecoverySendResult>;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function fillTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*(first_name|brand_name|cart_total|creator_name)\s*\}\}/g, (_, key: string) => values[key] ?? "");
}

export function renderRecoveryEmail(
  template: RecoveryEmailTemplate,
  values: Record<string, string>,
  recoveryUrl: string,
  unsubscribeUrl: string | null = null
): { subject: string; html: string; text: string } {
  // An empty placeholder ("Hi {{first_name}},") shouldn't leave stray spaces or a leading comma.
  const fill = (t: string) => {
    const out = fillTemplate(t, values).replace(/[ \t]+([,.!?])/g, "$1").replace(/^[\s,]+/, "").trim();
    return out.charAt(0).toUpperCase() + out.slice(1);
  };
  const subject = fill(template.subject).replace(/[\r\n]+/g, " ").slice(0, 200);
  const paragraphs = fill(template.body).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const heading = fill(template.heading);
  const footer = fill(template.footer);
  const button = fill(template.button_label) || "Finish checkout";
  const href = escapeHtml(recoveryUrl);
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:8px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>
${heading ? `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(heading)}</h1>` : ""}
${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n")}
<p style="margin:22px 0"><a href="${href}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">${escapeHtml(button)}</a></p>
${footer ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#777">${escapeHtml(footer).replace(/\n/g, "<br>")}</p>` : ""}
${unsubscribeUrl ? `<p style="margin:12px 0 0;font-size:12px;color:#777"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#777">Unsubscribe</a></p>` : ""}
</td></tr></table></td></tr></table></body></html>`;
  const text = [heading, ...paragraphs, `${button}: ${recoveryUrl}`, footer, unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return { subject, html, text };
}

const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[a-z]{2,}$/i;

export function createRecoverySender(options: RecoveryEmailsOptions | undefined, fetchImpl: typeof fetch): RecoverySender | null {
  if (!options) return null;
  if (!options.resendApiKey?.startsWith("re_")) throw new Error("recoveryEmails.resendApiKey must be a Resend API key (re_...).");
  if (!/<[^\s@<>]+@[^\s@<>]+>$|^[^\s@<>]+@[^\s@<>]+$/.test(options.from?.trim() ?? "")) {
    throw new Error('recoveryEmails.from must be an address like "Kraze <hello@kraze.com>".');
  }
  const requireConsent = options.requireMarketingConsent === true;
  return {
    requireConsent,
    async send(watch, template, { creatorName, unsubscribeUrl, manual }) {
      if (!template.enabled && !manual) return "disabled";
      if (!watch.email || !EMAIL_RE.test(watch.email)) return "no_email";
      if (!watch.recoveryUrl) return "no_link";
      if (requireConsent && !watch.marketingConsent) return "no_consent";
      const values = {
        first_name: watch.firstName ?? "",
        brand_name: options.brandName,
        cart_total: money(watch.cartTotal, watch.currency),
        creator_name: creatorName ?? "",
      };
      const email = renderRecoveryEmail(template, values, watch.recoveryUrl, unsubscribeUrl);
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.resendApiKey}`,
            "content-type": "application/json",
            // Resend drops repeats of the same key, so a retried sweep never emails twice.
            "idempotency-key": `md-recovery-${watch.id}`.slice(0, 256),
          },
          body: JSON.stringify({
            from: options.from,
            to: [watch.email],
            subject: email.subject,
            html: email.html,
            text: email.text,
            ...(options.replyTo ? { reply_to: options.replyTo } : {}),
            // One-click unsubscribe (RFC 8058), which Gmail and Yahoo require.
            headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
            tags: [{ name: "type", value: "cart_recovery" }],
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
        });
        if (!response.ok) throw new Error(`Resend answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
        return "sent";
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return "failed";
      }
    },
  };
}
