#!/usr/bin/env node
/** WorkBuddy background guardian.
 * Page injection, media/gallery and lifecycle policy have independent modules.
 * CDP connects only to verified loopback WorkBuddy pages. A user close is never
 * followed by automatic launch; unsafe repair waits for explicit close/reopen.
 */

import process from 'node:process';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { shouldApplyDefaultWallpaper } from './wb-startup-media.mjs';
import { createWorkBuddyLogger } from './wb-runner-log.mjs';
import { compareThemeNameStages } from './wb-theme-name-diagnostic.mjs';
import { runWorkBuddyGuardian, parseWorkBuddyRunnerArgs } from './wb-guardian-loop.mjs';
import { fetchTargets, openWs, evaluate } from './wb-cdp-connection.mjs';
import { createWorkBuddyGallery } from './wb-gallery.mjs';
import { createWorkBuddyFilePicker } from './wb-file-picker.mjs';
import { runWorkBuddyWatchdog } from './wb-watchdog.mjs';


const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 导入 adapter（workspace 名优先，相对 dist 兜底） ─────────────────────
async function loadAdapter() {
  const candidates = [
    '../packages/adapter-workbuddy/dist/index.js',
    '../packages/adapter-workbuddy/dist/index.js',
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* 试下一个 */ }
  }
  throw new Error('无法导入 WorkBuddy adapter —— 先跑 tsc 编译该包');
}
const A = await loadAdapter();
const core = await import('../packages/core/dist/index.js');
const repairChain = new core.StartupRepairChain();
const {
  BACKGROUND_BAR_INJECTION, BACKGROUND_BAR_CLEANUP, BACKGROUND_BAR_STYLE_ID,
  buildContractCss, readTheme,
  TOKEN_SCAN_EXPRESSION, buildTokenOverlayCss, TOKEN_OVERLAY_STYLE_ID,
  HARDCODED_SURFACE_SCAN_EXPRESSION, buildHardcodedSurfaceCss,
  buildStyleKeeperExpression,
  pickWorkBuddyTarget, assertLoopbackDebuggerUrl,
  ensureWorkBuddyCdp,
  listWorkBuddyProcesses, selectWorkBuddyReconnectDelay,
  isInitialPersistState,
} = A;
for (const [k, v] of Object.entries({
  BACKGROUND_BAR_INJECTION, BACKGROUND_BAR_CLEANUP, buildContractCss, readTheme,
  TOKEN_SCAN_EXPRESSION, buildTokenOverlayCss, TOKEN_OVERLAY_STYLE_ID,
  HARDCODED_SURFACE_SCAN_EXPRESSION, buildHardcodedSurfaceCss, buildStyleKeeperExpression,
  pickWorkBuddyTarget, assertLoopbackDebuggerUrl,
  ensureWorkBuddyCdp,
  listWorkBuddyProcesses, selectWorkBuddyReconnectDelay,
  isInitialPersistState,
})) {
  if (typeof v !== 'string' && typeof v !== 'function') {
    process.stderr.write(`adapter 导出形状不对：${k}\n`); process.exit(2);
  }
}
const CONTRACT_STYLE_ID = A.STYLE_ID || 'beauticode-contract-style';
const HARDCODED_STYLE_ID = 'beauticode-hardcoded-style';
const APPLY_IDS = [CONTRACT_STYLE_ID, TOKEN_OVERLAY_STYLE_ID, HARDCODED_STYLE_ID];

