'use strict';

/* =====================================================================
 * PDF 横並びビューア
 *
 * 方針
 *  - 全ページ分の枠(div)だけ先に作り、画面付近のページだけ canvas に描画する（仮想化）
 *  - 画面から離れたページの canvas は width/height=0 にして即解放（iOS Safari 対策）
 *  - ズームは iOS 標準のピンチ／ダブルタップをそのまま使い、
 *    visualViewport の倍率を見て「今見えているページだけ」高解像度で描き直す
 *    → ベクター情報から再描画するので、拡大しても文字が崩れない
 *  - canvas の総ピクセル数に上限を設けて、メモリ不足を避ける
 * ===================================================================== */

/* ---------- 設定 ---------- */

// PDF.js の取得先。ローカルに置く場合は './vendor/pdfjs/' などに変更（README 参照）
const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';

const GAP             = 6;     // ページ間の隙間(px)。style.css の --gap と合わせる
const MAX_DPR         = 3;     // 画面密度の上限
const MAX_CANVAS_SIDE = 4096;  // canvas 1枚の一辺の上限(px)
const MAX_CANVAS_PX   = 8e6;   // canvas 1枚のピクセル数の上限
const BUDGET_PX       = 24e6;  // 同時に保持する canvas の合計ピクセル数の上限（約96MB）
const NEAR_MARGIN     = 1;     // 画面の上下 何画面分 先読みするか
const MAX_ACTIVE      = 2;     // 同時に描画するページ数

/* ---------- 要素 ---------- */

const $ = (s) => document.querySelector(s);
const grid     = $('#grid');
const emptyEl  = $('#empty');
const statusEl = $('#status');
const fileEl   = $('#file');
const openBtn  = $('#open');
const modeBtns = { 2: $('#m2'), 3: $('#m3') };

/* ---------- 状態 ---------- */

let pdf = null;            // PDFDocumentProxy
let loadingTask = null;
let gen = 0;               // ファイルを開くたびに増える（古い非同期処理の破棄用）
let pages = [];            // { n, el, canvas, pxw, job, pri }
let cols = 2;
let geo = { cw: 0, ch: 0, top: 0, left: 0, pitch: 0, xp: 0, rows: 0 };
let zoomQ = 1;             // 確定した拡大率（0.25刻みに切り上げ）
let zoomTimer = 0;
let idleTimer = 0;
let raf = 0;
let active = 0;            // 描画中のジョブ数
const live = new Set();    // canvas を持つ／描画待ちのページ
const pending = new Map(); // 描画待ち: page -> 目標幅(canvas px)

/* ---------- PDF.js の読み込み ---------- */

let pdfjsReady = null;
function ensurePdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PDFJS_BASE + 'build/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => {
      pdfjsReady = null;
      reject(new Error('PDF.js を読み込めませんでした。通信を確認してください'));
    };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

/* ---------- 表示 ---------- */

function setStatus(text, isErr) {
  statusEl.textContent = text || '';
  statusEl.classList.toggle('err', !!isErr);
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
      cMapUrl: PDFJS_BASE + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
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

    // 全ページ 1ページ目と同じ比率として枠を作る（各ページのサイズ取得で待たない）
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    p1.cleanup();
    if (myGen !== gen) return;

    buildGrid(doc.numPages, vp.height / vp.width);
    setStatus(doc.numPages + 'ページ');
  } catch (e) {
    if (myGen !== gen) return;
    console.error(e);
    resetDoc();
    setStatus('PDFを開けませんでした（ファイルが大きすぎる可能性があります）', true);
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

/* ---------- イベント ---------- */

openBtn.addEventListener('click', () => fileEl.click());
fileEl.addEventListener('change', () => {
  const f = fileEl.files && fileEl.files[0];
  fileEl.value = '';          // 同じファイルをもう一度選べるようにする
  if (f) openFile(f);
});
modeBtns[2].addEventListener('click', () => setCols(2));
modeBtns[3].addEventListener('click', () => setCols(3));

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

// 先に PDF.js を読み込んでおく（ファイル選択後の待ちを減らす）
ensurePdfJs().catch((e) => setStatus(e.message, true));
