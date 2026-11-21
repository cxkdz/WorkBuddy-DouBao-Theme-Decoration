#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIA = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.m4v': 'video/mp4',
});
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.m4v']);

function parseArgs(argv) {
  const out = { host: '', once: false, clean: false, verbose: false, watchdog: false, noRepair: false, pidFile: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host') out.host = String(argv[++i] || '').toLowerCase();
    else if (arg.startsWith('--host=')) out.host = arg.slice(7).toLowerCase();
    else if (arg === '--once') out.once = true;
    else if (arg === '--clean') out.clean = true;
    else if (arg === '--verbose' || arg === '-v') out.verbose = true;
    else if (arg === '--watchdog') out.watchdog = true;
    else if (arg === '--no-repair') out.noRepair = true;
    else if (arg === '--pid-file') out.pidFile = String(argv[++i] || '');
  }
  if (out.host !== 'cursor' && out.host !== 'doubao') {
    throw new Error('用法：node desktop-cdp-runner.mjs --host cursor|doubao [--once|--clean|--watchdog|--no-repair]');
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.watchdog && (args.once || args.clean)) {
  throw new Error('--watchdog 不能与 --once 或 --clean 同时使用。');
}

if (args.watchdog) {
  if (args.pidFile) {
    fs.mkdirSync(path.dirname(args.pidFile), { recursive: true });
    fs.writeFileSync(args.pidFile, JSON.stringify({
      schema: 'beauticode.desktop-runner/v1',
      pid: process.pid,
      startedAtMs: Date.now(),
      image: process.execPath,
      host: args.host,
      runner: fileURLToPath(import.meta.url),
      pidFile: path.resolve(args.pidFile),
    }) + '\n', 'utf8');
  }
  const childArgs = process.argv.slice(2).filter((arg) => arg !== '--watchdog');
  const stopSignals = new Set(['SIGINT', 'SIGTERM']);
  let stopping = false;
  let child = null;
  const start = () => {
    if (stopping) return;
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...childArgs], {
      stdio: 'inherit', windowsHide: true,
    });
    let ended = false;
    const restart = () => {
      if (ended) return;
      ended = true;
      child = null;
      if (!stopping) setTimeout(start, 1000);
    };
    child.once('exit', restart);
    child.once('error', restart);
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  for (const signal of stopSignals) process.once(signal, () => {
    stopping = true;
    child?.kill();
    finish();
  });
  start();
  await finished;
  if (args.pidFile) { try { fs.unlinkSync(args.pidFile); } catch {} }
  process.exit(0);
}

async function loadModule(packageName, fallback) {
  try { return await import(packageName); } catch { return await import(fallback); }
}

const shared = await loadModule('../packages/adapter-desktop-cdp/dist/index.js', '../packages/adapter-desktop-cdp/dist/index.js');
const core = await loadModule('../packages/core/dist/index.js', '../packages/core/dist/index.js');
const adapter = args.host === 'cursor'
  ? await loadModule('../packages/adapter-cursor/dist/index.js', '../packages/adapter-cursor/dist/index.js')
  : await loadModule('../packages/adapter-doubao/dist/index.js', '../packages/adapter-doubao/dist/index.js');
const spec = args.host === 'cursor' ? adapter.CURSOR_CDP_SPEC : adapter.DOUBAO_CDP_SPEC;
const buildInjection = args.host === 'cursor'
  ? adapter.buildCursorBackgroundInjection
  : adapter.buildDoubaoBackgroundInjection;
const buildCleanup = args.host === 'cursor'
  ? adapter.buildCursorBackgroundCleanup
  : adapter.buildDoubaoBackgroundCleanup;

const ts = () => new Date().toISOString().slice(11, 23);
const log = {
  info: (...parts) => process.stderr.write(`[${ts()}] [${args.host}] ${parts.join(' ')}\n`),
  warn: (...parts) => process.stderr.write(`[${ts()}] [${args.host}:warn] ${parts.join(' ')}\n`),
  debug: (...parts) => { if (args.verbose) process.stderr.write(`[${ts()}] [${args.host}:debug] ${parts.join(' ')}\n`); },
};

const dataRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'beauticode', 'hosts', args.host);
const stateFile = path.join(dataRoot, 'state.json');
fs.mkdirSync(dataRoot, { recursive: true });