// ── 参数 ──────────────────────────────────────────────────────────────
const args = parseWorkBuddyRunnerArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    '用法：node wb-cdp-runner.mjs [--port 9336] [--once] [--clean] [--verbose] [--watchdog] [--no-launch]\n' +
    '  默认常驻：仅修复 10 秒内新启动且没有 CDP 的 WorkBuddy；主动退出后不会重开\n' +
    '  --once   应用一次后退出    --clean  清理后退出    --watchdog 崩溃拉起\n' +
    '  --no-launch  不启动/重启宿主，缺 CDP 时失败退出\n');
  process.exit(0);
}
let PORT = args.port || parseInt(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || '9336', 10);
// 默认壁纸：舞台没有媒体时自动铺上（否则透明面透出的是 #101114 纯色，
// 看起来就像"不透明没生效"——实测踩过）。--wallpaper 可换。
const DEFAULT_WALLPAPER = args.wallpaper
  || (fs.existsSync(path.join(REPO, 'assets', 'themes', 'internal-beyond', 'bg-canvas-4k.webp'))
    ? path.join(REPO, 'assets', 'themes', 'internal-beyond', 'bg-canvas-4k.webp')
    : path.join(REPO, 'assets', 'themes', 'internal-beyond', 'bg-canvas-4k.png'));

const log = createWorkBuddyLogger({
  file: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'beauticode', 'logs', 'wb-runner.log'),
  debug: args.verbose,
});
log.info('runner-started');
const themeNameKey = crypto.randomBytes(32);
let pendingNameDiagnostic = null;
function safeErrorCode(error) {
  const code = String(error?.code || 'error');
  return /^[A-Za-z_0-9-]{1,32}$/.test(code) ? code : 'error';
}

// ── CDP ───────────────────────────────────────────────────────────────
function setStyleExpr(id, css) {
  return `(function(){
var id=${JSON.stringify(id)}, css=${JSON.stringify(css)};
var el=document.getElementById(id);
if(!el){el=document.createElement('style');el.id=id;el.setAttribute('data-bc-injected','beauticode');document.head.appendChild(el);}
el.textContent=css;return 'style:'+id;})()`;
}

// ── 皮肤商城（DSH gallery 对齐）：本地服务 + 浏览器商城页 ─────────────
// 公用皮肤 = 内置素材 + 用户皮肤目录（~/Library/Application Support/beauticode/skins）。
// 浏览器里点卡片 → /apply → 经 CDP 应用到 WorkBuddy 面板（__bcApplyBackgroundPath）。
const DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'beauticode')
  : path.join(os.homedir(), 'Library', 'Application Support', 'beauticode');
