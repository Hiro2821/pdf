'use strict';

/* =====================================================================
 * PDF 横並びビューア
 *
 * 表示側の方針
 *  - 全ページ分の枠(div)だけ先に作り、画面付近のページだけ canvas に描画する（仮想化）
 *  - 画面から離れたページの canvas は width/height=0 にして即解放（iOS Safari 対策）
 *  - ズームは iOS 標準のピンチ／ダブルタップをそのまま使い、
 *    visualViewport の倍率を見て「今見えているページだけ」高解像度で描き直す
 *    → ベクター情報から再描画するので、拡大しても文字が崩れない
 *  - canvas の総ピクセル数に上限を設けて、メモリ不足を避ける
 *
 * 書き出し側の方針
 *  - 画面表示用の PDF.js とは完全に分離し、pdf-lib で元PDFのページを
 *    「画像化せずに」新しいPDFのページへ縮小配置する（embedPage）
 *  - 全ページを一度に処理せず、2/3ページ分のグループごとに順番に処理する
 *
 * オフライン対応（iPadだけで完結できるように、vendorフォルダへの手動配置はしない）
 *  - PDF.js / pdf-lib は jsDelivr の固定バージョンURLから読み込む
 *  - sw.js がアプリ本体と、これらライブラリ関連ファイルを Cache Storage に保存する
 *  - 初回オンライン起動時に、このファイルの warmupOfflineCache() が
 *    必要なファイルをまとめて先読み・キャッシュし、画面に進捗を表示する
 *    （cmaps / standard_fonts は jsDelivr のファイル一覧APIで列挙して取得する。
 *     列挙に失敗しても致命的にはせず、以後は実際に使われた時にその都度キャッシュする）
 * ===================================================================== */

/* ---------- ライブラリの読み込み先（固定バージョンのCDN） ---------- */

const PDFJS_VERSION  = '3.11.174';
const PDFLIB_VERSION = '1.17.1';

const PDFJS_CDN  = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/`;
const PDFLIB_URL = `https://cdn.jsdelivr.net/npm/pdf-lib@${PDFLIB_VERSION}/dist/pdf-lib.min.js`;

// sw.js の LIB_CACHE と同じ名前にすること（ここと sw.js の両方で使うキャッシュ）
const LIB_CACHE = 'pdfviewer-lib-v1';

/* ---------- 表示の設定 ---------- */

const GAP             = 6;     // ページ間の隙間(px)。style.css の --gap と合わせる
const MAX_DPR         = 3;     // 画面密度の上限
const MAX_CANVAS_SIDE = 4096;  // canvas 1枚の一辺の上限(px)
const MAX_CANVAS_PX   = 8e6;   // canvas 1枚のピクセル数の上限
const BUDGET_PX       = 24e6;  // 同時に保持する canvas の合計ピクセル数の上限（約96MB）
const NEAR_MARGIN     = 1;     // 画面の上下 何画面分 先読みするか
const MAX_ACTIVE      = 2;     // 同時に描画するページ数

/* ---------- 書き出しの設定 ---------- */

const EXPORT_GAP_RATIO   = 0.02; // ページ間の余白（基準ページ幅に対する比率）
const EXPORT_YIELD_EVERY = 8;    // この数のグループごとに一度 UI へ制御を返す

/* ---------- 要素 ---------- */

const $ = (s) => document.querySelector(s);
const grid          = $('#grid');
const emptyEl       = $('#empty');
const statusEl      = $('#status');
const offlineBanner = $('#offlineBanner');
const netPill       = $('#netPill');
const fileEl        = $('#file');
const openBtn       = $('#open');
const exportBtn     = $('#exportBtn');
const modeBtns      = { 2: $('#m2'), 3: $('#m3') };

/* ---------- 状態 ---------- */

let pdf = null;            // PDFDocumentProxy（表示用）
let loadingTask = null;
let currentFile = null;    // 選択中の File（PDF本体は保存しない。参照のみ保持し、必要な時だけ読み直す）
let gen = 0;               // ファイルを開くたびに増える（古い非同期処理の破棄用）
let pages = [];            // { n, el, canvas, pxw, job, pri }
let cols = 2;
let geo = { cw: 0, ch: 0, top: 0, left: 0, pitch: 0, xp: 0, rows: 0 };
let zoomQ = 1;             // 確定した拡大率（0.25刻みに切り上げ）
let zoomTimer = 0;
let idleTimer = 0;
let raf = 0;
let active = 0;            // 描画中のジョブ数
let exporting = false;
let lastStatusText = '';   // 書き出し中の一時表示から戻すための退避
const live = new Set();    // canvas を持つ／描画待ちのページ
const pending = new Map(); // 描画待ち: page -> 目標幅(canvas px)