function readState() {
  try {
    const buf = fs.readFileSync(stateFile);
    if (buf.length > 256 * 1024) return null;
    const value = JSON.parse(buf.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function writeState(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024) return;
  const next = JSON.parse(raw);
  const prev = readState();
  // 防止页面重载/清理时把空状态写回磁盘，覆盖已保存的背景与主题。
  if (prev && !next.cleared && !next.wallpaper &&
      !(Array.isArray(next.themes) && next.themes.length) &&
      (prev.wallpaper || (Array.isArray(prev.themes) && prev.themes.length))) return;
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, stateFile);
}

function openWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let opened = false;
    let settled = false;
    const pending = new Map();
    const handlers = [];
    const rejectPending = (error) => {
      for (const [requestId, task] of pending) {
        pending.delete(requestId);
        clearTimeout(task.timer);
        task.rej(error);
      }
    };
    const fail = (error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      rejectPending(failure);
      if (!settled) {
        settled = true;
        reject(failure);
      }
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      if (!opened || ws.readyState !== 1) {
        rej(new Error('CDP WebSocket is not open.'));
        return;
      }
      const requestId = ++id;
      pending.set(requestId, { res, rej });
      const timer = setTimeout(() => {
        const task = pending.get(requestId);
        if (!task) return;
        pending.delete(requestId);
        task.rej(new Error(`CDP request timed out: ${method}`));
      }, 10_000);
      pending.get(requestId).timer = timer;
      try {
        ws.send(JSON.stringify({ id: requestId, method, params }));
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        rej(error);
      }
    });
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id && pending.has(message.id)) {
        const task = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(task.timer);
        message.error ? task.rej(new Error(message.error.message || 'CDP error')) : task.res(message.result);
      } else if (message.method) {
        for (const handler of handlers) handler(message);
      }
    });
    ws.addEventListener('open', () => {
      opened = true;
      settled = true;
      resolve({
        ws, send,
        onEvent: (handler) => handlers.push(handler),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', (event) => {
      fail(new Error(`CDP WebSocket connection failed${event?.message ? `: ${event.message}` : '.'}`));
    });
    ws.addEventListener('close', () => {
      opened = false;
      fail(new Error('CDP WebSocket disconnected.'));
    });
  });
}

async function evaluate(connection, expression) {
  const reply = await connection.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (reply.exceptionDetails) {
    throw new Error((reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'page exception').slice(0, 240));
  }
  return reply.result?.value;
}

async function pickFileNative() {
  if (process.platform !== 'win32') throw new Error('本轮仅支持 Windows 原生文件选择器。');
  const ps = [
    "$ErrorActionPreference='Stop'",
    "$OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
    '[Console]::OutputEncoding=$OutputEncoding',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '$owner=New-Object System.Windows.Forms.Form',
    "$owner.Text='beautiCode 文件选择器'",
    '$owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedToolWindow',
    '$owner.ShowInTaskbar=$false',
    '$owner.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Size=[System.Drawing.Size]::new(1,1)',
    '$owner.Opacity=0.01',
    '$owner.TopMost=$true',
    '$dialog=New-Object System.Windows.Forms.OpenFileDialog',
    "$dialog.Filter='媒体|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif;*.mp4;*.mov;*.webm;*.m4v'",
    '$dialog.Multiselect=$false', '$dialog.CheckFileExists=$true', '$dialog.RestoreDirectory=$true',
    "$dialog.Title='选择背景图片或视频'",
    'try{[void]$owner.Show();[void]$owner.Activate();[void]$owner.BringToFront();[System.Windows.Forms.Application]::DoEvents();$result=$dialog.ShowDialog($owner);if($result -eq [System.Windows.Forms.DialogResult]::OK){[Console]::WriteLine($dialog.FileName)}}finally{$dialog.Dispose();$owner.Close();$owner.Dispose()}',
  ].join(';');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return await new Promise((resolve, reject) => execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()),
  ));
}

