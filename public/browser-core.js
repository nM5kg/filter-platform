// Filter Platform web browser — PURE logic module (browser-core.js).
//
// No DOM, no browser APIs, no localStorage: every function here is pure
// and Node-testable (see harness/test-browser-core.js). The shell
// (public/browser.html) loads this file and calls it via window.FPBrowserCore.
//
// Filter policy (same as the Android FilterEngine DEFAULT_POLICY):
//   threshold 0.70, PERSON -> cover, NO_PERSON >= 0.70 -> allow,
//   UNKNOWN -> cover (fail closed). That policy lives in the Worker /
//   content script, not here — this module only decides omnibox,
//   suggestions, SafeSearch rewrites and download gating.

(function (root) {
  'use strict';

  var DEFAULT_HOMEPAGE = 'https://filter-platform-dashboard.pages.dev/test-pages/index.html';

  // A scheme is "scheme://..." or a known scheme prefix. A bare word
  // followed by ":port" (localhost:3000, example.com:8080) is a host
  // with a port, NOT a scheme — the naive /^[a-z][...]*:/ test misreads
  // both of those as schemes.
  var HAS_SCHEME = /^(?:[a-z][a-z0-9+-]*:\/\/|(?:https?|ftp|file|about|data|blob|mailto|tel):)/i;

  var SEARCH_ENGINES = {
    duckduckgo: { id: 'duckduckgo', name: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q=' },
    google: { id: 'google', name: 'Google', searchUrl: 'https://www.google.com/search?q=' },
    bing: { id: 'bing', name: 'Bing', searchUrl: 'https://www.bing.com/search?q=' }
  };

  // ---------------------------------------------------------------- URLs

  // True when the input looks like a bare host (optionally with a port
  // and/or a path), i.e. something "https://" can simply be prepended to.
  // "example.com:8080" is a URL (numeric port), not a scheme — the scheme
  // check in resolveOmnibox runs first and only matches a scheme followed
  // by ":", so "example.com:8080" never reaches here as a scheme.
  // Single words ("cats"), phrases with spaces, and "example.com:abc"
  // (non-numeric port) are NOT URL-like and become searches.
  function isUrlLike(input) {
    var v = (input || '').trim();
    if (!v || /\s/.test(v)) return false;
    if (HAS_SCHEME.test(v)) return false; // has a scheme
    var hostPart = v.split(/[\/?#]/)[0];
    if (/^localhost(:\d+)?$/i.test(hostPart)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(hostPart)) return true;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?$/i.test(hostPart)) return true;
    return false;
  }

  // Omnibox resolution. settings = { searchEngine, homepage }.
  //   blank            -> homepage
  //   has a scheme     -> as-is (http://, https://, ...)
  //   space / not URL-like -> search URL via settings.searchEngine
  //   domain / IP / localhost (with optional :port and path) -> https:// + input
  function resolveOmnibox(input, settings) {
    settings = settings || {};
    var engine = SEARCH_ENGINES[settings.searchEngine] || SEARCH_ENGINES.duckduckgo;
    var homepage = settings.homepage || DEFAULT_HOMEPAGE;
    var v = (input || '').trim();
    if (!v) return homepage;
    if (HAS_SCHEME.test(v)) return v;
    if (/\s/.test(v) || !isUrlLike(v)) return engine.searchUrl + encodeURIComponent(v);
    return 'https://' + v;
  }

  // ---------------------------------------------------------------- suggestions

  // Bookmarks first, then history newest-first, then open tabs; dedupe by
  // URL (case-insensitive). history entries: {url, title, time};
  // bookmarks: {url, title}; openTabs: {url, title}. Each result is
  // {url, title, kind} with kind 'bookmark' | 'history' | 'tab'.
  // An empty query returns the same ordering unfiltered (up to limit).
  function suggestions(query, history, bookmarks, openTabs, limit) {
    limit = limit || 8;
    var q = (query || '').trim().toLowerCase();
    var out = [];
    var seen = {};
    function push(list, kind) {
      (list || []).forEach(function (item) {
        if (!item || out.length >= limit) return;
        var url = item.url || '';
        if (!url) return;
        var key = url.toLowerCase();
        if (seen[key]) return;
        if (q) {
          var hay = ((item.title || '') + ' ' + url).toLowerCase();
          if (hay.indexOf(q) === -1) return;
        }
        seen[key] = true;
        out.push({ url: url, title: item.title || url, kind: kind });
      });
    }
    push(bookmarks, 'bookmark');
    var hist = (history || []).slice().sort(function (a, b) {
      return (b.time || 0) - (a.time || 0);
    });
    push(hist, 'history');
    push(openTabs, 'tab');
    return out;
  }

  // ---------------------------------------------------------------- downloads

  var IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|bmp)$/i;

  // Gate a download request from the iframe.
  //   url            - the requested download URL
  //   blockedHosts   - array of blocked hostnames (exact host or subdomain)
  //   elementVerdict - 'allow' | 'cover' | 'block' | 'review' | 'painted' | null/undefined
  // BLOCK when: host is blocked; verdict is cover/block/review/painted;
  // verdict is null/unknown AND the URL looks like an image (extension
  // before ?/# — URL.pathname already excludes query/fragment); scheme
  // is not http(s). 'painted' is blocked even though the image is
  // visible: the paint overlays only hide the person on screen, the
  // raw bytes still contain the person, so they must never download.
  // Otherwise ALLOW.
  function decideDownload(url, blockedHosts, elementVerdict) {
    var parsed;
    try { parsed = new URL(url); } catch (e) {
      return { allowed: false, reason: 'invalid-url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'bad-scheme' };
    }
    var host = parsed.hostname.toLowerCase();
    for (var i = 0; i < (blockedHosts || []).length; i++) {
      var b = String(blockedHosts[i]).toLowerCase();
      if (host === b || host.slice(-(b.length + 1)) === '.' + b) {
        return { allowed: false, reason: 'blocked-host' };
      }
    }
    if (elementVerdict === 'cover' || elementVerdict === 'block' || elementVerdict === 'review' || elementVerdict === 'painted') {
      return { allowed: false, reason: 'verdict-' + elementVerdict };
    }
    if ((elementVerdict === null || elementVerdict === undefined || elementVerdict === '') &&
        IMAGE_EXT.test(parsed.pathname)) {
      return { allowed: false, reason: 'unknown-image' };
    }
    return { allowed: true };
  }

  // ---------------------------------------------------------------- SafeSearch

  // SafeSearch rewrite (same rules as FilterEngine.rewriteSafeSearch — the
  // proxy Worker is authoritative and re-applies it; this is only for
  // display / the shell-side URL). Kept verbatim from the original shell.
  function rewriteSafeSearch(url) {
    var rules = [
      [/^https:\/\/(?:www\.)?google\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2,3})\/search/i, 'safe', 'active'],
      [/^https:\/\/(?:www\.)?bing\.com\/search/i, 'adlt', 'strict'],
      [/^https:\/\/(?:www\.)?duckduckgo\.com\/.*[?&]q=/i, 'kp', '1']
    ];
    for (var i = 0; i < rules.length; i++) {
      if (!rules[i][0].test(url)) continue;
      var key = rules[i][1], val = rules[i][2];
      var hashIdx = url.indexOf('#');
      var frag = hashIdx >= 0 ? url.substring(hashIdx) : '';
      var noFrag = hashIdx >= 0 ? url.substring(0, hashIdx) : url;
      var qIdx = noFrag.indexOf('?');
      var base = qIdx >= 0 ? noFrag.substring(0, qIdx) : noFrag;
      var query = qIdx >= 0 ? noFrag.substring(qIdx + 1) : '';
      var params = query ? query.split('&') : [];
      var found = false;
      for (var j = 0; j < params.length; j++) {
        if (params[j].split('=')[0] === key) { params[j] = key + '=' + val; found = true; }
      }
      if (!found) params.push(key + '=' + val);
      return base + '?' + params.join('&') + frag;
    }
    return url;
  }

  var api = {
    DEFAULT_HOMEPAGE: DEFAULT_HOMEPAGE,
    SEARCH_ENGINES: SEARCH_ENGINES,
    isUrlLike: isUrlLike,
    resolveOmnibox: resolveOmnibox,
    suggestions: suggestions,
    decideDownload: decideDownload,
    rewriteSafeSearch: rewriteSafeSearch
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FPBrowserCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
