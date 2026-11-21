import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'node:http';

export function createWorkBuddyGallery({core,dataDir:DATA_DIR,log,safeErrorCode,onNameDiagnostic}) {
const GALLERY_PORT_BASE = 9337;
const GALLERY_TOKEN = crypto.randomBytes(16).toString('hex');
const CENTER_URL = core.SKIN_CENTER_ORIGIN;
const DREAMSKIN_API = 'https://api.dreamskin.cc/v1';
const DREAMSKIN_ID = /^ver_[a-f0-9]{12,64}$/;
const DREAMSKIN_CACHE = path.join(DATA_DIR, 'tmp', 'dreamskin');
const DREAMSKIN_THEMES = path.join(DATA_DIR, 'themes');
let galleryPort = null;
let galleryServer = null;
let galleryApplyFn = null;
let readRendererName = null;
const skinRegistry = new Map();
async function buildCatalog() {
  skinRegistry.clear();
  const skins = await core.listApprovedSkins();
  for (const skin of skins) skinRegistry.set(skin.id, skin);
  return skins;
}

// ── DreamSkin.cc（Codex 主题社区）适配：只取壁纸，不搬 Codex 专用 CSS ──
function httpJson(url, timeoutMs) {
  return fetch(url, { headers: { 'user-agent': 'beauticode-workbuddy/1.0' }, signal: AbortSignal.timeout(timeoutMs || 8000) })
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
  if (!galleryApplyFn || !readRendererName) throw new Error('守护未连接 WorkBuddy');
  const src = await dreamSkinImage(id);
  const focus = await dreamSkinFocus(id);
  fs.mkdirSync(DREAMSKIN_THEMES, { recursive: true });
  const ext = path.extname(src);
  const slug = String(name || id).replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || id;
  const persistent = path.join(DREAMSKIN_THEMES, 'dreamskin-' + slug + '-' + id.slice(-6) + ext);
  fs.copyFileSync(src, persistent);
  try {
    await galleryApplyFn({
      file: persistent,
      name: String(name || 'DreamSkin 主题'),
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
  const tokenJson = JSON.stringify(GALLERY_TOKEN);
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
<h1>主题库</h1><p id="sub">DreamSkin.cc 的社区主题，取壁纸适配到 WorkBuddy；作者与协议随卡片标注。</p>
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
  msg.textContent = '正在把「' + name + '」的壁纸应用到 WorkBuddy…';
  fetch('/apply', { method: 'POST', headers: { 'content-type': 'application/json', 'x-beauticode-media-token': TOKEN }, body: JSON.stringify({ dreamskinId: id, name: name }) })
    .then(function(r){ return r.json(); }).then(function(j){
      msg.textContent = j.ok ? ('已应用：「' + name + '」') : ('应用失败：' + (j.error || '未知错误'));
    }).catch(function(){ msg.textContent = '应用失败（守护未连接 WorkBuddy）'; });
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
    document.getElementById('sub').textContent = mode === 'dreamskin' ? 'DreamSkin.cc 的社区主题，取壁纸适配到 WorkBuddy；作者与协议随卡片标注。' : 'beauticode 原有皮肤目录（皮肤中心服务器长期不可用时为空）。';
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

function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch {
    return false;
  }
}

function requestToken(req, url, body) {
  const header = req.headers['x-beauticode-media-token'];
  if (typeof header === 'string' && header) return header;
  if (url.searchParams.get('t')) return url.searchParams.get('t');
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

function deny(res, status, error) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error }));
}

function startGalleryServer(binding) {
  galleryApplyFn = binding.apply;
  readRendererName = binding.readName;
  if (galleryServer && galleryPort) return Promise.resolve(galleryPort);

  const galleryHandler = (req, res) => {
    if (!isLoopbackHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
      deny(res, 403, 'forbidden origin');
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');
    const allowedOrigin = req.headers.origin && isAllowedOrigin(req.headers.origin) ? req.headers.origin : '';
    if (allowedOrigin) res.setHeader('access-control-allow-origin', allowedOrigin);
    res.setHeader('access-control-allow-headers', 'content-type, x-beauticode-media-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    res.setHeader('content-type', 'application/json; charset=utf-8');

    const tokenOk = requestToken(req, u, null) === GALLERY_TOKEN;
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cache-control', 'no-store');
    if (!tokenOk) { deny(res, 403, 'bad token'); return; }

    if (u.pathname === '/beauticode/gallery' || u.pathname === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(galleryPage());
      return;
    }

    if (u.pathname === '/api/catalog') {
      buildCatalog().then((skins) => res.end(JSON.stringify({ skins, url: CENTER_URL }))).catch((error) => deny(res, 502, error.message));
      return;
    }
    if (u.pathname === '/api/dreamskin') {
      listDreamSkin({
        limit: u.searchParams.get('limit'),
        offset: u.searchParams.get('offset'),
        sort: u.searchParams.get('sort'),
        query: u.searchParams.get('q'),
      }).then((data) => res.end(JSON.stringify(Object.assign({ ok: true }, data)))
        ).catch((error) => deny(res, 502, error instanceof Error ? error.message : 'DreamSkin 读取失败'));
      return;
    }
    if (u.pathname === '/api/dreamskin/media') {
      const id = u.searchParams.get('id') || '';
      dreamSkinImage(id).then((file) => {
        const ext = path.extname(file).toLowerCase();
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        res.setHeader('content-type', types[ext] || 'application/octet-stream');
        res.setHeader('cache-control', 'private, max-age=86400');
        fs.createReadStream(file).on('error', () => deny(res, 500, 'image stream error')).pipe(res);
      }).catch((error) => deny(res, 502, error instanceof Error ? error.message : 'DreamSkin 图片读取失败'));
      return;
    }
    if (u.pathname === '/media') {
      const id = u.searchParams.get('id') || '';
      if (!core.isSafeSkinId(id)) { deny(res, 400, 'bad id'); return; }
      Promise.resolve(skinRegistry.get(id) || core.getApprovedSkin(id)).then(async (skin) => {
        skinRegistry.set(id, skin);
        const download = await core.downloadApprovedAsset(skin, skin.type, { directory: path.join(DATA_DIR, 'tmp', 'gallery') });
        res.setHeader('content-type', download.contentType || 'application/octet-stream');
        fs.createReadStream(download.filePath).on('close', () => fs.rmSync(download.tempDir, { recursive: true, force: true })).pipe(res);
      }).catch((error) => deny(res, 502, error.message));
      return;
    }
    if (u.pathname === '/apply') {
      if (req.method !== 'POST') { deny(res, 405, 'POST required'); return; }
      const chunks = [];
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
        if (n > 4096) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
        if (requestToken(req, u, body) !== GALLERY_TOKEN) { deny(res, 403, 'bad token'); return; }
        if (body.dreamskinId) {
          const dsid = String(body.dreamskinId || '');
          const dsname = String(body.name || 'DreamSkin 主题').slice(0, 80);
          if (!DREAMSKIN_ID.test(dsid)) { deny(res, 400, 'bad dreamskin id'); return; }
          installDreamSkin(dsid, dsname).then(() => {
            res.end(JSON.stringify({ ok: true, name: dsname }));
          }).catch((error) => deny(res, 500, error instanceof Error ? error.message : 'DreamSkin 应用失败'));
          return;
        }
        const id = String(body.id || '');
        if (!core.isSafeSkinId(id)) { deny(res, 400, 'bad id'); return; }
        const skin = skinRegistry.get(id) || await core.getApprovedSkin(id).catch((error) => { deny(res, 502, error.message); return null; });
        if (!skin) return;
        if (!readRendererName || !galleryApplyFn) { deny(res, 503, '守护未连接 WorkBuddy'); return; }
        let download;
        try {
          download = await core.downloadApprovedAsset(skin, skin.type, { directory: path.join(DATA_DIR, 'tmp', 'gallery') });
        } catch (error) {
          deny(res, 502, error instanceof Error ? error.message : '皮肤资源下载失败');
          return;
        }
        const persistentDir = path.join(DATA_DIR, 'themes');
        fs.mkdirSync(persistentDir, { recursive: true });
        const persistent = path.join(persistentDir, `${skin.sourceSkinId}${path.extname(download.filePath)}`);
        const backup = `${persistent}.previous-${process.pid}-${Date.now()}`;
        let hadPrevious = false;
        let committed = false;
        try {
          if (fs.existsSync(persistent)) { fs.renameSync(persistent, backup); hadPrevious = true; }
          fs.renameSync(download.filePath, persistent);
          await galleryApplyFn({
            file: persistent,
            name: skin.name,
            provenance: { source: skin.source, sourceSkinId: skin.sourceSkinId, sourceVersion: skin.sourceVersion },
          });
          // The catalog value is held only in memory until the next state write.
          // Never log a theme name or a stable unkeyed hash.
          const renderer = await readRendererName().catch(() => null);
          onNameDiagnostic({ catalog: skin.name, renderer, file: persistent, at: Date.now() });
          committed = true;
          log.info('skin-center-applied');
          res.end(JSON.stringify({ ok: true, name: skin.name }));
        } catch (error) {
          try { fs.rmSync(persistent, { force: true }); } catch {}
          if (hadPrevious) { try { fs.renameSync(backup, persistent); } catch {} }
          deny(res, 500, error.message);
        } finally {
          fs.rmSync(download.tempDir, { recursive: true, force: true });
          if (committed || !hadPrevious) fs.rmSync(backup, { force: true });
        }
      });
      return;
    }
    deny(res, 404, 'not found');
  };

  return new Promise((resolve) => {
    let p = GALLERY_PORT_BASE;
    const tryNext = () => {
      if (p >= GALLERY_PORT_BASE + 9) {
        log.warn('皮肤商城端口耗尽（9337-9345），未启动（其余功能不受影响）');
        resolve(null);
        return;
      }
      const port = p++;
      const server = createServer(galleryHandler);
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') { log.info(`皮肤商城端口 ${port} 被占，换下一个…`); tryNext(); }
        else { log.warn('skin-center-service-error', safeErrorCode(e)); resolve(null); }
      });
      server.listen(port, '127.0.0.1', () => {
        galleryServer = server;
        galleryPort = port;
        log.info(`皮肤商城 ✓ http://127.0.0.1:${port}/beauticode/gallery（仅本机，需令牌）`);
        resolve(port);
      });
    };
    tryNext();
  });
}

return {
  start:startGalleryServer,
  configuration:()=>({port:galleryPort,token:GALLERY_TOKEN,centerUrl:CENTER_URL}),
  disconnect:()=>{galleryApplyFn=null;readRendererName=null;},
  stop:()=>{galleryApplyFn=null;readRendererName=null;galleryServer?.close();galleryServer=null;galleryPort=null;},
};
}
