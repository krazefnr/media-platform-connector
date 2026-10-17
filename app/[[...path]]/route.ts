import { getApp } from "../../lib/app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every path (setup page, /media, /api/md/*, Shopify, cron) is handled by the connector app. */
function handle(request: Request) {
  return getApp().handle(request);
}

export { handle as GET, handle as POST, handle as OPTIONS, handle as HEAD };