/* ---------- PDF.js の読み込み（表示用。CDNから。SWがキャッシュしていればオフラインでも可） ---------- */

let pdfjsReady = null;
function ensurePdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS_CDN + 'build/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_CDN + 'build/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => {
      pdfjsReady = null;
      reject(new Error('PDF.js を読み込めませんでした。一度オンラインの状態でこのアプリを開いてください'));
    };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

/* ---------- pdf-lib の読み込み（書き出し用。初回の書き出し時に遅延読み込み） ---------- */

let pdfLibReady = null;
function ensurePdfLib() {
  if (pdfLibReady) return pdfLibReady;
  pdfLibReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFLIB_URL;
    s.onload = () => resolve(window.PDFLib);
    s.onerror = () => {
      pdfLibReady = null;
      reject(new Error('pdf-lib を読み込めませんでした。一度オンラインの状態でこのアプリを開いてください'));
    };
    document.head.appendChild(s);
  });
  return pdfLibReady;
}

/* ---------- 表示（ステータス） ---------- */

function setStatus(text, isErr) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('err', !!isErr);
}

function flashStatus(text, ms) {
  setStatus(text);
  setTimeout(() => { if (!exporting) setStatus(lastStatusText); }, ms || 2000);
}

/* ---------- ファイルを開く ---------- */

async function openFile(file) {
  const myGen = ++gen;
  resetDoc();
  setStatus('読み込み中…');
  try {
    const lib = await ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    if (myGen !== gen) return;

    const task = lib.getDocument({
      data,
      cMapUrl: PDFJS_CDN + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS_CDN + 'standard_fonts/',
      disableAutoFetch: true,
      disableStream: true,
    });
    loadingTask = task;
    task.onPassword = (update, reason) => {
      const pw = window.prompt(reason === 2 ? 'パスワードが違います。もう一度入力してください' : 'パスワードを入力してください');
      if (pw === null) task.destroy(); else update(pw);
    };

    const doc = await task.promise;
    if (myGen !== gen) return;
    pdf = doc;
    currentFile = file; // 表示に成功した時点で初めて「書き出し対象」として扱う

    // 全ページ 1ページ目と同じ比率として枠を作る（各ページのサイズ取得で待たない）
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    p1.cleanup();
    if (myGen !== gen) return;

    buildGrid(doc.numPages, vp.height / vp.width);
    lastStatusText = doc.numPages + 'ページ';
    setStatus(lastStatusText);
    exportBtn.disabled = false;
  } catch (e) {
    if (myGen !== gen) return;
    console.error(e);
    resetDoc();
    setStatus('PDFを開けませんでした（ファイルが大きすぎる、または通信が必要な可能性があります）', true);
  }
}

function resetDoc() {
  for (const s of Array.from(live)) release(s);
  live.clear();
  pending.clear();
  pages = [];
  geo = { cw: 0, ch: 0, top: 0, left: 0, pitch: 0, xp: 0, rows: 0 };
  if (loadingTask) { try { loadingTask.destroy(); } catch (_) {} loadingTask = null; }
  pdf = null;
  currentFile = null;
  exportBtn.disabled = true;
  grid.textContent = '';
  emptyEl.hidden = false;
  clearTimeout(idleTimer);
}

function buildGrid(n, ar) {
  emptyEl.hidden = true;
  document.documentElement.style.setProperty('--ar', ar.toFixed(5));
  const frag = document.createDocumentFragment();
  pages = [];
  for (let i = 0; i < n; i++) {
    const el = document.createElement('div');
    el.className = 'cell';
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = String(i + 1);
    el.appendChild(num);
    frag.appendChild(el);
    pages.push({ n: i + 1, el, canvas: null, pxw: 0, job: null, pri: 0 });
  }
  grid.textContent = '';
  grid.appendChild(frag);
  window.scrollTo(0, 0);
  measure();
  schedule();
}

/* ---------- レイアウト計測（ドキュメント座標） ---------- */

function docOffset(el, prop) {
  let v = 0;
  for (let e = el; e; e = e.offsetParent) v += e[prop];
  return v;
}

