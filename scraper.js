import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_DIR = 'snapshots';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MAX_PAGES = 1;
const MAX_MEDIA = 10; // Telegram sendMediaGroup limit
const CAPTION_MAX = 1024;

// Default currency per domain (amazon.com $ = USD, amazon.ca $ = CAD, etc.).
const currencyByHost = {
  'www.amazon.com': 'USD',
  'www.amazon.ca': 'CAD',
  'www.amazon.co.uk': 'GBP',
};

// Locale per domain so each Amazon site gets the expected Accept-Language.
const localeByHost = {
  'www.amazon.com': 'en-US',
  'www.amazon.ca': 'en-CA',
  'www.amazon.co.uk': 'en-GB',
};

// Host → country metadata for Telegram section headers.
const countryByHost = {
  'www.amazon.com': { code: 'US', flag: '🇺🇸' },
  'www.amazon.ca': { code: 'CA', flag: '🇨🇦' },
  'www.amazon.co.uk': { code: 'UK', flag: '🇬🇧' },
};

const currencySymbol = {
  USD: '$',
  GBP: '£',
  CAD: 'CA$',
  HKD: 'HK$',
  EUR: '€',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePrice(raw, defaultCurrency) {
  if (!raw) return null;
  const s = String(raw).trim();
  let cur = defaultCurrency;
  if (/^USD\b/i.test(s)) cur = 'USD';
  else if (/^GBP\b/i.test(s)) cur = 'GBP';
  else if (/^CAD\b/i.test(s)) cur = 'CAD';
  else if (/^EUR\b/i.test(s)) cur = 'EUR';
  else if (/^HKD\b/i.test(s)) cur = 'HKD';
  else if (/^CA\$/i.test(s)) cur = 'CAD';
  else if (/^US\$/i.test(s)) cur = 'USD';
  else if (/^£/.test(s)) cur = 'GBP';
  else if (/^€/.test(s)) cur = 'EUR';
  // A plain `$` falls through and uses defaultCurrency.

  const m = s.match(/[\d,]+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(/,/g, ''));
  if (!isFinite(v)) return null;
  return { value: v, currency: cur };
}

async function fetchHkdRates() {
  try {
    const r = await fetch(
      'https://api.frankfurter.dev/v1/latest?base=HKD&symbols=USD,GBP,CAD,EUR',
    );
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    const rates = {};
    for (const c of ['USD', 'GBP', 'CAD', 'EUR']) {
      if (j.rates?.[c]) rates[c] = 1 / j.rates[c];
    }
    rates.HKD = 1;
    console.log('[rates] HKD base:', rates);
    return rates;
  } catch (e) {
    console.error('[rates] fetch failed, using fallback:', e.message);
    return { USD: 7.78, GBP: 9.80, CAD: 5.60, EUR: 8.45, HKD: 1 };
  }
}

function toHkd(value, currency, rates) {
  const r = rates[currency];
  if (!r || value == null) return null;
  return Math.round(value * r);
}

function fmtNative(value, currency) {
  if (value == null) return '';
  const sym = currencySymbol[currency] ?? `${currency} `;
  return `${sym}${value.toFixed(2)}`;
}

function hkTimestamp() {
  return new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Resize Amazon CDN image URL to a small thumbnail (reduces file size so
// Telegram renders more compactly in media groups).
function resizeAmazonImage(url, px = 200) {
  if (!url || !/media-amazon\.com\/images/.test(url)) return url;
  // Strip any existing transforms like `._AC_UY436_FMjpg_.` between the
  // basename and the extension.
  const stripped = url.replace(/\._[A-Z0-9_,-]+_\./, '.');
  // Insert a compact transform right before the extension.
  return stripped.replace(/\.(jpg|jpeg|png|webp)(\?.*)?$/i, `._AC_UL${px}_.$1$2`);
}

function truncate(s, n) {
  const clean = (s || '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

// ─── Scraper ────────────────────────────────────────────────────────────────

async function setDeliveryCountry(page, origin, countryCode, primeUrl, flow = 'target') {
  // Two priming modes:
  //   'target'   — go straight to the search URL (works for amazon.com where
  //                homepage→merchant pivot trips a 503).
  //   'homepage' — land on the home page, pause, POST, pause again, then the
  //                caller navigates to the search URL. Looks more like a real
  //                user clicking "Deliver to" in the header, which amazon.co.uk
  //                seems to prefer.
  if (flow === 'homepage') {
    await page.goto(origin + '/', { waitUntil: 'load', timeout: 90000 });
  } else {
    await page.goto(primeUrl || origin + '/', { waitUntil: 'load', timeout: 90000 });
  }
  await page
    .waitForSelector('#nav-global-location-popover-link', { timeout: 45000 })
    .catch(() => {});
  if (flow === 'homepage') {
    const dwell = 8000 + Math.floor(Math.random() * 4000); // 8-12s
    console.log(`  [homepage flow] browsing for ${dwell}ms before address-change`);
    await page.waitForTimeout(dwell);
  }
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
  if (flow === 'homepage') {
    const dwell = 5000 + Math.floor(Math.random() * 5000); // 5-10s
    console.log(`  [homepage flow] dwell ${dwell}ms after address-change before search`);
    await page.waitForTimeout(dwell);
  }
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

          const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
          const ariaLabel = clean(el.querySelector('h2 a')?.getAttribute('aria-label'));
          const linkText = clean(el.querySelector('h2 a')?.textContent);
          const recipeLink = clean(el.querySelector('[data-cy="title-recipe"] a')?.textContent);
          const recipeText = clean(el.querySelector('[data-cy="title-recipe"]')?.textContent);
          const h2Text = clean(el.querySelector('h2')?.textContent);
          const title =
            (ariaLabel.length >= 15 && ariaLabel) ||
            (linkText.length >= 15 && linkText) ||
            (recipeLink.length >= 15 && recipeLink) ||
            (recipeText.length >= 15 && recipeText) ||
            h2Text ||
            ariaLabel ||
            linkText ||
            '';

          const priceEl = el.querySelector('.a-price .a-offscreen');
          const priceRaw = priceEl?.textContent?.trim() || null;

          const imgEl = el.querySelector('img.s-image, img[data-image-latency]');
          const image =
            imgEl?.getAttribute('src') ||
            imgEl?.getAttribute('data-src') ||
            null;

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

          return { asin, title, price: priceRaw, image, link };
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

  const isBlocked = (status, title) =>
    (status && status >= 400) ||
    /robot|captcha|sorry|service\s*unavailable|^5\d\d\b/i.test(title || '');

  for (let p = 1; p <= MAX_PAGES; p++) {
    let title = '';
    let status = null;
    // Amazon's soft-block window for a rate-limited IP is often ~minute-scale,
    // so short 2/4/6s retries rarely escape it. Longer backoff gives us a
    // real chance without ballooning total runtime past ~2 minutes per URL.
    const backoffMs = [10_000, 30_000, 60_000];
    for (let attempt = 1; attempt <= backoffMs.length + 1; attempt++) {
      const resp = await page.goto(currentUrl, { waitUntil: 'load', timeout: 90000 });
      status = resp?.status() ?? null;
      await page
        .evaluate(() => document.getElementById('redir-modal')?.remove())
        .catch(() => {});
      title = await page.title();
      if (!isBlocked(status, title)) break;
      if (attempt > backoffMs.length) break; // exhausted retries
      const wait = backoffMs[attempt - 1];
      console.log(
        `  page ${p} attempt ${attempt} blocked (status=${status}, title="${title}"); retrying in ${wait}ms`,
      );
      await page.waitForTimeout(wait);
    }
    if (isBlocked(status, title)) {
      await dumpArtifacts(page, `blocked-${new URL(currentUrl).host}-p${p}`);
      throw new Error(`Blocked by Amazon after 3 attempts (status=${status}, title="${title}")`);
    }

    // AWS WAF serves a JS CAPTCHA that auto-solves via its own script — we
    // just have to give it time. Detect the WAF shell by its `gokuProps` /
    // `awsWafCookieDomainList` globals and wait them out. If they're still
    // present after 25s, the challenge didn't pass and we treat the page as
    // blocked (higher up will dump an artifact).
    await page
      .waitForFunction(
        () =>
          typeof window.gokuProps === 'undefined' &&
          typeof window.awsWafCookieDomainList === 'undefined',
        null,
        { timeout: 25000 },
      )
      .catch(() => console.log(`  page ${p}: WAF challenge didn't clear in 25s`));

    await page
      .waitForSelector('[data-component-type="s-search-result"]', { timeout: 45000 })
      .catch(() => {});

    const diag = await page.evaluate(() => {
      const glow = document.querySelector('#glow-ingress-line2');
      const header = document.querySelector('.s-breadcrumb, [data-component-type="s-result-info-bar"]');
      return {
        shipTo: glow ? glow.innerText.trim() : null,
        header: header ? header.innerText.trim().slice(0, 120) : null,
      };
    });
    console.log(`  page ${p} diag: shipTo=${JSON.stringify(diag.shipTo)} header=${JSON.stringify(diag.header)}`);

    const items = await extractItems(page, origin);

    // Silent-block detection: page rendered without expected chrome (no glow
    // banner, no result header) AND no items. Dump artifacts so we can see
    // what Amazon actually served. (Title didn't match /sorry|robot/, so the
    // regular retry path above didn't catch it.)
    if (items.length === 0 && diag.shipTo == null && diag.header == null) {
      console.log(`  page ${p}: silent block suspected (no chrome, no items) — dumping artifact`);
      await dumpArtifacts(page, `silent-${new URL(currentUrl).host}-p${p}`);
    }
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
      const next = document.querySelector('a.s-pagination-next:not(.s-pagination-disabled)');
      return next ? next.getAttribute('href') : null;
    });
    if (!nextHref) break;
    currentUrl = new URL(nextHref, origin).href;
  }

  return all;
}

// ─── Diff ───────────────────────────────────────────────────────────────────

function diffInteresting(oldItems, newItems, defaultCurrency) {
  const oldMap = new Map(oldItems.map((i) => [i.asin, i]));
  const added = newItems.filter((i) => !oldMap.has(i.asin));

  const dropped = [];
  for (const i of newItems) {
    const o = oldMap.get(i.asin);
    if (!o) continue;
    // Prefer stored priceValue, else re-parse.
    const oldV =
      typeof o.priceValue === 'number'
        ? o.priceValue
        : parsePrice(o.price, defaultCurrency)?.value ?? null;
    const newV = typeof i.priceValue === 'number' ? i.priceValue : null;
    if (oldV == null || newV == null) continue;
    if (newV < oldV) dropped.push({ ...i, oldPrice: o.price, oldPriceValue: oldV });
  }
  return { added, dropped };
}

// ─── Telegram ───────────────────────────────────────────────────────────────

async function tgApi(method, payload) {
  if (!TG_TOKEN || !TG_CHAT) {
    console.log(`[tg] ${method}: no TG_TOKEN/TG_CHAT, skipping`);
    return null;
  }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, ...payload }),
  });
  if (!res.ok) {
    console.error(`[tg] ${method} error:`, res.status, await res.text());
    return null;
  }
  return res.json();
}

