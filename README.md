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

### Restock what sold

On the Doctrine list, set **Fill slots with** to **Restock what sold since last haul**. Everything you sold at the hub since your last Jita → hub courier contract goes to the top of the buy list, with at least as many as you sold. That includes items that aren't on the tracker. Those rows are marked **SOLD**. Sold-out items come next, then everything else by profit.

## Where your ISK is

The Trade journal shows your trading wallet division's balance, plus your stock at cost, split into: listed at the hub, in transit on courier contracts, and not listed yet.

## Sell prices

When a haul lands, open the **Sell prices** tab and click **Price my stock**. It uses the wallets set up on the Trade journal tab to find what you bought in Jita and haven't sold yet, then shows for each item:

- **Your cost:** average Jita price plus hauling.
- **Break-even:** the lowest price that doesn't lose money after sales tax and the hub broker fee.
- **Min price:** the lowest price that still makes your minimum return (the Doctrine list's "Minimum return %").
- **Hub lowest:** the Keepstar's lowest sell and how many sellers, or **SOLD OUT**.
- **List at:** one tick under the hub's lowest. For sold-out items it's the 7-day regional average or your sold-out markup, whichever is higher. It never goes below your minimum. Click it to copy the price.
- **Why:** a short reason, including a warning when the hub is already selling below your minimum or your break-even.

Prices follow EVE's 4-significant-figure rule. If you've already listed some items, the hub's lowest may be your own order.

## Liquidate

Turn items you didn't buy in Jita into ISK quickly. Copy them from your EVE hangars (list view, Ctrl+C) into the **Liquidate** tab and click **Plan the sale**. For each item:

1. **List at the Keepstar** only as many as the hub sells within your time limit (default 7 days), one tick under the lowest seller. This only happens if it beats selling instantly.
2. **Sell the rest instantly** into whichever pays more after fees: **buy orders at the Keepstar**, or **Jita 4-4 buy orders** after a courier. Hauling uses your hauling settings.
3. Anything the buyers can't absorb is flagged as left over.

The totals show the ISK from each route and the m³ to haul to Jita.

## Order check

Check your orders as often as you like. **Order check** tells you which sell orders at the Keepstar are worth updating:

- **Update:** cheaper units ahead of you would take longer than your threshold (default 1 day of sales) to clear. It shows the new price (click to copy), the update fee, and how much less you'd get.
- **Leave it:** you're already the lowest, the cheaper units ahead will sell soon anyway, or the undercut is tiny (default under 1%).
- **Hold:** matching would go below your minimum price (your Jita cost plus hauling, at your minimum return).
- **Wait:** changed less than 5 minutes ago, so EVE won't allow another update yet.

It reads open orders with the characters on the Trade journal tab. They now also ask for `esi-markets.read_character_orders.v1` and `esi-markets.read_corporation_orders.v1`, so add those to your EVE app and click **Allow order access** next to each character. Corp orders need the **Accountant** or **Trader** role.

## Trade journal

The **Trade journal** tab reads your real buys, sales, sales tax and broker fees from your wallets and shows what each item actually made.

**One-time setup:** on https://developers.eveonline.com, open the EVE app and add these two permissions to the ones it already has:

- `esi-wallet.read_character_wallet.v1`
- `esi-wallet.read_corporation_wallets.v1`

Then, in the Trade journal tab:

1. Click **Add a character (with wallet access)** for each character that buys or sells.
2. Leave **Corp wallet** on **Include**, and set the division you trade from. 1 is the Master Wallet, then 2–7 in the order shown in game. Pick a character with the **Accountant** or **Junior Accountant** role to read it. Everything in that division counts as trading.
3. Choose a period, up to 30 days (CCP only keeps 30 days of wallet journal), and click **Load my trades**.

**What it shows:**

- Revenue, cost of what sold, estimated hauling, and the sales tax and broker fees actually charged.
- Net profit.
- Unsold stock, valued at cost.
- A line comparing the broker fees you paid with what listing would have cost. The difference is mostly order updates.
- Per item: average buy and sell price, profit, return, your sales per day compared with the hub's (from the doctrine tracker, if loaded), and how much is left to sell.

## Delivery alerts (Discord)

A small Cloudflare Worker (`watcher/`) checks your courier contracts every 10 minutes and posts to Discord when one is **picked up**, **delivered**, or **fails/is rejected**. It works with the site closed.

### One-time setup (at your PC, in PowerShell)

1. **EVE app permissions:** at https://developers.eveonline.com, add `esi-contracts.read_character_contracts.v1` and `esi-contracts.read_corporation_contracts.v1` to your EVE app.
2. **Discord webhook:** in a private channel go to **Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL**.
3. **Storage and worker:**
   ```powershell
   cd C:\path\to\eve-trader\watcher
   npx wrangler kv namespace create WATCH
   ```
   Copy the `id` it prints into `watcher\wrangler.toml` (replace `PASTE_KV_NAMESPACE_ID_HERE`), then deploy:
   ```powershell
   npx wrangler deploy
   ```
4. **Let the site use the same storage:** in the Cloudflare dashboard, go to **Workers & Pages → eve-trader → Settings → Bindings → Add → KV namespace**. Set the variable name to `WATCH` and choose the namespace you just made. Save, then redeploy, or just push any change.
5. **Turn it on:** go to the site's **Trade journal** tab → **Delivery alerts**, paste the webhook link, and click **Turn on alerts**. Log in with the character that issues the courier contracts (or any corp member, for corp contracts). A test message appears in Discord.

### Notes

- **Your first check only records the contracts you already have.** Alerts start with the next change.
- **The alert login is separate from your other logins.** Its token is stored only in your Cloudflare KV, so the worker can check while the site is closed. Click **Turn off** to delete it.
- **Optional:** set `ALLOWED_CHARACTERS` (comma-separated character IDs) on the Pages project to stop anyone else registering alerts on your site.
- **Testing:** visit the worker's URL (`https://eve-trader-watcher.<your-subdomain>.workers.dev`) to run a check right away.

## Daily summary (Discord)

Every day at 8:00 AM Eastern, the watcher posts a summary to the alerts channel:

- **Last 24 hours:** profit on your import sales, after Jita cost, hauling, the actual sales tax and the hub broker fee, plus your top items.
- **Restock soon:** imported items that are sold out or have under 3 days of stock left. Stock means bought in Jita minus sold at the hub. Days come from the doctrine tracker or regional history. It also notes items with no other sellers.
- **Orders worth updating:** the same rules as the Order check tab.

It uses the settings, hub and tracker you saved on the site, plus the cloud history. The alert login asks for market access (`esi-markets.structure_markets.v1`, `esi-markets.read_corporation_orders.v1`, `esi-markets.read_character_orders.v1`), so **turn alerts on again once** after updating. To get a summary right away, open `https://eve-trader-watcher.<subdomain>.workers.dev/?summary=1`.

## Cloud history (Cloudflare D1)

CCP only keeps about 30 days of wallet journal. The watcher Worker copies your wallets into a D1 database **every hour**: the character, plus the corp division set on the Trade journal tab. It also stores every courier contract with what it actually cost. The Trade journal and Sell prices tabs read this history together with the live wallet, so nothing from your trading is lost.

Your **delivery-alert registration** works as your cloud account. While alerts are on:

- **Settings sync:** your settings, hub and doctrine tracker are saved to the cloud and load on any device.
- **Wallet copies:** the alert login includes wallet access so the Worker can copy your wallets. Log in with the character that has the corp **Accountant** (or Junior Accountant) role.

### One-time setup (PowerShell, in the `watcher` folder)

```powershell
npx wrangler d1 create eve-trader
```
Put the `database_id` it prints into `watcher\wrangler.toml` (replace `PASTE_D1_DATABASE_ID_HERE`), then:
```powershell
npx wrangler d1 execute eve-trader --remote --file=schema.sql
npx wrangler deploy
```
In the Cloudflare dashboard, go to **Workers & Pages → eve-trader → Settings → Bindings → Add → D1 database**. Set the variable name to `DB`, choose database `eve-trader`, and save. Then redeploy the site (merge `dev` into `main`) and turn delivery alerts on, or on again, from the Trade journal tab.

## Known limits

- ESI caches structure markets for about 5 minutes, so scanning more often than that won't show anything new.
- Daily volume comes from regional history, so it includes other markets in the same region.
- Items the hub doesn't stock at all don't show up, because there's no hub price to compare. A "missing items" view can be added later.
- Local testing with `npx wrangler pages dev public` runs at `http://localhost:8788/`. EVE apps allow one callback URL, so create a second EVE app with that callback for testing.

## Version

The version number lives in `public/version.js` and shows at the bottom of both pages. It goes up with every change pushed to `dev`, so you can tell at a glance whether the live site has the latest change.
