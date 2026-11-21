import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { assertStableMedia, validateLocalMedia } from './wb-media-validation.mjs';

export function createWorkBuddyFilePicker({core,evaluate,log,safeErrorCode}) {
// ── 原生文件选择器（DSH「宿主接管文件选择」的移植） ────────────────────
// WorkBuddy renderer 拦程序化 file chooser（Page.fileChooserOpened 未触发），
// 所以面板「选择文件」只发 __bcPickRequest，由守护开系统原生对话框并回填路径。


async function pickFileNative() {
  // 注意：回调里不能引用外层 await 解构的 stdout（TDZ → ReferenceError 当场崩掉守护，
  // 实测踩过：用户一选完文件守护就死，KeepAlive 拉回来时注入已被清理）。回调参数独立命名。
  if (platform() === 'darwin') {
    return await new Promise((resolve, reject) => {
      execFile('osascript', ['-e',
        'POSIX path of (choose file with prompt "选择背景图片或视频")'],
        (err, so) => err ? reject(err) : resolve(String(so).trim()));
    });
  }
  if (platform() === 'win32') {
    const ps = [
      "$ErrorActionPreference='Stop'",
      // Windows PowerShell 5 writes redirected console output in the active
      // OEM code page by default. Node decodes the pipe as UTF-8, so a media
      // path containing Chinese characters used to arrive as U+FFFD and the
      // renderer later reported MEDIA_ERR_SRC_NOT_SUPPORTED. Pin both output
      // channels to UTF-8 before the dialog prints its selected path.
      "$OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
      "[Console]::OutputEncoding=$OutputEncoding",
      "Add-Type -AssemblyName System.Windows.Forms",
      "Add-Type -AssemblyName System.Drawing",
      "[System.Windows.Forms.Application]::EnableVisualStyles()",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.Text='beautiCode 文件选择器'",
      "$owner.FormBorderStyle=[System.Windows.Forms.FormBorderStyle]::FixedToolWindow",
      "$owner.ShowInTaskbar=$false",
      "$owner.StartPosition=[System.Windows.Forms.FormStartPosition]::CenterScreen",
      "$owner.Size=[System.Drawing.Size]::new(1,1)",
      "$owner.Opacity=0.01",
      "$owner.TopMost=$true",
      "$d=New-Object System.Windows.Forms.OpenFileDialog",
      "$d.Filter='媒体|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp;*.avif;*.mp4;*.mov;*.webm;*.m4v'",
      "$d.Multiselect=$false",
      "$d.CheckFileExists=$true",
      "$d.RestoreDirectory=$true",
      "$d.Title='选择背景图片或视频'",
      "try { [void]$owner.Show(); [void]$owner.Hide(); [void]$owner.Show(); [void]$owner.Activate(); [void]$owner.BringToFront(); [System.Windows.Forms.Application]::DoEvents(); $r=$d.ShowDialog($owner); if($r -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::WriteLine($d.FileName) } } finally { $d.Dispose(); $owner.Close(); $owner.Dispose() }",
    ].join('; ');
    const encoded = Buffer.from(ps, 'utf16le').toString('base64');
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, maxBuffer: 1 << 20 },
        (err, so) => err ? reject(err) : resolve(String(so).trim()));
    });
    if (!out) throw new Error('cancel');
    return out;
  }
  // Linux：zenity 优先，kdialog 回退（KDE 桌面常无 zenity）
  const out = await new Promise((resolve, reject) => {
    execFile('zenity', ['--file-selection', '--title', '选择背景图片或视频'],
      (err, so) => {
        if (!err) return resolve(String(so).trim());
        execFile('kdialog', ['--getopenfilename', '.', 'image/* video/*',
          '::选择背景图片或视频'], (e2, s2) => e2 ? reject(e2) : resolve(String(s2).trim()));
      });
  });
  if (!out) throw new Error('cancel');
  return out;
}

/** 专用快轮询（150ms）：面板「选择文件」请求 → 原生选择器 → 回填路径。
 *  之前 600ms 的轮询延迟是"开选择器卡顿感"的主要可去除成分（实测 osascript
 *  本身仅 ~20ms；对话框首次初始化是系统成本，无法消除，但即时反馈可掩盖）。 */
function startPickWatcher(c) {
  let busy = false;
  return setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const want = await evaluate(c, 'window.__bcPickRequest || 0');
      if (!want) return;
      await evaluate(c, 'window.__bcPickRequest = 0');
      log.info('面板请求文件选择器 → 打开系统对话框');
      let picked = '';
      try { picked = await pickFileNative(); } catch { picked = ''; }
      if (!picked) {
        await evaluate(c, 'window.__bcBackgroundMsg && window.__bcBackgroundMsg("已取消选择。")');
        return;
      }
      const checked = await validateLocalMedia(picked,core);
      picked = checked.path;
      assertStableMedia(picked, checked.identity);
      log.info('file-selected');
      // DSH/Codex 回落路径：不走 file://（视频/权限不可靠），
      // 用 DOM.setFileInputFiles 把真实 File 塞进隐藏 input，再派发 change，
      // 页面 applyBlob 走 blob: URL —— 与路径编码、TCC、CSP 全部解耦。
      // 真实路径先行传递：payload 的 applyBlob 读它记入持久状态（媒体显示仍走
      // blob URL 不变）——否则路径在 setFileInputFiles→blob 链路中丢失，重启无法恢复
      await evaluate(c, 'window.__bcPendingPickPath = ' + JSON.stringify(picked));
      await c.send('DOM.enable');
      const doc = await c.send('DOM.getDocument', { depth: 1 });
      const q = await c.send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#beauticode-workbuddy-bg-panel [data-id="fileInput"]',
      });
      if (!q.result?.nodeId && !q.nodeId) throw new Error('找不到隐藏的文件输入框');
      const nodeId = q.result?.nodeId || q.nodeId;
      await c.send('DOM.setFileInputFiles', { files: [picked], nodeId });
      assertStableMedia(picked, checked.identity);
      await evaluate(c,
        'document.querySelector(\'#beauticode-workbuddy-bg-panel [data-id="fileInput"]\')' +
        '.dispatchEvent(new Event("change", { bubbles: true }));');
      log.info('已回填并触发导入');
    } catch (e) { log.debug('picker-error', safeErrorCode(e)); }
    finally { busy = false; }
  }, 150);
}

// ── 单次连接生命周期 ──────────────────────────────────────────────────

return {start:startPickWatcher};
}
