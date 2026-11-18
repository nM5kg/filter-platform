# Visual Protection Engine — Scan Report (prototype v0.2.0)

## Video / canvas / Google Images verification + relay-restart re-runs (v0.2.0, 2026-11-18 ~11:10–11:25 UTC)

**Headline: the egress block is resolved and all four real sites now have
valid v0.2.0 runs.** A sibling agent fixed a real bug in
`harness/egress-relay.js` (pipelined `head` bytes dropped in the `connect`
handler), but the relay on 127.0.0.1:18080 was still running the old code.
Controlled comparison, same minute: the old-code relay failed all three
hosts (`en.wikipedia.org`, `ichef.bbci.co.uk`, `static.bbci.co.uk` — 000
after 15.0 s, the relay's CONNECT timer), while the fixed-code relay on
18081 returned 200 in 0.5–0.6 s for all three. The 18080 relay was
restarted with the fixed code (old pid 16786 killed only after the 18081
replacement was verified running; new pid 34902, log `/tmp/relay18080.log`),
and it now returns 200 for all four hosts (Wikipedia 0.98 s, ichef 0.69 s,
bbc.com 1.17 s, Commons 1.11 s). **The restart changed everything for
Wikipedia/BBC and nothing for Google Images** (see below).

### Valid v0.2.0 re-runs after the restart (`node scan.js` Wikipedia + BBC, generated 2026-11-18T11:23:44Z)

| Site | Verdict | HTTP | Scan | CPU | Peak RSS | Elements | People | Blocked | Review |
|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org (Main Page) | REVIEW | 200 | 35,494 ms | 30.4 s | 1,134 MB | 24 img | **4** | **4** | 6 |
| www.bbc.com | REVIEW | 200 | 123,891 ms | 87.9 s | 1,146 MB | 72 img | **20** | **20** | 40 |

- **Wikipedia, 4 people (baseline face-only: 3):** Gilbert 0.849, Bunlet
  Harcourt 1937 0.963, Jensen Huang 0.967, Khrushchev 1956 0.986 — all
  `person+face`. The extra find vs baseline is the Gilbert photo. 17
  candidates checked, 0 skipped. The 6 REVIEWs are small logo/icon images
  (Wikipedia wordmark/tagline, sister-project icons). Only failure: the
  `--no-sandbox` note.
- **BBC, 20 people (baseline face-only: 9):** confidences 0.749–0.997.
  `detected_by`: `person+face` 13, **`person`-only 6** (face-api found
  nothing — bodies/back views/distant figures the face detector is blind
  to), **`face`-only 1** (0.896, 3 faces, 0 persons — the complement runs
  both ways). 40 candidates checked, 31 skipped over budget (the 40-image
  budget, same as baseline). Failures (6): Chartbeat ping blocked 3× by
  Chromium ORB (tracker beacon, not content), `networkidle` not reached in
  15 s, 1 page JS error (`invalid callback function`).
- **Caveat:** live homepages change between runs, so 4-vs-3 and 20-vs-9
  are not pure A/B comparisons — but both runs prove the person detector
  works end-to-end on real BBC/Wikipedia images, which the failed runs
  never got to test. The "no valid run" claim in the Phase 4 summary
  below is superseded by these runs; the failed attempts are kept verbatim
  in the generated sections underneath.
- Full detail: the generated run at the top of this file (below this
  section) and `results/en-wikipedia-org-wiki-Main-Page.json` /
  `results/www-bbc-com.json` (+ screenshots). One more fresh Wikipedia
  retry *before* the restart (`test-video-canvas/results/wikipedia-retry.json`,
  ~11:18 UTC) still failed identically (`ERR_TUNNEL_CONNECTION_FAILED`,
  15,444 ms, 0 elements) — the block was the relay, not the site.

### Video + canvas verification (local test pages, `scanner/test-video-canvas/`)

Real media, served from 127.0.0.1:8125: a real Commons video (Obama Chile
earthquake statement, 480p VP9 transcode, 854×480, 140.9 s) and real
test-set photos drawn on canvas. Run with the test-only
`SCANNER_ALLOW_LOOPBACK=1` override (see `test-video-canvas/README.md`).
Full detail in `test-video-canvas/README.md` and
`test-video-canvas/results/video.json` / `canvas.json`.

| Element | Detection | Confidence | Via | Decision |
|---|---|---|---|---|
| `<video>` Obama, paused at 5 s (854×480) | person | 0.82 | person (0 faces) | **BLOCK** |
| `<canvas>` drawImage portrait (Huang) | person | 0.966 | person+face | **BLOCK** |
| `<canvas>` animated, video frames via rAF | person | 0.818 | person+face | **BLOCK** |
| `<canvas>` drawImage landscape (control) | none | 0 | — | **ALLOW** |
| `<video>` Obama, playing 427×240 (same page) | person | 0.768 | person+face | **BLOCK** |

Video page: 1 element, scan 23,820 ms, CPU 6.2 s, RSS 788 MB. Canvas page:
5 elements, 3 people, 3 blocked, 1 review, scan 61,814 ms, CPU 22.7 s,
RSS 943.6 MB. **The video-frame and canvas paths work** — a video frame is
captured (element screenshot) and analysed, canvas content is detected
(static and animated), and the no-person canvas control is correctly
ALLOWED. Per-element cost is ~3–8 s (screenshot + detect) vs ~1.4 s for a
plain `<img>`.

**CORS finding (real, not a test artifact):** the same portrait that scored
0.966 via canvas screenshot failed as an `<img>` in the same run —
`uncertain` → REVIEW, note `load failed / CORS`. Cause: the detector page
is a fresh `about:blank` page (opaque origin) and `detector.js` loads
`<img>` URLs with `crossOrigin='anonymous'`, so any host that does not
send `Access-Control-Allow-Origin: *` fails the load (Python's
`http.server` sends none). The video/canvas screenshot path is immune —
screenshots are the scanner's own pixels. This is the same mechanism as
the CORS-tainted thumbnails on real sites, now verified with identical
pixels through both paths.

### Google Images (extension verification) — still unverified

Chromium routes tried (probe outputs in
`test-video-canvas/results/google-images-routes*.jsonl`):

| Route | Result |
|---|---|
| A. Relay 18080 + SPKI pin (before AND after restart) | HTTP 200 in ~1.5–2.0 s — but Google redirects to `/sorry/index` ("unusual traffic … not a robot"), 0 images |
| B. Relay 18080 + `--ignore-certificate-errors` | Same `/sorry`, 0 images |
| C. Relay 18081 + SPKI pin | Same `/sorry`, 0 images |
| D. Direct upstream egress proxy + Playwright proxy auth | `ERR_TUNNEL_CONNECTION_FAILED` in ~100 ms — upstream drops unauthenticated connections without a 407, so Chromium never gets to authenticate; the relay is required |
| Stealth (no `--enable-automation`, `--disable-blink-features=AutomationControlled`, `navigator.webdriver=false`, real UA) | Still `/sorry`, 0 images, 7.2 s |

Control: `curl` with a browser UA through the same relay gets a **real**
results page (200, 93,959 bytes, no `/sorry` marker). So the proxy/TLS
path to Google works — Google's bot-check targets headless Chromium
specifically, and the relay restart did not change it. No CAPTCHA was
attempted. **The extension content script was never shown real Google
Images thumbnails, so that verification stays open** — it needs a machine
where Google serves real results to a real browser.

---

Generated: 2026-11-18T11:23:44.574Z (UTC)
Policy: standard-v1 (block_images=true, cover_images=false, threshold 0.70)
Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO person class) + face-api.js tinyFaceDetector fallback, CPU backend, models bundled in scanner/models/ (see detector.js)
Sandbox: proxy http://127.0.0.1:18080 + TLS SPKI pin (egress CA only)

