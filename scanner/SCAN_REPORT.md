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