function formatItemLine(kind, item, rates) {
  // kind: 'new' | 'drop'
  const emoji = kind === 'new' ? '✅' : '🔻';
  const titleHtml = `<a href="${escapeHtml(item.link)}">${escapeHtml(truncate(item.title, 55))}</a>`;
  // amazon.com (Export Sales) already returns prices in HKD when ship-to=HK,
  // so showing "HK$X (≈HK$X)" would be redundant. Skip the conversion suffix
  // whenever the native currency is already HKD.
  const isHkdNative = item.currency === 'HKD';
  if (kind === 'new') {
    const native = fmtNative(item.priceValue, item.currency);
    const hkd = isHkdNative ? null : toHkd(item.priceValue, item.currency, rates);
    const priceTxt = item.priceValue != null
      ? `${escapeHtml(native)}${hkd ? ` <i>(≈HK$${hkd})</i>` : ''}`
      : '<i>price N/A</i>';
    return `${emoji} ${titleHtml} — ${priceTxt}`;
  }
  // drop
  const oldN = fmtNative(item.oldPriceValue, item.currency);
  const newN = fmtNative(item.priceValue, item.currency);
  const oldH = isHkdNative ? null : toHkd(item.oldPriceValue, item.currency, rates);
  const newH = isHkdNative ? null : toHkd(item.priceValue, item.currency, rates);
  const hkdPart =
    oldH && newH ? ` <i>(≈HK$${oldH} → HK$${newH})</i>` : '';
  return `${emoji} ${titleHtml} — <s>${escapeHtml(oldN)}</s> → ${escapeHtml(newN)}${hkdPart}`;
}