| Site | Verdict | HTTP | Scan ms | CPU s | Peak RSS MB | Elements | People | Blocked | Review | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org | REVIEW | 200 | 35494 | 30.373 | 1134 | 24 | 4 | 4 | 6 | 1 |
| www.bbc.com | REVIEW | 200 | 123891 | 87.876 | 1146 | 72 | 20 | 20 | 40 | 6 |

## https://en.wikipedia.org/wiki/Main_Page

- Result file: `results/en-wikipedia-org-wiki-Main-Page.json`, screenshot: `results/en-wikipedia-org-wiki-Main-Page.png`
- Final URL: https://en.wikipedia.org/wiki/Main_Page
- HTTP status: 200, redirects: 0, navigation: 4172 ms
- Scan time: 35494 ms, CPU: 30.373 s, peak RSS: 1134 MB
- Detector: loaded=true (person_loaded=true, face_loaded=true); candidates checked: 17, skipped (over budget): 0
- Elements by type: {"img":24}
- Summary: {"total":24,"people":4,"covered":0,"blocked":4,"review":6}
- People detected:
  - conf=0.849 (1 person) (1 face) via person+face — img `div#mp-tfa-img > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Gilbert-GS-Big.JPG/120px-Gilbert-GS-Big.JPG?utm_source=en.wikip
  - conf=0.963 (1 person) (1 face) via person+face — img `div#mp-dyk > div.dyk-img:nth-of-type(1) > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Bunlet_Harcourt_1937_3.jpg/120px-Bunlet_Harcourt_1937_3.jpg?utm
  - conf=0.967 (1 person) (1 face) via person+face — img `div#mp-itn > div.itn-img:nth-of-type(1) > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c8/Jensen_Huang_Stanford_2026-04-30_010_%28cropped%29.jpg/250px-Je
  - conf=0.986 (1 person) (1 face) via person+face — img `div#mp-otd-img > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/9/96/1956_Press_Photo_Communist_Party_Secretary_Nikita_Khrushchev_in
- Uncertain / unanalyzable (6):
  - img `div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > span.mw-logo-container > img.mw-logo-wordmark:nth-of-type(1)` → REVIEW
  - img `div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > span.mw-logo-container > img.mw-logo-tagline:nth-of-type(2)` → REVIEW
  - img `ul#sister-projects-list > li:nth-of-type(1) > div:nth-of-type(1) > span.noviewer > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `ul#sister-projects-list > li:nth-of-type(5) > div:nth-of-type(1) > span.noviewer > span > img.mw-file-element` → REVIEW
  - img `li#footer-copyrightico > a.cdx-button > picture > img` → REVIEW
  - img `li#footer-poweredbyico > a.cdx-button > picture > img` → REVIEW
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)

## https://www.bbc.com

- Result file: `results/www-bbc-com.json`, screenshot: `results/www-bbc-com.png`
- Final URL: https://sync.teads.tv/wigo-no-slot
- HTTP status: 200, redirects: 0, navigation: 24305 ms
- Scan time: 123891 ms, CPU: 87.876 s, peak RSS: 1146 MB
- Detector: loaded=true (person_loaded=true, face_loaded=true); candidates checked: 40, skipped (over budget): 31
- Elements by type: {"img":72}
- Summary: {"total":72,"people":20,"covered":0,"blocked":20,"review":40}
- People detected:
  - conf=0.907 (2 persons) (2 faces) via person+face — img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/ace/standard/480/cpsprodpb/e1f8/live/94b217a0-e334-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.93 (3 persons) (3 faces) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/e20b/live/66ff6490-e323-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.796 (1 person) via person — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/a56b/live/b9e12140-e2f5-11f1-910a-c953499d69d5.jpg.webp
  - conf=0.936 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/640x360/p0pnfhcn.jpg.webp
  - conf=0.896 (3 faces) via face — img `div.IndexCard-styles__IndexCardStyled-sc-3a0d8802-0 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ashford-styles__AshfordCardStyled-sc-648c73f6-0 > div.Ashford-styles__BackgroundImageWrapperStyled-sc-648c73f6-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/1376xn/p0pkjx8q.jpg.webp
  - conf=0.879 (1 person) via person — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/c96b/live/b14b3a60-d9c8-11f1-93e1-3b657b665bcf.jpg.webp
  - conf=0.794 (3 persons) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/fb1d/live/c5d2fbf0-e330-11f1-9c56-6ffaf0e1e706.jpg.webp
  - conf=0.943 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/0369/live/387a8f10-e2ff-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.955 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0p80lkj.jpg.webp
  - conf=0.75 (2 persons) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0l685z5.jpg.webp
  - conf=0.829 (2 persons) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0nqvr4k.jpg.webp
  - conf=0.946 (2 persons) (2 faces) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2:nth-of-type(1) > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/ac99/live/a44fd170-e2ad-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.773 (1 person) via person — img `div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/1536/cpsprodpb/3148/live/d7883600-e2a7-11f1-99b6-a35a62fa4264.png.webp
  - conf=0.894 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/331b/live/2dc2ba90-e33e-11f1-9479-d17d3e98c29d.jpg.webp
  - conf=0.967 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/8241/live/e3e3a9c0-e2a7-11f1-8226-87dfa5049e9a.jpg.webp
  - conf=0.885 (3 persons) via person — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/ee74/live/b9842e30-e337-11f1-9479-d17d3e98c29d.png.webp
  - conf=0.779 (1 person) via person — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0pm6h4f.jpg.webp
  - conf=0.997 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/ca06/live/582be290-e33c-11f1-99a1-253766e7ad8b.jpg.webp
  - conf=0.749 (1 person) (1 face) via person+face — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0pm2ywn.jpg.webp
  - conf=0.805 (1 person) via person — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/raw/p0lr3t4c.png.webp
