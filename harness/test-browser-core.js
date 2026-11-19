// Plain node tests for public/browser-core.js (no framework).
// Usage: node harness/test-browser-core.js
'use strict';
const assert = require('node:assert');
const core = require('../public/browser-core.js');

let n = 0;
function eq(actual, expected, label) { n++; assert.strictEqual(actual, expected, label); }
function deep(actual, expected, label) { n++; assert.deepStrictEqual(actual, expected, label); }

// ---- resolveOmnibox ----
eq(core.resolveOmnibox('', {}), core.DEFAULT_HOMEPAGE, 'blank -> homepage');
eq(core.resolveOmnibox('   ', {}), core.DEFAULT_HOMEPAGE, 'whitespace -> homepage');
eq(core.resolveOmnibox('', { homepage: 'https://example.com/home' }), 'https://example.com/home', 'blank -> custom homepage');
eq(core.resolveOmnibox('https://example.com/a?b=1', {}), 'https://example.com/a?b=1', 'https scheme as-is');
eq(core.resolveOmnibox('http://example.com', {}), 'http://example.com', 'http scheme as-is');
eq(core.resolveOmnibox('wikipedia.org', {}), 'https://wikipedia.org', 'bare domain -> https');
eq(core.resolveOmnibox('en.wikipedia.org/wiki/Cats', {}), 'https://en.wikipedia.org/wiki/Cats', 'domain + path -> https');
eq(core.resolveOmnibox('example.com:8080', {}), 'https://example.com:8080', 'domain:port is a URL, not a scheme');
eq(core.resolveOmnibox('localhost:3000', {}), 'https://localhost:3000', 'localhost:port -> https');
eq(core.resolveOmnibox('localhost', {}), 'https://localhost', 'localhost -> https');
eq(core.resolveOmnibox('192.168.1.1', {}), 'https://192.168.1.1', 'IPv4 -> https');
eq(core.resolveOmnibox('192.168.1.1:8080/x', {}), 'https://192.168.1.1:8080/x', 'IPv4:port/path -> https');
eq(core.resolveOmnibox('cats', {}), 'https://duckduckgo.com/?q=cats', 'single word -> DDG search (default)');
eq(core.resolveOmnibox('hello world', {}), 'https://duckduckgo.com/?q=hello%20world', 'phrase -> DDG search, encoded');
eq(core.resolveOmnibox('cats', { searchEngine: 'google' }), 'https://www.google.com/search?q=cats', 'single word -> Google');
eq(core.resolveOmnibox('cats & dogs', { searchEngine: 'bing' }), 'https://www.bing.com/search?q=cats%20%26%20dogs', 'phrase -> Bing, encoded');
eq(core.resolveOmnibox('cats', { searchEngine: 'nope' }), 'https://duckduckgo.com/?q=cats', 'unknown engine falls back to DDG');
eq(core.resolveOmnibox('example.com:abc', {}), 'https://duckduckgo.com/?q=example.com%3Aabc', 'non-numeric port -> search, not URL');

// ---- isUrlLike ----
eq(core.isUrlLike('example.com'), true, 'isUrlLike domain');
eq(core.isUrlLike('example.com:8080'), true, 'isUrlLike domain:port');
eq(core.isUrlLike('example.com:abc'), false, 'isUrlLike non-numeric port');
eq(core.isUrlLike('cats'), false, 'isUrlLike single word');
eq(core.isUrlLike('hello world'), false, 'isUrlLike phrase');
eq(core.isUrlLike('localhost:3000'), true, 'isUrlLike localhost:port');
eq(core.isUrlLike('10.0.0.5'), true, 'isUrlLike IPv4');
eq(core.isUrlLike('https://example.com'), false, 'isUrlLike rejects scheme (handled elsewhere)');

// ---- suggestions ----
const hist = [
  { url: 'https://en.wikipedia.org/wiki/Cat', title: 'Cat', time: 100 },
  { url: 'https://example.com', title: 'Example', time: 300 },
  { url: 'https://www.bbc.com/news', title: 'BBC News', time: 200 },
];
const bkm = [{ url: 'https://en.wikipedia.org/wiki/Dog', title: 'Dog wiki' }];
const tabs = [
  { url: 'https://en.wikipedia.org/wiki/Cat', title: 'Cat tab' },
  { url: 'https://news.ycombinator.com', title: 'HN' },
];
let s = core.suggestions('wiki', hist, bkm, tabs);
eq(s.length, 2, 'suggestions: wiki matches bookmark + history');
eq(s[0].kind, 'bookmark', 'suggestions: bookmark first');
eq(s[0].url, 'https://en.wikipedia.org/wiki/Dog', 'suggestions: bookmark url');
eq(s[1].kind, 'history', 'suggestions: history second');
s = core.suggestions('', hist, bkm, tabs);
eq(s[0].kind, 'bookmark', 'suggestions empty query: bookmark first');
eq(s[1].url, 'https://example.com', 'suggestions empty query: history newest-first');
eq(s[2].url, 'https://www.bbc.com/news', 'suggestions empty query: history second-newest');
eq(s[3].url, 'https://en.wikipedia.org/wiki/Cat', 'suggestions empty query: history oldest last');
eq(s[4].url, 'https://news.ycombinator.com', 'suggestions empty query: open tab last, cat tab deduped');
eq(s.length, 5, 'suggestions empty query: dedupe by URL');
s = core.suggestions('zzz-no-match', hist, bkm, tabs);
eq(s.length, 0, 'suggestions: no match -> empty');
s = core.suggestions('', hist, bkm, tabs, 2);
eq(s.length, 2, 'suggestions: limit respected');