function measure() {
  if (!pages.length) return;
  const a = pages[0].el;
  const cw = a.offsetWidth, ch = a.offsetHeight;
  if (!cw || !ch) return;
  const top = docOffset(a, 'offsetTop');
  const left = docOffset(a, 'offsetLeft');
  const below = pages[cols] ? pages[cols].el : null;
  const right = cols > 1 && pages[1] ? pages[1].el : null;
  geo = {
    cw, ch, top, left,
    pitch: below ? docOffset(below, 'offsetTop') - top : ch + GAP,
    xp: right ? docOffset(right, 'offsetLeft') - left : cw + GAP,
    rows: Math.ceil(pages.length / cols),
  };
}

/* ---------- 描画スケジューラ ---------- */

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; update(); });
}

// 今の画面（拡大中は見えている範囲だけ）を基準に、描画するページと解像度を決める
function update() {
  if (!pdf || !geo.pitch) return;

  const vv = window.visualViewport;
  const vL = vv ? vv.pageLeft : window.scrollX;
  const vT = vv ? vv.pageTop : window.scrollY;
  const vW = vv ? vv.width : window.innerWidth;
  const vH = vv ? vv.height : window.innerHeight;
  const vR = vL + vW, vB = vT + vH;
  const cx = vL + vW / 2, cy = vT + vH / 2;

  const { cw, ch, top, left, pitch, xp, rows } = geo;
  const margin = Math.max(vH * NEAR_MARGIN, pitch * 1.5);
  const r1 = Math.min(rows - 1, Math.floor((vB + margin - top) / pitch));
  const r0 = Math.min(Math.max(0, Math.floor((vT - margin - top) / pitch)), rows - 1);

  // 候補ページ（表示中 + 先読み範囲）
  const cands = [];
  for (let r = r0; r <= r1; r++) {
    const y0 = top + r * pitch, y1 = y0 + ch;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= pages.length) break;
      const x0 = left + c * xp, x1 = x0 + cw;
      const vis = x1 > vL && x0 < vR && y1 > vT && y0 < vB;
      const dx = (x0 + x1) / 2 - cx, dy = (y0 + y1) / 2 - cy;
      cands.push({ s: pages[i], vis, d: dx * dx + dy * dy });
    }
  }
  cands.sort((a, b) => (b.vis - a.vis) || (a.d - b.d));

  // 解像度: 表示中のページ = 画面密度 × 拡大率、先読み = 画面密度（等倍）
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  const nVis = cands.reduce((n, c) => n + (c.vis ? 1 : 0), 0);
  const kCap = Math.min(MAX_CANVAS_SIDE / Math.max(cw, ch), Math.sqrt(MAX_CANVAS_PX / (cw * ch)));
  let kHi = Math.min(dpr * zoomQ, kCap, Math.sqrt(BUDGET_PX * 0.75 / (Math.max(1, nVis) * cw * ch)));
  kHi = Math.max(0.5, Math.floor(kHi * 8) / 8);
  const kBase = Math.min(dpr, kHi);

  // メモリ予算内で、画面中心に近い順に採用
  const want = new Map();
  let used = 0;
  for (const c of cands) {
    const k = c.vis ? kHi : kBase;
    const cost = cw * k * ch * k;
    if (!c.vis && used + cost > BUDGET_PX) continue;
    used += cost;
    want.set(c.s, cw * k);
    c.s.pri = (c.vis ? 0 : 1e12) + c.d;
  }

  // 不要になったページは解放
  for (const s of Array.from(live)) if (!want.has(s)) release(s);
  for (const s of Array.from(pending.keys())) if (!want.has(s)) pending.delete(s);

  // 必要なページは描画待ちへ
  for (const [s, w] of want) {
    live.add(s);
    const needs = !s.canvas || s.pxw < w * 0.95 || s.pxw > w * 1.7;
    if (needs) {
      if (s.job && s.job.w !== w) cancelJob(s);
      if (!s.job) pending.set(s, w);
    } else {
      pending.delete(s);
      if (s.job) cancelJob(s);
    }
  }

  pump();
  armIdle();
}

function pump() {
  while (active < MAX_ACTIVE && pending.size) {
    let best = null;
    for (const s of pending.keys()) if (!best || s.pri < best.pri) best = s;
    const w = pending.get(best);
    pending.delete(best);
    startJob(best, w);
  }
}