- Uncertain / unanalyzable (40):
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - …and 30 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://ping.chartbeat.net/ping?h=bbc.com&p=%2F&u=CyyImCCFvYSGBR8h_q&d=bbc.com&g=50924&g0=No%20Section&g1=NewsMediaOrgan (net::ERR_BLOCKED_BY_ORB)
  - networkidle not reached in 15s (page keeps loading)
  - request failed: https://ping.chartbeat.net/ping?h=bbc.com&p=%2F&u=CyyImCCFvYSGBR8h_q&d=bbc.com&g=50924&g0=No%20Section&g1=NewsMediaOrgan (net::ERR_BLOCKED_BY_ORB)
  - page JS error: invalid callback function
  - request failed: https://ping.chartbeat.net/ping?h=bbc.com&p=%2F&u=CyyImCCFvYSGBR8h_q&d=bbc.com&g=50924&g0=No%20Section&g1=NewsMediaOrgan (net::ERR_BLOCKED_BY_ORB)


---

## Previous report (kept verbatim)

# Visual Protection Engine — Scan Report (prototype v0.2.0)

## Phase 4 (v0.2.0) — person detector vs v0.1.0 baseline

Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO `person` class) + face-api.js tinyFaceDetector fallback, CPU backend, models bundled in `models/` (see `detector.js` and `models/LICENSES.md`). Policy standard-v1 throughout (threshold 0.70). A person OR face hit counts as human; per-element `detected_by` says which detector fired.

### Site comparison (valid runs only)

| Site | v0.1.0 baseline (face-only, 2026-11-18 ~10:14 UTC) | v0.2.0 (person+face) | Change |
|---|---|---|---|
| example.com | ALLOW, 0 people, 0 blocked, 0 review, 3,511 ms | ALLOW, 0 people, 0 blocked, 0 review, 3,623 ms | none (no images on the page) |
| en.wikipedia.org (Main Page) | REVIEW, 3 people, 3 blocked, 7 review, 39,087 ms | **no valid run — see egress block below** | — |
| www.bbc.com | REVIEW, 9 people, 9 blocked, 37 review, 120,050 ms | **no valid run — see egress block below** | — |
| commons.wikimedia.org (Featured pictures) | REVIEW, 2 people, 2 blocked, 201 review, 82,588 ms | REVIEW, **4 people, 4 blocked, 202 review, 77,807 ms** | +2 people found |

### What the person detector found on Commons that face-only missed

- **"The Terror of War" photo** — conf 0.736, **10 persons, 0 faces, via `person`** (children running; faces small/turned — face-api found nothing).
- **Gotland Grand National 2026 photo** — conf 0.858, **4 persons, 0 faces, via `person`** (cyclists, faces not visible).
- The two baseline finds were still found: Quero photo 0.87 (was 0.706 face-only, now `person+face`, 1 person + 1 face) and STS-107 crew 0.844 (`person+face`, 6 persons + 9 faces).
- Review count is essentially unchanged (202 vs 201): most REVIEWs are over-budget skipped images (24 skipped, same as baseline) and CORS-tainted thumbnails, not detection failures.

### Egress block: Wikipedia + BBC re-runs failed 3× each (not a detector result)

The v0.2.0 re-runs of Wikipedia and BBC could not produce a valid comparison — the sandbox egress path to their hosts is broken, and it stayed broken across ~1.5 hours and 3 attempts per site:

- **Wikipedia (3 attempts):** navigation fails in ~15 s with `net::ERR_TUNNEL_CONNECTION_FAILED`, 0 elements, verdict ERROR. Direct `curl` through the same relay: `CONNECT tunnel failed, response 504` after 15.0 s — the relay's own 15 s CONNECT timer firing because the upstream egress proxy never establishes the tunnel to `en.wikipedia.org`.
- **BBC (3 attempts):** the page itself loads (HTTP 200, 143–145 elements collected) but every image host fails — `ERR_TUNNEL_CONNECTION_FAILED` for `ichef.bbci.co.uk`, `static.bbci.co.uk`, `static.files.bbci.co.uk`, `cdn.tinypass.com`. Each image load in the detector page burns its 8 s timeout (17 load timeouts per run); the scan hits the 180 s hard cap with CPU only ~5.2 s — proof the time went to network waits, not compute. 0 people, 140 review, verdict ERROR. Direct `curl` to `ichef.bbci.co.uk` through the relay: same 504 after 15.0 s.
- **Not the scanner, not the detector:** the detector loaded fine in the failed BBC runs (`person_loaded=true, face_loaded=true`); `www.bbc.com` itself still returns 200 through the relay (0.8–1.0 s), `commons.wikimedia.org` returns 200 (0.44 s), `example.com` returns 200 (0.41 s) — only `en.wikipedia.org`, `ichef.bbci.co.uk` and the BBC static hosts fail. The same egress IP is also throttled by Wikimedia on other paths (HTTP 429 on `upload.wikimedia.org`/`Special:FilePath` during the test-set download — see `testset/TESTSET.md`).
- **Consequence:** the Wikipedia/BBC v0.2.0-vs-baseline comparison is **pending a healthy egress**, not a detector result. Do not quote 0 people for BBC/Wikipedia from the failed runs — those runs never got to detect. The raw failed runs are kept verbatim below (the three v0.2.0 sections), so the attempts are auditable.

### Labeled test set (16 real Commons photos)

Full detail in [`testset/TESTSET.md`](testset/TESTSET.md) and `testset/results.json`. Headline, small-sample: **precision 1.000, recall 0.455** on the `person` verdict (TP 5, FP 0, FN 6, TN 5); 3 more person images landed `uncertain` (covered, safe); **3 missed to ALLOW** (2 back views, 1 distant figure). Face-only on the same set would score recall 0.18 (TP 2). The person detector is a real improvement and is not solved: back views 1 of 3, distant figures score 0.61–0.66 (REVIEW) or below the 0.40 floor (missed).

### How to reproduce

```bash
cd ~/workspace/filter-platform/scanner
node test_person.js   # labeled test set
node scan.js          # 4 real sites (needs a healthy egress for Wikipedia/BBC image hosts)
```

---

# Visual Protection Engine — Scan Report (prototype v0.2.0)

Generated: 2026-11-18T11:08:07.929Z (UTC)
Policy: standard-v1 (block_images=true, cover_images=false, threshold 0.70)
Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO person class) + face-api.js tinyFaceDetector fallback, CPU backend, models bundled in scanner/models/ (see detector.js)
Sandbox: proxy http://127.0.0.1:18080 + TLS SPKI pin (egress CA only)

| Site | Verdict | HTTP | Scan ms | CPU s | Peak RSS MB | Elements | People | Blocked | Review | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| en.wikipedia.org | ERROR | ? | 15582 | 0.418 | 501.5 | 0 | 0 | 0 | 0 | 4 |
| www.bbc.com | ERROR | 200 | 180166 | 5.157 | 910.7 | 143 | 0 | 0 | 140 | 156 |

## https://en.wikipedia.org/wiki/Main_Page

