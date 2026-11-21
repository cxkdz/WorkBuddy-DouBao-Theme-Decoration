import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.basename(here).toLowerCase() === 'scripts' ? path.dirname(here) : here;

const SAFE_FAILURE_CODES = new Set([
  'multiple-main-processes',
  'already-running-without-cdp',
  'cdp-target-unavailable',
  'executable-not-found',
  'windows-only',
  'unsupported-host',
  'WB_EXECUTABLE_NOT_FOUND',
  'WB_ALREADY_RUNNING_WITHOUT_CDP',
  'WB_CDP_TIMEOUT',
  'WB_CDP_NO_TARGET',
  'WB_REPAIR_AMBIGUOUS',
  'WB_REPAIR_STALE',
  'WB_REPAIR_SUPPRESSED',
  'WB_REPAIR_EXITED',
  'WB_HOST_CLOSED',
  'WB_PROCESS_SCAN_FAILED', 'WB_CONNECTION_UNVERIFIED', 'WB_CDP_OWNER_MISMATCH', 'WB_CLIENT_CHANGED', 'WB_LAUNCH_IN_PROGRESS',
]);

export function quickLaunchFailureCode(error) {
  if (error instanceof Error && SAFE_FAILURE_CODES.has(error.code)) return error.code;
  return error instanceof Error && SAFE_FAILURE_CODES.has(error.message)
    ? error.message
    : 'unexpected-error';
}

async function load(relative) {
  return import(pathToFileURL(path.join(runtimeRoot, relative)).href);
}

async function launchDesktop(host, options) {
  const shared = await load('packages/adapter-desktop-cdp/dist/index.js');
  const adapter = await load(`packages/adapter-${host}/dist/index.js`);
  const spec = host === 'cursor' ? adapter.CURSOR_CDP_SPEC : adapter.DOUBAO_CDP_SPEC;
  const { launchDesktopQuickHost } = await import('./desktop-quick-launch.mjs');
  const ready = await launchDesktopQuickHost(spec, {
    listProcesses: shared.listDesktopProcesses,
    findExecutable: shared.findDesktopExecutable,
    pickPort: shared.pickAvailableDesktopPort,
    launchWithCdp: shared.launchDesktopWithCdp,
    discover: shared.discoverDesktopCdp,
  });
  options.onVerified?.(ready.verification);
  return ready.result;
}

export async function runQuickLaunch(host, options = {}) {
  if (process.platform !== 'win32') throw new Error('windows-only');
  if (host === 'codex-plugin') {
    const packed = path.join(runtimeRoot, 'vendor', 'adapter-codex', 'index.js');
    const { ensureCodexCdp } = await load(fs.existsSync(packed)
      ? 'vendor/adapter-codex/index.js'
      : 'packages/adapter-codex/dist/index.js');
    const ready = await ensureCodexCdp({ restartIfBlind: false, timeoutMs: 20_000 });
    return ready.launched ? 'connected' : 'already-connected';
  }
  if (host === 'workbuddy') {
    const { withWorkBuddyLaunch } = await import('./wb-startup-coordination.mjs');
    return withWorkBuddyLaunch(async () => {
      const { ensureWorkBuddyCdp, verifyWorkBuddyConnection } = await load('packages/adapter-workbuddy/dist/index.js');
      const portFile = path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'beauticode','workbuddy-port.json');
      let preferredPort;
      try { const value=JSON.parse(fs.readFileSync(portFile,'utf8')).port; if(Number.isInteger(value)&&value>0&&value<=65535) preferredPort=value; } catch {}
      const ready = await ensureWorkBuddyCdp({ preferredPort, restartIfBlind: false, timeoutMs: 20_000 });
      const receipt = await verifyWorkBuddyConnection(ready.port);
      options.onVerified?.(receipt);
      return ready.launched ? 'connected' : 'already-connected';
    });
  }
  if (host === 'cursor' || host === 'doubao') return launchDesktop(host, options);
  throw new Error('unsupported-host');
}

async function main() {
  const host = String(process.argv[2] || '').toLowerCase();
  const dataHost = host === 'codex-plugin' ? 'codex' : host;
  const file = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'beautiCode', 'hosts', dataHost, 'quick-launch.json');
  let state;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    let verification;
    const result = await runQuickLaunch(host, { onVerified: value => { verification = value; } });
    state = { at: new Date().toISOString(), startedAt, durationMs: Date.now() - started,
      result, meaning: 'last-startup-result', ...(verification ? {verification} : {}) };
  } catch (error) {
    // The shortcut is hidden; retain a bounded local diagnostic without URLs or command lines.
    state = { at: new Date().toISOString(), startedAt, durationMs: Date.now() - started,
      result: 'failed', reason: quickLaunchFailureCode(error), meaning: 'last-startup-result' };
    process.exitCode = 1;
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(state) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(state) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  await main();
}
