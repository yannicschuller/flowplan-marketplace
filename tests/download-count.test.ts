import { test } from "node:test";
import assert from "node:assert/strict";
import { req, useTempData } from "./helpers";
useTempData();
import { countable, firstToday, isBot } from "../lib/download-count";

const BROWSERS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 11; CUBOT X30 Build/RP1A.200720.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
];
const BOTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "TelegramBot (like TwitterBot)",
  "WhatsApp/2.23.20.0",
  "DuckDuckBot-Https/1.1; (+https://duckduckgo.com/duckduckbot)",
  "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
  "curl/8.5.0",
  "python-requests/2.32.3",
  "Go-http-client/2.0",
];

test("browsers are people, crawlers, link previews and scripts are not", () => {
  for (const ua of BROWSERS) assert.equal(isBot(ua), false, ua);
  for (const ua of BOTS) assert.equal(isBot(ua), true, ua);
  assert.equal(isBot(null), true, "no user agent");
});

const at = (headers: Record<string, string>) => req("/api/templates/x/download", { headers: { "user-agent": BROWSERS[0], ...headers } });
test("a download counts for a click on the link, the hand-over for the page's own fetch", () => {
  assert.equal(countable(at({ "sec-fetch-mode": "navigate", "sec-fetch-user": "?1", "sec-fetch-site": "same-origin" }), "download"), true);
  assert.equal(countable(at({}), "download"), true, "a browser without Fetch Metadata");
  // A crawler running a browser navigates without a user gesture; an <img>/prefetch is no navigation.
  assert.equal(countable(at({ "sec-fetch-mode": "navigate", "sec-fetch-site": "none" }), "download"), false);
  assert.equal(countable(at({ "sec-fetch-mode": "no-cors", "sec-fetch-site": "cross-site" }), "download"), false);
  assert.equal(countable(at({ "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" }), "open"), true);
  assert.equal(countable(at({ "sec-fetch-mode": "cors", "sec-fetch-site": "cross-site" }), "open"), false);
  assert.equal(countable(req("/api/templates/x/download", { headers: { "user-agent": BOTS[0], "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" } }), "download"), false);
});

test("once per visitor, version and kind a day", () => {
  const r = req("/api/templates/x/download", { headers: { "x-forwarded-for": "198.51.100.7" } });
  const day = Date.UTC(2026, 10, 13, 9);
  assert.equal(firstToday(r, "download", "v1", day), true);
  assert.equal(firstToday(r, "download", "v1", day + 3 * 3_600_000), false, "three hours later");
  assert.equal(firstToday(r, "open", "v1", day + 1000), true, "opening counts separately");
  assert.equal(firstToday(r, "download", "v2", day + 1000), true, "another version");
  assert.equal(firstToday(req("/x", { headers: { "x-forwarded-for": "198.51.100.8" } }), "download", "v1", day + 1000), true, "another visitor");
});