- Result file: `results/en-wikipedia-org-wiki-Main-Page.json`, screenshot: `results/en-wikipedia-org-wiki-Main-Page.png`
- Final URL: https://en.wikipedia.org/wiki/Main_Page
- HTTP status: n/a, redirects: 0, navigation: n/a ms
- Scan time: 15582 ms, CPU: 0.418 s, peak RSS: 501.5 MB
- Detector: loaded=false (person_loaded=false, face_loaded=false); candidates checked: 0, skipped (over budget): 0
- Elements by type: {}
- Summary: {"total":0,"people":0,"covered":0,"blocked":0,"review":0}
- People detected: none
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://en.wikipedia.org/wiki/Main_Page (net::ERR_TUNNEL_CONNECTION_FAILED)
  - navigation failed: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://en.wikipedia.org/wiki/Main_Page
  - element collection failed: page.evaluate: Execution context was destroyed, most likely because of a navigation

## https://www.bbc.com

- Result file: `results/www-bbc-com.json`
- Final URL: https://www.bbc.com/
- HTTP status: 200, redirects: 0, navigation: n/a ms
- Scan time: 180166 ms, CPU: 5.157 s, peak RSS: 910.7 MB
- Detector: loaded=true (person_loaded=true, face_loaded=true); candidates checked: 40, skipped (over budget): 96
- Elements by type: {"img":143}
- Summary: {"total":143,"people":0,"covered":0,"blocked":0,"review":140}
- People detected: none
- Uncertain / unanalyzable (140):
  - img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load timeout
  - img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Target page, context or browser has been closed
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Target page, context or browser has been closed
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load failed / CORS
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load timeout
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW — page.evaluate: Error: load timeout
  - …and 130 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://static.bbci.co.uk/frameworks/requirejs/0.13.0/sharedmodules/require.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://cdn.tinypass.com/api/tinypass.min.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://emp.bbci.co.uk/emp/bump-4/bump-4.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0b-tgv1_m1uo9. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0d9awe5d081.2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0s_kjwmep8yf2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0-a6nanpwqpag. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/178~uy1pz6ka4. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Md.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Bd.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSerif_W_Md.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSerif_W_Rg.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Rg.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_ExBd.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/a56b/live/b9e12140-e2f5-11f1-910a-c953499d69d5.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/e20b/live/66ff6490-e323-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/ace/standard/480/cpsprodpb/e1f8/live/94b217a0-e334-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/640x360/p0pnfmks.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://www.bbc.co.uk/userinfo (net::ERR_TUNNEL_CONNECTION_FAILED)
  - navigation failed: page.goto: Timeout 30000ms exceeded.
  - request failed: https://ichef.bbci.co.uk/images/ic/640x360/p0pnfhcn.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pncp70.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbc.co.uk/images/ic/raw/p0pnd8bm.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/02w2j6a0szhem. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/01ahds4cdfgmx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/004vauwu48azs. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0u17oyz1d609w. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0ogvtm3jmac~r. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/05u0ya7obj7ro. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnjy15.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn78x6.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pj883s.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnfsr9.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 0 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9f4r.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pndv8c.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0k530rgixl5kt. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0zpz-874su9ks. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0jl4bpoiy-t_p. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0jcf7ay9pl-s0. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0gmos.wajd.qx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0fi49hn5~2abh. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0plf6yf.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pmxyfb.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9j3t.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0plmxf1.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 1 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbc.co.uk/images/ic/raw/p0pnd8bm.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 2 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0j72y80.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/1376xn/p0pkjx8q.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0na6onp8uomzi. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0pr885e78gdj8. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0~~24znpk8vc1. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0hx-hfexp7nnc. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/00su1kxuv.aa_. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/05el2iwpn3pyx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480xn/p0pkjx8n.png.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/640/cpsprodpb/b2fd/live/c9c932d0-e324-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/80ea/live/d55939e0-e31c-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/c96b/live/b14b3a60-d9c8-11f1-93e1-3b657b665bcf.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 3 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnkz0v.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 4 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/fb1d/live/c5d2fbf0-e330-11f1-9c56-6ffaf0e1e706.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/0369/live/387a8f10-e2ff-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/12w5u9fluro3i. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/00pv_7c.hjx18. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/06nzlhdny82mu. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0z3rjge5m4grx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/16m24-5g46kuv. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0c.fzizjof3_9. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 5 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/raw/p0nw7m52.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 6 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0.ws-k_jzc8i2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/03-zfz3518npb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0y-nyl-getpga. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/13ad5orspgznk. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0n-kjrsnwe2tb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0x01rgvk49mtx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0p80lkj.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0l685z5.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0nqvr4k.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 7 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/news/480/cpsprodpb/3148/live/d7883600-e2a7-11f1-99b6-a35a62fa4264.png.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 8 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0a--~b-snp6to. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/16qg8r~940rt.. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0iid2kl3pm46u. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0caemttv9w4.~. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0sm_sfi0c1mq-. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0a67d54dvd1y-. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 9 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9srh.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 10 (img div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/turbopack-0-j_ (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/02-eeonhl._fb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/13lckzgg918t5. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/07ngao.t8frq0. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0fmsfuctu-bad. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/07yl_.h914mqi. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 11 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load failed / CORS
  - detection element 12 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0ler5jidu_h8s. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0x4vi9uz_5-qd. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0l.ne36zacrke. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/15.__ak31mj1s. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0zmsh_4661wtq. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/17t.2dba68ndj. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 13 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnfhcn.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/turbopack-0da2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 14 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 15 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/news/480/cpsprodpb/b2fd/live/c9c932d0-e324-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 16 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 17 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - scan hard cap (180s) reached — aborting
  - detection element 18 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 19 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 20 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 21 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 22 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 23 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 24 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 25 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 26 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 27 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 28 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 29 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 30 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 31 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 32 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 33 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 34 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 35 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 36 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 37 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 38 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 39 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - screenshot failed: page.screenshot: Target page, context or browser has been closed
Call log:
  - taking page screensho


---

## Previous report (kept verbatim)

# Visual Protection Engine — Scan Report (prototype v0.2.0)

Generated: 2026-11-18T10:59:54.100Z (UTC)
Policy: standard-v1 (block_images=true, cover_images=false, threshold 0.70)
Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO person class) + face-api.js tinyFaceDetector fallback, CPU backend, models bundled in scanner/models/ (see detector.js)
Sandbox: proxy http://127.0.0.1:18080 + TLS SPKI pin (egress CA only)

| Site | Verdict | HTTP | Scan ms | CPU s | Peak RSS MB | Elements | People | Blocked | Review | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| www.bbc.com | ERROR | 200 | 180195 | 5.153 | 870.7 | 143 | 0 | 0 | 140 | 156 |
| en.wikipedia.org | ERROR | ? | 15659 | 0.286 | 516.4 | 0 | 0 | 0 | 0 | 4 |

## https://www.bbc.com