async function startJob(s, w) {
  const job = { w, cancelled: false, task: null };
  s.job = job;
  active++;
  const myGen = gen;
  const doc = pdf;
  let page = null, canvas = null;
  try {
    page = await doc.getPage(s.n);
    if (job.cancelled || myGen !== gen) return;

    const { cw, ch } = geo;
    const k = w / cw;
    const v0 = page.getViewport({ scale: 1 });
    const fit = Math.min(cw / v0.width, ch / v0.height);   // 枠に収める倍率
    const vp = page.getViewport({ scale: fit * k });

    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d', { alpha: false });

    job.task = page.render({ canvasContext: ctx, viewport: vp });
    await job.task.promise;

    if (job.cancelled || myGen !== gen) { discard(canvas); canvas = null; return; }

    // 新しい canvas を先に重ねてから古いものを外す（ちらつき防止）
    s.el.appendChild(canvas);
    if (s.canvas) discard(s.canvas);
    s.canvas = canvas;
    s.pxw = w;
    canvas = null;
  } catch (e) {
    if (canvas) discard(canvas);
    if (!e || e.name !== 'RenderingCancelledException') console.warn('render failed', s.n, e);
  } finally {
    if (page) { try { page.cleanup(); } catch (_) {} }
    active--;
    if (s.job === job) s.job = null;
    pump();
  }
}

function cancelJob(s) {
  const job = s.job;
  if (!job) return;
  job.cancelled = true;
  try { if (job.task) job.task.cancel(); } catch (_) {}
  s.job = null;
}

function discard(c) {
  c.width = 0;      // iOS Safari は 0 にしないとメモリが戻りにくい
  c.height = 0;
  c.remove();
}

function release(s) {
  cancelJob(s);
  if (s.canvas) { discard(s.canvas); s.canvas = null; }
  s.pxw = 0;
  pending.delete(s);
  live.delete(s);
}

// 操作が止まってしばらくしたら PDF.js 内部のキャッシュを掃除
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pdf && !active && !pending.size) pdf.cleanup().catch(() => {});
  }, 6000);
}

/* ---------- 表示モード切替 ---------- */

function setCols(n) {
  if (n === cols) return;
  // 切り替え前後で「今見ている位置」がずれないようにする
  const rowF = pages.length && geo.pitch ? (window.scrollY - geo.top) / geo.pitch : -1;
  const pageF = rowF * cols;

  cols = n;
  grid.style.setProperty('--cols', String(n));
  for (const k of [2, 3]) modeBtns[k].setAttribute('aria-pressed', String(k === n));

  measure();
  if (rowF > 0 && geo.pitch) window.scrollTo(0, geo.top + (pageF / cols) * geo.pitch);
  schedule();
}

/* ---------- 拡大率の確定 ---------- */

function quantizeZoom(z) {
  return z < 1.05 ? 1 : Math.ceil(z * 4) / 4;
}

function settleZoom() {
  const z = quantizeZoom(window.visualViewport ? window.visualViewport.scale : 1);
  if (z !== zoomQ) { zoomQ = z; schedule(); }
}

/* =====================================================================
 * PDF 書き出し（横並びレイアウトを新しい1つのPDFとして保存）
 *
 * - 表示用の PDF.js は使わず、pdf-lib で元PDFを読み込み直す
 * - 元ページを画像化せず embedPage で「そのまま」新ページへ埋め込む（ベクター維持）
 * - n (2 or 3) ページぶんのグループごとに処理し、終わったら次のグループへ進む
 * - 新ページのサイズは 1ページ目の寸法を基準にする（既存の表示グリッドと同じ考え方。
 *   Goodnotes書き出しは通常すべて同寸のため）。異なる寸法のページは
 *   縦横比を保ったまま枠内に収める（引き伸ばさない）
 * ===================================================================== */

