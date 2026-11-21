import { setTimeout as delay } from 'node:timers/promises';
import { createWorkBuddyRecovery, WORKBUDDY_MANUAL_CODES } from './wb-guardian-state.mjs';
import { workBuddyLaunchActive } from './wb-startup-coordination.mjs';

/** The host's retry policy lives separately from page injection and media state. */
export async function runWorkBuddyGuardian({args,adapter,repairChain,log,stateFile,getPort,setPort,session,safeErrorCode}) {
  const recovery = createWorkBuddyRecovery({file:stateFile,guardianPid:args.watchdogChild ? process.ppid : process.pid});
  async function ensure(processes) {
    if (!recovery.observe(processes) || workBuddyLaunchActive()) return;
    try {
      const ready=await adapter.ensureWorkBuddyCdp({preferredPort:getPort(),launch:!args.noLaunch,
        launchIfMissing:false,restartIfBlind:!args.noLaunch,repairWindowMs:10_000,
        timeoutMs:args.once?15_000:20_000,repairChain,log});
      setPort(ready.port, ready.launched || ready.restarted);
    } catch(error) {
      const code=safeErrorCode(error);
      if(args.once||args.noLaunch) throw error;
      if(WORKBUDDY_MANUAL_CODES.has(code)) {
        if(recovery.block(code,processes)) log.warn('manual-intervention',code,'请正常退出 WorkBuddy，再通过背景快捷方式或已修复的图标重开。');
      } else log.warn('workbuddy-not-ready',code);
    }
  }
  if(!args.clean) {
    try {await ensure(await adapter.listWorkBuddyProcesses());}
    catch(error) {if(args.once||args.noLaunch) throw error;log.warn('startup-not-ready',safeErrorCode(error));}
  }
  for(;;) {
    let reconnectDelayMs=3_000;
    let processes;
    try {
      processes=await adapter.listWorkBuddyProcesses();
      repairChain.observeSnapshot(processes);
      reconnectDelayMs=adapter.selectWorkBuddyReconnectDelay(processes);
      const repairAllowed=recovery.observe(processes);
      // A launcher owns this startup until its receipt is verified. Observation
      // continues, but the guardian must not restart its just-created client.
      if(!repairAllowed) {
        const endpoint=await adapter.discoverWorkBuddyCdp({ports:[getPort()],timeoutMs:450});
        if(endpoint) {setPort(endpoint.port);recovery.connected();}
        else {await delay(reconnectDelayMs);continue;}
      }
      log.info(`连接 http://127.0.0.1:${getPort()} …`);
      await session(()=>recovery.connected());
    } catch(error) {
      if(args.once||args.noLaunch) throw error;
      log.warn('connection-lost',safeErrorCode(error));
      if(processes?.length) await ensure(processes);
    }
    if(args.once) return;
    await delay(reconnectDelayMs);
  }
}

export function parseWorkBuddyRunnerArgs(argv) {
  const o = { port: 0, once: false, clean: false, verbose: false, help: false, watchdog: false, noLaunch: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = parseInt(argv[++i], 10);
    else if (a === '--wallpaper') o.wallpaper = argv[++i];
    else if (a === '--once') o.once = true;
    else if (a === '--clean') o.clean = true;
    else if (a === '--verbose' || a === '-v') o.verbose = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--watchdog') o.watchdog = true;
    else if (a === '--no-launch') o.noLaunch = true;
    else if (a === '--watchdog-child') o.watchdogChild = true;
    else if (a.startsWith('--port=')) o.port = parseInt(a.slice(7), 10);
  }
  return o;
}
