import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createDesktopHostEnvironment, terminateWindowsProcessGeneration } from "../../core/dist/index.js";
import { DEFAULT_WORKBUDDY_CDP_PORT, DEFAULT_WORKBUDDY_CDP_PORTS, WORKBUDDY_CDP_ENV_KEY, discoverWorkBuddyCdp, parseRemoteDebuggingFlags, probeCdpPort, probeWorkBuddyCdp, workBuddyCdpPortCandidates, } from "./discovery.js";
const execFileAsync = promisify(execFile);
export const DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS = 10_000;
export const DEFAULT_WORKBUDDY_CDP_POLL_INTERVAL_MS = 200;
export const DEFAULT_WORKBUDDY_FAST_RECONNECT_DELAY_MS = 500;
export const DEFAULT_WORKBUDDY_IDLE_RECONNECT_DELAY_MS = 3_000;
export function classifyWorkBuddyStartupProcess(proc, nowMs = Date.now(), repairWindowMs = DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS) {
    if (proc.port != null)
        return "wait-for-cdp";
    if (proc.createdAtMs == null || !Number.isFinite(proc.createdAtMs)) {
        return "ignore-stale";
    }
    const ageMs = nowMs - proc.createdAtMs;
    return ageMs >= 0 && ageMs < repairWindowMs
        ? "repair-now"
        : "ignore-stale";
}
/** Choose a reconnect cadence without ever granting permission to launch. */
export function selectWorkBuddyReconnectDelay(processes, nowMs = Date.now(), repairWindowMs = DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS) {
    const hasLiveProcess = processes.some((processInfo) => Number.isInteger(processInfo.pid) && processInfo.pid > 0);
    const hasRecentStart = processes.some((processInfo) => processInfo.createdAtMs != null &&
        Number.isFinite(processInfo.createdAtMs) &&
        nowMs >= processInfo.createdAtMs &&
        nowMs - processInfo.createdAtMs < repairWindowMs);
    return hasLiveProcess || hasRecentStart
        ? DEFAULT_WORKBUDDY_FAST_RECONNECT_DELAY_MS
        : DEFAULT_WORKBUDDY_IDLE_RECONNECT_DELAY_MS;
}
function executableFromCommandLine(commandLine) {
    const quoted = commandLine.match(/^\s*["']([^"']+)["']/);
    return quoted?.[1] ?? commandLine.trim().split(/\s+/)[0] ?? "";
}
export function isWorkBuddyMainProcess(commandLine, name, exePath = "", platform = process.platform) {
    if (/\s--type=/.test(commandLine))
        return false;
    const executable = exePath || executableFromCommandLine(commandLine);
    if (!executable)
        return false;
    if (platform === "win32") {
        const quoted = /^\s*"[^"]+"\s*(.*)$/.exec(commandLine);
        const args = quoted
            ? quoted[1] ?? ""
            : /^\s*\S+\s*(.*)$/.exec(commandLine)?.[1] ?? "";
        // WorkBuddy ships helper entrypoints (daemon-app-server and extension
        // servers) through the same executable. They are not the browser main
        // process and must not make a stale/multi-process repair look unsafe.
        if (args && !args.trim().startsWith("--"))
            return false;
        return (name.toLowerCase() === "workbuddy.exe" &&
            path.win32.basename(executable).toLowerCase() === "workbuddy.exe");
    }
    if (platform === "darwin") {
        return /\/WorkBuddy\.app\/Contents\/MacOS\/(?:Electron|WorkBuddy)$/i.test(executable);
    }
    return path.basename(executable).toLowerCase() === "workbuddy";
}
export function parsePsElapsedSeconds(value) {
    const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match)
        return null;
    const days = Number(match[1] ?? 0);
    const hours = Number(match[2] ?? 0);
    const minutes = Number(match[3]);
    const seconds = Number(match[4]);
    if (hours > 23 || minutes > 59 || seconds > 59)
        return null;
    return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}