function buildCombinedCaption({ perCountry, rates }) {
  const lines = [`⏱ <b>${hkTimestamp()} HKT</b>`];
  const status = [];
  for (const code of ['US', 'UK', 'CA']) {
    const pc = perCountry[code];
    if (!pc) continue;
    if (pc.count != null) status.push(`${pc.flag} ${pc.count}`);
    else status.push(`${pc.flag} ⚠️`);
  }
  if (status.length) lines.push(status.join(' · '));

  let any = false;
  for (const code of ['US', 'UK', 'CA']) {
    const pc = perCountry[code];
    if (!pc || (!pc.added?.length && !pc.dropped?.length)) continue;
    any = true;
    lines.push('');
    lines.push(`${pc.flag} <b>${code}</b>`);
    for (const item of pc.added) lines.push(formatItemLine('new', item, rates));
    for (const item of pc.dropped) lines.push(formatItemLine('drop', item, rates));
  }
  if (!any) {
    lines.push('');
    lines.push('<i>No new items or price drops.</i>');
  }

  const text = lines.join('\n');
  // Telegram rejects captions mid-HTML-tag (Unclosed start tag). Truncate on a
  // newline boundary so we never cut inside an <a>…</a> or <b>…</b> block.
  if (text.length <= CAPTION_MAX) return text;
  const target = CAPTION_MAX - 2;
  const nl = text.lastIndexOf('\n', target);
  const cut = nl > 0 ? nl : target;
  return text.slice(0, cut) + '\n…';
}

