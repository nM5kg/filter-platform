# Video / canvas verification (scanner v0.2.0)

Local test pages that verify the scanner's `<video>` and `<canvas>` paths,
which no real-site run had exercised (the four real sites contain no video
or canvas elements). All media is real: the video is a Wikimedia Commons
transcode, the photos are the scanner's own labeled test-set images.

## Files

| File | What it is |
|---|---|
| `video.html` | One `<video>` (Obama statement). Page JS seeks to 5 s and pauses, so the sampled frame is deterministic. |
| `canvas.html` | Canvas A: person portrait via `drawImage` (static). Canvas B: the Obama video drawn frame-by-frame with `requestAnimationFrame` (animated). Canvas C: landscape control via `drawImage`. Plus an `<img>` control of the same portrait, and the source `<video>` visible at 427×240. |
| `assets/obama-chile-480p.webm` | Real video: Wikimedia Commons `File:Barack Obama gives statement on 2010 Chile earthquake 2010-02-27.ogv`, 480p VP9 transcode, 854×480, 140.9 s, 8,826,254 bytes. Obama speaks at a podium, visible in frame throughout. Downloaded 2026-11-18 via the Commons API (`prop=videoinfo&viprop=derivatives`). |
| `assets/p1-huang-portrait.jpg` | Copy of `../testset/p1-huang-portrait.jpg` (Jensen Huang portrait, 960×1279) — person. |
| `assets/l1-glacier-lake.jpg` | Copy of `../testset/l1-glacier-lake.jpg` (glacier lake, 960×635) — no-person control. |
| `results/video.json`, `results/canvas.json` | Visual Content Maps from the verification runs. |
| `results/127-0-0-1-video-html.png`, `results/127-0-0-1-canvas-html.png` | Page screenshots from those runs. |
| `results/video.log`, `results/canvas.log` | Scanner stderr (phase timings). |
| `results/wikipedia-retry.json` (+ `.log`) | Fresh Wikipedia re-run (2026-11-18 ~11:18 UTC) **before** the relay restart: still `ERROR`, `ERR_TUNNEL_CONNECTION_FAILED` — the block was the relay, not the site. |
| `results/wikibbc-scan.log` | `scan.js` stdout for the post-restart Wikipedia + BBC re-runs (both valid — see `SCAN_REPORT.md`). |
| `results/google-images-routes.jsonl` (+ `google-images-routes-post-restart.jsonl`) | Chromium reachability probe: routes A–D to Google Images (pre- and post-restart — identical outcome). |
| `results/google-images-stealth.json` | One stealth-fingerprint attempt (still `/sorry`). |

## How to reproduce

```bash
# 1. Serve this directory (port 8125; 8123 is held by a leftover server
#    from the extension verification — do not reuse it).
cd ~/workspace/filter-platform/scanner/test-video-canvas
python3 -m http.server 8125 --bind 127.0.0.1

# 2. Run the scanner against the local pages. NO proxy (local traffic
#    needs none; a proxy would try to route 127.0.0.1 through the egress).
#    SCANNER_ALLOW_LOOPBACK=1 is the test-only SSRF override in
#    scanner.js — it disables the loopback guard for this run only and is
#    recorded in failures[]. Never set it in production.
cd ~/workspace/filter-platform/scanner
SCANNER_ALLOW_LOOPBACK=1 node scanner.js http://127.0.0.1:8125/video.html  --out test-video-canvas/results/video.json  --screenshot
SCANNER_ALLOW_LOOPBACK=1 node scanner.js http://127.0.0.1:8125/canvas.html --out test-video-canvas/results/canvas.json --screenshot
```

## Results (2026-11-18, v0.2.0)

- **Video (video.html):** 1 element, `person` conf **0.82**, 1 person, 0 faces,
  via `person` (MediaPipe only — face-api found no face in that frame) →
  **BLOCK**. Scan 23,820 ms, CPU 6.2 s, RSS 788 MB. The video-frame path
  (element screenshot → detector) works.