function mediaIdentity(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function assertStableMedia(file, expectedIdentity) {
  const logical = path.resolve(String(file || ''));
  const logicalInfo = fs.lstatSync(logical);
  if (logicalInfo.isSymbolicLink()) throw new Error('媒体路径不能是符号链接。');
  const resolved = fs.realpathSync.native(logical);
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('媒体路径不是普通文件。');
  if (expectedIdentity && mediaIdentity(info) !== expectedIdentity) {
    throw new Error('媒体文件在应用前发生变化。');
  }
  return { path: resolved, identity: mediaIdentity(info) };
}

async function validateMedia(file) {
  const logical = path.resolve(String(file || ''));
  const ext = path.extname(logical).toLowerCase();
  if (!MEDIA[ext]) throw new Error('不支持的媒体格式。');
  const first = assertStableMedia(logical);
  // The shared validator performs magic/container checks and walks every path
  // segment for symlinks/reparse points. Keep the identity check here as well:
  // the renderer receives a path, so it must not race a replacement file.
  const checked = VIDEO.has(ext)
    ? await core.validateVideoFile(first.path, { mode: 'fast' })
    : await core.validateImageFile(first.path, { mode: 'fast' });
  const stable = assertStableMedia(checked.filePath, first.identity);
  return { path: stable.path, identity: stable.identity };
}

async function setFileInput(connection, file, meta) {
  const checked = await validateMedia(file);
  const resolved = checked.path;
  assertStableMedia(resolved, checked.identity);
  const requestId = meta.requestId || `runner-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const prepared = { ...meta, path: resolved, requestId };
  await evaluate(connection, `window.__bcDesktopPrepareFile(${JSON.stringify(prepared)})`);
  await connection.send('DOM.enable');
  const document = await connection.send('DOM.getDocument', { depth: 1 });
  const selector = `#beauticode-${args.host}-background-panel [data-id="fileInput"]`;
  const query = await connection.send('DOM.querySelector', {
    nodeId: document.root.nodeId, selector,
  });
  const nodeId = query.nodeId || query.result?.nodeId;
  if (!nodeId) throw new Error('找不到背景文件输入框。');
  await connection.send('DOM.setFileInputFiles', { files: [resolved], nodeId });
  assertStableMedia(resolved, checked.identity);
  await evaluate(connection, `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`);
  if (meta.mode === 'gallery' || meta.mode === 'theme' || meta.mode === 'restore') {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const result = await evaluate(connection, `window.__bcDesktopApplyResult && window.__bcDesktopApplyResult[${JSON.stringify(requestId)}]`);
      if (result?.status === 'ok') return result;
      if (result?.status === 'error') throw new Error(result.error || '背景媒体加载失败。');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('等待背景媒体加载或主题保存超时。');
  }
}

function openExternal(url) {
  if (process.platform !== 'win32') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

const galleryToken = crypto.randomBytes(20).toString('hex');
const skinRegistry = new Map();
let galleryPort = null;
let galleryServer = null;
let activeConnection = null;

async function buildCatalog() {
  skinRegistry.clear();
  const result = await core.listApprovedSkins();
  for (const skin of result) skinRegistry.set(skin.id, skin);
  return result;
}

// ── DreamSkin.cc（Codex 主题社区）适配：只取壁纸，不搬 Codex 专用 CSS ──
const DREAMSKIN_API = 'https://api.dreamskin.cc/v1';
const DREAMSKIN_ID = /^ver_[a-f0-9]{12,64}$/;
const DREAMSKIN_CACHE = path.join(dataRoot, 'tmp', 'dreamskin');
const DREAMSKIN_THEMES = path.join(dataRoot, 'themes');
function httpJson(url, timeoutMs) {
  return fetch(url, { headers: { 'user-agent': 'beauticode-doubao/1.0' }, signal: AbortSignal.timeout(timeoutMs || 8000) })
    .then((r) => { if (!r.ok) throw new Error('dreamskin-http-' + r.status); return r.json(); });
}
function dreamSkinItem(raw) {
  const meta = raw.displayMeta || {};
  const colors = meta.colors || {};
  return {
    id: String(raw.id || ''),
    name: String(raw.name || '未命名主题'),
    author: String(raw.authorDisplayName || ''),
    downloads: Number(raw.downloadCount || 0),
    appearance: String(meta.appearance || ''),
    accent: String(colors.accent || '#7aa2ff'),
    license: String(raw.license || ''),
    bytes: Number(raw.packageBytes || 0),
  };
}
async function listDreamSkin({ limit, offset, sort, query }) {
  const n = Math.max(1, Math.min(48, Number(limit) || 12));
  const o = Math.max(0, Number(offset) || 0);
  const params = new URLSearchParams();
  params.set('limit', String(n));
  params.set('offset', String(o));
  if (sort === 'popular' || sort === 'favorites') params.set('sort', sort);
  const q = String(query || '').trim().slice(0, 40);
  if (q) params.set('q', q);
  const data = await httpJson(DREAMSKIN_API + '/themes?' + params.toString(), 9000);
  return { items: (data.items || []).map(dreamSkinItem), total: Number(data.total || 0), limit: n, offset: o };
}
const dreamSkinPreviewCache = new Map();
async function dreamSkinPreview(id) {
  if (dreamSkinPreviewCache.has(id)) return dreamSkinPreviewCache.get(id);
  const preview = await httpJson(DREAMSKIN_API + '/themes/' + encodeURIComponent(id) + '/preview', 9000);
  dreamSkinPreviewCache.set(id, preview);
  return preview;
}
async function dreamSkinFocus(id) {
  const preview = await dreamSkinPreview(id);
  const art = (preview && preview.theme && preview.theme.art) || {};
  const fx = Number(art.focusX), fy = Number(art.focusY);
  return {
    focusX: Number.isFinite(fx) ? Math.min(1, Math.max(0, fx)) : 0.5,
    focusY: Number.isFinite(fy) ? Math.min(1, Math.max(0, fy)) : 0.5,
  };
}
function sniffImage(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.length > 3 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return '';
}
async function dreamSkinImage(id) {
  if (!DREAMSKIN_ID.test(id)) throw new Error('dreamskin-id');
  fs.mkdirSync(DREAMSKIN_CACHE, { recursive: true });
  const cached = ['png', 'jpg', 'webp', 'gif']
    .map((ext) => path.join(DREAMSKIN_CACHE, id + '.' + ext))
    .find((p) => { try { return fs.statSync(p).size > 1024; } catch { return false; } });
  if (cached) return cached;
  const preview = await dreamSkinPreview(id);
  const url = String((preview && preview.background && preview.background.url) || '');
  if (!url.startsWith('https://api.dreamskin.cc/')) throw new Error('dreamskin-preview-url');
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('dreamskin-image-http-' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf.length > 16 * 1024 * 1024) throw new Error('dreamskin-image-size');
  const ext = sniffImage(buf);
  if (!ext) throw new Error('dreamskin-image-format');
  const dest = path.join(DREAMSKIN_CACHE, id + '.' + ext);
  fs.writeFileSync(dest, buf);
  return dest;
}
async function installDreamSkin(id, name) {
  if (!activeConnection) throw new Error('守护尚未连接豆包');
  const src = await dreamSkinImage(id);
  const focus = await dreamSkinFocus(id);
  fs.mkdirSync(DREAMSKIN_THEMES, { recursive: true });
  const ext = path.extname(src);
  const slug = String(name || id).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || id;
  const persistent = path.join(DREAMSKIN_THEMES, 'dreamskin-' + slug + '-' + id.slice(-6) + ext);
  fs.copyFileSync(src, persistent);
  try {
    await setFileInput(activeConnection, persistent, {
      mode: 'gallery',
      name: String(name || 'DreamSkin 主题'),
      save: true,
      provenance: { source: 'dreamskin.cc', sourceSkinId: id },
      focusX: focus.focusX,
      focusY: focus.focusY,
    });
    log.info('dreamskin-applied');
    return persistent;
  } catch (e) {
    try { fs.rmSync(persistent, { force: true }); } catch {}
    throw e;
  }
}

function galleryPage() {
  const tokenJson = JSON.stringify(galleryToken);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>beauticode 主题库</title><style>
body{margin:0;background:#0f1014;color:#e8e8ea;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:14px 20px 10px;border-bottom:1px solid rgba(255,255,255,.1);background:#1b1c21;position:sticky;top:0;z-index:2}
.tabs{display:flex;gap:8px}
.tab{background:transparent;border:1px solid rgba(255,255,255,.16);color:#cfcfd4;padding:6px 12px;border-radius:999px;cursor:pointer;font:inherit}
.tab.on{background:#e8e8ea;color:#15161a;border-color:#e8e8ea}
h1{margin:8px 0 2px;font-size:16px;font-weight:600}
#sub{margin:0;font-size:12px;color:#9a9aa2}
.bar{display:flex;gap:8px;margin-top:10px}
#q{flex:1;background:#101114;border:1px solid #34343c;color:#eee;border-radius:8px;padding:7px 10px;font:inherit;min-width:0}
#sort{background:#101114;border:1px solid #34343c;color:#eee;border-radius:8px;padding:7px 8px;font:inherit}
#msg{padding:10px 20px;color:#9a9aa2;min-height:18px;font-size:12px}
main{padding:14px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.card{display:block;width:100%;height:auto;min-height:0;box-sizing:border-box;appearance:none;line-height:normal;border:1px solid rgba(255,255,255,.14);border-radius:14px;overflow:hidden;background:#202127;cursor:pointer;text-align:left;color:#e8e8ea;padding:0;font:inherit}
.card:hover{background:#2a2b33;border-color:rgba(255,255,255,.26)}
.card img,.card video{width:100%;height:auto;max-height:none;aspect-ratio:16/10;object-fit:cover;display:block;background:#14151a}
.card .txt{display:block;padding:8px 10px 9px}
.card b{display:block;font-size:13px;font-weight:500;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card small{display:block;margin-top:3px;font-size:11px;color:#8f9098;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pager{display:flex;gap:10px;justify-content:center;align-items:center;padding:8px 0 30px;color:#9a9aa2;font-size:12px}
#pager button{background:#24252c;border:1px solid #3a3b44;color:#e8e8ea;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit}
#pager button:disabled{opacity:.35;cursor:default}
</style></head><body>
<header>
<div class="tabs"><button class="tab on" data-mode="dreamskin">DreamSkin 社区</button><button class="tab" data-mode="local">beauticode 目录</button></div>
<h1>主题库</h1><p id="sub">DreamSkin.cc 的社区主题，取壁纸适配到 豆包；作者与协议随卡片标注。</p>
<div class="bar" id="dsbar"><input id="q" placeholder="搜索主题、作者…（回车）"><select id="sort"><option value="popular">下载最多</option><option value="favorites">收藏最多</option><option value="new">最新发布</option></select></div>
</header>
<div id="msg">正在读取 DreamSkin 主题…</div><main id="grid"></main><div id="pager"></div>
<script>
var TOKEN = ${tokenJson};
var mode = 'dreamskin', dsOff = 0, dsTotal = 0, dsLimit = 12, dsSort = 'popular', dsQ = '';
var grid = document.getElementById('grid'), msg = document.getElementById('msg'), pager = document.getElementById('pager');
function clearAll(){ grid.innerHTML = ''; pager.innerHTML = ''; }
function card(item, isVideo, id, name, sub){
  var b = document.createElement('button'); b.className = 'card'; b.dataset.id = id; b.dataset.name = name || '';
  var m = document.createElement(isVideo ? 'video' : 'img');
  if (isVideo) { m.muted = true; m.preload = 'metadata'; } else { m.loading = 'lazy'; m.alt = ''; }
  m.src = '/api/dreamskin/media?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(TOKEN);
  if (mode !== 'dreamskin') m.src = '/media?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(TOKEN);
  var t = document.createElement('span'); t.className = 'txt';
  var nb = document.createElement('b'); nb.textContent = name || '未命名';
  var sm = document.createElement('small'); sm.textContent = sub || '';
  t.appendChild(nb); t.appendChild(sm); b.appendChild(m); b.appendChild(t); return b;
}
function renderPager(){
  pager.innerHTML = '';
  var prev = document.createElement('button'); prev.textContent = '上一页'; prev.disabled = dsOff <= 0;
  var info = document.createElement('span'); info.textContent = '第 ' + (Math.floor(dsOff / dsLimit) + 1) + ' / ' + Math.max(1, Math.ceil(dsTotal / dsLimit)) + ' 页';
  var next = document.createElement('button'); next.textContent = '下一页'; next.disabled = dsOff + dsLimit >= dsTotal;
  prev.onclick = function(){ if (dsOff > 0) { dsOff -= dsLimit; loadDS(); } };
  next.onclick = function(){ if (dsOff + dsLimit < dsTotal) { dsOff += dsLimit; loadDS(); } };
  pager.appendChild(prev); pager.appendChild(info); pager.appendChild(next);
}
function loadDS(){
  clearAll(); msg.textContent = '正在读取 DreamSkin 主题…';
  var qs = 'limit=' + dsLimit + '&offset=' + dsOff + '&sort=' + encodeURIComponent(dsSort) + '&q=' + encodeURIComponent(dsQ) + '&t=' + encodeURIComponent(TOKEN);
  fetch('/api/dreamskin?' + qs).then(function(r){ return r.json(); }).then(function(d){
    if (!d || !d.ok) throw new Error((d && d.error) || '读取失败');
    dsTotal = d.total || 0;
    (d.items || []).forEach(function(it){
      var sub = (it.author ? it.author : '匿名') + ' · ' + (it.license || '') + ' · ' + (it.downloads || 0) + ' 次下载';
      grid.appendChild(card(it, false, it.id, it.name, sub));
    });
    msg.textContent = dsTotal ? ('共 ' + dsTotal + ' 款 · 点卡片直接换成壁纸（只取图，不搬 Codex 配色）') : '没有匹配的主题';
    if (dsTotal) renderPager();
  }).catch(function(e){ msg.textContent = 'DreamSkin 读取失败：' + (e.message || e); });
}
function loadLocal(){
  clearAll(); msg.textContent = '正在读取本地目录…';
  fetch('/api/catalog?t=' + encodeURIComponent(TOKEN)).then(function(r){ return r.json(); }).then(function(d){
    var skins = (d && d.skins) || [];
    skins.forEach(function(s){ grid.appendChild(card(s, s.type === 'video', s.id, s.name, s.type === 'video' ? '视频皮肤' : '图片皮肤')); });
    msg.textContent = skins.length ? ('共 ' + skins.length + ' 款') : '本地目录为空（皮肤中心服务器不可用，DreamSkin 不受影响）';
  }).catch(function(e){ msg.textContent = '目录读取失败：' + (e.message || e); });
}
function applyDream(id, name){
  msg.textContent = '正在把「' + name + '」的壁纸应用到 豆包…';
  fetch('/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-beauticode-media-token': TOKEN }, body: JSON.stringify({ dreamskinId: id, name: name }) })
    .then(function(r){ return r.json(); }).then(function(j){
      msg.textContent = j.ok ? ('已应用：「' + name + '」') : ('应用失败：' + (j.error || '未知错误'));
    }).catch(function(){ msg.textContent = '应用失败（守护未连接 豆包）'; });
}
grid.addEventListener('click', function(ev){
  var c = ev.target.closest('.card'); if (!c) return;
  if (mode === 'dreamskin') applyDream(c.dataset.id, c.dataset.name);
  else {
    var name = c.dataset.name;
    msg.textContent = '正在应用「' + name + '」…';
    fetch('/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-beauticode-media-token': TOKEN }, body: JSON.stringify({ id: c.dataset.id }) })
      .then(function(r){ return r.json(); }).then(function(j){ msg.textContent = j.ok ? ('已应用：「' + name + '」') : ('应用失败：' + (j.error || '未知错误')); });
  }
});
document.querySelectorAll('.tab').forEach(function(tab){
  tab.addEventListener('click', function(){
    mode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.toggle('on', x === tab); });
    document.getElementById('dsbar').style.display = mode === 'dreamskin' ? 'flex' : 'none';
    document.getElementById('sub').textContent = mode === 'dreamskin' ? 'DreamSkin.cc 的社区主题，取壁纸适配到 豆包；作者与协议随卡片标注。' : 'beauticode 原有皮肤目录（皮肤中心服务器长期不可用时为空）。';
    dsOff = 0; if (mode === 'dreamskin') loadDS(); else loadLocal();
  });
});
document.getElementById('sort').addEventListener('change', function(e){ dsSort = e.target.value; dsOff = 0; loadDS(); });
var qtimer = null;
document.getElementById('q').addEventListener('input', function(e){ clearTimeout(qtimer); qtimer = setTimeout(function(){ dsQ = e.target.value.trim(); dsOff = 0; loadDS(); }, 450); });
document.getElementById('q').addEventListener('keydown', function(e){ if (e.key === 'Enter') { clearTimeout(qtimer); dsQ = e.target.value.trim(); dsOff = 0; loadDS(); } });
loadDS();
</script></body></html>`;
}

function isLoopbackHost(value) {
  const host = String(value || '').replace(/^\[/, '').split(/[:\]]/)[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function startGallery() {
  if (galleryServer) return Promise.resolve(galleryPort);
  const handler = async (request, response) => {
    if (!isLoopbackHost(request.headers.host)) { response.writeHead(403).end(); return; }
    const url = new URL(request.url, 'http://127.0.0.1');
    const token = request.headers['x-beauticode-media-token'] || url.searchParams.get('t');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cache-control', 'no-store');
    if (token !== galleryToken) { response.writeHead(403).end(JSON.stringify({ ok: false, error: 'bad token' })); return; }
    if (url.pathname === '/' || url.pathname === '/beauticode/gallery') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(galleryPage()); return;
    }
    if (url.pathname === '/api/catalog') {
      try {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ skins: await buildCatalog(), url: core.SKIN_CENTER_ORIGIN }));
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ ok: false, skins: [], error: error.message }));
      }
      return;
    }
    if (url.pathname === '/api/dreamskin') {
      try {
        const data = await listDreamSkin({
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
          sort: url.searchParams.get('sort'),
          query: url.searchParams.get('q'),
        });
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(Object.assign({ ok: true }, data)));
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }
    if (url.pathname === '/api/dreamskin/media') {
      try {
        const file = await dreamSkinImage(String(url.searchParams.get('id') || ''));
        const ext = path.extname(file).toLowerCase();
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        response.setHeader('content-type', types[ext] || 'application/octet-stream');
        response.setHeader('cache-control', 'private, max-age=86400');
        fs.createReadStream(file).pipe(response);
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }
    const id = String(url.searchParams.get('id') || '');
    if (url.pathname === '/media') {
      const skin = skinRegistry.get(id);
      if (!skin) { response.writeHead(404).end(); return; }
      let download;
      try {
        download = await core.downloadApprovedAsset(skin, skin.type, { directory: path.join(dataRoot, 'tmp', 'gallery') });
        response.setHeader('content-type', download.contentType || 'application/octet-stream');
        fs.createReadStream(download.filePath).on('close', () => fs.rmSync(download.tempDir, { recursive: true, force: true })).pipe(response);
      } catch (error) {
        response.writeHead(502).end(JSON.stringify({ ok: false, error: error.message }));
      }
      return;
    }
    if (url.pathname === '/apply' && request.method === 'POST') {
      let body = Buffer.alloc(0);
      request.on('data', (part) => { if (body.length < 4096) body = Buffer.concat([body, part]); });
      request.on('end', async () => {
        try {
          const payload = JSON.parse(body.toString('utf8'));
          if (payload.dreamskinId) {
            if (!DREAMSKIN_ID.test(String(payload.dreamskinId))) throw new Error('bad dreamskin id');
            const name = String(payload.name || 'DreamSkin 主题').slice(0, 80);
            await installDreamSkin(String(payload.dreamskinId), name);
            response.end(JSON.stringify({ ok: true, name }));
            return;
          }
          const item = skinRegistry.get(String(payload.id || ''));
          if (!item || !activeConnection) throw new Error(`${spec.displayName} 守护尚未连接。`);
          const download = await core.downloadApprovedAsset(item, item.type, { directory: path.join(dataRoot, 'tmp', 'gallery') });
          const persistentDir = path.join(dataRoot, 'themes');
          fs.mkdirSync(persistentDir, { recursive: true });
          const persistent = path.join(persistentDir, `${item.sourceSkinId}${path.extname(download.filePath)}`);
          const backup = `${persistent}.previous-${process.pid}-${Date.now()}`;
          let hadPrevious = false;
          let committed = false;
          try {
            if (fs.existsSync(persistent)) { fs.renameSync(persistent, backup); hadPrevious = true; }
            fs.renameSync(download.filePath, persistent);
            await setFileInput(activeConnection, persistent, {
              mode: 'gallery', name: item.name, save: true,
              provenance: { source: item.source, sourceSkinId: item.sourceSkinId, sourceVersion: item.sourceVersion },
            });
            committed = true;
          } catch (error) {
            try { fs.rmSync(persistent, { force: true }); } catch {}
            if (hadPrevious) { try { fs.renameSync(backup, persistent); } catch {} }
            throw error;
          } finally {
            fs.rmSync(download.tempDir, { recursive: true, force: true });
            if (committed || !hadPrevious) fs.rmSync(backup, { force: true });
          }
          response.end(JSON.stringify({ ok: true }));
        } catch (error) { response.writeHead(500).end(JSON.stringify({ ok: false, error: error.message })); }
      });
      return;
    }
    response.writeHead(404).end();
  };
  return new Promise((resolve) => {
    let port = args.host === 'cursor' ? 9381 : 9382;
    const tryPort = () => {
      if (port > 9390) { log.warn('皮肤中心端口耗尽。'); resolve(null); return; }
      const server = createServer(handler);
      server.once('error', (error) => error.code === 'EADDRINUSE' ? (port++, tryPort()) : resolve(null));
      server.listen(port, '127.0.0.1', () => { galleryServer = server; galleryPort = port; resolve(port); });
    };
    tryPort();
  });
}

async function applyRuntime(connection, galleryUrl) {
  const result = await evaluate(connection, buildInjection(galleryUrl));
  if (result === 'no-anchor' || result === 'anchor-text-mismatch') {
    reportRuntimeDiagnosis(result === 'no-anchor' ? 'host-ui-updated' : 'anchor-text-mismatch');
    throw new Error(`DOM 兼容检查失败：${result}`);
  }
  if (result === 'ok') {
    const state = readState();
    if (state) await evaluate(connection, `window.__bcDesktopRestoreState(${JSON.stringify(state)})`);
    reportRuntimeDiagnosis('ready');
  }
  return result;
}

let lastRuntimeDiagnosis = '';
function reportRuntimeDiagnosis(state) {
  if (state === lastRuntimeDiagnosis) return;
  lastRuntimeDiagnosis = state;
  if (state === 'ready') log.info('实时诊断：CDP 目标、宿主锚点与背景入口均正常。');
  else if (state === 'host-ui-updated' || state === 'anchor-text-mismatch') {
    log.warn(`实时诊断：${state}；宿主页面契约不匹配，已停止注入。`);
  } else {
    log.warn(`实时诊断：${state}；正在尝试恢复背景入口。`);
  }
}

async function runSession(endpoint) {
  const wsUrl = shared.assertLoopbackDebuggerUrl(endpoint.target.webSocketDebuggerUrl, endpoint.port);
  const connection = await openWs(wsUrl);
  activeConnection = connection;
  await connection.send('Page.enable');
  if (args.clean) {
    await evaluate(connection, buildCleanup());
    connection.close();
    return 'done';
  }
  // DreamSkin 主题库本地服务（仅本机、带令牌）；目录本身来自 dreamskin.cc。
  const port = await startGallery();
  const galleryUrl = port ? `http://127.0.0.1:${port}/beauticode/gallery?t=${encodeURIComponent(galleryToken)}` : '';
  try { fs.writeFileSync(path.join(dataRoot, 'gallery-url.txt'), galleryUrl, 'utf8'); } catch {}
  try { await applyRuntime(connection, galleryUrl); }
  catch (error) { activeConnection = null; connection.close(); throw error; }
  log.info(`已注入 ${shared.safeTargetLabel(endpoint.target.url)} :${endpoint.port}`);

  let busy = false;
  let lastPick = 0;
  let lastApply = '';
  let lastSkin = 0;
  let lastDirty = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const snapshot = await evaluate(connection, `(() => { const a=document.querySelector(${JSON.stringify(spec.anchorSelector)}); const t=a?String(a.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase():''; return {pick:window.__bcDesktopPickRequest||0,apply:window.__bcDesktopApplyRequest||null,skin:window.__bcDesktopSkinCenterRequest||0,dirty:window.__bcDesktopPersistDirty||0,entry:!!document.getElementById('beauticode-${args.host}-background-entry'),style:!!document.getElementById('beauticode-${args.host}-background-style'),stage:!!document.getElementById('beauticode-bg-stage'),anchor:!!a,anchorTextMatches:!!a&&t.includes(${JSON.stringify(spec.anchorText.toLowerCase())})}; })()`);
      if (!snapshot.anchor || !snapshot.anchorTextMatches) {
        reportRuntimeDiagnosis('host-ui-updated');
        await evaluate(connection, buildCleanup());
        return;
      }
      if (!snapshot.entry || !snapshot.style || !snapshot.stage) {
        reportRuntimeDiagnosis(!snapshot.entry ? 'entry-missing' : 'partial-injection');
        await applyRuntime(connection, galleryUrl);
      } else {
        reportRuntimeDiagnosis('ready');
      }
      if (snapshot.pick && snapshot.pick !== lastPick) {
        lastPick = snapshot.pick;
        await evaluate(connection, 'window.__bcDesktopPickRequest=0');
        let picked = '';
        try { picked = await pickFileNative(); } catch {}
        if (picked) await setFileInput(connection, picked, { mode: 'import', save: false });
      }
      if (snapshot.apply?.requestId && snapshot.apply.requestId !== lastApply) {
        lastApply = snapshot.apply.requestId;
        await evaluate(connection, 'window.__bcDesktopApplyRequest=null');
        try { await setFileInput(connection, snapshot.apply.path, snapshot.apply); }
        catch { await evaluate(connection, `window.__bcDesktopMessage(${JSON.stringify(spec.strings.missingFile)})`); }
      }
      if (snapshot.skin && snapshot.skin !== lastSkin) {
        lastSkin = snapshot.skin;
        await evaluate(connection, 'window.__bcDesktopSkinCenterRequest=0');
        if (galleryUrl) openExternal(galleryUrl);
      }
      if (snapshot.dirty !== lastDirty) {
        lastDirty = snapshot.dirty;
        const raw = await evaluate(connection, 'window.__bcDesktopPersistGet&&window.__bcDesktopPersistGet()');
        if (raw) writeState(raw);
      }
    } finally { busy = false; }
  };
  await tick();
  if (args.once) { connection.close(); return 'done'; }
  const interval = setInterval(() => tick().catch((error) => log.debug(error.message)), 300);
  return await new Promise((resolve) => {
    connection.ws.addEventListener('close', () => { clearInterval(interval); activeConnection = null; resolve('closed'); }, { once: true });
  });
}

const monitor = args.noRepair ? { close() {} } : shared.startDesktopStartupRepairMonitor(spec, log);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopping = true;
  monitor.close();
  galleryServer?.close();
  activeConnection?.close();
});

do {
  const endpoint = await shared.discoverDesktopCdp(spec);
  if (endpoint) {
    try {
      const result = await runSession(endpoint);
      if (result === 'done') break;
    } catch (error) {
      if (!String(error?.message || '').startsWith('DOM 兼容检查失败：')) log.warn(error.message);
      if (args.once || args.clean) { process.exitCode = 1; break; }
    }
  } else if (args.once || args.clean) {
    log.warn(`${spec.displayName} 没有可用的受控 CDP 页面。`);
    process.exitCode = 1;
    break;
  }
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, 700));
} while (!stopping);

monitor.close();
galleryServer?.close();
