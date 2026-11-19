/* Filter Platform — ONLINE REVIEW ENGINE (window.FpReview)
 *
 * On-demand client-side second opinion: RF-DETR Nano (Apache 2.0, Roboflow)
 * via onnxruntime-web 1.22.0 (npm, MIT), WASM CPU backend. No server, no
 * account, no per-image cost — the model file is fetched from the same
 * Pages site, chunked, and cached in IndexedDB.
 *
 * Model: RF-DETR Nano, ONNX opset 17, input "input" [1,3,384,384] float32,
 * outputs "dets" [1,300,4] and "labels" [1,300,91] (raw logits).
 * sha256 of the reassembled model:
 *   26728b72ccbb264678566993bc63007d48622490d547aff950814c9f9bee0851
 * (116,607,449 bytes, split into ~14 MiB chunks under models-rfdetr/,
 *  described by models-rfdetr/manifest.json).
 *
 * onnxruntime-web 1.22.0 (npm) vendored under vendor-ort/: ort.min.js
 * plus ort-wasm-simd-threaded.jsep.mjs/.wasm — the 1.22 wasm-backend
 * loader ALWAYS imports the ".jsep" build (verified: with only the
 * plain threaded files present, session creation fails fetching the
 * jsep .mjs). JSEP/WebGPU itself only activates for a 'webgpu'
 * execution provider, which this file never requests; inference here
 * is plain WASM CPU. The jsep .wasm is 21,872,216 bytes (< 25 MB cap).
 * The plain ort-wasm-simd-threaded.mjs/.wasm are vendored alongside
 * as a fallback but are not loaded by ort.min.js 1.22.0.
 *
 * Preprocessing / decode replicate the benchmark EXACTLY
 * (scanner/models/rf-detr/benchmark.py, rfdetr 1.12.1 runtime helpers,
 *  and android/.../RfDetrOrtBackend.kt):
 *   - stretch the image to 384x384 (aspect NOT preserved), bilinear
 *     half-pixel centres, antialias off, ImageNet normalise
 *     mean [0.485,0.456,0.406] std [0.229,0.224,0.225], NCHW float32.
 *   - decode: per-class SIGMOID on "labels" logits (NOT softmax), logits
 *     clipped to [-88, 88] first; person = class slot 1.
 *   - box format (VERIFIED empirically, not assumed): "dets" is
 *     cxcywh NORMALISED. Proof: on p1-huang-portrait the top person
 *     query's raw dets are [0.500, 0.510, 0.998, 0.965] — centre
 *     (0.50, 0.51), width ~1.0, height ~0.97 — which decodes to
 *     xyxy (0.001, 0.027, 0.999, 0.992), area 0.963, i.e. the whole
 *     full-frame portrait. Interpreted as xyxy it would be nonsense.
 *     Conversion: x = cx - w/2, y = cy - h/2, then clip xyxy to [0,1].
 *
 * RESIZE APPROXIMATION (honest limit): the benchmark resizes with
 * torchvision / numpy half-pixel bilinear. Here the resize is
 * canvas drawImage (browser bilinear). The two differ slightly, so
 * borderline scores may differ by a hair from the benchmark. The
 * [0.30, 0.50) 'uncertain' band absorbs that: anything near a
 * boundary is 'uncertain', never a confident wrong call.
 *
 * DECISION BANDS (FIXED — do not change without a product decision):
 *   best person score >= 0.50  -> person confirmed:
 *       humanImageMode === 'block' -> 'block'
 *       else (paint mode): largest single person box area > 0.60 of the
 *         image OR sum of person-box areas > 0.60 -> 'block'
 *         (a person filling most of the frame cannot be painted over
 *         usefully — the whole picture IS the person);
 *         otherwise -> 'allow_painted' (paint over the person boxes).
 *   best in [0.30, 0.50)        -> 'uncertain' (ask / keep covered).
 *   best < 0.30                 -> 'allow' (no person found).
 * Boxes are ALL person boxes with score >= 0.30, as {x,y,w,h,score}
 * fractions 0..1 of the image, origin top-left.
 *
 * Loading: ensure() lazy-loads ort + model ONLY on first call. The
 * assembled model bytes are cached in IndexedDB keyed by the model
 * sha256, so later loads skip the 116 MB download. If IndexedDB
 * storage fails (quota), the session still works in-memory-only for
 * this page load and the failure is reported honestly in the
 * ensure() result (cacheStored:false, cacheNote set) — never silent.
 * A failed load rejects with a clear Error; nothing is swallowed.
 *
 * Plain classic script, no modules, no bundler. Exposes window.FpReview:
 *   ensure(progressCb) -> Promise<{ready, fromCache, loadMs, modelBytes,
 *                                  cacheStored, cacheNote}>
 *   review(source, humanImageMode) -> Promise<{decision, boxes, best,
 *                                  model, inferMs, contentHash, ...}>
 *   isReady() -> boolean
 * progressCb(phase, loadedBytes, totalBytes), phase in
 *   'ort' | 'model' | 'ready' | 'cached'.
 */