- Result file: `results/www-bbc-com.json`
- Final URL: https://www.bbc.com/
- HTTP status: 200, redirects: 0, navigation: n/a ms
- Scan time: 180195 ms, CPU: 5.153 s, peak RSS: 870.7 MB
- Detector: loaded=true (person_loaded=true, face_loaded=true); candidates checked: 40, skipped (over budget): 95
- Elements by type: {"img":143}
- Summary: {"total":143,"people":0,"covered":0,"blocked":0,"review":140}
- People detected: none
- Uncertain / unanalyzable (140):
  - img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load timeout
  - img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Target page, context or browser has been closed
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Target page, context or browser has been closed
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load failed / CORS
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load timeout
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW — page.evaluate: Error: load timeout
  - …and 130 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://cdn.tinypass.com/api/tinypass.min.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.bbci.co.uk/frameworks/requirejs/0.13.0/sharedmodules/require.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0b-tgv1_m1uo9. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0d9awe5d081.2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0s_kjwmep8yf2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0-a6nanpwqpag. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/178~uy1pz6ka4. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://emp.bbci.co.uk/emp/bump-4/bump-4.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Md.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Bd.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Rg.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSerif_W_Md.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSerif_W_Rg.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_ExBd.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/e20b/live/66ff6490-e323-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/ace/standard/480/cpsprodpb/e1f8/live/94b217a0-e334-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/a56b/live/b9e12140-e2f5-11f1-910a-c953499d69d5.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/640x360/p0pnfmks.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pncp70.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://www.bbc.co.uk/userinfo (net::ERR_TUNNEL_CONNECTION_FAILED)
  - navigation failed: page.goto: Timeout 30000ms exceeded.
  - request failed: https://ichef.bbci.co.uk/images/ic/640x360/p0pmyqpz.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbc.co.uk/images/ic/raw/p0pnd8bm.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/02w2j6a0szhem. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/01ahds4cdfgmx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/004vauwu48azs. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0u17oyz1d609w. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0ogvtm3jmac~r. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/05u0ya7obj7ro. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnjy15.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn78x6.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pj883s.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9f4r.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pndv8c.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 0 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0plf6yf.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0k530rgixl5kt. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0zpz-874su9ks. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0jl4bpoiy-t_p. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0jcf7ay9pl-s0. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0gmos.wajd.qx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0fi49hn5~2abh. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnfsr9.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pmxyfb.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9j3t.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0j72y80.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0plmxf1.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 1 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbc.co.uk/images/ic/raw/p0pnd8bm.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 2 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/images/ic/1376xn/p0pkjx8q.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0na6onp8uomzi. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0pr885e78gdj8. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0~~24znpk8vc1. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0hx-hfexp7nnc. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/00su1kxuv.aa_. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/05el2iwpn3pyx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480xn/p0pkjx8n.png.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/640/cpsprodpb/b2fd/live/c9c932d0-e324-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/80ea/live/d55939e0-e31c-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/c96b/live/b14b3a60-d9c8-11f1-93e1-3b657b665bcf.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/fb1d/live/c5d2fbf0-e330-11f1-9c56-6ffaf0e1e706.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 3 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnkz0v.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 4 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/0369/live/387a8f10-e2ff-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/12w5u9fluro3i. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/00pv_7c.hjx18. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/06nzlhdny82mu. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0z3rjge5m4grx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/16m24-5g46kuv. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0c.fzizjof3_9. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 5 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/raw/p0nw7m52.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 6 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0.ws-k_jzc8i2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/03-zfz3518npb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0y-nyl-getpga. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/13ad5orspgznk. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0n-kjrsnwe2tb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0x01rgvk49mtx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0p80lkj.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0l685z5.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0nqvr4k.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 7 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/news/480/cpsprodpb/3148/live/d7883600-e2a7-11f1-99b6-a35a62fa4264.png.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 8 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0a--~b-snp6to. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/16qg8r~940rt.. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0iid2kl3pm46u. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0caemttv9w4.~. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0sm_sfi0c1mq-. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0a67d54dvd1y-. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 9 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9srh.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 10 (img div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/turbopack-0-j_ (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/02-eeonhl._fb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/13lckzgg918t5. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/07ngao.t8frq0. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0fmsfuctu-bad. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/07yl_.h914mqi. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 11 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load failed / CORS
  - detection element 12 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0ler5jidu_h8s. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0x4vi9uz_5-qd. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0l.ne36zacrke. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/15.__ak31mj1s. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0zmsh_4661wtq. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/17t.2dba68ndj. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 13 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pmyqpz.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/turbopack-0da2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 14 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 15 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/news/480/cpsprodpb/b2fd/live/c9c932d0-e324-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 16 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 17 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - scan hard cap (180s) reached — aborting
  - detection element 18 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 19 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 20 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 21 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 22 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 23 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 24 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 25 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 26 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 27 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 28 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 29 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 30 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 31 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 32 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 33 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 34 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 35 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 36 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 37 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 38 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 39 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - screenshot failed: page.screenshot: Target page, context or browser has been closed

## https://en.wikipedia.org/wiki/Main_Page

- Result file: `results/en-wikipedia-org-wiki-Main-Page.json`, screenshot: `results/en-wikipedia-org-wiki-Main-Page.png`
- Final URL: https://en.wikipedia.org/wiki/Main_Page
- HTTP status: n/a, redirects: 0, navigation: n/a ms
- Scan time: 15659 ms, CPU: 0.286 s, peak RSS: 516.4 MB
- Detector: loaded=false (person_loaded=false, face_loaded=false); candidates checked: 0, skipped (over budget): 0
- Elements by type: {}
- Summary: {"total":0,"people":0,"covered":0,"blocked":0,"review":0}
- People detected: none
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://en.wikipedia.org/wiki/Main_Page (net::ERR_TUNNEL_CONNECTION_FAILED)
  - navigation failed: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://en.wikipedia.org/wiki/Main_Page
  - element collection failed: page.evaluate: Execution context was destroyed, most likely because of a navigation


---

## Previous report (kept verbatim)

# Visual Protection Engine — Scan Report (prototype v0.2.0)

Generated: 2026-11-18T10:55:35.779Z (UTC)
Policy: standard-v1 (block_images=true, cover_images=false, threshold 0.70)
Detector: MediaPipe ObjectDetector EfficientDet-Lite0 (COCO person class) + face-api.js tinyFaceDetector fallback, CPU backend, models bundled in scanner/models/ (see detector.js)
Sandbox: proxy http://127.0.0.1:18080 + TLS SPKI pin (egress CA only)

| Site | Verdict | HTTP | Scan ms | CPU s | Peak RSS MB | Elements | People | Blocked | Review | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| example.com | ALLOW | 200 | 3623 | 0.606 | 549.4 | 0 | 0 | 0 | 0 | 1 |
| en.wikipedia.org | ERROR | ? | 15305 | 0.19 | 534.1 | 0 | 0 | 0 | 0 | 4 |
| www.bbc.com | ERROR | 200 | 180151 | 5.213 | 811.5 | 145 | 0 | 0 | 142 | 157 |
| commons.wikimedia.org | REVIEW | 200 | 77807 | 63.4 | 1207.2 | 244 | 4 | 4 | 202 | 1 |

## https://example.com

