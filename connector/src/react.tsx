"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IFRAME_REFERRER_POLICY, IFRAME_SANDBOX, mountMediaDashboard } from "./host/index.js";

export type MediaDashboardEmbedProps = {
  /** From creatorEmbedUrl() / adminEntryUrl(), minted on the server for this request. */
  src: string;
  dashboardOrigin: string;
  /** Same-origin stats endpoint. Default "/api/md/stats". */
  statsUrl?: string;
  className?: string;
  title?: string;
  nonce?: string;
  /** Fixed height of the sales screen (it scrolls inside). Default 960. */
  panelHeight?: number;
};

/**
 * The media dashboard iframe with the brand's own sales screen drawn over its
 * placeholder slot. The iframe is rendered by React (once, client-side) so
 * Strict Mode's double effects never load the single-use pass twice. It is
 * sandboxed from its first load: the dashboard can never navigate this page.
 */
export function MediaDashboardEmbed({ src, dashboardOrigin, statsUrl, className, title, nonce, panelHeight }: MediaDashboardEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Layout effect: the message listener is attached before the iframe document can post anything.
  useLayoutEffect(() => {
    if (!mounted || !containerRef.current || !frameRef.current) return;
    const handle = mountMediaDashboard({
      container: containerRef.current,
      iframe: frameRef.current,
      src,
      dashboardOrigin,
      statsUrl,
      title,
      nonce,
      panelHeight,
    });
    return () => handle.destroy();
  }, [mounted, src, dashboardOrigin, statsUrl, title, nonce, panelHeight]);

  return (
    <div ref={containerRef} className={className} style={{ position: "relative" }}>
      {mounted ? (
        <iframe
          ref={frameRef}
          src={src}
          title={title ?? "Media Dashboard"}
          allow="clipboard-write"
          sandbox={IFRAME_SANDBOX}
          referrerPolicy={IFRAME_REFERRER_POLICY}
          style={{ display: "block", width: "100%", height: 720, border: 0 }}
        />
      ) : null}
    </div>
  );
}

export default MediaDashboardEmbed;