(function (global) {
  'use strict';

  var MODEL_SHA256 = '26728b72ccbb264678566993bc63007d48622490d547aff950814c9f9bee0851';
  var MODEL_BYTES = 116607449;
  var INPUT_SIZE = 384;
  var NUM_QUERIES = 300;
  var NUM_CLASSES = 91;
  var PERSON_SLOT = 1;
  var SCORE_FLOOR = 0.30;   // boxes are reported at >= 0.30; below is 'allow'
  var CONFIRM = 0.50;       // >= 0.50: person confirmed
  var AREA_BLOCK = 0.60;    // person area fraction above which paint -> block
  var MEAN = [0.485, 0.456, 0.406];
  var STD = [0.229, 0.224, 0.225];
  var DB_NAME = 'fp-review';
  var DB_STORE = 'models';

  // Base URL of this script's directory, captured at load time (the
  // <script> tag is still document.currentScript while this runs).
  var BASE = './';
  try {
    var _cs = document.currentScript;
    if (_cs && _cs.src) BASE = _cs.src.slice(0, _cs.src.lastIndexOf('/') + 1);
  } catch (e) { /* keep './' */ }

  var _session = null;        // ort.InferenceSession once created
  var _ensurePromise = null;  // in-flight ensure() (dedupes concurrent calls)
  var _ready = false;
  var _fromCache = false;
  var _cacheStored = false;
  var _cacheNote = null;
  var _reviewQueue = Promise.resolve(); // serialise reviews on one session

  function _progress(cb, phase, loaded, total) {
    if (typeof cb === 'function') {
      try { cb(phase, loaded || 0, total || 0); } catch (e) { /* caller error: ignore */ }
    }
  }

  function _hex(buf) {
    var bytes = new Uint8Array(buf);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return out;
  }

  function _sha256Hex(data) {
    // data: ArrayBuffer / TypedArray / DataView
    return global.crypto.subtle.digest('SHA-256', data).then(_hex);
  }

  function _loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        reject(new Error('FpReview: failed to load script ' + src));
      };
      document.head.appendChild(s);
    });
  }

  // ---- IndexedDB cache (model bytes keyed by sha256) -------------------
  function _idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in global)) {
        reject(new Error('IndexedDB unavailable in this browser'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () {
        reject(new Error('IndexedDB open failed: ' + (req.error && req.error.message)));
      };
      req.onblocked = function () {
        reject(new Error('IndexedDB open blocked (another tab holds it)'));
      };
    });
  }

  function _idbGet(db, key) {
    return new Promise(function (resolve, reject) {
      var req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () {
        reject(new Error('IndexedDB read failed: ' + (req.error && req.error.message)));
      };
    });
  }

  function _idbPut(db, key, value) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(value, key);
      tx.onsuccess = function () { resolve(); };
      tx.onerror = function () {
        reject(new Error('IndexedDB write failed: ' + (tx.error && tx.error.message)));
      };
    });
  }

  // ---- Model fetch (chunked, parallel, verified) -----------------------
  function _fetchModel(progressCb) {
    return fetch(BASE + 'models-rfdetr/manifest.json', { cache: 'default' })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('FpReview: manifest fetch failed, HTTP ' + resp.status);
        }
        return resp.json();
      })
      .then(function (manifest) {
        if (manifest.sha256 !== MODEL_SHA256) {
          throw new Error('FpReview: manifest sha256 mismatch (expected ' +
            MODEL_SHA256 + ', got ' + manifest.sha256 + ')');
        }
        if (manifest.totalBytes !== MODEL_BYTES) {
          throw new Error('FpReview: manifest totalBytes mismatch (expected ' +
            MODEL_BYTES + ', got ' + manifest.totalBytes + ')');
        }
        var chunks = manifest.chunks;
        if (!chunks || !chunks.length) {
          throw new Error('FpReview: manifest lists no chunks');
        }
        var total = manifest.totalBytes;
        var parts = new Array(chunks.length);
        var loaded = 0;
        var CONCURRENCY = 4;
        var next = 0;
        function worker() {
          if (next >= chunks.length) return Promise.resolve();
          var idx = next++;
          var c = chunks[idx];
          return fetch(BASE + 'models-rfdetr/' + c.file, { cache: 'default' })
            .then(function (resp) {
              if (!resp.ok) {
                throw new Error('FpReview: chunk fetch failed: ' + c.file +
                  ' (HTTP ' + resp.status + ')');
              }
              return resp.arrayBuffer();
            })
            .then(function (buf) {
              if (buf.byteLength !== c.bytes) {
                throw new Error('FpReview: chunk size mismatch: ' + c.file +
                  ' (expected ' + c.bytes + ', got ' + buf.byteLength + ')');
              }
              return _sha256Hex(buf).then(function (h) {
                if (h !== c.sha256) {
                  throw new Error('FpReview: chunk sha256 mismatch: ' + c.file);
                }
                parts[idx] = new Uint8Array(buf);
                loaded += buf.byteLength;
                _progress(progressCb, 'model', loaded, total);
              });
            })
            .then(worker);
        }
        var workers = [];
        for (var w = 0; w < Math.min(CONCURRENCY, chunks.length); w++) {
          workers.push(worker());
        }
        return Promise.all(workers).then(function () {
          var assembled = new Uint8Array(total);
          var off = 0;
          for (var i = 0; i < parts.length; i++) {
            assembled.set(parts[i], off);
            off += parts[i].length;
          }
          return assembled.buffer;
        });
      })
      .then(function (modelBuf) {
        return _sha256Hex(modelBuf).then(function (h) {
          if (h !== MODEL_SHA256) {
            throw new Error('FpReview: reassembled model sha256 mismatch ' +
              '(expected ' + MODEL_SHA256 + ', got ' + h + ')');
          }
          return modelBuf;
        });
      });
  }

  // ---- ensure() ---------------------------------------------------------
  function ensure(progressCb) {
    if (_ready) {
      return Promise.resolve({
        ready: true, fromCache: _fromCache, loadMs: 0,
        modelBytes: MODEL_BYTES, cacheStored: _cacheStored, cacheNote: _cacheNote
      });
    }
    if (_ensurePromise) return _ensurePromise;
    var t0 = (typeof performance !== 'undefined' && performance.now) ?
      performance.now() : Date.now();
    _ensurePromise = (function () {
      var fromCache = false;
      var modelBuf = null;
      var db = null;
      _progress(progressCb, 'ort', 0, 0);
      // 1. Load onnxruntime-web (UMD, defines global ort).
      var loadOrt = (typeof global.ort !== 'undefined') ?
        Promise.resolve() : _loadScript(BASE + 'vendor-ort/ort.min.js');
      return loadOrt.then(function () {
        if (typeof global.ort === 'undefined' || !global.ort.InferenceSession) {
          throw new Error('FpReview: ort.min.js loaded but global ort is missing');
        }
        global.ort.env.wasm.wasmPaths = BASE + 'vendor-ort/';
        // 2. Try the IndexedDB cache first.
        return _idbOpen().then(function (d) { db = d; return _idbGet(db, MODEL_SHA256); })
          .catch(function (err) {
            // Cache unavailable is not fatal: fall back to download.
            _cacheNote = 'IndexedDB unavailable, downloading instead: ' + err.message;
            return null;
          })
          .then(function (cached) {
            if (cached && cached.byteLength === MODEL_BYTES) {
              fromCache = true;
              _progress(progressCb, 'cached', MODEL_BYTES, MODEL_BYTES);
              return cached;
            }
            if (cached) {
              _cacheNote = 'Cached model had wrong size (' + cached.byteLength +
                ' bytes), re-downloading';
            }
            return _fetchModel(progressCb);
          })
          .then(function (buf) {
            modelBuf = buf;
            // 3. Verify + store in cache (best effort; quota errors are
            //    recorded honestly, session still works in-memory-only).
            return _sha256Hex(modelBuf).then(function (h) {
              if (h !== MODEL_SHA256) {
                throw new Error('FpReview: model sha256 mismatch (expected ' +
                  MODEL_SHA256 + ', got ' + h + ')');
              }
              if (fromCache) { _cacheStored = true; return; }
              if (!db) return; // no DB: in-memory-only, note already set
              return _idbPut(db, MODEL_SHA256, modelBuf)
                .then(function () { _cacheStored = true; })
                .catch(function (err) {
                  _cacheStored = false;
                  _cacheNote = 'IndexedDB store failed (' + err.message +
                    '); model held in memory only for this page load';
                });
            });
          })
          .then(function () {
            // 4. Create the session (WASM CPU backend).
            return global.ort.InferenceSession.create(modelBuf, {
              executionProviders: ['wasm'],
              graphOptimizationLevel: 'all'
            });
          })
          .then(function (session) {
            _session = session;
            _ready = true;
            _fromCache = fromCache;
            var loadMs = Math.round(((typeof performance !== 'undefined' &&
              performance.now) ? performance.now() : Date.now()) - t0);
            _progress(progressCb, 'ready', MODEL_BYTES, MODEL_BYTES);
            return {
              ready: true, fromCache: fromCache, loadMs: loadMs,
              modelBytes: MODEL_BYTES, cacheStored: _cacheStored,
              cacheNote: _cacheNote
            };
          });
      });
    })().catch(function (err) {
      // Never swallow: a failed load rejects with a clear Error, and a
      // later ensure() may retry (the cached promise is dropped).
      _ensurePromise = null;
      if (err instanceof Error) throw err;
      throw new Error('FpReview: load failed: ' + err);
    });
    return _ensurePromise;
  }

  // ---- Image input ------------------------------------------------------
  function _sourceToImage(source) {
    // Returns Promise<{img, width, height, bytesForHash: ArrayBuffer|null}>
    if (source instanceof ArrayBuffer) {
      return _bytesToImage(new Uint8Array(source), source);
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return source.arrayBuffer().then(function (buf) {
        return _bytesToImage(new Uint8Array(buf), buf);
      });
    }
    if (source && (source instanceof HTMLImageElement ||
        source instanceof HTMLCanvasElement ||
        (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas))) {
      var w = source.naturalWidth || source.width;
      var h = source.naturalHeight || source.height;
      if (!w || !h) {
        return Promise.reject(new Error('FpReview: image element has no size yet'));
      }
      return Promise.resolve({ img: source, width: w, height: h, bytesForHash: null });
    }
    return Promise.reject(new Error(
      'FpReview: review() source must be an ArrayBuffer, Blob, ' +
      'HTMLImageElement or canvas; got ' + Object.prototype.toString.call(source)));
  }

  function _bytesToImage(bytes, buf) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([bytes], { type: 'image/*' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve({ img: img, width: img.naturalWidth, height: img.naturalHeight, bytesForHash: buf });
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('FpReview: could not decode image bytes (not a supported image?)'));
      };
      img.src = url;
    });
  }

  function _elementBytes(img) {
    // For element/canvas sources there are no original bytes: hash the
    // exact pixels reviewed, as a PNG re-encode. Documented in review().
    return new Promise(function (resolve, reject) {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      var ctx = c.getContext('2d');
      if (!ctx) { reject(new Error('FpReview: no 2d canvas context')); return; }
      ctx.drawImage(img, 0, 0);
      if (c.toBlob) {
        c.toBlob(function (b) {
          if (!b) { reject(new Error('FpReview: canvas toBlob failed')); return; }
          b.arrayBuffer().then(resolve, reject);
        }, 'image/png');
      } else {
        reject(new Error('FpReview: canvas toBlob unavailable'));
      }
    });
  }

  // ---- Preprocess: stretch to 384x384, ImageNet normalise, NCHW -------
  function _preprocess(img, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = INPUT_SIZE;
    canvas.height = INPUT_SIZE;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('FpReview: no 2d canvas context');
    // drawImage IS the resize (browser bilinear; see header note). The
    // image is stretched to square — aspect NOT preserved, as the model
    // expects (benchmark convention).
    ctx.drawImage(img, 0, 0, INPUT_SIZE, INPUT_SIZE);
    var data = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    var hw = INPUT_SIZE * INPUT_SIZE;
    var out = new Float32Array(3 * hw);
    for (var i = 0; i < hw; i++) {
      var r = data[i * 4] / 255;
      var g = data[i * 4 + 1] / 255;
      var b = data[i * 4 + 2] / 255;
      out[i] = (r - MEAN[0]) / STD[0];
      out[hw + i] = (g - MEAN[1]) / STD[1];
      out[2 * hw + i] = (b - MEAN[2]) / STD[2];
    }
    return out;
  }

  // ---- Decode: sigmoid, person slot 1, cxcywh -> xyxy fractions --------
  function _decode(dets, labels) {
    var boxes = [];
    var best = 0;
    for (var q = 0; q < NUM_QUERIES; q++) {
      var logit = labels[q * NUM_CLASSES + PERSON_SLOT];
      var clipped = logit < -88 ? -88 : (logit > 88 ? 88 : logit);
      var score = 1 / (1 + Math.exp(-clipped));
      if (score > best) best = score;
      if (score < SCORE_FLOOR) continue;
      var cx = dets[q * 4];
      var cy = dets[q * 4 + 1];
      var w = dets[q * 4 + 2];
      var h = dets[q * 4 + 3];
      var x0 = cx - w / 2;
      var y0 = cy - h / 2;
      var x1 = cx + w / 2;
      var y1 = cy + h / 2;
      // Clip to the image, exactly as decode_detections clips xyxy.
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > 1) x1 = 1;
      if (y1 > 1) y1 = 1;
      var bw = x1 - x0;
      var bh = y1 - y0;
      if (bw <= 0 || bh <= 0) continue;
      boxes.push({ x: x0, y: y0, w: bw, h: bh, score: score });
    }
    boxes.sort(function (a, b) { return b.score - a.score; });
    return { boxes: boxes, best: best };
  }

  // ---- review() ---------------------------------------------------------
  function review(source, humanImageMode) {
    var mode = (humanImageMode === 'block') ? 'block' : 'paint';
    var run = _reviewQueue.then(function () {
      return _reviewOnce(source, mode);
    });
    // Keep the queue alive after a failure so later reviews still run.
    _reviewQueue = run.catch(function () { /* queue only */ });
    return run;
  }

  function _reviewOnce(source, mode) {
    if (!_ready || !_session) {
      return Promise.reject(new Error(
        'FpReview: not ready — call ensure() first and await it'));
    }
    var t0 = (typeof performance !== 'undefined' && performance.now) ?
      performance.now() : Date.now();
    return _sourceToImage(source).then(function (src) {
      var hashPromise = src.bytesForHash ?
        _sha256Hex(src.bytesForHash) :
        _elementBytes(src.img).then(_sha256Hex);
      var preT0 = (typeof performance !== 'undefined' && performance.now) ?
        performance.now() : Date.now();
      var input = _preprocess(src.img, src.width, src.height);
      var preprocessMs = Math.round(((typeof performance !== 'undefined' &&
        performance.now) ? performance.now() : Date.now()) - preT0);
      var tensor = new global.ort.Tensor('float32', input,
        [1, 3, INPUT_SIZE, INPUT_SIZE]);
      var runT0 = (typeof performance !== 'undefined' && performance.now) ?
        performance.now() : Date.now();
      return _session.run({ input: tensor }).then(function (outputs) {
        var inferMs = Math.round(((typeof performance !== 'undefined' &&
          performance.now) ? performance.now() : Date.now()) - runT0);
        var dets = outputs.dets.data;
        var labels = outputs.labels.data;
        if (!dets || dets.length !== NUM_QUERIES * 4) {
          throw new Error('FpReview: unexpected dets output shape (' +
            (dets && dets.length) + ')');
        }
        if (!labels || labels.length !== NUM_QUERIES * NUM_CLASSES) {
          throw new Error('FpReview: unexpected labels output shape (' +
            (labels && labels.length) + ')');
        }
        var dec = _decode(dets, labels);
        var boxes = dec.boxes;
        var best = dec.best;
        var decision;
        if (best >= CONFIRM) {
          if (mode === 'block') {
            decision = 'block';
          } else {
            var largest = 0;
            var sum = 0;
            for (var i = 0; i < boxes.length; i++) {
              var area = boxes[i].w * boxes[i].h;
              if (area > largest) largest = area;
              sum += area;
            }
            decision = (largest > AREA_BLOCK || sum > AREA_BLOCK) ?
              'block' : 'allow_painted';
          }
        } else if (best >= SCORE_FLOOR) {
          decision = 'uncertain';
        } else {
          decision = 'allow';
        }
        var totalMs = Math.round(((typeof performance !== 'undefined' &&
          performance.now) ? performance.now() : Date.now()) - t0);
        return hashPromise.then(function (hash) {
          return {
            decision: decision,
            boxes: boxes,
            best: best,
            model: 'rf-detr-nano',
            inferMs: inferMs,
            contentHash: 'b:' + hash,
            preprocessMs: preprocessMs,
            totalMs: totalMs
          };
        });
      });
    });
  }

  function isReady() { return _ready; }

  global.FpReview = {
    ensure: ensure,
    review: review,
    isReady: isReady,
    MODEL_SHA256: MODEL_SHA256,
    MODEL_BYTES: MODEL_BYTES
  };
})(typeof window !== 'undefined' ? window : this);
