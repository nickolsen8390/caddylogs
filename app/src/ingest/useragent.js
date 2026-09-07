// A small, dependency-free user-agent classifier. Deliberately conservative:
// anything it cannot place becomes "Other" rather than a wrong guess.

const BOT_RE =
  /(bot|crawler|spider|crawl|slurp|archiver|scraper|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|axios\/|node-fetch|libwww|httpclient|headlesschrome|phantomjs|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexitybot|applebot|facebookexternalhit|slackbot|discordbot|telegrambot|whatsapp|twitterbot|linkedinbot|bingpreview|yandex|baiduspider|duckduckbot|uptime|pingdom|monitor|nagios|zabbix|prometheus|masscan|zgrab|nuclei|nmap|sqlmap|nikto)/i;

const NAMED_BOTS = [
  [/googlebot/i, 'Googlebot'],
  [/bingbot/i, 'Bingbot'],
  [/gptbot/i, 'GPTBot'],
  [/claudebot|anthropic-ai/i, 'ClaudeBot'],
  [/ccbot/i, 'CCBot'],
  [/perplexitybot/i, 'PerplexityBot'],
  [/bytespider/i, 'Bytespider'],
  [/petalbot/i, 'PetalBot'],
  [/applebot/i, 'Applebot'],
  [/ahrefsbot/i, 'AhrefsBot'],
  [/semrushbot/i, 'SemrushBot'],
  [/mj12bot/i, 'MJ12bot'],
  [/dotbot/i, 'DotBot'],
  [/yandexbot/i, 'YandexBot'],
  [/baiduspider/i, 'Baiduspider'],
  [/duckduckbot/i, 'DuckDuckBot'],
  [/facebookexternalhit|meta-externalagent/i, 'Facebook'],
  [/twitterbot/i, 'Twitterbot'],
  [/slackbot/i, 'Slackbot'],
  [/discordbot/i, 'Discordbot'],
  [/telegrambot/i, 'TelegramBot'],
  [/uptimerobot/i, 'UptimeRobot'],
  [/pingdom/i, 'Pingdom'],
  [/curl\//i, 'curl'],
  [/wget\//i, 'Wget'],
  [/python-requests|python-urllib|aiohttp/i, 'Python'],
  [/go-http-client/i, 'Go http'],
  [/okhttp/i, 'OkHttp'],
  [/axios\//i, 'axios'],
  [/node-fetch|undici/i, 'Node fetch'],
  [/sqlmap|nikto|nuclei|zgrab|masscan|nmap/i, 'Scanner'],
];

// Order matters: more specific engines first.
const BROWSERS = [
  [/edg(?:e|a|ios)?\/([\d.]+)/i, 'Edge'],
  [/opr\/([\d.]+)/i, 'Opera'],
  [/opera[ /]([\d.]+)/i, 'Opera'],
  [/samsungbrowser\/([\d.]+)/i, 'Samsung Internet'],
  [/vivaldi\/([\d.]+)/i, 'Vivaldi'],
  [/brave\/([\d.]+)/i, 'Brave'],
  [/ucbrowser\/([\d.]+)/i, 'UC Browser'],
  [/yabrowser\/([\d.]+)/i, 'Yandex Browser'],
  [/firefox\/([\d.]+)/i, 'Firefox'],
  [/fxios\/([\d.]+)/i, 'Firefox'],
  [/crios\/([\d.]+)/i, 'Chrome'],
  [/chrome\/([\d.]+)/i, 'Chrome'],
  [/chromium\/([\d.]+)/i, 'Chromium'],
  [/version\/([\d.]+).*safari/i, 'Safari'],
  [/safari\/([\d.]+)/i, 'Safari'],
  [/msie ([\d.]+)/i, 'Internet Explorer'],
  [/trident\/.*rv:([\d.]+)/i, 'Internet Explorer'],
];

const OSES = [
  [/windows nt 10\.0/i, 'Windows 10/11'],
  [/windows nt 6\.3/i, 'Windows 8.1'],
  [/windows nt 6\.2/i, 'Windows 8'],
  [/windows nt 6\.1/i, 'Windows 7'],
  [/windows phone/i, 'Windows Phone'],
  [/windows/i, 'Windows'],
  [/android[ /]?([\d.]+)?/i, 'Android'],
  [/(iphone|ipod).*os ([\d_]+)/i, 'iOS'],
  [/ipad.*os ([\d_]+)/i, 'iPadOS'],
  [/iphone|ipod|ipad/i, 'iOS'],
  [/mac os x ([\d_.]+)/i, 'macOS'],
  [/macintosh/i, 'macOS'],
  [/cros /i, 'ChromeOS'],
  [/ubuntu/i, 'Ubuntu'],
  [/debian/i, 'Debian'],
  [/fedora/i, 'Fedora'],
  [/freebsd/i, 'FreeBSD'],
  [/linux/i, 'Linux'],
];

const cache = new Map();
const CACHE_MAX = 20000;

/**
 * @param {string} ua
 * @returns {{browser:string, os:string, device:string, bot:0|1}}
 */
export function parseUserAgent(ua) {
  if (!ua) return { browser: 'None', os: 'Unknown', device: 'Unknown', bot: 0 };
  const hit = cache.get(ua);
  if (hit) return hit;

  let browser = 'Other';
  let os = 'Unknown';
  let device = 'Desktop';
  let bot = 0;

  if (BOT_RE.test(ua)) {
    bot = 1;
    device = 'Bot';
    browser = 'Other bot';
    for (const [re, name] of NAMED_BOTS) {
      if (re.test(ua)) {
        browser = name;
        break;
      }
    }
    os = 'Bot';
  } else {
    for (const [re, name] of BROWSERS) {
      const m = ua.match(re);
      if (m) {
        const major = (m[1] || '').split('.')[0];
        browser = major ? `${name} ${major}` : name;
        break;
      }
    }
    for (const [re, name] of OSES) {
      if (re.test(ua)) {
        os = name;
        break;
      }
    }
    if (/ipad|tablet|playbook|silk/i.test(ua)) device = 'Tablet';
    else if (/mobi|android|iphone|ipod|windows phone/i.test(ua)) device = 'Mobile';
    else if (/smart-?tv|appletv|googletv|hbbtv|netcast|roku/i.test(ua)) device = 'TV';
  }

  const out = { browser, os, device, bot };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ua, out);
  return out;
}
