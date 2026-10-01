'use strict';

/* =====================================================================
 * Service Worker — オフラインキャッシュ
 *
 * 2つのキャッシュに分ける:
 *  - CORE_CACHE : index.html / style.css / app.js / sw.js など、アプリ本体。
 *                 ネットワーク優先（オンライン時は常に最新を取得してキャッシュを更新）、
 *                 オフライン時のみキャッシュから返す。
 *  - LIB_CACHE  : cdn.jsdelivr.net から読み込む PDF.js・pdf-lib・cmaps・standard_fonts。
 *                 キャッシュ優先（あればそれを使い、なければ取得してキャッシュに追加）。
 *                 app.js の warmupOfflineCache() が初回アクセス時にまとめて先読みするが、
 *                 ここでも「使われたら保存する」ことで取りこぼしを補う。
 *
 * CACHE_VERSION を上げると CORE_CACHE だけが作り直され、古い本体キャッシュは破棄される。
 * LIB_CACHE の名前は app.js の LIB_CACHE 定数と必ず一致させること
 * （ライブラリのバージョンを変更する場合は、両方のファイルでこの名前も更新する）。
 * LIB_CACHE はアプリ本体の更新では破棄しないため、index.html/app.js を更新しても
 * 大きなライブラリファイルを再取得する必要はない。
 * ===================================================================== */

const CACHE_VERSION = 'v1';
const CORE_CACHE    = 'pdfviewer-core-' + CACHE_VERSION;
const LIB_CACHE      = 'pdfviewer-lib-v1'; // app.js の LIB_CACHE と同じ文字列にすること

const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
];

const JSDELIVR_HOST = 'cdn.jsdelivr.net';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const core = await caches.open(CORE_CACHE);
    try { await core.addAll(CORE_ASSETS); } catch (e) { /* 一部失敗しても続行 */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== CORE_CACHE && k !== LIB_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // ライブラリ本体（jsDelivr）: キャッシュ優先 → 無ければ取得してキャッシュへ
  if (url.hostname === JSDELIVR_HOST) {
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return new Response('', { status: 503, statusText: 'offline: library not cached yet' });
      }
    })());
    return;
  }

  // それ以外の他オリジンへの通信は行わない方針のため、素通し（通常は発生しない）
  if (url.origin !== self.location.origin) return;

  // アプリ本体: ネットワーク優先 → 失敗したらキャッシュへフォールバック
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CORE_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      const cache = await caches.open(CORE_CACHE);
      const cached = (await cache.match(req)) || (await cache.match('./index.html'));
      if (cached) return cached;
      return new Response('オフラインです。一度オンラインの状態でこのアプリを開いてください。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