async function exportSpreadPdf() {
  if (exporting) return;
  if (!currentFile) { setStatus('先にPDFを開いてください', true); return; }

  exporting = true;
  const myGen = gen;
  openBtn.disabled = true;
  exportBtn.disabled = true;
  modeBtns[2].disabled = true;
  modeBtns[3].disabled = true;
  const n = cols;

  try {
    setStatus('書き出しの準備をしています…');
    const { PDFDocument } = await ensurePdfLib();
    if (myGen !== gen) return;

    // 表示中のPDFとは別に、書き出し用として元ファイルを読み直す
    // （画面側のメモリ管理に影響させないため。PDF自体は保存しない＝一時的に読むだけ）
    const srcBytes = new Uint8Array(await currentFile.arrayBuffer());
    if (myGen !== gen) return;

    const srcDoc = await PDFDocument.load(srcBytes, { updateMetadata: false });
    const total = srcDoc.getPageCount();
    if (total === 0) throw new Error('ページがありません');

    const basePage = srcDoc.getPage(0);
    const baseW = basePage.getWidth();
    const baseH = basePage.getHeight();
    const gapPt = Math.max(2, baseW * EXPORT_GAP_RATIO);
    const outW = baseW * n + gapPt * (n - 1);
    const outH = baseH;

    const outDoc = await PDFDocument.create();
    const groups = Math.ceil(total / n);

    for (let g = 0; g < groups; g++) {
      if (myGen !== gen) throw new Error('cancelled');

      const idxs = [];
      for (let k = 0; k < n; k++) {
        const idx = g * n + k;
        if (idx < total) idxs.push(idx);
      }

      const outPage = outDoc.addPage([outW, outH]);
      let x = 0;
      for (const idx of idxs) {
        const srcPage = srcDoc.getPage(idx);
        // embedPage: 画像化せず、元ページの内容をそのまま埋め込む（ベクター・文字情報を維持）
        const embedded = await outDoc.embedPage(srcPage);
        const scale = Math.min(baseW / embedded.width, baseH / embedded.height);
        const w = embedded.width * scale;
        const h = embedded.height * scale;
        const dx = x + (baseW - w) / 2;
        const dy = (baseH - h) / 2;
        outPage.drawPage(embedded, { x: dx, y: dy, width: w, height: h });
        x += baseW + gapPt;
      }

      setStatus(`${n}ページ横並びPDFを作成中… ${g + 1} / ${groups} ページ`);
      if ((g % EXPORT_YIELD_EVERY) === EXPORT_YIELD_EVERY - 1) {
        await new Promise((r) => setTimeout(r, 0)); // UI を固まらせない
      }
    }

    if (myGen !== gen) throw new Error('cancelled');

    setStatus('PDFを書き出しています…');
    const outBytes = await outDoc.save();
    if (myGen !== gen) return;

    const baseName = (currentFile.name || 'document.pdf').replace(/\.pdf$/i, '');
    const outName = `${baseName}_${n}ページ表示.pdf`;
    await deliverPdf(outBytes, outName);

    if (myGen === gen) flashStatus('書き出しが完了しました', 2500);
  } catch (e) {
    if (myGen !== gen || (e && e.message === 'cancelled')) return; // 新しいPDFが開かれた等
    console.error(e);
    setStatus('PDFの書き出しに失敗しました' + (e && e.message ? '（' + e.message + '）' : ''), true);
  } finally {
    exporting = false;
    if (myGen === gen) {
      openBtn.disabled = false;
      modeBtns[2].disabled = false;
      modeBtns[3].disabled = false;
      exportBtn.disabled = !currentFile;
    }
  }
}

// 書き出したPDFを端末へ渡す。共有シート（ファイルに保存 / Goodnotes等へ共有）を優先し、
// 使えない場合は通常のダウンロードにフォールバックする
async function deliverPdf(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });

  if (window.File && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // ユーザーが共有をキャンセルした
      console.warn('share failed, falling back to download', e);
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* =====================================================================
 * オフライン利用の準備（Service Worker 登録 + ライブラリの先読みキャッシュ）
 * ===================================================================== */

function showSetup(kind, msg) {
  offlineBanner.textContent = msg;
  offlineBanner.className = kind; // 'info' | 'ok' | 'err'
  offlineBanner.hidden = false;
}
function hideSetup() { offlineBanner.hidden = true; }

function updateNetPill() {
  const online = navigator.onLine;
  netPill.textContent = online ? 'オンライン' : 'オフライン';
  netPill.classList.toggle('offline', !online);
}

// 1ファイルをキャッシュへ保存。既にあれば何もしない。成功/失敗を返す
async function cacheOne(cache, url) {
  try {
    const existing = await cache.match(url);
    if (existing) return true;
    const res = await fetch(url, { mode: 'cors' });
    if (res && (res.ok || res.type === 'opaque')) { await cache.put(url, res); return true; }
    return false;
  } catch (_) {
    return false;
  }
}

async function cacheAllConcurrent(cache, urls, concurrency, onProgress) {
  let idx = 0, done = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      await cacheOne(cache, urls[i]);
      done++;
      if (onProgress) onProgress(done, urls.length);
    }
  }
  const n = Math.max(1, Math.min(concurrency, urls.length));
  await Promise.all(Array.from({ length: n }, worker));
}

