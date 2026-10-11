// Visitor-analytics fields derived from one request: whether it was a page
// view, which campaign and channel brought the visitor, and their language.
//
// Everything here works from what Caddy already logs — request headers, the
// query string, the response Content-Type — so no tracking script is needed.
// The cost is what a server cannot see: client-side route changes in a
// single-page app, and pages served from a CDN cache, never reach the log.

/** Header lookup that ignores case and unwraps Caddy's array-valued headers. */
export function header(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  let v = headers[name];
  if (v === undefined) {
    const want = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === want) {
        v = headers[k];
        break;
      }
    }
  }
  if (v === undefined || v === null) return null;
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.length ? s : null;
}

// ---------------------------------------------------------------------------
//  Page views
// ---------------------------------------------------------------------------

/**
 * True when a browser navigated to this URL: a top-level document load, not
 * an asset, an API call, a frame, or a speculative prefetch. Whether it then
 * counts as a page view depends on the status — see isPageview().
 */
export function isNavigation({ method, bot, headers, respHeaders }) {
  if (bot || method !== 'GET') return false;

  // Prefetches and prerenders (including Google's from its results page) are
  // fetched before anyone decides to visit.
  const purpose = (
    header(headers, 'Sec-Purpose') ?? header(headers, 'Purpose') ?? header(headers, 'X-Moz') ?? ''
  ).toLowerCase();
  if (purpose.includes('prefetch') || purpose.includes('prerender')) return false;

  // Every current browser says what the response is for, over HTTPS.
  const dest = header(headers, 'Sec-Fetch-Dest');
  if (dest) return dest.toLowerCase() === 'document';

  // Older browsers, and plain HTTP: go by what was asked for and what came back.
  const accept = header(headers, 'Accept') ?? '';
  if (!accept.includes('text/html')) return false;
  const type = header(respHeaders, 'Content-Type');
  return !type || type.toLowerCase().startsWith('text/html');
}

/** A navigation that delivered a page (or confirmed a cached one). */
export function isPageview(ev) {
  if (!ev.nav) return false;
  const s = ev.status || 0;
  return (s >= 200 && s < 300) || s === 304;
}

/** SQL equivalent of isPageview(), for queries over `events`. */
export const PAGEVIEW_SQL = '(nav = 1 AND ((status >= 200 AND status < 300) OR status = 304))';

// ---------------------------------------------------------------------------
//  Campaigns
// ---------------------------------------------------------------------------

export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

// Ad click IDs stand in for UTM tags when a link was not tagged. fbclid and
// twclid are added to organic shares too, so they imply a source, not paid.
const CLICK_IDS = [
  ['gclid', 'google', 'cpc'],
  ['gbraid', 'google', 'cpc'],
  ['wbraid', 'google', 'cpc'],
  ['dclid', 'google', 'display'],
  ['msclkid', 'bing', 'cpc'],
  ['yclid', 'yandex', 'cpc'],
  ['ttclid', 'tiktok', 'paid'],
  ['li_fat_id', 'linkedin', 'paid'],
  ['fbclid', 'facebook', null],
  ['twclid', 'x', null],
];

const clean = (v, max = 128) => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s || null;
};

/**
 * UTM tags from a query string. `source` and `ref` fill in for utm_source
 * (Product Hunt, newsletters and many link shorteners use them), then ad
 * click IDs. Source and medium are lowercased so "Newsletter" and
 * "newsletter" count together; campaign names keep their case.
 */
export function campaignOf(query) {
  const out = { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null };
  if (!query) return out;
  let p;
  try {
    p = new URLSearchParams(query);
  } catch {
    return out;
  }
  for (const k of UTM_KEYS) out[k] = clean(p.get(k));
  out.utm_source ??= clean(p.get('source')) ?? clean(p.get('ref'));
  if (!out.utm_source || !out.utm_medium) {
    for (const [param, source, medium] of CLICK_IDS) {
      if (!p.has(param)) continue;
      out.utm_source ??= source;
      out.utm_medium ??= medium;
      break;
    }
  }
  if (out.utm_source) out.utm_source = out.utm_source.toLowerCase();
  if (out.utm_medium) out.utm_medium = out.utm_medium.toLowerCase();
  return out;
}