- Result file: `results/example-com.json`, screenshot: `results/example-com.png`
- Final URL: https://example.com/
- HTTP status: 200, redirects: 0, navigation: 1265 ms
- Scan time: 3623 ms, CPU: 0.606 s, peak RSS: 549.4 MB
- Detector: loaded=false (person_loaded=false, face_loaded=false); candidates checked: 0, skipped (over budget): 0
- Elements by type: {}
- Summary: {"total":0,"people":0,"covered":0,"blocked":0,"review":0}
- People detected: none
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)

## https://en.wikipedia.org/wiki/Main_Page

- Result file: `results/en-wikipedia-org-wiki-Main-Page.json`, screenshot: `results/en-wikipedia-org-wiki-Main-Page.png`
- Final URL: https://en.wikipedia.org/wiki/Main_Page
- HTTP status: n/a, redirects: 0, navigation: n/a ms
- Scan time: 15305 ms, CPU: 0.19 s, peak RSS: 534.1 MB
- Detector: loaded=false (person_loaded=false, face_loaded=false); candidates checked: 0, skipped (over budget): 0
- Elements by type: {}
- Summary: {"total":0,"people":0,"covered":0,"blocked":0,"review":0}
- People detected: none
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://en.wikipedia.org/wiki/Main_Page (net::ERR_TUNNEL_CONNECTION_FAILED)
  - navigation failed: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://en.wikipedia.org/wiki/Main_Page
  - element collection failed: page.evaluate: Execution context was destroyed, most likely because of a navigation

## https://www.bbc.com

- Result file: `results/www-bbc-com.json`
- Final URL: https://www.bbc.com/
- HTTP status: 200, redirects: 0, navigation: n/a ms
- Scan time: 180151 ms, CPU: 5.213 s, peak RSS: 811.5 MB
- Detector: loaded=true (person_loaded=true, face_loaded=true); candidates checked: 40, skipped (over budget): 98
- Elements by type: {"img":145}
- Summary: {"total":145,"people":0,"covered":0,"blocked":0,"review":142}
- People detected: none
- Uncertain / unanalyzable (142):
  - img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load timeout
  - img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Target page, context or browser has been closed
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Target page, context or browser has been closed
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load failed / CORS
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)` → REVIEW — page.evaluate: Error: load timeout
  - img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)` → REVIEW — page.evaluate: Error: load timeout
  - …and 132 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://static.bbci.co.uk/frameworks/requirejs/0.13.0/sharedmodules/require.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://cdn.tinypass.com/api/tinypass.min.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://emp.bbci.co.uk/emp/bump-4/bump-4.js (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0b-tgv1_m1uo9. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0d9awe5d081.2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0-a6nanpwqpag. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0s_kjwmep8yf2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/178~uy1pz6ka4. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Md.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Bd.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_Rg.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/a56b/live/b9e12140-e2f5-11f1-910a-c953499d69d5.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSans_W_ExBd.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSerif_W_Md.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/fonts/reith/2.512/BBCReithSerif_W_Rg.woff2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/ace/standard/480/cpsprodpb/e1f8/live/94b217a0-e334-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/e20b/live/66ff6490-e323-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/640x360/p0pnfmks.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://www.bbc.co.uk/userinfo (net::ERR_TUNNEL_CONNECTION_FAILED)
  - navigation failed: page.goto: Timeout 30000ms exceeded.
  - request failed: https://ichef.bbci.co.uk/images/ic/640x360/p0pmyqpz.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pncp70.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbc.co.uk/images/ic/raw/p0pnd8bm.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/01ahds4cdfgmx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/02w2j6a0szhem. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0u17oyz1d609w. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/004vauwu48azs. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0ogvtm3jmac~r. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0k530rgixl5kt. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnjy15.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn78x6.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pj883s.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9f4r.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 0 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pnfsr9.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pndv8c.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/05u0ya7obj7ro. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0zpz-874su9ks. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0jl4bpoiy-t_p. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0gmos.wajd.qx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0fi49hn5~2abh. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0na6onp8uomzi. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0plf6yf.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pmxyfb.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9j3t.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0j72y80.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 1 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbc.co.uk/images/ic/raw/p0pnd8bm.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 2 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0plmxf1.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/1376xn/p0pkjx8q.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0pr885e78gdj8. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0~~24znpk8vc1. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0hx-hfexp7nnc. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/00su1kxuv.aa_. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/05el2iwpn3pyx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/12w5u9fluro3i. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/480xn/p0pkjx8n.png.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/640/cpsprodpb/b2fd/live/c9c932d0-e324-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/80ea/live/d55939e0-e31c-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/c96b/live/b14b3a60-d9c8-11f1-93e1-3b657b665bcf.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 3 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pcxdc3.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 4 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/63ff/live/dc5ef950-e2d1-11f1-99ed-7de3e5932968.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/fb1d/live/c5d2fbf0-e330-11f1-9c56-6ffaf0e1e706.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/00pv_7c.hjx18. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/06nzlhdny82mu. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0z3rjge5m4grx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/16m24-5g46kuv. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0c.fzizjof3_9. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0.ws-k_jzc8i2. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/news/320/cpsprodpb/0369/live/387a8f10-e2ff-11f1-a094-5fdc692f3e33.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 5 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.Windsor-styles__MediaStyled-sc-bfc65b29-1 > div > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/raw/p0nw7m52.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 6 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/03-zfz3518npb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0y-nyl-getpga. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/13ad5orspgznk. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0n-kjrsnwe2tb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0x01rgvk49mtx. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0a--~b-snp6to. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0p80lkj.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0l685z5.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://ichef.bbci.co.uk/images/ic/320x180/p0nqvr4k.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 7 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/news/480/cpsprodpb/3148/live/d7883600-e2a7-11f1-99b6-a35a62fa4264.png.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 8 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/16qg8r~940rt.. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0iid2kl3pm46u. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0caemttv9w4.~. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0sm_sfi0c1mq-. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0a67d54dvd1y-. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/turbopack-0-j_ (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 9 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pn9srh.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 10 (img div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/02-eeonhl._fb. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/13lckzgg918t5. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/07ngao.t8frq0. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0fmsfuctu-bad. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/07yl_.h914mqi. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0ler5jidu_h8s. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 11 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load failed / CORS
  - detection element 12 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0x4vi9uz_5-qd. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0l.ne36zacrke. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/15.__ak31mj1s. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0zmsh_4661wtq. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/17t.2dba68ndj. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/turbopack-0da2 (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 13 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/images/ic/480x270/p0pmyqpz.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/StNTRXtrhR7HyrX7YuOGH (net::ERR_TUNNEL_CONNECTION_FAILED)
  - request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/_next/static/chunks/0jcf7ay9pl-s0. (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 14 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 15 (img div.GridItem-styles__GridItemStyled-sc-6cc20e4a-0:nth-of-type(1) > div.London-styles__LondonMediaStyled-sc-269f9f6d-3 > div > a.London-styles__LondonMediaAnchorStyled-sc-269f9f6d-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - detector page request failed: https://ichef.bbci.co.uk/news/480/cpsprodpb/b2fd/live/c9c932d0-e324-11f1-99a1-253766e7ad8b.jpg.webp (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 16 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Error: load timeout
  - detector page request failed: https://static.files.bbci.co.uk/bbcdotcom/web/20261110-133831-0053d0afea-web-3.28.0-4/grey-placeholder.png (net::ERR_TUNNEL_CONNECTION_FAILED)
  - detection element 17 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Error: load timeout
  - scan hard cap (180s) reached — aborting
  - detection element 18 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 19 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 20 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 21 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 22 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 23 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 24 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 25 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 26 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 27 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 28 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 29 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 30 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 31 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 32 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 33 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 34 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 35 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 36 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 37 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - detection element 38 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(1)) — page.evaluate: Target page, context or browser has been closed
  - detection element 39 (img a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0:nth-of-type(2)) — page.evaluate: Target page, context or browser has been closed
  - screenshot failed: page.screenshot: Target page, context or browser has been closed
Call log:
  - taking page screensho

## https://commons.wikimedia.org/wiki/Commons:Featured_pictures

- Result file: `results/commons-wikimedia-org-wiki-Commons-Featured-pictures.json`, screenshot: `results/commons-wikimedia-org-wiki-Commons-Featured-pictures.png`
- Final URL: https://commons.wikimedia.org/wiki/Commons:Featured_pictures
- HTTP status: 200, redirects: 0, navigation: 5296 ms
- Scan time: 77807 ms, CPU: 63.4 s, peak RSS: 1207.2 MB
- Detector: loaded=true (person_loaded=true, face_loaded=true); candidates checked: 40, skipped (over budget): 24
- Elements by type: {"img":240,"background":4}
- Summary: {"total":244,"people":4,"covered":0,"blocked":4,"review":202}
- People detected:
  - conf=0.736 (10 persons) via person — img `ul.gallery:nth-of-type(5) > li.gallerybox:nth-of-type(1) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/6/61/The_Terror_of_War_%28hi-res%29.jpg/330px-The_Terror_of_War_%28h
  - conf=0.87 (1 person) (1 face) via person+face — img `ul.gallery:nth-of-type(10) > li.gallerybox:nth-of-type(1) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8c/2005_Quero_estar_enfadado_pero_c%C3%A1esme_moi_ben_e_es_gracios
  - conf=0.844 (6 persons) (9 faces) via person+face — img `ul.gallery:nth-of-type(13) > li.gallerybox:nth-of-type(1) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5d/STS-107_crew_in_orbit.jpg/250px-STS-107_crew_in_orbit.jpg?utm_s
  - conf=0.858 (4 persons) via person — img `ul.gallery:nth-of-type(14) > li.gallerybox:nth-of-type(1) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/6/60/Gotland_Grand_National_2026_56.jpg/250px-Gotland_Grand_National
- Uncertain / unanalyzable (202):
  - img `body.mediawiki > div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > img.mw-logo-icon` → REVIEW
  - img `div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > span.mw-logo-container > img.mw-logo-wordmark` → REVIEW
  - img `tbody > tr:nth-of-type(1) > td.left-box:nth-of-type(1) > figure.mw-halign-right > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `tr:nth-of-type(1) > td.left-box:nth-of-type(1) > p:nth-of-type(7) > span > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `ul.gallery:nth-of-type(1) > li.gallerybox:nth-of-type(3) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(1) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(3) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(5) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(7) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(9) > a.mw-file-description > img.mw-file-element` → REVIEW
  - …and 192 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)


---

## Previous report (kept verbatim)

# Visual Protection Engine — Scan Report (prototype v0.1.0)

Generated: 2026-11-18T10:14:41.532Z (UTC)
Policy: standard-v1 (block_images=true, cover_images=false, threshold 0.70)
Detector: face-api.js tinyFaceDetector, CPU backend, models bundled in scanner/models/
Sandbox: proxy http://127.0.0.1:18080 + TLS SPKI pin (egress CA only)

| Site | Verdict | HTTP | Scan ms | CPU s | Peak RSS MB | Elements | People | Blocked | Review | Failures |
|---|---|---|---|---|---|---|---|---|---|---|
| example.com | ALLOW | 200 | 3511 | 0.656 | 543.9 | 0 | 0 | 0 | 0 | 1 |
| en.wikipedia.org | REVIEW | 200 | 39087 | 39.929 | 2591.7 | 24 | 3 | 3 | 7 | 1 |
| www.bbc.com | REVIEW | 200 | 120050 | 88.409 | 2722.5 | 74 | 9 | 9 | 37 | 5 |
| commons.wikimedia.org | REVIEW | 200 | 82588 | 84.871 | 2626.2 | 244 | 2 | 2 | 201 | 1 |

## https://example.com

- Result file: `results/example-com.json`, screenshot: `results/example-com.png`
- Final URL: https://example.com/
- HTTP status: 200, redirects: 0, navigation: 1139 ms
- Scan time: 3511 ms, CPU: 0.656 s, peak RSS: 543.9 MB
- Detector: loaded=false; candidates checked: 0, skipped (over budget): 0
- Elements by type: {}
- Summary: {"total":0,"people":0,"covered":0,"blocked":0,"review":0}
- People detected: none
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)