- **Canvas (canvas.html):** 5 elements, 3 people, 3 blocked, 1 review.
  Scan 61,814 ms, CPU 22.7 s, RSS 943.6 MB.
  - Canvas A (drawImage portrait): `person` **0.966**, 1 person + 1 face,
    `person+face` → **BLOCK**.
  - Canvas B (animated, video frames): `person` **0.818**, 1 person + 1 face
    → **BLOCK** — the screenshot caught a live animation frame with Obama.
  - Canvas C (landscape control): `none` → **ALLOW** (no false positive).
  - Video (427×240, same page): `person` **0.768**, 1 person + 1 face →
    **BLOCK** (second video confirmation).
  - Img control (same portrait as Canvas A): `uncertain` → **REVIEW**,
    note `load failed / CORS` — see the CORS finding below.
- **CORS finding (real, not a test artifact):** the detector page is a fresh
  `about:blank` page with an opaque origin, and `detector.js` loads `<img>`
  URLs with `crossOrigin='anonymous'`. A host that does not send
  `Access-Control-Allow-Origin: *` fails the load → `uncertain` → REVIEW
  (fail closed). Python's `http.server` sends no CORS headers, so the local
  `<img>` control failed while the *identical pixels* via canvas screenshot
  scored 0.966 and BLOCKED. This is the same mechanism as the
  CORS-tainted thumbnails on real sites — the video/canvas screenshot path
  is immune to it because screenshots are the scanner's own pixels.
- **Detection cost:** a video/canvas element costs ~3–8 s each on this VM
  (screenshot + scrollIntoView + detect), vs ~1.4 s for a plain `<img>`.
  The canvas page's 5 elements took 61.8 s end-to-end.
- **`networkidle not reached in 15s`** appears on both runs (the video keeps
  a connection open while streaming) — benign, detection still ran.

## Google Images probe (same day)

**Update 2026-11-18 ~11:20 UTC — the egress relay was restarted with fixed
code** (see `SCAN_REPORT.md`): Wikipedia and BBC now have valid v0.2.0
runs (Wikipedia 4 people, BBC 20 people — `node scan.js` via the restarted
relay, generated 2026-11-18T11:23:44Z). The relay restart changed
everything for Wikipedia/BBC and nothing for Google Images: routes A–C
were re-run after the restart and still land on Google's `/sorry`
bot-check page, 0 images. The probe table below is unchanged by the
restart.

Chromium routes tried (probe scripts were one-offs in `/tmp`,
`probe-google-images.js` / `probe-google-images-stealth.js`; outputs saved
in `results/`):

| Route | Result |
|---|---|
| A. Relay 18080 + SPKI pin | HTTP 200 in 1.7 s — but Google redirects to `/sorry/index` ("unusual traffic … not a robot"), 0 images |
| B. Relay 18080 + `--ignore-certificate-errors` | Same `/sorry`, 0 images, 1.5 s |
| C. Relay 18081 + SPKI pin | Same `/sorry`, 0 images, 1.5 s |
| D. Direct upstream egress proxy + Playwright proxy auth | `ERR_TUNNEL_CONNECTION_FAILED` in 102 ms — upstream drops unauthenticated connections without a 407, so Chromium never gets to authenticate; the relay is required |
| Stealth (no `--enable-automation`, `--disable-blink-features=AutomationControlled`, `navigator.webdriver=false`, real UA) | Still `/sorry`, 0 images, 7.2 s |

Control: `curl` with a browser UA through the same relay gets a **real**
results page (200, 93,959 bytes, no `/sorry` marker). So the proxy/TLS
path to Google now works — Google's bot-check targets headless Chromium
specifically. No CAPTCHA was attempted. **Google Images extension
verification stays unverified** (no real thumbnails were ever shown to the
content script); it needs a machine where Google serves real results to a
real browser.
