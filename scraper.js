import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SNAPSHOT_DIR = 'snapshots';
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const MAX_PAGES = 1;
const MAX_MEDIA = 10; // Telegram sendMediaGroup limit
// Telegram limits: sendMessage = 4096 chars, sendMediaGroup caption = 1024.
// We send via sendMessage, so the higher cap applies. Leaving a small safety
// margin so any HTML escaping or follow-on emoji doesn't push us over.
const CAPTION_MAX = 3900;

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

function roundToTen(n) {
  return Math.round(n / 10) * 10;
}

function toHkd(value, currency, rates) {
  const r = rates[currency];
  if (!r || value == null) return null;
  return roundToTen(value * r);
}

function fmtNative(value, currency) {
  if (value == null) return '';
  const sym = currencySymbol[currency] ?? `${currency} `;
  // HKD prices look chunkier when rounded to the nearest 10 — matches how
  // people actually mention prices in HK ("六百" not "595.27").
  if (currency === 'HKD') return `${sym}${roundToTen(value)}`;
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

// Heuristic: look at a product page's title + bullets + description and
// extract how many booster packs are inside. Returns:
//   integer >= 1 — best guess of pack count
//   0            — explicitly a non-pack product (e.g. battle deck only)
//   null         — couldn't determine
function parseBoosterCount(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  const tally = (counts) => {
    const t = new Map();
    for (const n of counts) t.set(n, (t.get(n) || 0) + 1);
    return [...t.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  };

  // Strong signal: words like "booster" / "contains N packs" make the count
  // unambiguous. Allow up to 3 brand/qualifier words between the digit and
  // "booster", so phrases like "8 Pokémon TCG booster packs" or "8 additional
  // Pokémon TCG booster packs" match.
  const strong = [];
  const strongPatterns = [
    /(\d+)\s+(?:[A-Za-zé.®'-]+\s+){0,3}booster\s*packs?\b/gi,
    /(\d+)\s*pok[eé]mon\s*tcg\s*(?:booster\s*)?packs?\b/gi,
    /(\d+)\s*card\s*booster\s*packs?\b/gi,
    /\b(?:contains?|includes?|with|comes\s+with|receive)\s*(\d+)\s+(?:[A-Za-zé.®'-]+\s+){0,3}(?:booster\s+)?packs?\b/gi,
    /\b(\d+)\s*packs?\s*\)/g,
  ];
  for (const re of strongPatterns) {
    let m;
    while ((m = re.exec(lower)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 100) strong.push(n);
    }
  }
  if (strong.length > 0) return tally(strong);

  // Weak signal: bare "N packs" anywhere (e.g. "6 Packs, Promos" in titles).
  // Bound to 1–50 to skip nonsense like "365 packs delivered".
  const weak = [];
  const weakRe = /(\d+)\s*packs?\b/g;
  let m;
  while ((m = weakRe.exec(lower)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) weak.push(n);
  }
  if (weak.length > 0) return tally(weak);

  // Explicit non-pack products — Battle Decks / theme decks / single tins.
  if (/\bbattle\s+deck\b/.test(lower) && !/\bbooster\b/.test(lower)) return 0;
  if (/\btin\b/.test(lower) && !/\bbooster\b/.test(lower)) return 0;

  return null;
}

async function extractBoosterCount(page, url) {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    // Let any AWS WAF JS challenge resolve first.
    await page
      .waitForFunction(
        () =>
          typeof window.gokuProps === 'undefined' &&
          typeof window.awsWafCookieDomainList === 'undefined',
        null,
        { timeout: 15000 },
      )
      .catch(() => {});
    await page.waitForSelector('#productTitle, #title', { timeout: 15000 }).catch(() => {});
    const text = await page.evaluate(() => {
      const sel = [
        '#productTitle',
        '#title',
        '#feature-bullets',
        '#productFactsDesktopExpander',
        '#productDescription',
      ];
      return sel
        .map((s) => document.querySelector(s)?.innerText || '')
        .filter(Boolean)
        .join('\n');
    });
    return parseBoosterCount(text);
  } catch (err) {
    console.log(`  [booster] fetch failed: ${err.message.slice(0, 80)}`);
    return null;
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

          // Detect ads: Amazon flags sponsored cards via a span with the
          // sponsored-label class, a "Sponsored" badge in aria-label, or by
          // duplicating the word in the title. Mark them so we can filter
          // before diffing — ads rotate constantly and pollute the diff.
          const isSponsored =
            !!el.querySelector('.puis-sponsored-label-text, .s-sponsored-label-text, [data-component-type="sb-loom-desktop"]') ||
            /sponsored/i.test(
              el.querySelector('.s-sponsored-label-info-icon, .s-sponsored-label')
                ?.textContent || '',
            );

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

          // Final fallback ad signal: the title (or its sources) literally
          // begins with "Sponsored" / has it duplicated.
          const titleLooksSponsored = /^sponsored\b/i.test(title) || /\bsponsoredsponsored\b/i.test(title);

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

          return {
            asin,
            title,
            price: priceRaw,
            image,
            link,
            sponsored: isSponsored || titleLooksSponsored,
          };
        })
        .filter((i) => i.asin && !i.sponsored),
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
  // Surface an item the first time we have a real price for it. That covers:
  //   1. brand-new ASIN with a price right away
  //   2. ASIN we previously snapshotted with priceValue=null (unavailable /
  //      pre-order at the time) and which now has a real price — the user
  //      never saw the alert for #1, so we still alert here.
  // Items that are still un-priced get skipped (no actionable signal).
  const added = newItems.filter((i) => {
    if (typeof i.priceValue !== 'number') return false;
    const o = oldMap.get(i.asin);
    if (!o) return true; // truly new
    return typeof o.priceValue !== 'number'; // first time priced
  });

  const dropped = [];
  for (const i of newItems) {
    const o = oldMap.get(i.asin);
    if (!o) continue;
    // Prefer stored priceValue + currency, else re-parse from raw price string.
    const oldParsed =
      typeof o.priceValue === 'number'
        ? { value: o.priceValue, currency: o.currency || defaultCurrency }
        : parsePrice(o.price, o.currency || defaultCurrency);
    const oldV = oldParsed?.value ?? null;
    const oldC = oldParsed?.currency ?? null;
    const newV = typeof i.priceValue === 'number' ? i.priceValue : null;
    const newC = i.currency ?? null;
    if (oldV == null || newV == null) continue;
    // Currency must match to compare meaningfully — Amazon sometimes flips
    // a domain's display currency between runs (e.g. UK price shown as HKD
    // one week, £ the next), and a raw numeric compare across currencies
    // would falsely report a drop / rise.
    if (oldC && newC && oldC !== newC) continue;
    if (newV >= oldV) continue;
    // Suppress drops that disappear after the same rounding the message uses
    // for display: HKD rounds to nearest 10 (210 vs 208 → both HK$210), other
    // currencies round to integer (£35.00 vs £34.99 → both £35). This kills
    // the "HK$210 → HK$210" / "£35 → £35" noise alerts without missing real
    // drops that move at least one rounding step.
    const oldRounded = newC === 'HKD' ? roundToTen(oldV) : Math.round(oldV);
    const newRounded = newC === 'HKD' ? roundToTen(newV) : Math.round(newV);
    if (oldRounded === newRounded) continue;
    dropped.push({ ...i, oldPrice: o.price, oldPriceValue: oldV, oldCurrency: oldC });
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

// Compute per-booster-pack price in HKD (rounded to nearest $10) when the
// product page told us how many packs are inside.
function perPackHkd(item, rates) {
  if (!item.boosterPacks || item.boosterPacks <= 0) return null;
  if (item.priceValue == null) return null;
  const totalHkd =
    item.currency === 'HKD'
      ? item.priceValue
      : (rates[item.currency] || 0) * item.priceValue;
  if (!totalHkd) return null;
  return roundToTen(totalHkd / item.boosterPacks);
}

function formatItemLine(kind, item, rates) {
  // kind: 'new' | 'drop'
  const emoji = kind === 'new' ? '✅' : '🔻';
  const titleHtml = `<a href="${escapeHtml(item.link)}">${escapeHtml(truncate(item.title, 55))}</a>`;
  // amazon.com (Export Sales) already returns prices in HKD when ship-to=HK,
  // so showing "HK$X (≈HK$X)" would be redundant. Skip the conversion suffix
  // whenever the native currency is already HKD.
  const isHkdNative = item.currency === 'HKD';
  const perPack = perPackHkd(item, rates);
  // Always print a per-pack column so the user knows the column exists for
  // every item, not just the products that parsed cleanly.
  const perPackTxt = perPack
    ? ` <i>· ${item.boosterPacks} pack${item.boosterPacks > 1 ? 's' : ''} ~HK$${perPack}/ea</i>`
    : ` <i>· packs N/A</i>`;
  if (kind === 'new') {
    const native = fmtNative(item.priceValue, item.currency);
    const hkd = isHkdNative ? null : toHkd(item.priceValue, item.currency, rates);
    const priceTxt = item.priceValue != null
      ? `${escapeHtml(native)}${hkd ? ` <i>(≈HK$${hkd})</i>` : ''}`
      : '<i>price N/A</i>';
    return `${emoji} ${titleHtml} — ${priceTxt}${perPackTxt}`;
  }
  // drop — old/new currency might differ in pathological cases, render each
  // with its own native symbol just to be defensive.
  const oldCur = item.oldCurrency || item.currency;
  const newCur = item.currency;
  const oldN = fmtNative(item.oldPriceValue, oldCur);
  const newN = fmtNative(item.priceValue, newCur);
  const oldH = oldCur === 'HKD' ? null : toHkd(item.oldPriceValue, oldCur, rates);
  const newH = newCur === 'HKD' ? null : toHkd(item.priceValue, newCur, rates);
  const hkdPart =
    oldH && newH ? ` <i>(≈HK$${oldH} → HK$${newH})</i>` : '';
  return `${emoji} ${titleHtml} — <s>${escapeHtml(oldN)}</s> → ${escapeHtml(newN)}${hkdPart}${perPackTxt}`;
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
  // Suppress the message entirely when nothing interesting happened.
  // A run that found "no new items, no price drops" used to still ping
  // Telegram with a heartbeat — flooded the chat. Now we only notify on
  // real signal.
  const hasChanges = Object.values(perCountry).some(
    (pc) => (pc?.added?.length || 0) > 0 || (pc?.dropped?.length || 0) > 0,
  );
  if (!hasChanges) {
    console.log('[tg] no new items / price drops — skipping Telegram');
    return;
  }
  const text = buildCombinedCaption({ perCountry, rates });
  await tgApi('sendMessage', {
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
}

const STATUS_FILE = path.join(SNAPSHOT_DIR, '_status.json');

function buildStatusText(perCountry) {
  const parts = [];
  for (const code of ['US', 'UK', 'CA']) {
    const pc = perCountry[code];
    if (!pc) continue;
    if (pc.count != null) parts.push(`${pc.flag} ${pc.count}`);
    else parts.push(`${pc.flag} ⚠️`);
  }
  return `⏱ <b>${hkTimestamp()} HKT</b>\n${parts.join(' · ')}`;
}

async function updateStatusMessage(perCountry) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const text = buildStatusText(perCountry);
  let state = null;
  try {
    state = JSON.parse(await fs.readFile(STATUS_FILE, 'utf8'));
  } catch {}

  // Try to edit the existing pinned-style status message in place. Edits
  // don't fire a notification on the user's device, so the status updates
  // silently while real alerts (sendCombined) keep their notification.
  if (state?.messageId) {
    const editRes = await fetch(
      `https://api.telegram.org/bot${TG_TOKEN}/editMessageText`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT,
          message_id: state.messageId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      },
    );
    if (editRes.ok) {
      console.log(`[tg] status message ${state.messageId} edited silently`);
      return;
    }
    const body = await editRes.text();
    // "message is not modified" just means same content — fine, treat as success.
    if (/message is not modified/i.test(body)) {
      console.log('[tg] status message unchanged');
      return;
    }
    console.log(`[tg] edit failed (${editRes.status}); will send a new status message:`, body.slice(0, 120));
  }

  // First run, or the saved message_id is gone (user deleted it / 48h edit
  // window expired): send a fresh one with notification suppressed and
  // remember its id for next time.
  const sendRes = await tgApi('sendMessage', {
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: true,
  });
  const newId = sendRes?.result?.message_id;
  if (newId) {
    await fs.writeFile(STATUS_FILE, JSON.stringify({ messageId: newId }, null, 2));
    console.log(`[tg] new status message ${newId} sent (silent) and saved`);
  }
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

        // Reuse cached booster-pack counts from previous snapshot. Only cache
        // a number — null cached entries are retried so improvements to the
        // parser propagate without manual snapshot resets.
        const prevBoosters = new Map(
          (prev || [])
            .filter((p) => typeof p.boosterPacks === 'number')
            .map((p) => [p.asin, p.boosterPacks]),
        );
        let fetched = 0;
        for (const item of items) {
          if (prevBoosters.has(item.asin)) {
            item.boosterPacks = prevBoosters.get(item.asin);
            continue;
          }
          // Cheap first pass: if the search-result title alone tells us the
          // pack count (e.g. "...Premium Collection - 6 Packs"), skip the
          // product-page fetch entirely.
          const fromTitle = parseBoosterCount(item.title);
          if (fromTitle !== null) {
            item.boosterPacks = fromTitle;
            continue;
          }
          if (!item.link) {
            item.boosterPacks = null;
            continue;
          }
          fetched++;
          item.boosterPacks = await extractBoosterCount(page, item.link);
          await page.waitForTimeout(800 + Math.random() * 700); // gentle pacing
        }
        if (fetched > 0) console.log(`booster-pack fetch: ${fetched} new product pages`);

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
  await updateStatusMessage(perCountry);

  if (hadError) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