async function sendCombined({ perCountry, rates }) {
  // Always send a single text message with a compact link preview for the
  // first interesting item (gives a ~60px thumbnail in a card at the bottom
  // without occupying the whole message height like sendPhoto would).
  const text = buildCombinedCaption({ perCountry, rates });
  await tgApi('sendMessage', {
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

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

  const rates = await fetchHkdRates();

  // Group targets by origin.
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

  // Aggregate per-country results for the final combined Telegram message.
  const perCountry = {}; // { US: { flag, count, added, dropped }, ... }

  let hadError = false;

  for (const [origin, group] of byOrigin) {
    const host = new URL(origin).host;
    const defaultCurrency = currencyByHost[host] || 'USD';
    const country = countryByHost[host] || { code: host, flag: '🌐' };

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: localeByHost[host] || 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': `${localeByHost[host] || 'en-US'},en;q=0.9`,
      },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    const deliverTarget = group.find((t) => t.deliverTo);
    const deliverTo = deliverTarget?.deliverTo;
    const flow = deliverTarget?.deliveryFlow || 'target';
    if (deliverTo) {
      try {
        console.log(`\n[${origin}] setting delivery to ${deliverTo} (flow=${flow})`);
        await setDeliveryCountry(page, origin, deliverTo, group[0].url, flow);
        console.log(`[${origin}] delivery set to ${deliverTo}`);
      } catch (err) {
        // Non-fatal: when the runner already exits from the desired country
        // (e.g. Surfshark HK exit + deliverTo=HK), Amazon returns the change
        // POST with no JSON body and we treat that as a failure even though
        // the search page below still shows the right ship-to. Keep going
        // and let the in-page diag confirm whether ship-to is correct.
        console.warn(`[${origin}] address-change skipped: ${err.message}`);
      }
    }

    // Initialize per-country bucket.
    perCountry[country.code] = {
      flag: country.flag,
      count: null,
      added: [],
      dropped: [],
    };

    let first = true;
    for (const t of group) {
      if (!first) await page.waitForTimeout(2000 + Math.random() * 2000);
      first = false;
      console.log(`\n=== ${t.name} (${t.slug}) ===`);
      try {
        const items = await scrapeAllPages(page, t.url);
        // Enrich: parse priceValue + currency.
        for (const item of items) {
          const parsed = parsePrice(item.price, defaultCurrency);
          item.priceValue = parsed?.value ?? null;
          item.currency = parsed?.currency ?? defaultCurrency;
        }
        console.log(`found ${items.length} items`);

        const snapPath = path.join(SNAPSHOT_DIR, `${t.slug}.json`);
        const prev = await readSnapshot(snapPath);

        // Guard: suspiciously empty result when prev had items = treat as soft-block.
        if (prev && prev.length > 0 && items.length === 0) {
          console.log(`suspicious 0-item result (prev had ${prev.length}) — keep snapshot`);
          hadError = true;
          continue;
        }

        perCountry[country.code].count =
          (perCountry[country.code].count ?? 0) + items.length;

        if (prev) {
          const d = diffInteresting(prev, items, defaultCurrency);
          console.log(`changes: +${d.added.length} 🔻${d.dropped.length}`);
          perCountry[country.code].added.push(...d.added);
          perCountry[country.code].dropped.push(...d.dropped);
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

  console.log('\n--- Sending combined Telegram message ---');
  await sendCombined({ perCountry, rates });

  if (hadError) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
