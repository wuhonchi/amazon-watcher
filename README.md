# amazon-watcher

Cron-based watcher for Amazon search pages. Detects added / removed products and price changes, then pings Telegram.

## How it works

1. GitHub Actions runs `node scraper.js` every 10 minutes.
2. Playwright loads each URL in `urls.json`, extracts product cards.
3. Diff against previous snapshot in `snapshots/<slug>.json`.
4. If changed → Telegram message.
5. Commit updated snapshot back to the repo.

## Local run

```bash
npm install
npx playwright install chromium
TELEGRAM_TOKEN=xxx TELEGRAM_CHAT_ID=xxx node scraper.js
```

## GitHub Secrets required

- `TELEGRAM_TOKEN` — bot token from @BotFather
- `TELEGRAM_CHAT_ID` — your chat id

## Add / remove URLs

Edit `urls.json`. Each entry: `{ slug, name, url, deliverTo? }`.

- `slug` — snapshot filename (kebab-case, keep stable)
- `url` — Amazon search URL (avoid session-specific params like `ds`, `qid`, `ref`)
- `deliverTo` — optional ISO country code (e.g. `"HK"`, `"CA"`). Scraper will call Amazon's address-change endpoint so results reflect that country's shipping availability.

### Known limitations

- **amazon.co.uk** rejects country changes for guest (unauthenticated) sessions. Setting `deliverTo: "HK"` on a `.co.uk` URL will log a warning and fall back to the runner's default ship-to (usually UK from GitHub Actions).
- If Amazon rate-limits or soft-blocks (`Sorry! Something went wrong!`), the scraper retries 3× with backoff, then skips that URL for this run (keeps the previous snapshot so the next run still detects changes correctly).
