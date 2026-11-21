import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { listWorkBuddyProcesses } from './launch.js';
import { probeWorkBuddyCdp } from './discovery.js';
const execute = promisify(execFile);
const failure = (code) => Object.assign(new Error(code), { code });
async function listeningOwner(port) {
    if (process.platform !== 'win32')
        throw failure('WB_CONNECTION_UNVERIFIED');
    const script = `$ErrorActionPreference='Stop'; $owners=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Where-Object {$_.LocalAddress -in '127.0.0.1','::1','0.0.0.0','::'} | Select-Object -ExpandProperty OwningProcess -Unique); if($owners.Count -eq 1){[Console]::Write($owners[0])}`;
    try {
        const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5_000, maxBuffer: 4096 });
        const pid = Number(stdout.trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    catch {
        throw failure('WB_CONNECTION_UNVERIFIED');
    }
}
/** A startup receipt, not a promise that the client will remain open forever. */
export async function verifyWorkBuddyConnection(port, options = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw failure('WB_CONNECTION_UNVERIFIED');
    const interval = options.intervalMs ?? 1_500;
    if (!Number.isInteger(interval) || interval < 0 || interval > 3_000)
        throw failure('WB_CONNECTION_UNVERIFIED');
    const scan = options.hooks?.listProcesses ?? listWorkBuddyProcesses;
    const probe = options.hooks?.probe ?? probeWorkBuddyCdp;
    const owner = options.hooks?.owner ?? listeningOwner;
    let generation;
    let receipt;
    for (let sample = 0; sample < 3; sample++) {
        if (sample)
            await delay(interval);
        const processes = await scan();
        if (!processes.length)
            throw failure('WB_HOST_CLOSED');
        if (processes.length !== 1)
            throw failure('WB_REPAIR_AMBIGUOUS');
        const primary = processes[0];
        const current = `${primary.pid}:${primary.createdAtMs}`;
        if (generation && generation !== current)
            throw failure('WB_CLIENT_CHANGED');
        generation = current;
        if (!await probe(port, { timeoutMs: 700 }))
            throw failure('WB_CDP_NO_TARGET');
        if (await owner(port) !== primary.pid)
            throw failure('WB_CDP_OWNER_MISMATCH');
        const final = await scan();
        if (final.length !== 1 || `${final[0].pid}:${final[0].createdAtMs}` !== current)
            throw failure('WB_HOST_CLOSED');
        receipt = { pid: primary.pid, clientGeneration: primary.createdAtMs, port, verifiedAt: new Date().toISOString() };
    }
    return receipt;
}
//# sourceMappingURL=verification.js.map