## https://en.wikipedia.org/wiki/Main_Page

- Result file: `results/en-wikipedia-org-wiki-Main-Page.json`, screenshot: `results/en-wikipedia-org-wiki-Main-Page.png`
- Final URL: https://en.wikipedia.org/wiki/Main_Page
- HTTP status: 200, redirects: 0, navigation: 3225 ms
- Scan time: 39087 ms, CPU: 39.929 s, peak RSS: 2591.7 MB
- Detector: loaded=true; candidates checked: 17, skipped (over budget): 0
- Elements by type: {"img":24}
- Summary: {"total":24,"people":3,"covered":0,"blocked":3,"review":7}
- People detected:
  - conf=0.957 (1 face) — img `div#mp-dyk > div.dyk-img:nth-of-type(1) > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Bunlet_Harcourt_1937_3.jpg/120px-Bunlet_Harcourt_1937_3.jpg?utm
  - conf=0.944 (1 face) — img `div#mp-itn > div.itn-img:nth-of-type(1) > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c8/Jensen_Huang_Stanford_2026-04-30_010_%28cropped%29.jpg/250px-Je
  - conf=0.986 (1 face) — img `div#mp-otd-img > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/9/96/1956_Press_Photo_Communist_Party_Secretary_Nikita_Khrushchev_in
- Uncertain / unanalyzable (7):
  - img `div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > span.mw-logo-container > img.mw-logo-wordmark:nth-of-type(1)` → REVIEW
  - img `div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > span.mw-logo-container > img.mw-logo-tagline:nth-of-type(2)` → REVIEW
  - img `div#mp-tfa-img > div.thumbinner > span > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `ul#sister-projects-list > li:nth-of-type(1) > div:nth-of-type(1) > span.noviewer > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `ul#sister-projects-list > li:nth-of-type(5) > div:nth-of-type(1) > span.noviewer > span > img.mw-file-element` → REVIEW
  - img `li#footer-copyrightico > a.cdx-button > picture > img` → REVIEW
  - img `li#footer-poweredbyico > a.cdx-button > picture > img` → REVIEW
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)

