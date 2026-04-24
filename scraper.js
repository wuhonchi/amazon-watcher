import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_DIR = 'snapshots';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MAX_ITEMS_IN_MESSAGE = 10;
const MAX_PAGES = 1;

async function setDeliveryCountry(page, origin, countryCode) {
  await page.goto(origin + '/', { waitUntil: 'load', timeout: 90000 });
  await page
    .waitForSelector('#nav-global-location-popover-link', { timeout: 45000 })
    .catch(() => {
      // Some regions render the header lazily — fall through and try the POST anyway.
    });
  const result = await page.evaluate(async (cc) => {
    try {
      const r = await fetch('/portal-migration/hz/glow/address-change?actionSource=glow', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `locationType=COUNTRY&district=&countryCode=${cc}&storeContext=generic&pageType=Gateway&actionSource=glow`,
      });
      const text = await r.text();
      let updated = false;
      try {
        updated = !!JSON.parse(text).isAddressUpdated;
      } catch {}
      return { status: r.status, updated, bodyLen: text.length };
    } catch (err) {
      return { status: 0, updated: false, err: err.message };
    }
  }, countryCode);
  console.log(`  address-change response:`, JSON.stringify(result));
  if (!result.updated) {
    throw new Error(
      `Failed to set delivery country to ${countryCode} at ${origin} (status=${result.status})`,
    );
  }
  // Verify: reload home page and read the ship-to label. If it doesn't reflect
  // the new country, the server silently ignored the change (common on amazon.co.uk
  // for guest sessions when switching to a country requiring sign-in).
  await page.goto(origin + '/', { waitUntil: 'load', timeout: 90000 });
  const actualShipTo = await page
    .locator('#glow-ingress-line2')
    .innerText()
    .catch(() => '');
  console.log(`  verified ship-to label: "${actualShipTo.trim() || '(not found)'}"`);
}

async function dumpArtifacts(page, label) {
  try {
    await fs.mkdir('debug', { recursive: true });
    const safe = label.replace(/[^a-z0-9._-]/gi, '_');
    await page.screenshot({ path: `debug/${safe}.png`, fullPage: false }).catch(() => {});
    const html = await page.content().catch(() => '');
    await fs.writeFile(`debug/${safe}.html`, html.slice(0, 200_000));
    console.log(`  [artifact] saved debug/${safe}.{png,html}`);
  } catch (e) {
    console.log('  [artifact] dump failed:', e.message);
  }
}

