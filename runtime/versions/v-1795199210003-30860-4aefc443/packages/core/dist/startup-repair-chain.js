/**
 * One repair budget for one observed client-launch chain. The host adapter
 * validates executable identity and process count before calling claim().
 * A child of our controlled relaunch is never repaired again, even if the
 * upstream launcher drops its CDP flags. Only verified CDP or a subsequent
 * observed user close releases that budget. A launch that produced no process
 * expires after a bounded settling window.
 */
export class StartupRepairChain {
    now;
    freshWindowMs;
    launchSettleMs;
    handled = new Map();
    active = null;
    constructor(now = Date.now, freshWindowMs = 10_000, launchSettleMs = 30_000) {
        this.now = now;
        this.freshWindowMs = freshWindowMs;
        this.launchSettleMs = launchSettleMs;
    }
    claim(processInfo) {
        const now = this.now();
        const created = processInfo.createdAtMs;
        if (!Number.isInteger(processInfo.pid) || processInfo.pid < 1 ||
            created == null || !Number.isFinite(created) ||
            now < created || now - created >= this.freshWindowMs)
            return false;
        if (this.active) {
            if (this.active.replacementSeen || now - this.active.startedAt < this.launchSettleMs) {
                return false;
            }
            this.active = null;
        }
        const key = `${processInfo.pid}:${created}`;
        if (this.handled.has(key))
            return false;
        this.handled.set(key, now);
        for (const [older, claimedAt] of this.handled) {
            if (now - claimedAt > 300_000)
                this.handled.delete(older);
        }
        this.active = { original: key, startedAt: now, launched: false, replacementSeen: false };
        return true;
    }
    markLaunched() {
        if (this.active)
            this.active.launched = true;
    }
    markVerified() {
        this.active = null;
    }
    markFailed() {
        this.active = null;
    }
    observeSnapshot(processes) {
        if (!this.active?.launched)
            return;
        if (processes.some((row) => row.createdAtMs != null && `${row.pid}:${row.createdAtMs}` !== this.active?.original))
            this.active.replacementSeen = true;
        if (processes.length === 0 && this.active.replacementSeen)
            this.active = null;
    }
}
//# sourceMappingURL=startup-repair-chain.js.map