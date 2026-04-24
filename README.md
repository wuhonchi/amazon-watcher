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

Edit `urls.json`. Each entry: `{ slug, name, url }`. `slug` is the snapshot filename (use kebab-case, keep stable).
