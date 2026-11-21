import fs from 'node:fs';
import { spawn } from 'node:child_process';
export async function runWorkBuddyWatchdog({args,dataDir:DATA_DIR,pidFile:RUNNER_PID_FILE,runner,log}) {
  if (args.once || args.clean) {
    throw new Error('--watchdog 不能与 --once 或 --clean 同时使用');
  }
  let child = null;
  let stopping = false;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const owner = {
    schema: 'beauticode.wb-runner/v1', pid: process.pid,
    startedAtMs: Date.now(), image: process.execPath,
    runner: runner, pidFile: RUNNER_PID_FILE,
  };
  try { fs.writeFileSync(RUNNER_PID_FILE, JSON.stringify(owner) + '\n', 'utf8'); } catch { /* best effort */ }
  const releasePid = () => {
    try {
      if (JSON.parse(fs.readFileSync(RUNNER_PID_FILE, 'utf8')).pid === process.pid) {
        fs.rmSync(RUNNER_PID_FILE, { force: true });
      }
    } catch { /* already gone */ }
  };
  const start = () => {
    if (stopping) return;
    const childArgs = [...process.argv.slice(2).filter((a) => a !== '--watchdog'), '--watchdog-child'];
    child = spawn(process.execPath, [runner, ...childArgs], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    child.on('exit', (code, signal) => {
      if (stopping) process.exit(code ?? 0);
      log.warn(`runner 退出（${code ?? signal}），1s 后拉起`);
      setTimeout(start, 1000);
    });
  };
  const stop = () => {
    stopping = true;
    releasePid();
    if (child?.pid) {
      try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    setTimeout(() => process.exit(0), 800);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', releasePid);
  start();
  await new Promise(() => {});
}

