# Media Platform connector

Your brand's own app for the Media Platform. It runs in **your** Vercel account with **your own Supabase** and keeps everything private: sales, shoppers, emails, recordings, ad data. The Media Platform only ever learns which services you've switched on and whether setup checks pass.

## Set up

1. **Deploy** with the button on the Media Platform's Integration page. Fill in the values it shows (`MEDIA_PLATFORM_URL`, `BRAND`, `BRAND_NAME`, `SITE_URL`, `OWNER_KEY`).
2. **Link your Supabase**: in your Supabase project, **Project Settings → Integrations → Vercel** → connect it to this Vercel project → in Vercel, **Redeploy**. (Or set `SUPABASE_DB_URL` by hand to your Supabase **Connect → Transaction pooler** address, with your password in it.)
3. Open this app's address, sign in with your `OWNER_KEY`, and follow the setup page: paste your connect code, give Claude Code the short website prompt, and connect Shopify. Every step shows a tick when it works.

Owners and creators then use `https://<your site>/media`.

## Security

- `OWNER_KEY` lives only in this project's environment and is typed only into this app's own pages. The Media Platform never sees it, so nothing it does can open your owner view. Changing it signs out every remembered device.
- Creators sign in with their Media Platform login; this app checks the platform's signature on who they are, and shows each creator only their own numbers, after you approve them.
- Its tables are all named `md_…` and locked (row level security), so your website's public Supabase key can't read them. Only this app, and you in Supabase, can.
- This app's key pair is made on first start and kept in your database. Only the public half is sent to the Media Platform.
- Turn on two-factor sign-in for your Vercel account: anyone who can sign in to it can see this project's settings.

## Updates

This app only changes when you choose to update it. Before accepting an update, use the "Updates" prompt on the setup page to have your AI check nothing in it sends your data anywhere new. You can stay on your current version for as long as you like.

`connector/` holds the connector's source; it's built during every deploy (`npm run build`). `npm test` runs its tests.