async function extractItems(page, origin) {
  return page.$$eval(
    '[data-component-type="s-search-result"]',
    (els, origin) =>
      els
        .map((el) => {
          const asin = el.getAttribute('data-asin');
          const titleEl = el.querySelector('h2 a span, h2 span, [data-cy="title-recipe"] span');
          const priceEl = el.querySelector('.a-price .a-offscreen');
          const linkEl = el.querySelector(
            'a.a-link-normal.s-line-clamp-2, h2 a, a.a-link-normal[href*="/dp/"]',
          );
          let link = '';
          const href = linkEl?.getAttribute('href');
          if (href) {
            try {
              link = new URL(href, origin).href;
            } catch {}
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
}

async function scrapeAllPages(page, url) {
  const origin = new URL(url).origin;
  const seen = new Set();
  const all = [];
  let currentUrl = url;

  for (let p = 1; p <= MAX_PAGES; p++) {
    let title = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.goto(currentUrl, { waitUntil: 'load', timeout: 90000 });
      await page
        .evaluate(() => document.getElementById('redir-modal')?.remove())
        .catch(() => {});
      title = await page.title();
      if (!/robot|captcha|sorry/i.test(title)) break;
      const wait = 2000 * attempt;
      console.log(`  page ${p} attempt ${attempt} blocked (${title}); retrying in ${wait}ms`);
      await page.waitForTimeout(wait);
    }
    if (/robot|captcha|sorry/i.test(title)) {
      await dumpArtifacts(page, `blocked-${new URL(currentUrl).host}-p${p}`);
      throw new Error(`Blocked by Amazon after 3 attempts (title: ${title})`);
    }

    await page
      .waitForSelector('[data-component-type="s-search-result"]', { timeout: 30000 })
      .catch(() => {
        /* zero-result page — fine, we'll just return what we have */
      });

    // Diagnostic: what ship-to does the SEARCH page itself show, and what's the result header?
    const diag = await page.evaluate(() => {
      const glow = document.querySelector(
        '#glow-ingress-line2, #nav-global-location-slot #glow-ingress-line2',
      );
      const header = document.querySelector(
        '.s-breadcrumb, [data-component-type="s-result-info-bar"], .sg-col-14-of-20 h2',
      );
      return {
        shipTo: glow ? glow.innerText.trim() : null,
        header: header ? header.innerText.trim().slice(0, 200) : null,
      };
    });
    console.log(`  page ${p} diag: shipTo=${JSON.stringify(diag.shipTo)} header=${JSON.stringify(diag.header)}`);

    const items = await extractItems(page, origin);
    let added = 0;
    for (const i of items) {
      if (!seen.has(i.asin)) {
        seen.add(i.asin);
        all.push(i);
        added++;
      }
    }
    console.log(`  page ${p}: +${added} (total ${all.length})`);

    if (added === 0 && p > 1) break;

    const nextHref = await page.evaluate(() => {
      const next = document.querySelector(
        'a.s-pagination-next:not(.s-pagination-disabled)',
      );
      return next ? next.getAttribute('href') : null;
    });
    if (!nextHref) break;
    currentUrl = new URL(nextHref, origin).href;
  }

  return all;
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
      lines.push(
        `• <a href="${escapeHtml(i.link)}">${escapeHtml(truncate(i.title, 80))}</a>${priceTxt}`,
      );
    }
    if (added.length > MAX_ITEMS_IN_MESSAGE)
      lines.push(`…+${added.length - MAX_ITEMS_IN_MESSAGE} more`);
  }

  if (removed.length) {
    lines.push(`\n❌ <b>Gone (${removed.length}):</b>`);
    for (const i of removed.slice(0, MAX_ITEMS_IN_MESSAGE)) {
      lines.push(`• ${escapeHtml(truncate(i.title, 80))}`);
    }
    if (removed.length > MAX_ITEMS_IN_MESSAGE)
      lines.push(`…+${removed.length - MAX_ITEMS_IN_MESSAGE} more`);
  }

  if (priceChanged.length) {
    lines.push(`\n💰 <b>Price changed (${priceChanged.length}):</b>`);
    for (const i of priceChanged.slice(0, MAX_ITEMS_IN_MESSAGE)) {
      lines.push(
        `• <a href="${escapeHtml(i.link)}">${escapeHtml(truncate(i.title, 70))}</a>: ${escapeHtml(
          i.oldPrice || 'N/A',
        )} → ${escapeHtml(i.price || 'N/A')}`,
      );
    }
    if (priceChanged.length > MAX_ITEMS_IN_MESSAGE)
      lines.push(`…+${priceChanged.length - MAX_ITEMS_IN_MESSAGE} more`);
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

  // Group targets by origin — one shared context per origin so we only set delivery once.
  const byOrigin = new Map();
  for (const t of targets) {
    const origin = new URL(t.url).origin;
    if (!byOrigin.has(origin)) byOrigin.set(origin, []);
    byOrigin.get(origin).push(t);
  }

  const browser = await chromium.launch({
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // Per-origin locale so each Amazon domain gets the expected Accept-Language.
  const localeByHost = {
    'www.amazon.com': 'en-US',
    'www.amazon.ca': 'en-CA',
    'www.amazon.co.uk': 'en-GB',
  };

  let hadError = false;

  for (const [origin, group] of byOrigin) {
    const host = new URL(origin).host;
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: localeByHost[host] || 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': `${localeByHost[host] || 'en-US'},en;q=0.9`,
      },
    });
    // Strip the `navigator.webdriver` giveaway before any page script runs.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    // If any target in this group specifies deliverTo, set it now (uses the first non-empty).
    const deliverTo = group.find((t) => t.deliverTo)?.deliverTo;
    if (deliverTo) {
      try {
        console.log(`\n[${origin}] setting delivery to ${deliverTo}`);
        await setDeliveryCountry(page, origin, deliverTo);
        console.log(`[${origin}] delivery set to ${deliverTo}`);
      } catch (err) {
        console.error(`[${origin}] failed to set delivery: ${err.message}`);
        await dumpArtifacts(page, `setDelivery-${new URL(origin).host}`);
        hadError = true;
      }
    }

    let first = true;
    for (const t of group) {
      if (!first) await page.waitForTimeout(2000 + Math.random() * 2000);
      first = false;
      console.log(`\n=== ${t.name} (${t.slug}) ===`);
      try {
        const items = await scrapeAllPages(page, t.url);
        console.log(`found ${items.length} items`);

        const snapPath = path.join(SNAPSHOT_DIR, `${t.slug}.json`);
        const prev = await readSnapshot(snapPath);

        if (prev) {
          const d = diffItems(prev, items);
          const total = d.added.length + d.removed.length + d.priceChanged.length;
          if (total > 0) {
            console.log(
              `changes: +${d.added.length} -${d.removed.length} Δ${d.priceChanged.length}`,
            );
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
      }
    }

    await context.close();
  }

  await browser.close();
  if (hadError) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