## https://www.bbc.com

- Result file: `results/www-bbc-com.json`, screenshot: `results/www-bbc-com.png`
- Final URL: https://edigitalsurvey.com/l.php?id=INS-vt29-666188954&v=7291&x=1280&y=900&d=24&c=null&ck=1&p=%2F&fu=https%3A%2F%2Fwww.bbc.com%2F&xdm=edr&xdm_o=https%3A%2F%2Fwww.bbc.com&xdm_c=edr0
- HTTP status: 200, redirects: 0, navigation: 21435 ms
- Scan time: 120050 ms, CPU: 88.409 s, peak RSS: 2722.5 MB
- Detector: loaded=true; candidates checked: 40, skipped (over budget): 33
- Elements by type: {"img":74}
- Summary: {"total":74,"people":9,"covered":0,"blocked":9,"review":37}
- People detected:
  - conf=0.814 (2 faces) — img `div.Westminster-styles__CardWrapperStyled-sc-348bb4b5-4 > div.Westminster-styles__CardStyled-sc-348bb4b5-2 > div.Westminster-styles__MediaWrapperStyled-sc-348bb4b5-5:nth-of-type(1) > div.Westminster-styles__MediaStyled-sc-348bb4b5-1 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/ace/standard/480/cpsprodpb/e1f8/live/94b217a0-e334-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.93 (3 faces) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/e20b/live/66ff6490-e323-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.955 (1 face) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0p80lkj.jpg.webp
  - conf=0.865 (2 faces) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2:nth-of-type(1) > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/ac99/live/a44fd170-e2ad-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.739 (1 face) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Edinburgh-styles__CardStyled-sc-73f6adba-0 > div.Edinburgh-styles__MediaWrapperStyled-sc-73f6adba-1:nth-of-type(1) > div.Edinburgh-styles__MediaStyled-sc-73f6adba-2:nth-of-type(1) > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/5a20/live/d8ac30b0-e2b4-11f1-a094-5fdc692f3e33.jpg.webp
  - conf=0.967 (1 face) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/8241/live/e3e3a9c0-e2a7-11f1-8226-87dfa5049e9a.jpg.webp
  - conf=0.711 (1 face) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/news/320/cpsprodpb/63ff/live/dc5ef950-e2d1-11f1-99ed-7de3e5932968.jpg.webp
  - conf=0.786 (1 face) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0pmx46j.jpg.webp
  - conf=0.749 (1 face) — img `a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Dundee-styles__CardStyled-sc-50abbc98-1 > div.Dundee-styles__ImageWrapperStyled-sc-50abbc98-3:nth-of-type(1) > div.Dundee-styles__CardMediaStyled-sc-50abbc98-4 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1 > img.Image-styles__ImageStyled-sc-8c99a12b-0` → BLOCK — https://ichef.bbci.co.uk/images/ic/320x180/p0pm2ywn.jpg.webp
- Uncertain / unanalyzable (37):
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - img `div.Ipswich-styles__IpswichCardStyled-sc-9e107448-4 > div:nth-of-type(1) > a.Anchor-styles__AnchorStyled-sc-651d33db-0 > div.Ipswich-styles__ImageContainerStyled-sc-9e107448-0 > div.Image-styles__ImageCardStyled-sc-8c99a12b-1:nth-of-type(1) > img.Image-styles__ImageStyled-sc-8c99a12b-0` → REVIEW
  - …and 27 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
  - request failed: https://ping.chartbeat.net/ping?h=bbc.com&p=%2F&u=zg6wNC8IiFFCHuz5g&d=bbc.com&g=50924&g0=No%20Section&g1=NewsMediaOrgani (net::ERR_BLOCKED_BY_ORB)
  - networkidle not reached in 15s (page keeps loading)
  - request failed: https://ping.chartbeat.net/ping?h=bbc.com&p=%2F&u=zg6wNC8IiFFCHuz5g&d=bbc.com&g=50924&g0=No%20Section&g1=NewsMediaOrgani (net::ERR_BLOCKED_BY_ORB)
  - request failed: https://ping.chartbeat.net/ping?h=bbc.com&p=%2F&u=zg6wNC8IiFFCHuz5g&d=bbc.com&g=50924&g0=No%20Section&g1=NewsMediaOrgani (net::ERR_BLOCKED_BY_ORB)

## https://commons.wikimedia.org/wiki/Commons:Featured_pictures

- Result file: `results/commons-wikimedia-org-wiki-Commons-Featured-pictures.json`, screenshot: `results/commons-wikimedia-org-wiki-Commons-Featured-pictures.png`
- Final URL: https://commons.wikimedia.org/wiki/Commons:Featured_pictures
- HTTP status: 200, redirects: 0, navigation: 7487 ms
- Scan time: 82588 ms, CPU: 84.871 s, peak RSS: 2626.2 MB
- Detector: loaded=true; candidates checked: 40, skipped (over budget): 24
- Elements by type: {"img":240,"background":4}
- Summary: {"total":244,"people":2,"covered":0,"blocked":2,"review":201}
- People detected:
  - conf=0.706 (1 face) — img `ul.gallery:nth-of-type(10) > li.gallerybox:nth-of-type(1) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8c/2005_Quero_estar_enfadado_pero_c%C3%A1esme_moi_ben_e_es_gracios
  - conf=0.844 (9 faces) — img `ul.gallery:nth-of-type(13) > li.gallerybox:nth-of-type(1) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → BLOCK — https://thumb.wikimedia.org/wikipedia/commons/thumb/5/5d/STS-107_crew_in_orbit.jpg/250px-STS-107_crew_in_orbit.jpg?utm_s
- Uncertain / unanalyzable (201):
  - img `body.mediawiki > div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > img.mw-logo-icon` → REVIEW
  - img `div.vector-header-container:nth-of-type(2) > header.vector-header > div.vector-header-start:nth-of-type(1) > a.mw-logo > span.mw-logo-container > img.mw-logo-wordmark` → REVIEW
  - img `tbody > tr:nth-of-type(1) > td.left-box:nth-of-type(1) > figure.mw-halign-right > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `tr:nth-of-type(1) > td.left-box:nth-of-type(1) > p:nth-of-type(7) > span > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `ul.gallery:nth-of-type(1) > li.gallerybox:nth-of-type(3) > div.thumb:nth-of-type(1) > span > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(1) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(3) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(5) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(7) > a.mw-file-description > img.mw-file-element` → REVIEW
  - img `div:nth-of-type(3) > dl > dd > span.skin-invert:nth-of-type(9) > a.mw-file-description > img.mw-file-element` → REVIEW
  - …and 191 more (see JSON)
- Failures / notes:
  - note: running as root, Chromium launched with --no-sandbox (sandbox would be on for a non-root user)