// ---------------------------------------------------------------------------
//  Channels
// ---------------------------------------------------------------------------

export const CHANNELS = [
  'Direct', 'Search', 'Social', 'AI assistant', 'Email', 'Paid', 'Referral', 'Campaign', 'Internal',
];

// Referrer host -> channel, first match wins. AI assistants come first
// because some live on search-engine domains (gemini.google.com).
const HOST_RULES = [
  [
    /^(chatgpt\.com|chat\.openai\.com|(www\.)?perplexity\.ai|claude\.ai|gemini\.google\.com|bard\.google\.com|copilot\.microsoft\.com|chat\.mistral\.ai|chat\.deepseek\.com|(www\.)?meta\.ai|poe\.com|(www\.)?phind\.com|chat\.qwen\.ai|grok\.com|(www\.)?you\.com)$/,
    'AI assistant',
  ],
  [
    /^(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|mail\.aol\.com|mail\.proton\.me|app\.fastmail\.com|mail\.zoho\.[a-z]+|webmail\..+|mail\..+)$/,
    'Email',
  ],
  [
    /^((www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?|com\.google\.android\.googlequicksearchbox|(.+\.)?bing\.com|(.+\.)?duckduckgo\.com|(.+\.)?search\.yahoo\.(com|co\.jp)|(.+\.)?yandex\.[a-z]+|ya\.ru|(.+\.)?baidu\.com|(www\.)?ecosia\.org|search\.brave\.com|(www\.)?startpage\.com|(www\.)?qwant\.com|kagi\.com|(.+\.)?naver\.com|(.+\.)?seznam\.cz|(.+\.)?sogou\.com|(www\.)?so\.com|(www\.)?ask\.com|search\.aol\.com)$/,
    'Search',
  ],
  [
    /(^|\.)(facebook\.com|fb\.me|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|reddit\.com|redd\.it|news\.ycombinator\.com|youtube\.com|youtu\.be|pinterest\.[a-z.]+|pin\.it|tiktok\.com|threads\.net|threads\.com|bsky\.app|mastodon\.social|discord\.com|t\.me|telegram\.org|whatsapp\.com|vk\.com|weibo\.com|quora\.com|tumblr\.com|snapchat\.com)$/,
    'Social',
  ],
];

// utm_source written as a name rather than a host.
const SOURCE_RULES = [
  [/^(chatgpt|openai|perplexity|claude|gemini|copilot|deepseek|mistral|grok)$/, 'AI assistant'],
  [/^(google|bing|duckduckgo|ddg|yahoo|yandex|baidu|ecosia|brave|startpage|qwant|kagi|naver)$/, 'Search'],
  [
    /^(facebook|fb|instagram|ig|twitter|x|linkedin|reddit|youtube|pinterest|tiktok|threads|bluesky|bsky|mastodon|discord|telegram|whatsapp|hackernews|hn|snapchat|tumblr|quora)$/,
    'Social',
  ],
];

const PAID_MEDIUM = /^(cpc|ppc|cpm|cpv|cpa|paid|paid[-_ ]?(search|social|media|ads?)|display|banner|retargeting|remarketing)$/;
const EMAIL_MEDIUM = /e-?mail|newsletter/;
const EMAIL_SOURCE = /e-?mail|newsletter|mailchimp|sendgrid|klaviyo|substack|convertkit|buttondown|mailerlite|brevo/;
const SOCIAL_MEDIUM = /^(social|social[-_ ]?(media|network)|organic[-_ ]?social|sm)$/;

const matchRules = (rules, value) => {
  for (const [re, channel] of rules) if (re.test(value)) return channel;
  return null;
};

const stripWww = (h) => (h.startsWith('www.') ? h.slice(4) : h);

/** A referrer on the same site — the visitor clicked a link on your own page. */
export function isInternalReferer(host, refHost) {
  if (!host || !refHost) return false;
  return stripWww(host) === stripWww(refHost);
}

/** True for a referrer host that came from somewhere else. */
export function isExternalReferer(host, refHost) {
  return Boolean(refHost) && refHost !== '(direct)' && !isInternalReferer(host, refHost);
}

/**
 * Where a visit came from, in the coarse groups analytics tools use. Explicit
 * UTM tags win over the referrer, because a tagged link says what the
 * publisher meant even when the browser sends no referrer at all (apps,
 * email clients, and HTTPS-to-HTTP links).
 *
 * @param {{host:string, refHost:string|null, utm:object}} p
 */
export function channelOf({ host, refHost, utm }) {
  const source = utm?.utm_source ?? '';
  const medium = utm?.utm_medium ?? '';

  if (PAID_MEDIUM.test(medium)) return 'Paid';
  if (EMAIL_MEDIUM.test(medium) || EMAIL_SOURCE.test(source)) return 'Email';
  if (source) {
    const named = matchRules(SOURCE_RULES, source) ?? (source.includes('.') ? matchRules(HOST_RULES, source) : null);
    if (named) return named;
  }
  if (SOCIAL_MEDIUM.test(medium)) return 'Social';
  if (medium === 'organic') return 'Search';

  if (isExternalReferer(host, refHost)) return matchRules(HOST_RULES, refHost) ?? 'Referral';
  if (source || medium || utm?.utm_campaign) return 'Campaign';
  if (refHost && refHost !== '(direct)') return 'Internal';
  return 'Direct';
}

// ---------------------------------------------------------------------------
//  Language
// ---------------------------------------------------------------------------

/**
 * The visitor's preferred language from Accept-Language, as a BCP 47 tag
 * trimmed to language plus region or script: "en-US", "zh-Hant", "fr".
 */
export function languageOf(acceptLanguage) {
  if (!acceptLanguage) return null;
  const first = acceptLanguage.split(',')[0].split(';')[0].trim();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(first)) return null;
  const [lang, sub] = first.split('-');
  if (!sub) return lang.toLowerCase();
  let s = sub;
  if (/^[a-z]{2}$/i.test(sub)) s = sub.toUpperCase();
  else if (/^[a-z]{4}$/i.test(sub)) s = sub[0].toUpperCase() + sub.slice(1).toLowerCase();
  return `${lang.toLowerCase()}-${s}`;
}

// ---------------------------------------------------------------------------
//  Disguised bots
// ---------------------------------------------------------------------------

const CHROMIUM_RE = /(?:Chrome|Chromium)\/(\d+)/;

/**
 * A client that claims to be a modern Chromium browser but sends none of the
 * headers every Chromium browser sends over HTTPS (Sec-Fetch-* since 76,
 * Sec-CH-UA since 89). That is a script with a copied User-Agent string.
 *
 * Only judged over TLS — browsers omit these headers on plain HTTP, which is
 * also what Caddy sees behind a TLS-terminating CDN — and only when the log
 * carries several headers, so a log filter that strips them cannot turn every
 * visitor into a bot.
 */
export function looksDisguised(ua, headers, tls) {
  if (!ua || !tls || !headers || typeof headers !== 'object') return false;
  // Chrome, Edge and Opera on iOS are WebKit underneath: no client hints.
  if (/CriOS|EdgiOS|FxiOS|OPiOS/i.test(ua)) return false;
  const m = ua.match(CHROMIUM_RE);
  if (!m || Number(m[1]) < 90) return false;
  if (Object.keys(headers).length < 3) return false;
  return !header(headers, 'Sec-Fetch-Mode') && !header(headers, 'Sec-CH-UA');
}