// ---- decideDownload ----
deep(core.decideDownload('https://example.com/photo.jpg', [], 'allow'), { allowed: true }, 'download: allowed image with allow verdict');
deep(core.decideDownload('https://example.com/file.pdf', [], null), { allowed: true }, 'download: non-image, unknown verdict -> allow');
deep(core.decideDownload('https://example.com/photo.jpg', [], null), { allowed: false, reason: 'unknown-image' }, 'download: image, unknown verdict -> block');
deep(core.decideDownload('https://example.com/photo.png?x=1', [], undefined), { allowed: false, reason: 'unknown-image' }, 'download: image with query, unknown verdict -> block');
deep(core.decideDownload('https://example.com/photo.JPG', [], ''), { allowed: false, reason: 'unknown-image' }, 'download: image ext case-insensitive');
deep(core.decideDownload('https://example.com/photo.jpg', [], 'cover'), { allowed: false, reason: 'verdict-cover' }, 'download: cover verdict -> block');
deep(core.decideDownload('https://example.com/photo.jpg', [], 'block'), { allowed: false, reason: 'verdict-block' }, 'download: block verdict -> block');
deep(core.decideDownload('https://example.com/file.pdf', [], 'review'), { allowed: false, reason: 'verdict-review' }, 'download: review verdict -> block');
deep(core.decideDownload('https://www.facebook.com/pic.jpg', ['facebook.com'], 'allow'), { allowed: false, reason: 'blocked-host' }, 'download: exact blocked host');
deep(core.decideDownload('https://m.facebook.com/pic.jpg', ['facebook.com'], 'allow'), { allowed: false, reason: 'blocked-host' }, 'download: blocked subdomain');
deep(core.decideDownload('https://notfacebook.com/pic.jpg', ['facebook.com'], 'allow'), { allowed: true }, 'download: lookalike host is NOT a subdomain match');
deep(core.decideDownload('ftp://example.com/file.zip', [], 'allow'), { allowed: false, reason: 'bad-scheme' }, 'download: ftp scheme -> block');
deep(core.decideDownload('data:image/png;base64,abc', [], 'allow'), { allowed: false, reason: 'bad-scheme' }, 'download: data: scheme -> block');
deep(core.decideDownload('not a url', [], 'allow'), { allowed: false, reason: 'invalid-url' }, 'download: invalid URL -> block');

// ---- rewriteSafeSearch (verbatim rules) ----
eq(core.rewriteSafeSearch('https://www.google.com/search?q=cats'), 'https://www.google.com/search?q=cats&safe=active', 'safesearch: google gains safe=active');
eq(core.rewriteSafeSearch('https://www.google.com/search?q=cats&safe=off'), 'https://www.google.com/search?q=cats&safe=active', 'safesearch: google safe=off rewritten to active');
eq(core.rewriteSafeSearch('https://www.bing.com/search?q=cats'), 'https://www.bing.com/search?q=cats&adlt=strict', 'safesearch: bing gains adlt=strict');
eq(core.rewriteSafeSearch('https://duckduckgo.com/?q=cats'), 'https://duckduckgo.com/?q=cats&kp=1', 'safesearch: ddg gains kp=1');
eq(core.rewriteSafeSearch('https://example.com/?q=cats'), 'https://example.com/?q=cats', 'safesearch: unrelated URL untouched');
eq(core.rewriteSafeSearch('https://www.google.com/search?q=cats#frag'), 'https://www.google.com/search?q=cats&safe=active#frag', 'safesearch: fragment preserved');

// ---- search engine URLs ----
eq(core.SEARCH_ENGINES.duckduckgo.searchUrl, 'https://duckduckgo.com/?q=', 'engine: DDG url');
eq(core.SEARCH_ENGINES.google.searchUrl, 'https://www.google.com/search?q=', 'engine: Google url');
eq(core.SEARCH_ENGINES.bing.searchUrl, 'https://www.bing.com/search?q=', 'engine: Bing url');

console.log(`browser-core tests: ${n} assertions passed`);