export function workBuddyInstallCandidates(env = process.env, platform = process.platform) {
    const home = env.HOME || env.USERPROFILE || os.homedir();
    if (platform === "win32") {
        const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        const pf = env.ProgramFiles || "C:\\Program Files";
        const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        return [
            path.join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"),
            path.join(local, "Programs", "WorkBuddyAI", "WorkBuddy.exe"),
            path.join(local, "WorkBuddy", "WorkBuddy.exe"),
            path.join(pf, "WorkBuddy", "WorkBuddy.exe"),
            path.join(pf86, "WorkBuddy", "WorkBuddy.exe"),
        ];
    }
    if (platform === "darwin") {
        return [
            "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
            "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
        ];
    }
    return [];
}
export function findWorkBuddyExecutable(env = process.env, platform = process.platform) {
    for (const candidate of workBuddyInstallCandidates(env, platform)) {
        try {
            if (fs.existsSync(candidate))
                return candidate;
        }
        catch {
            /* ignore */
        }
    }
    return null;
}
export async function isLoopbackPortFree(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return false;
    return await new Promise((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => {
            server.close(() => resolve(true));
        });
    });
}
export async function pickAvailableLoopbackPort(preferred = DEFAULT_WORKBUDDY_CDP_PORT, hooks = {}) {
    const probe = hooks.probeCdp ?? probeCdpPort;
    const probeWorkBuddy = hooks.probeWorkBuddy ?? probeWorkBuddyCdp;
    const isFree = hooks.isPortFree ?? isLoopbackPortFree;
    const ordered = workBuddyCdpPortCandidates(preferred);
    for (const port of ordered) {
        const existing = await probe(port, { timeoutMs: 200 });
        if (!existing && (await isFree(port)))
            return port;
        const workbuddy = await probeWorkBuddy(port, { timeoutMs: 200 });
        if (workbuddy)
            return port;
    }
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = address && typeof address === "object" ? address.port : preferred;
            server.close(() => resolve(port));
        });
    });
}
async function scanWindowsWorkBuddyProcesses() {
    const script = [
        "$ErrorActionPreference='SilentlyContinue';",
        "Get-CimInstance Win32_Process | ForEach-Object {",
        "$cmd=$_.CommandLine;",
        "if(-not $cmd){return};",
        "if($cmd -match '\\s--type='){return};",
        "if($_.Name -ine 'WorkBuddy.exe'){return};",
        "$created=0;",
        "try{$created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}catch{};",
        "$o=@{pid=$_.ProcessId;name=$_.Name;exe=$_.ExecutablePath;cmd=$cmd;created=$created};",
        "($o | ConvertTo-Json -Compress -Depth 3)",
        "}",
    ].join(" ");
    try {
        const { stdout } = await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ], { windowsHide: true, timeout: 12_000, maxBuffer: 4 * 1024 * 1024 });
        const found = [];
        for (const line of String(stdout ?? "").split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{"))
                continue;
            let row;
            try {
                row = JSON.parse(trimmed);
            }
            catch {
                continue;
            }
            const commandLine = typeof row.cmd === "string" ? row.cmd : "";
            const name = typeof row.name === "string" ? row.name : "unknown";
            const executablePath = typeof row.exe === "string" ? row.exe : "";
            if (!isWorkBuddyMainProcess(commandLine, name, executablePath, "win32")) {
                continue;
            }
            const flags = parseRemoteDebuggingFlags(commandLine);
            found.push({
                pid: Number(row.pid) || 0,
                name,
                executablePath,
                commandLine,
                port: flags.safe ? flags.port : null,
                createdAtMs: Number.isFinite(Number(row.created)) && Number(row.created) > 0
                    ? Number(row.created)
                    : null,
            });
        }
        return found;
    }
    catch {
        throw Object.assign(new Error('WorkBuddy process scan failed.'), { code: 'WB_PROCESS_SCAN_FAILED' });
    }
}
async function scanUnixWorkBuddyProcesses() {
    try {
        const elapsedField = process.platform === "darwin" ? "etime=" : "etimes=";
        const { stdout } = await execFileAsync("ps", [
            "-axo",
            `pid=,${elapsedField},command=`,
        ], {
            timeout: 5_000,
            maxBuffer: 4 * 1024 * 1024,
        });
        const found = [];
        for (const line of String(stdout ?? "").split(/\n/)) {
            const match = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
            if (!match)
                continue;
            const commandLine = match[3] ?? "";
            const executablePath = executableFromCommandLine(commandLine);
            const processName = path.basename(executablePath);
            if (!isWorkBuddyMainProcess(commandLine, processName, executablePath, process.platform)) {
                continue;
            }
            const flags = parseRemoteDebuggingFlags(commandLine);
            const elapsedSeconds = process.platform === "darwin"
                ? parsePsElapsedSeconds(match[2] ?? "")
                : Number(match[2]);
            found.push({
                pid: Number(match[1]) || 0,
                name: "WorkBuddy",
                executablePath,
                commandLine,
                port: flags.safe ? flags.port : null,
                createdAtMs: elapsedSeconds != null && Number.isFinite(elapsedSeconds)
                    ? Date.now() - elapsedSeconds * 1_000
                    : null,
            });
        }
        return found;
    }
    catch {
        return [];
    }
}
export async function listWorkBuddyProcesses() {
    if (process.platform === "win32")
        return scanWindowsWorkBuddyProcesses();
    return scanUnixWorkBuddyProcesses();
}
export async function stopWorkBuddyProcesses(procs) {
    for (const proc of procs) {
        if (!proc.pid || proc.pid <= 0)
            continue;
        if (process.platform === "win32") {
            await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/T"], {
                windowsHide: true,
                timeout: 8_000,
            }).catch(() => { });
        }
        else {
            try {
                process.kill(proc.pid, "SIGTERM");
            }
            catch {
                /* already gone */
            }
        }
    }
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const still = await listWorkBuddyProcesses();
        if (still.length === 0)
            return;
        await delay(200);
    }
    for (const proc of await listWorkBuddyProcesses()) {
        if (process.platform === "win32") {
            await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, timeout: 8_000 }).catch(() => { });
        }
        else {
            try {
                process.kill(proc.pid, "SIGKILL");
            }
            catch {
                /* ignore */
            }
        }
    }
}
export async function launchWorkBuddyWithCdp(port, executable) {
    const env = createDesktopHostEnvironment(process.env, {
        [WORKBUDDY_CDP_ENV_KEY]: String(port),
    });
    const child = spawn(executable, [], {
        detached: true,
        stdio: "ignore",
        env,
        windowsHide: false,
    });
    await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
    child.unref();
}
export async function stopFreshWorkBuddyProcess(proc) {
    if (!proc.pid || proc.pid <= 0)
        return false;
    if (process.platform === "win32") {
        return terminateWindowsProcessGeneration(proc, true);
    }
    try {
        process.kill(proc.pid, "SIGTERM");
        return true;
    }
    catch {
        return false;
    }
}
export async function waitForWorkBuddyCdp(ports, timeoutMs, options = {}) {
    const discover = options.discover ?? discoverWorkBuddyCdp;
    const sleep = options.sleep ?? delay;
    const now = options.now ?? Date.now;
    const candidates = [
        ...new Set([...ports, ...DEFAULT_WORKBUDDY_CDP_PORTS]),
    ];
    const deadline = now() + Math.max(1_000, timeoutMs);
    while (now() < deadline) {
        const hit = await discover({
            ports: candidates,
            timeoutMs: 400,
        });
        if (hit)
            return hit;
        await sleep(DEFAULT_WORKBUDDY_CDP_POLL_INTERVAL_MS);
    }
    return null;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=launch.js.map