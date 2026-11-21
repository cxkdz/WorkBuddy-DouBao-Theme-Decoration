import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_WORKBUDDY_CDP_PORT, DEFAULT_WORKBUDDY_CDP_PORTS, WORKBUDDY_CDP_ENV_KEY, discoverWorkBuddyCdp, probeForeignCdp, } from "./discovery.js";
import { DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS, classifyWorkBuddyStartupProcess, listWorkBuddyProcesses, waitForWorkBuddyCdp, pickAvailableLoopbackPort, findWorkBuddyExecutable, launchWorkBuddyWithCdp, stopFreshWorkBuddyProcess, } from "./launch.js";
function workBuddyCdpError(code, message) {
    return Object.assign(new Error(message), { code });
}
/**
 * Codex-style ensure: attach if a WorkBuddy CDP is already up; otherwise
 * launch (or restart a blind instance) with WORKBUDDY_REMOTE_DEBUGGING_PORT.
 */
export async function ensureWorkBuddyCdp(opts = {}) {
    const log = opts.log;
    const ensureStartedAt = Date.now();
    const reportElapsed = (stage, result) => {
        log?.info(`WorkBuddy 启动诊断 stage=${stage} elapsedMs=${Math.max(0, Date.now() - ensureStartedAt)} result=${result}`);
    };
    const preferred = opts.preferredPort ?? DEFAULT_WORKBUDDY_CDP_PORT;
    const launch = opts.launch !== false;
    const launchIfMissing = opts.launchIfMissing !== false;
    const restartIfBlind = opts.restartIfBlind !== false;
    const repairWindowMs = opts.repairWindowMs ?? DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS;
    const timeoutMs = opts.timeoutMs ?? 40_000;
    const hooks = opts.hooks ?? {};
    const discover = hooks.discover ?? discoverWorkBuddyCdp;
    const probeForeign = hooks.probeForeignCdp ?? probeForeignCdp;
    const listProcesses = hooks.listProcesses ?? listWorkBuddyProcesses;
    const waitForCdp = hooks.waitForCdp ?? waitForWorkBuddyCdp;
    const pickPort = hooks.pickPort ?? pickAvailableLoopbackPort;
    const findExecutable = hooks.findExecutable ?? findWorkBuddyExecutable;
    const launchWithCdp = hooks.launchWithCdp ?? launchWorkBuddyWithCdp;
    const stopFresh = hooks.stopFresh ?? stopFreshWorkBuddyProcess;
    const existing = await discover({
        ports: [preferred, ...DEFAULT_WORKBUDDY_CDP_PORTS],
        timeoutMs: 450,
    });
    reportElapsed("initial-cdp-probe", existing ? "connected" : "missing");
    if (existing) {
        opts.repairChain?.markVerified();
        return { ...existing, launched: false, restarted: false };
    }
    if (!launch) {
        throw new Error(`WorkBuddy CDP is missing on loopback (preferred ${preferred}). Start WorkBuddy with ${WORKBUDDY_CDP_ENV_KEY}.`);
    }
    const procs = await listProcesses();
    opts.repairChain?.observeSnapshot(procs);
    reportElapsed("process-scan", procs.length === 0 ? "closed" : `count-${procs.length}`);
    let restarted = false;
    if (procs.length > 0) {
        const hasCdp = procs.some((p) => p.port != null);
        if (!hasCdp && restartIfBlind) {
            const repairable = procs.filter((proc) => classifyWorkBuddyStartupProcess(proc, Date.now(), repairWindowMs) ===
                "repair-now");
            if (repairable.length !== 1 || procs.length !== 1) {
                throw workBuddyCdpError(procs.length !== 1 ? "WB_REPAIR_AMBIGUOUS" : "WB_REPAIR_STALE", "WorkBuddy 已运行超过 10 秒或存在多个主进程；为保护用户会话，不自动重启。");
            }
            const proc = repairable[0];
            // An env-enabled launch has no port flag in its command line. Give the
            // renderer time to publish CDP before treating it as a blind launch.
            const settling = await waitForCdp([preferred, ...DEFAULT_WORKBUDDY_CDP_PORTS], Math.min(timeoutMs, 2_000));
            if (settling) {
                opts.repairChain?.markVerified();
                return { ...settling, launched: false, restarted: false };
            }
            if (opts.repairChain && !opts.repairChain.claim(proc)) {
                throw workBuddyCdpError("WB_REPAIR_SUPPRESSED", "WorkBuddy 本次启动链已尝试修复；等待用户正常关闭后重开。 ");
            }
            log?.warn(`WorkBuddy 新主进程 ${proc.pid} 没有 CDP，正在执行一次修复性重启…`);
            if (!(await stopFresh(proc))) {
                throw workBuddyCdpError("WB_REPAIR_EXITED", "WorkBuddy 新主进程已退出，取消本次自动重启。");
            }
            await delay(120);
            restarted = true;
            reportElapsed("fresh-client-stopped", "relaunching");
        }
        else if (hasCdp) {
            const declaredPorts = procs
                .map((proc) => proc.port)
                .filter((port) => port != null);
            const foreign = (await Promise.all([...new Set(declaredPorts)].map((port) => probeForeign(port, { timeoutMs: 200 }).catch(() => false)))).some(Boolean);
            // A foreign page target is conclusive: do not spend the 2s settling
            // grace waiting for WorkBuddy to appear on a port it does not own.
            // Without a target, keep the grace because Chromium may still be
            // creating WorkBuddy's renderer.
            const waiting = foreign
                ? null
                : await waitForCdp(declaredPorts, Math.min(timeoutMs, 2_000));
            if (waiting) {
                opts.repairChain?.markVerified();
                return { ...waiting, launched: false, restarted: false };
            }
            const now = Date.now();
            const repairable = procs.filter((proc) => proc.port != null &&
                proc.createdAtMs != null &&
                now >= proc.createdAtMs &&
                now - proc.createdAtMs < repairWindowMs);
            if (restartIfBlind && repairable.length === 1 && procs.length === 1) {
                const proc = repairable[0];
                if (opts.repairChain && !opts.repairChain.claim(proc)) {
                    throw workBuddyCdpError("WB_REPAIR_SUPPRESSED", "WorkBuddy 本次启动链已尝试修复；等待用户正常关闭后重开。 ");
                }
                log?.warn(`WorkBuddy 新主进程 ${proc.pid} 声明端口 ${proc.port} 但未出现 WorkBuddy 页面，正在执行一次端口修复性重启…`);
                if (!(await stopFresh(proc))) {
                    throw workBuddyCdpError("WB_REPAIR_EXITED", "WorkBuddy 新主进程已退出，取消本次自动重启。");
                }
                await delay(120);
                restarted = true;
                reportElapsed("blind-port-client-stopped", "relaunching");
            }
            else {
                throw workBuddyCdpError("WB_CDP_NO_TARGET", "WorkBuddy 进程带有调试端口，但本机没有 WorkBuddy 目标页。");
            }
        }
        else if (!restartIfBlind) {
            throw workBuddyCdpError("WB_ALREADY_RUNNING_WITHOUT_CDP", "WorkBuddy 已在运行但未开启 CDP。请退出后用带 WORKBUDDY_REMOTE_DEBUGGING_PORT 的方式启动。");
        }
    }
    else if (!launchIfMissing) {
        throw workBuddyCdpError("WB_HOST_CLOSED", "WorkBuddy 未运行；等待用户从原始图标启动。");
    }
    const exe = findExecutable() ||
        parseExecutableFromCommand(procs[0]?.commandLine ?? "");
    if (!exe) {
        throw workBuddyCdpError("WB_EXECUTABLE_NOT_FOUND", "找不到 WorkBuddy。请先安装，或用带 WORKBUDDY_REMOTE_DEBUGGING_PORT 的方式启动它。");
    }
    const port = await pickPort(preferred);
    log?.info(`带 ${WORKBUDDY_CDP_ENV_KEY}=${port} 启动 WorkBuddy`);
    await launchWithCdp(port, exe);
    if (restarted)
        opts.repairChain?.markLaunched();
    reportElapsed("client-relaunched", "awaiting-cdp");
    const ready = await waitForCdp([port], timeoutMs);
    reportElapsed("cdp-verification", ready ? "connected" : "timeout");
    if (!ready) {
        throw workBuddyCdpError("WB_CDP_TIMEOUT", `已启动 WorkBuddy，但 ${timeoutMs}ms 内未出现本机 CDP。请确认官方版本仍读取 ${WORKBUDDY_CDP_ENV_KEY}。`);
    }
    opts.repairChain?.markVerified();
    return { ...ready, launched: true, restarted };
}
function parseExecutableFromCommand(commandLine) {
    if (!commandLine)
        return null;
    const quoted = commandLine.match(/^"([^"]+\.(?:exe|app\/Contents\/MacOS\/[^"]+))"/i);
    if (quoted?.[1] && fs.existsSync(quoted[1]))
        return quoted[1];
    const first = commandLine.split(/\s+/)[0];
    if (first && fs.existsSync(first))
        return first;
    return null;
}
//# sourceMappingURL=ensure.js.map