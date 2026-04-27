# amazon-watcher

External-cron-driven watcher for Amazon search pages. Detects added items and price drops across amazon.com / amazon.co.uk / amazon.ca, then pings Telegram with thumbnails and HKD-converted prices.

## How it works

1. **cron-job.org** fires every 10 min and POSTs `workflows/check.yml/dispatches` on this repo.
2. The GitHub Actions workflow installs OpenVPN, connects to a **Surfshark HK exit** (so Amazon sees a residential HK IP).
3. `node scraper.js` runs Playwright Chromium against each URL in `urls.json`.
4. Items are diffed against `snapshots/<slug>.json`. New items + price drops are aggregated into one Telegram message (with native + ≈HKD prices and a thumbnail link preview).
5. Updated snapshots are committed back to the repo.
6. VPN is torn down last.

GitHub Actions' native `schedule:` trigger isn't used — it was skipping or delaying scheduled runs by 30–90 minutes during peak load. cron-job.org gives ~99% on-time triggering for free.

## Why the VPN

Amazon's CloudFront WAF returns hard 503s to GitHub-hosted Azure datacenter IPs that try to load amazon.co.uk search pages after a guest country-change POST. Routing the runner through a HK residential-looking exit IP avoids the IP-reputation block, and as a bonus the default ship-to becomes HK without needing the address-change POST at all (still kept for amazon.ca where we want CA delivery).

## Local run

```bash
npm install
npx playwright install chromium
TELEGRAM_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node scraper.js
```

(No VPN locally — your own network IP is whatever it is.)

## GitHub Secrets required

| Secret | Used by |
|---|---|
| `TELEGRAM_TOKEN` | scraper.js |
| `TELEGRAM_CHAT_ID` | scraper.js |
| `SURFSHARK_USER` | OpenVPN auth (Surfshark "Manual setup" service username) |
| `SURFSHARK_PASS` | OpenVPN auth (service password) |

The `.ovpn` file in `vpn-configs/` carries no secrets — just the public CA + tls-auth key. Auth is supplied at runtime from the secrets above.

## External trigger setup (cron-job.org)

Create a cron at [cron-job.org](https://cron-job.org) with:

- **URL**: `https://api.github.com/repos/<owner>/<repo>/actions/workflows/check.yml/dispatches`
- **Method**: `POST`
- **Body**: `{"ref":"main"}`
- **Headers**:
  - `Authorization: Bearer <fine-grained PAT with Actions: Read+Write>`
  - `Accept: application/vnd.github+json`
  - `User-Agent: cron-job.org`
- **Schedule**: every 10 minutes

A successful dispatch returns HTTP `204 No Content`.

## Add / remove URLs

Edit `urls.json`. Each entry:

```json
{
  "slug": "ca-pokemon-amazonca",
  "name": "Display name shown in Telegram heartbeat",
  "url": "https://www.amazon.ca/s?...",
  "deliverTo": "CA",
  "deliveryFlow": "target"
}
```

- `slug` — snapshot filename (kebab-case, keep stable)
- `url` — Amazon search URL (avoid session-specific params like `ds`, `qid`, `ref`)
- `deliverTo` — optional ISO country code. Scraper POSTs to Amazon's address-change endpoint so search results reflect that country's shipping availability.
- `deliveryFlow` — `"target"` (default) or `"homepage"`. Use `"homepage"` for amazon.co.uk: land on the home page, dwell ~10s, POST address-change, dwell ~7s, then load the search URL — looks more like a real user clicking the "Deliver to" widget than the snap-fetch flow.

## Known caveats

- **Surfshark server can occasionally be flagged by Amazon** if too many users share the same exit IP. If runs start failing again, drop another `.ovpn` (different city) into `vpn-configs/` and update the workflow to point at it.
- **Amazon rate-limits / soft-blocks (`503 - Service Unavailable Error`)** — the scraper retries with 10s/30s/60s backoff, then skips that URL for this run. Previous snapshot is preserved so the next run still detects changes correctly.
- **AWS WAF JS challenge** — the scraper waits up to 25s for the auto-solving challenge to clear before scraping (detects `window.gokuProps` / `awsWafCookieDomainList`).
