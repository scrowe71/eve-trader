# EVE Import Finder

This site compares your alliance hub (a player structure) with Jita 4-4 and lists the items worth importing. It accounts for your skills, broker fees, sales tax and alliance hauling. It runs on Cloudflare Pages, and you log in with EVE SSO.

```
public/
  index.html        the Import Finder
  app.js            login, ESI calls, analysis
  config.js         your EVE Client ID goes here
  calculator.html   the single-trade profit calculator
functions/api/
  token.js          passes the SSO token exchange through to CCP (no secret stored)
  jita.js           Jita prices from Fuzzwork, cached 5 minutes
```

## How it works

- **Login** uses EVE SSO with PKCE. No client secret is needed. Your tokens stay in your own browser's storage.
- **Hub orders** are read directly from ESI (`/markets/structures/{id}/`) with your login. The character must be able to dock at the structure.
- **Jita prices** come through `/api/jita`, which fetches Fuzzwork aggregates for Jita IV - Moon 4.
- **Item sizes and daily volume** come from public ESI. They're cached in your browser so repeat scans run faster.

## Setup (about 15 minutes, all in PowerShell)

### 1. Choose your site name

Cloudflare Pages gives you `https://<project-name>.pages.dev/`. Pick the name now, for example `diesel-trade`, because the EVE app needs the exact URL.

### 2. Create the EVE application

1. Go to https://developers.eveonline.com/ and log in.
2. Create a new application:
   - **Connection type:** Authentication & API Access
   - **Permissions (scopes):**
     - `esi-markets.structure_markets.v1`
     - `esi-search.search_structures.v1`
     - `esi-universe.read_structures.v1`
   - **Callback URL:** `https://diesel-trade.pages.dev/`, using your name. Keep the trailing slash.
3. Copy the **Client ID**. You don't need the secret key.
4. Open `public\config.js` and paste the Client ID in place of `PASTE_YOUR_CLIENT_ID_HERE`.

### 3. Deploy to Cloudflare

You need Node.js LTS installed (https://nodejs.org). Then, from this folder:

```powershell
cd C:\path\to\eve-trade-finder
npx wrangler login
npx wrangler pages project create diesel-trade --production-branch main
npx wrangler pages deploy public --project-name diesel-trade
```

Run `wrangler pages deploy` from this folder, not from inside `public`. Wrangler picks up the `functions` folder from the current directory.

To redeploy after any change, run the last line again.

### 4. Optional: lock the token function to your app

In the Cloudflare dashboard, go to **Workers & Pages → diesel-trade → Settings → Variables and Secrets**. Add `EVE_CLIENT_ID` with your Client ID, then redeploy. After that, `/api/token` only works for your app.

### 5. Optional: make the site private

The site holds no secrets, but you can keep other people off it. In the Cloudflare dashboard, open **Zero Trust → Access → Applications**, add the `*.pages.dev` site, and allow only your email address. That's free for one user.

## Using it

1. Click **Log in with EVE Online** and choose the character that docks at the hub.
2. Search for the hub structure by name (for example `1DQ1-A`), or paste its structure ID.
3. Check your fees. Set the hub broker fee to what the in-game sell window shows at that structure. Set the hauling rate and collateral % to your alliance service's prices.
4. Click **Scan for imports**.

The list is sorted by **profit per day of volume**: profit per unit × average units traded per day in the hub's region. **Days of stock** shows how long the hub's current listings would last at that pace. Low numbers mean the item is running short.

## Doctrine list

The **Doctrine list** tab works from the Initiative Doctrine Stock Tracker instead of scanning everything in the hub.

1. Load the tracker: upload its CSV export, or paste a Google Sheets link. A sheet link only works if the sheet is viewable without a Google login ("Anyone with the link" or "Publish to web").
2. Pick **Days to cover** (30 matches the tracker's "Required" column) and which usage average to plan on.
3. Leave **Include** on *Seeding items only* unless the alliance is fine with traders importing Industry items.
4. Click **Build import list**.

For each short item, the site works out **days × daily usage − hub stock**. It caps that at **Max ISK per item**, then fills the list best-first by total profit until **Total budget** or **Max cargo m³** runs out.

If an item is sold out at the Keepstar, its hub price is estimated as your **sold-out markup** on the Jita cost and marked **EST**.

**Copy for Multibuy** copies `Item<TAB>qty` lines you can paste into the Jita Multibuy window. **Download CSV** saves the list.

The tracker is saved in your browser, so you only need to load it again when you want fresh numbers.

## Known limits

- ESI caches structure markets for about 5 minutes, so scanning more often than that won't show anything new.
- Daily volume comes from regional history, so it includes other markets in the same region.
- Items the hub doesn't stock at all don't show up, because there's no hub price to compare. A "missing items" view can be added later.
- Local testing with `npx wrangler pages dev public` runs at `http://localhost:8788/`. EVE apps allow one callback URL, so create a second EVE app with that callback for testing.

## Version

The version number lives in `public/version.js` and shows at the bottom of both pages. It goes up with every change pushed to `dev`, so you can tell at a glance whether the live site has the latest change.