// jsDelivr のファイル一覧APIから、指定フォルダ(cmaps, standard_fonts)配下の
// すべてのファイルパスを列挙する。失敗しても呼び出し側で無視される
async function listPdfjsExtraFiles() {
  const listUrl = `https://data.jsdelivr.com/v1/packages/npm/pdfjs-dist@${PDFJS_VERSION}`;
  const res = await fetch(listUrl, { mode: 'cors' });
  if (!res.ok) throw new Error('listing unavailable');
  const data = await res.json();

  const targets = ['cmaps', 'standard_fonts'];
  function walk(files, prefix, atRoot) {
    let out = [];
    for (const f of files || []) {
      const name = prefix ? prefix + '/' + f.name : f.name;
      if (f.type === 'directory') {
        if (atRoot && !targets.includes(f.name)) continue; // ルート直下は対象フォルダのみ辿る
        out = out.concat(walk(f.files, name, false));
      } else {
        out.push(name);
      }
    }
    return out;
  }
  return walk(data.files, '', true).map((p) => PDFJS_CDN + p);
}

async function warmupOfflineCache() {
  if (!('caches' in window)) {
    showSetup('err', 'この端末ではオフライン利用の準備ができません（この機能に対応していません）');
    return;
  }
  try {
    showSetup('info', 'オフライン利用の準備中…');
    const cache = await caches.open(LIB_CACHE);

    // 必須の本体ファイル（これが失敗したら準備失敗とみなす）
    const core = [
      PDFJS_CDN + 'build/pdf.min.js',
      PDFJS_CDN + 'build/pdf.worker.min.js',
      PDFLIB_URL,
    ];
    const coreOk = await Promise.all(core.map((u) => cacheOne(cache, u)));
    if (!coreOk.every(Boolean)) {
      showSetup('err', 'オフライン利用の準備に失敗しました。通信環境を確認してください');
      return;
    }

    // cmaps / standard_fonts（任意。失敗しても準備失敗にはしない。
    // 取得できなかった分は、実際にそのPDFを開いた時にオンラインであれば都度キャッシュされる）
    try {
      const extra = await listPdfjsExtraFiles();
      if (extra.length) {
        await cacheAllConcurrent(cache, extra, 6, (done, total) => {
          showSetup('info', `オフライン利用の準備中…（関連ファイル ${done} / ${total}）`);
        });
      }
    } catch (_) {
      // 一覧取得に失敗しても致命的にはしない
    }

    showSetup('ok', 'オフライン利用の準備が完了しました');
    setTimeout(hideSetup, 4000);
  } catch (e) {
    console.warn('warmup failed', e);
    showSetup('err', 'オフライン利用の準備に失敗しました。通信環境を確認してください');
  }
}

async function initOffline() {
  updateNetPill();
  window.addEventListener('online', updateNetPill);
  window.addEventListener('offline', updateNetPill);

  if (!('serviceWorker' in navigator)) {
    showSetup('err', 'この端末・ブラウザはオフライン利用に対応していません。常に通信が必要です。');
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    console.warn('SW registration failed', e);
    showSetup('err', 'オフライン利用の準備に失敗しました。通信環境を確認してください');
    return;
  }
  if (!navigator.onLine) {
    showSetup('info', 'オフラインです。前回までにキャッシュした内容で利用できます。');
    return;
  }
  await warmupOfflineCache();
}

/* ---------- イベント ---------- */

openBtn.addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', () => {
  const f = fileEl.files && fileEl.files[0];
  fileEl.value = '';          // 同じファイルをもう一度選べるようにする
  if (f) openFile(f);
});
modeBtns[2].addEventListener('click', () => setCols(2));
modeBtns[3].addEventListener('click', () => setCols(3));
exportBtn.addEventListener('click', exportSpreadPdf);

window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', () => { measure(); schedule(); });
if (window.ResizeObserver) {
  new ResizeObserver(() => { measure(); schedule(); }).observe(grid);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('scroll', schedule);
  window.visualViewport.addEventListener('resize', () => {
    schedule();                               // 見えている範囲は即反映
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(settleZoom, 200);  // 拡大率はピンチが止まってから確定
  });
}

// 先に PDF.js を読み込んでおく（ファイル選択後の待ちを減らす）。pdf-lib は書き出し時に遅延読み込み
ensurePdfJs().catch((e) => setStatus(e.message, true));
initOffline();
