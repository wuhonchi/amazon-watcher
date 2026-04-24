import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_DIR = 'snapshots';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS_IN_MESSAGE = 10;

async function scrapeSearch(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // If Amazon throws CAPTCHA / dog page, bail out.
  const title = await page.title();
  if (/robot|captcha|sorry/i.test(title)) {
    throw new Error(`Blocked by Amazon (title: ${title})`);
  }

  await page.waitForSelector('[data-component-type="s-search-result"]', {
    timeout: 30000,
  });

  const origin = new URL(url).origin;
  const items = await page.$$eval(
    '[data-component-type="s-search-result"]',
    (els, origin) =>
      els
        .map((el) => {
          const asin = el.getAttribute('data-asin');
          const titleEl = el.querySelector('h2 a span, h2 span, [data-cy="title-recipe"] span');
          const priceEl = el.querySelector('.a-price .a-offscreen');
          const linkEl = el.querySelector('a.a-link-normal.s-line-clamp-2, h2 a, a.a-link-normal[href*="/dp/"]');
          let link = '';
          const href = linkEl?.getAttribute('href');
          if (href) {
            try {
              link = new URL(href, origin).href;
            } catch {
              link = '';
            }
          }
          return {
            asin,
            title: titleEl?.textContent?.trim() || '',
            price: priceEl?.textContent?.trim() || null,
            link,
          };
        })
        .filter((i) => i.asin),
    origin,
  );

  return items;
}

function diffItems(oldItems, newItems) {
  const oldMap = new Map(oldItems.map((i) => [i.asin, i]));
  const newMap = new Map(newItems.map((i) => [i.asin, i]));

  const added = newItems.filter((i) => !oldMap.has(i.asin));
  const removed = oldItems.filter((i) => !newMap.has(i.asin));
  const priceChanged = newItems
    .filter((i) => {
      const o = oldMap.get(i.asin);
      return o && o.price !== i.price;
    })
    .map((i) => ({ ...i, oldPrice: oldMap.get(i.asin).price }));

  return { added, removed, priceChanged };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(s, n) {
  const clean = (s || '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log('[tg] No Telegram config, skipping notification');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    console.error('[tg] error:', res.status, await res.text());
  } else {
    console.log('[tg] sent');
  }
}

function formatMessage(name, url, { added, removed, priceChanged }) {
  const lines = [`<b>${escapeHtml(name)}</b>`];

  if (added.length) {
    lines.push(`\n✅ <b>New (${added.length}):</b>`);
    for (const i of added.slice(0, MAX_ITEMS_IN_MESSAGE)) {
      const priceTxt = i.price ? ` — ${escapeHtml(i.price)}` : '';
      lines.push(`• <a href="${escapeHtml(i.link)}">${escapeHtml(truncate(i.title, 80))}</a>${priceTxt}`);
    }
    if (added.length > MAX_ITEMS_IN_MESSAGE) lines.push(`…+${added.length - MAX_ITEMS_IN_MESSAGE} more`);
  }

  if (removed.length) {
    lines.push(`\n❌ <b>Gone (${removed.length}):</b>`);
    for (const i of removed.slice(0, MAX_ITEMS_IN_MESSAGE)) {
      lines.push(`• ${escapeHtml(truncate(i.title, 80))}`);
    }
    if (removed.length > MAX_ITEMS_IN_MESSAGE) lines.push(`…+${removed.length - MAX_ITEMS_IN_MESSAGE} more`);
  }

  if (priceChanged.length) {
    lines.push(`\n💰 <b>Price changed (${priceChanged.length}):</b>`);
    for (const i of priceChanged.slice(0, MAX_ITEMS_IN_MESSAGE)) {
      lines.push(
        `• <a href="${escapeHtml(i.link)}">${escapeHtml(truncate(i.title, 70))}</a>: ${escapeHtml(i.oldPrice || 'N/A')} → ${escapeHtml(i.price || 'N/A')}`,
      );
    }
    if (priceChanged.length > MAX_ITEMS_IN_MESSAGE) lines.push(`…+${priceChanged.length - MAX_ITEMS_IN_MESSAGE} more`);
  }

  lines.push(`\n<a href="${escapeHtml(url)}">Open search page</a>`);
  return lines.join('\n');
}

async function readSnapshot(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const targets = JSON.parse(await fs.readFile('urls.json', 'utf8'));
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
  });

  let hadError = false;

  for (const t of targets) {
    console.log(`\n=== ${t.name} (${t.slug}) ===`);
    const page = await context.newPage();
    try {
      const items = await scrapeSearch(page, t.url);
      console.log(`found ${items.length} items`);

      const snapPath = path.join(SNAPSHOT_DIR, `${t.slug}.json`);
      const prev = await readSnapshot(snapPath);

      if (prev) {
        const d = diffItems(prev, items);
        const total = d.added.length + d.removed.length + d.priceChanged.length;
        if (total > 0) {
          console.log(`changes: +${d.added.length} -${d.removed.length} Δ${d.priceChanged.length}`);
          await sendTelegram(formatMessage(t.name, t.url, d));
        } else {
          console.log('no changes');
        }
      } else {
        console.log('first run — saving snapshot, no notification');
      }

      await fs.writeFile(snapPath, JSON.stringify(items, null, 2));
    } catch (err) {
      hadError = true;
      console.error(`[${t.slug}] error:`, err.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  if (hadError) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
