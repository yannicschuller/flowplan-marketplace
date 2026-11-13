// Which package requests count as a download or an "opened in Flowplan".
// Crawlers follow the plain download links on the template pages and link
// previews fetch them when someone shares one, so neither counts; a person
// counts once per version and day. Nothing is stored about the visitor
// beyond the daily ipKey() in the rate-limit table.
import { allow, ipKey } from "./rate-limit";
import { clientIp } from "./http";

// Crawlers, link previews, monitors and command-line clients by their
// user agent (case-insensitive). Clients that hide behind a browser's user
// agent are not caught here; the daily limit keeps them to one count each.
// "bot" at the end of a word (Googlebot/2.1, TelegramBot), but not the
// phone maker "CUBOT". Browser apps with their own names
// (DuckDuckGo, YaBrowser, baiduboxapp) are not on the list.
const BOT =
  /(?<!cu)bot\b|crawl|spider|slurp|scrap|preview|fetcher|facebookexternalhit|embedly|whatsapp\/|skypeuripreview|vkshare|pinterest|bitlybot|outbrain|w3c_validator|lighthouse|headless|phantomjs|puppeteer|playwright|selenium|python-|python\/|requests\/|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|wget|curl\/|node-fetch|undici|axios|postman|insomnia|uptime|pingdom|statuscake|datadog|newrelic|chatgpt-user|oai-searchbot|claude-web|claude-user|anthropic-ai|perplexity|bytespider|ccbot|semrush|ahrefs|mj12|dataforseo|ia_archiver|archive\.org_bot/i;

export function isBot(userAgent: string | null) {
  return !userAgent || BOT.test(userAgent);
}

// A person's request, as far as the headers tell: a known bot or no user
// agent never counts. Browsers send Fetch Metadata (all current ones do):
// a download must be a navigation the person started (a click on the link),
// the hand-over to Flowplan a fetch from the marketplace's own page.
export function countable(request: Request, via: "download" | "open") {
  const h = request.headers;
  if (isBot(h.get("user-agent"))) return false;
  const mode = h.get("sec-fetch-mode");
  if (!mode) return true; // an older browser without Fetch Metadata
  if (via === "open") return h.get("sec-fetch-site") === "same-origin" && mode === "cors";
  return mode === "navigate" && h.get("sec-fetch-user") === "?1";
}

// Counts at most once per visitor, version and kind a day.
export function firstToday(request: Request, via: "download" | "open", versionId: string, at = Date.now()) {
  return allow(`count:${via}:${ipKey(clientIp(request), at)}:${versionId}`, 1, 86_400, at);
}