const ENV_KEY = 'WORKBUDDY_REMOTE_DEBUGGING_PORT';
const PORT_FILE = path.join(DATA_DIR, 'workbuddy-port.json');
const RUNNER_PID_FILE = path.join(DATA_DIR, 'wb-runner.pid');
function readConfiguredPort() {
  try {
    const value = JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port;
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch { return null; }
}
let lastPersistedPort = readConfiguredPort();
function persistPortSelection(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const next = JSON.stringify({ port, updatedAt: new Date().toISOString() }) + '\n';
  try { fs.writeFileSync(PORT_FILE, next, { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ }
  if (process.platform === 'win32' && lastPersistedPort !== port) {
    lastPersistedPort = port;
    execFile('setx', [ENV_KEY, String(port)], { windowsHide: true }, () => {});
  }
}
if (!args.port) {
  const configured = readConfiguredPort();
  if (configured) PORT = configured;
}
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const gallery = createWorkBuddyGallery({core,dataDir:DATA_DIR,log,safeErrorCode,onNameDiagnostic:value=>{pendingNameDiagnostic=value;}});

// ── 完整应用序列 ──────────────────────────────────────────────────────
// α 槽变量化：把生成 CSS 里烘焙的「82%, transparent)」统一替换为
// 「var(--bc-surface-alpha-pct, 82%), transparent)」——面板透明度滑杆从此
// 实时驱动（纯 CSS 变量，拖动即生效，无需守护重造）。
const ALPHA_VARIFY = (css) =>
  css.split(' 82%, transparent)').join(' var(--bc-surface-alpha-pct, 82%), transparent)');

function isBlankPersistState(live) {
  // Keep the explicit legacy-shape check here: an array containing saved
  // themes is never considered hydration-blank, even if other fields are
  // still at their renderer defaults.
  const themesEmpty = !live || !Array.isArray(live.themes) || live.themes.length === 0;
  return themesEmpty && isInitialPersistState(live);
}

function galleryConfigExpression() {
  return `window.__bcUpdateGalleryConfig && window.__bcUpdateGalleryConfig(${JSON.stringify(gallery.configuration())})`;
}

async function injectBackgroundUi(c) {
  const {port:galleryPort,token:GALLERY_TOKEN,centerUrl:CENTER_URL}=gallery.configuration();
  const ui = await evaluate(c, BACKGROUND_BAR_INJECTION
    .replace(/__BC_GALLERY_PORT__/g, String(galleryPort || 9337))
    .replace(/__BC_GALLERY_TOKEN__/g, JSON.stringify(GALLERY_TOKEN))
    .replace(/__BC_CENTER_URL__/g, JSON.stringify(CENTER_URL || '')));
  log.info('UI ✓（' + JSON.stringify(ui) + '）');
  return ui;
}

async function updateGalleryConfig(c) {
  if (!gallery.configuration().port) return false;
  try {
    return await evaluate(c, galleryConfigExpression());
  } catch (error) {
    log.debug('skin-center-config-error', safeErrorCode(error));
    return false;
  }
}

async function applyAll(c, options = {}) {
  // 1) 主题（fail-closed：读不出就不上 CSS，只上 UI 并说明原因）
  const className = await evaluate(c, `[document.documentElement,document.body].filter(Boolean).map(n=>n.className+' '+(n.getAttribute('data-theme')||'')).join(' ')`);
  const theme = readTheme(String(className || ''));
  if (!theme) log.warn('theme-unrecognized; UI-only');

  // 2) 契约 CSS（浅深两套同时烘）
  if (theme) {
    await evaluate(c, setStyleExpr(CONTRACT_STYLE_ID, ALPHA_VARIFY(buildContractCss({ theme }))));
    log.info('contract CSS ✓（' + CONTRACT_STYLE_ID + '）');
  }

  // 3) token 覆盖层（页面侧扫描 → 生成）
  const scanRaw = await evaluate(c, TOKEN_SCAN_EXPRESSION);
  const scan = typeof scanRaw === 'string' ? JSON.parse(scanRaw) : scanRaw;
  const overlay = ALPHA_VARIFY(buildTokenOverlayCss(scan.rows || []));
  await evaluate(c, setStyleExpr(TOKEN_OVERLAY_STYLE_ID, overlay));
  log.info(`token overlay ✓（${(scan.rows || []).length} 个面 token，${(overlay.length / 1024).toFixed(0)} KB）`);

  // 4) 硬编码中性面中立化
  const hardRaw = await evaluate(c, HARDCODED_SURFACE_SCAN_EXPRESSION);
  const hard = typeof hardRaw === 'string' ? JSON.parse(hardRaw) : hardRaw;
  const hardCss = ALPHA_VARIFY(buildHardcodedSurfaceCss(hard.selectors || []));
  if (hardCss) await evaluate(c, setStyleExpr(HARDCODED_STYLE_ID, hardCss));
  log.info(`hardcoded 中立化 ✓（${(hard.selectors || []).length} 个面，跳过饱和 ${hard.skippedSaturated ?? 0}）`);

  // 4.6) 产物面板还原层：半透明体系只作用于外壳，产物阅读面（.sidebar-next）
  //      恢复原版 token（含语法高亮色）+ 中立化背景改回实心——否则面板内
  //      高亮被 color-mix 污染（用户实测"高亮全错"）、视频透光造成频闪。
  const restParts = [];
  const lTok = [], dTok = [];
  for (const row of (scan.rows || [])) {
    if (!row.token || !row.token.startsWith('--')) continue;
    if (row.lightValue) lTok.push(row.token + ':' + row.lightValue + ' !important;');
    if (row.darkValue) dTok.push(row.token + ':' + row.darkValue + ' !important;');
  }
  if (lTok.length) restParts.push('html.light .sidebar-next,html.cb-light .sidebar-next{' + lTok.join('') + '}');
  if (dTok.length) restParts.push('html.dark .sidebar-next,html.cb-dark .sidebar-next{' + dTok.join('') + '}');
  for (const sel of (hard.selectors || [])) {
    if (/^html|^[^\s.#[a-z]/i.test(sel)) continue;
    restParts.push('.sidebar-next ' + sel + '{background-color:var(--bc-panel-solid) !important}');
  }
  if (restParts.length) {
    const rest =
      'html:root{--bc-panel-solid-dark:rgb(31,31,31);--bc-panel-solid-light:rgb(252,252,252)}' +
      'html.dark .sidebar-next,html.cb-dark .sidebar-next{--bc-panel-solid:rgb(31,31,31)}' +
      'html.light .sidebar-next,html.cb-light .sidebar-next{--bc-panel-solid:rgb(252,252,252)}' +
      restParts.join('');
    await evaluate(c, setStyleExpr('beauticode-restore-panel', rest));
    log.info('产物面板还原层 ✓（' + (scan.rows || []).length + ' token 回原版，' + (hard.selectors || []).length + ' 面改实心）');
  }

  // 4.5) 沉降幕样式常驻：面板打开（守护触发）与文件卡片点击（页面内触发）共用
  await evaluate(c, "(function(){var s=document.getElementById('beauticode-panel-settle');if(!s){s=document.createElement('style');s.id='beauticode-panel-settle';s.textContent='.sidebar-next{transition:opacity .25s ease}html[data-bc-panel-settling] .sidebar-next{opacity:0 !important}';document.head.appendChild(s);}})()");

  // 5) 样式看门狗：**WorkBuddy 下停用**。
  //    我们的覆盖层/契约规则全部带 !important，顺序无关；而 WorkBuddy 宿主自己有
  //    一个 keeper（cb-font-size-override 重排器）。两个 keeper 互相"把自己钉到
  //    head 末尾"= 16Hz 的样式重排乒乓（实测 2 秒 66 次变更）→ 预览文字高亮频闪。
  //    停掉我方的，并叫停页面里已装的实例。
  await evaluate(c, "window.__bcKeepStylesLast && window.__bcKeepStylesLast.stop && window.__bcKeepStylesLast.stop(); 'keeper-stopped'");

  // 6) UI is normally mounted before this full scan (see session()). Keep a
  // self-healing fallback for target remounts and older callers.
  const ui = options.injectUi === false ? 'already-mounted' : await injectBackgroundUi(c);

  let diskBeforeRestore = null;
  try { diskBeforeRestore = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* no valid archive */ }
  let liveBeforeRestore = null;
  try {
    const raw = await evaluate(c, 'window.__bcPersistGet ? window.__bcPersistGet() : null');
    liveBeforeRestore = raw ? JSON.parse(raw) : null;
  } catch { /* treat unreadable live state as blank */ }

  // 7) 默认壁纸：仅在没有显式清除、没有保存媒体且舞台没有媒体时铺上。
  //    用户自己导入的 blob:/file:/用户路径不受影响；「清除背景」后也不会被顶回
  //    （本步只在 applyAll 时跑一次，清除后 entry 仍在、不触发重放）。
  if (fs.existsSync(DEFAULT_WALLPAPER) && shouldApplyDefaultWallpaper({
    cleared: Boolean(diskBeforeRestore?.cleared || liveBeforeRestore?.cleared),
    wallpaper: diskBeforeRestore?.wallpaper || liveBeforeRestore?.wallpaper || null,
    hasMedia: false,
  })) {
    const wp = await evaluate(c, `(function(){
var wp = ${JSON.stringify(DEFAULT_WALLPAPER)};
var url = 'file://' + encodeURI(wp.charAt(0) === '/' ? wp : '/' + wp).replace(/#/g, '%23');
var stage = document.getElementById('beauticode-bg-stage');
if (!stage) return 'no-stage';
var bgImg = stage.style.backgroundImage;
// 简写 background:#101114 展开后 backgroundImage 会是 "initial"（真值！）——
// 只排除 'none' 会误判"有媒体"→ 默认壁纸永远不铺、重启后死黑（实测踩过）
var hasMedia = (bgImg && bgImg !== 'none' && bgImg !== 'initial' && bgImg !== 'unset')
  || stage.querySelector('video,img');
if (hasMedia) return 'has-media';
// 用 <img class=bc-media> 而非 background-image —— 磨砂滑杆只作用于媒体元素，
// 默认壁纸若是 background-image，磨砂对它就无物可糊（实测踩过）。
var img = document.createElement('img');
img.className = 'bc-media';
img.setAttribute('data-bc-injected', 'beauticode');
img.src = url;
stage.appendChild(img);
return 'default-applied';
})()`);
    if (wp === 'default-applied') log.info('默认壁纸 ✓（舞台原本无媒体）');
    else log.debug('默认壁纸：' + wp);
  }

  // 8) 记忆恢复：有 state.json 就把壁纸 + 三滑杆恢复到上次退出时的样子
  //    （state.wallpaper=null 且 cleared=true = 用户上次主动清除 → 连默认壁纸也撤掉）
  if (diskBeforeRestore && isBlankPersistState(liveBeforeRestore)) {
    try {
      const st = diskBeforeRestore;
      await evaluate(c, 'window.__bcRestoreState && window.__bcRestoreState(' + JSON.stringify(st) + ')');
      log.info(st.cleared ? 'state-restored-cleared' : 'state-restored-media');
    } catch (e) { log.warn('state-restore-error', safeErrorCode(e)); }
  }
  return { theme, tokens: (scan.rows || []).length, ui };
}

// ── 清理（注入节点 + 我们的三块样式） ─────────────────────────────────
async function cleanupAll(c) {
  try {
    await evaluate(c, BACKGROUND_BAR_CLEANUP);
    for (const id of APPLY_IDS) {
      await evaluate(c, `(function(){var el=document.getElementById(${JSON.stringify(id)});if(el)el.remove();return 'removed:'+${JSON.stringify(id)};})()`);
    }
    log.info('清理完成');
  } catch (e) { log.warn('cleanup-error', safeErrorCode(e)); }
}

// ── 守护轮询：entry 丢失 / 主题切换 → 重新应用 ────────────────────────
function startWatcher(c, state) {
  let inflight = false;
  const tick = async () => {
    if (inflight) return; inflight = true;
    try {
      const v = JSON.parse(await evaluate(c, `JSON.stringify({
        entry: !!document.getElementById(${JSON.stringify(BACKGROUND_BAR_STYLE_ID + '-entry')}),
        style: !!document.getElementById(${JSON.stringify(BACKGROUND_BAR_STYLE_ID + '-style')}),
        stage: !!document.getElementById('beauticode-bg-stage'),
        nav: !!document.querySelector('.conversation-list-tabs'),
        theme: [document.documentElement,document.body].filter(Boolean).map(n=>n.className+' '+(n.getAttribute('data-theme')||'')).join(' '),
        panel: !!document.querySelector('.sidebar-next'),
        persist: window.__bcPersistGet ? window.__bcPersistGet() : null
      })`));
      const fpTheme = String(v.theme || '');
      const compatibility = !v.nav ? 'host-ui-updated' : !v.entry ? 'entry-missing' : !v.style || !v.stage ? 'partial-injection' : 'ready';
      if (compatibility !== state.lastCompatibilityFp) {
        state.lastCompatibilityFp = compatibility;
        if (compatibility === 'ready') log.info('实时诊断：WorkBuddy 锚点、背景入口与舞台正常');
        else log.warn(`实时诊断：WorkBuddy ${compatibility}`);
      }
      if (v.nav && (!v.entry || !v.style || !v.stage)) {
        log.debug('WorkBuddy 背景 DOM 缺失，尝试幂等恢复');
        await injectBackgroundUi(c);
        await updateGalleryConfig(c);
        await applyAll(c, { injectUi: false });
  onReady();
      } else if (state.lastThemeFp && fpTheme !== state.lastThemeFp) {
        log.info('主题切换 → 重扫 token 覆盖层');
        await applyAll(c);
      }
      state.lastThemeFp = fpTheme;
      // 产物面板开合检测：打开瞬间宿主注入样式潮会引发 ~16Hz 高亮翻转（频闪），
      // 沉降幕先把面板淡出 1.5s（让注入潮在幕后结束），再淡入已稳定的内容。
      const panelOpen = !!v.panel;
      if (panelOpen && !state.panelOpen) {
        log.info('产物面板打开 → 沉降幕 1.5s（压住进入期频闪）');
        await evaluate(c, "(function(){var s=document.getElementById('beauticode-panel-settle');if(!s){s=document.createElement('style');s.id='beauticode-panel-settle';s.textContent='.sidebar-next{transition:opacity .25s ease}html[data-bc-panel-settling] .sidebar-next{opacity:0 !important}';document.head.appendChild(s);}})()");
        await evaluate(c, "document.documentElement.setAttribute('data-bc-panel-settling','1')");
        setTimeout(function () {
          evaluate(c, "document.documentElement.removeAttribute('data-bc-panel-settling')")
            .catch(function (e) { log.debug('settling-overlay-error', safeErrorCode(e)); });
        }, 1500);
      }
      state.panelOpen = panelOpen;
      // ── 记忆调和：每 tick 核对（幂等）——React 重挂/SPA 导航随时可能把舞台打回默认 ──
      let blankLive = true;
      try {
        const live = v.persist ? JSON.parse(v.persist) : null;
        blankLive = isBlankPersistState(live);
      } catch { blankLive = true; }
      let disk = null;
      try { disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* 无存档 */ }
      const hasArchive = !!(disk && (disk.wallpaper || disk.cleared));

      if (hasArchive && disk.wallpaper && blankLive) {
        // 纯兜底：只在页面【真空白】（全 null 且无 blob 标记 = 刚重装/刚刷新）时
        // 恢复存档。非空白 = 用户的当前状态（拖动的滑杆、导入的 blob），绝不碰——
        // 每 tick 无条件 restore 会把用户刚拖的滑杆拽回存档值、把 blob 媒体顶掉
        //（实测：面板参数"隔一会儿变一下"的真凶）
        try {
          await evaluate(c, 'window.__bcRestoreState && window.__bcRestoreState(' + JSON.stringify(disk) + ')');
        } catch (e) { log.debug('state-reconcile-error', safeErrorCode(e)); }
      } else if (hasArchive && disk.cleared && blankLive) {
        // 清除态 + 页面空白（刚重装）→ 恢复清除态（撤掉默认壁纸）
        await evaluate(c, 'window.__bcRestoreState && window.__bcRestoreState(' + JSON.stringify(disk) + ')');
        log.info('记忆调和 ✓（清除态恢复）');
      }

      // 状态写盘：仅在页面状态真实变化（非空白样本）时覆盖存档
      // （空白样本 = 刚重装/刚刷新的初始态，覆盖会把已存壁纸冲掉——实测踩过）
      if (v.persist && v.persist !== state.lastPersist) {
        if (!blankLive) {
          fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
          fs.writeFileSync(STATE_FILE, v.persist);
          log.info('state-saved');
          if (pendingNameDiagnostic) {
            const pending = pendingNameDiagnostic;
            pendingNameDiagnostic = null;
            try {
              const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
              if (saved.wallpaper === pending.file && Date.now() - pending.at < 10_000) {
                const name = saved.themes?.find(t => t.id === saved.activeThemeId)?.name ?? null;
                const check = compareThemeNameStages({ catalog: pending.catalog, renderer: pending.renderer, persisted: name }, themeNameKey);
                log.info('theme-name-boundary', JSON.stringify(check));
              }
            } catch { log.warn('theme-name-boundary unavailable'); }
          }
        }
        state.lastPersist = v.persist;
      }
    } catch (e) { log.debug('watcher-error', safeErrorCode(e)); }
    finally { inflight = false; }
  };
  return setInterval(tick, 1500);
}

const filePicker=createWorkBuddyFilePicker({core,evaluate,log,safeErrorCode});

async function session(onReady = () => {}) {
  const targets = await fetchTargets(PORT);
  const page = pickWorkBuddyTarget(targets);
  if (!page) throw new Error('no WorkBuddy renderer page target');
  const wsUrl = assertLoopbackDebuggerUrl(page.webSocketDebuggerUrl, PORT);
  log.info('target-connected');
  const c = await openWs(wsUrl);
  let poll, pickPoll;
  try {

  if (args.clean) { await cleanupAll(c); c.close(); process.exit(0); }

  const state = { lastThemeFp: '', panelOpen: false, lastCompatibilityFp: '' };
  const galleryReady = gallery.start({apply:async (selection) => {
    await evaluate(c, 'window.__bcApplyBackgroundPath && window.__bcApplyBackgroundPath(' + JSON.stringify(selection.file) + ',' + JSON.stringify({ themeName: selection.name, provenance: selection.provenance, focusX: selection.focusX, focusY: selection.focusY }) + ')');
  },readName:()=>evaluate(c, `(() => {const raw=window.__bcPersistGet && window.__bcPersistGet();if(!raw)return null;const st=JSON.parse(raw);return st.themes?.find(t=>t.id===st.activeThemeId)?.name ?? null;})()`)});
  // Mount the entry as soon as the target is usable. Catalog listener setup
  // and the expensive token/surface scans continue in parallel; a late port
  // choice is pushed into the already-mounted entry below.
  await injectBackgroundUi(c);
  void galleryReady.then(() => updateGalleryConfig(c));
  await applyAll(c, { injectUi: false });
  onReady();

  if (args.once) { c.close(); process.exit(0); }

  c.onEvent((m) => {
    if (m.method === 'Page.loadEventFired') {
      log.info('页面重载 → 重新应用');
      applyAll(c).catch((e) => log.warn('reapply-error', safeErrorCode(e)));
    }
  });
  poll = startWatcher(c, state);
  pickPoll = filePicker.start(c);
  activeSession = { c, poll, pickPoll };
  log.info('守护运行中（1.5s 轮询 + 150ms 取件轮询 + 断线重连）；Ctrl+C 清理并退出');

  await new Promise((resolve, reject) => {
    c.ws.addEventListener('close', () => reject(Object.assign(new Error('ws-closed'), { code: 'WS_CLOSED' })));
  }); } finally {
    clearInterval(poll);clearInterval(pickPoll);gallery.disconnect();c.close();
    if(activeSession.c===c) activeSession={c:null,poll:null,pickPoll:null};
  }
}

let activeSession = { c: null, poll: null, pickPoll: null };
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(sig + ' → 清理并退出');
  clearInterval(activeSession.poll);
  clearInterval(activeSession.pickPoll);
  if (activeSession.c) await cleanupAll(activeSession.c).catch(() => {});
  try { activeSession.c?.close(); } catch {}
  try { gallery.stop(); } catch {}
  process.exit(0);
}

async function main() {
  if (args.watchdog) {
    await runWorkBuddyWatchdog({args,dataDir:DATA_DIR,pidFile:RUNNER_PID_FILE,runner:fileURLToPath(import.meta.url),log});
    return;
  }
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  await runWorkBuddyGuardian({args,adapter:A,repairChain,log,session,safeErrorCode,
    stateFile:path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'beautiCode','hosts','workbuddy','guardian-state.json'),
    getPort:()=>PORT,
    setPort:(port,launched=false)=>{
      if(!A.WORKBUDDY_CDP_LAUNCH_PORTS.includes(port)&&!launched)return;
      if(PORT!==port){PORT=port;persistPortSelection(PORT);}
    },
  });
}
main().catch((e) => { log.error('runner-fatal', safeErrorCode(e)); process.exit(1); });
