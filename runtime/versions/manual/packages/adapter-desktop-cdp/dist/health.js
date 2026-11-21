import { assertLoopbackDebuggerUrl, discoverDesktopCdp } from "./cdp.js";
async function connectPage(wsUrl, port, timeoutMs) {
    const url = assertLoopbackDebuggerUrl(wsUrl, port);
    const ws = new WebSocket(url);
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener("message", (event) => {
        let message;
        try {
            message = JSON.parse(String(event.data));
        }
        catch {
            return;
        }
        if (!Number.isInteger(message.id))
            return;
        const request = pending.get(message.id);
        if (!request)
            return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error)
            request.reject(new Error("CDP command failed."));
        else
            request.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP WebSocket open timed out.")), timeoutMs);
        ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket open failed.")); }, { once: true });
    });
    return {
        ws,
        send(method, params = {}) {
            const id = ++nextId;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error("CDP command timed out."));
                }, timeoutMs);
                pending.set(id, { resolve, reject, timer });
                ws.send(JSON.stringify({ id, method, params }));
            });
        },
    };
}
/** Read-only check of the host page contract and injected UI. */
export async function inspectDesktopUiHealth(spec, timeoutMs = 1_200) {
    const empty = (state, cdp = "missing", port = null) => ({
        host: spec.kind, cdp, port, anchor: null, anchorTextMatches: null,
        entry: null, style: null, stage: null, state,
    });
    const endpoint = await discoverDesktopCdp(spec);
    if (!endpoint?.target.webSocketDebuggerUrl)
        return empty("cdp-missing");
    let connection = null;
    try {
        connection = await connectPage(endpoint.target.webSocketDebuggerUrl, endpoint.port, timeoutMs);
        const entryId = `beauticode-${spec.kind}-background-entry`;
        const styleId = `beauticode-${spec.kind}-background-style`;
        const expression = `(() => { const a=document.querySelector(${JSON.stringify(spec.anchorSelector)}); const text=a?String(a.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase():''; return {anchor:!!a,anchorTextMatches:!!a&&text.includes(${JSON.stringify(spec.anchorText.toLowerCase())}),entry:!!document.getElementById(${JSON.stringify(entryId)}),style:!!document.getElementById(${JSON.stringify(styleId)}),stage:!!document.getElementById('beauticode-bg-stage')}; })()`;
        const response = await connection.send("Runtime.evaluate", { expression, returnByValue: true });
        const result = response?.result?.value;
        if (!result || typeof result.anchor !== "boolean")
            return empty("probe-failed", "connected", endpoint.port);
        const snapshot = {
            host: spec.kind, cdp: "connected", port: endpoint.port,
            anchor: result.anchor,
            anchorTextMatches: result.anchorTextMatches === true,
            entry: result.entry === true,
            style: result.style === true,
            stage: result.stage === true,
            state: "ready",
        };
        snapshot.state = !snapshot.anchor || !snapshot.anchorTextMatches
            ? "host-ui-updated"
            : !snapshot.entry
                ? "entry-missing"
                : !snapshot.style || !snapshot.stage
                    ? "partial-injection"
                    : "ready";
        return snapshot;
    }
    catch {
        return empty("probe-failed", "connected", endpoint.port);
    }
    finally {
        try {
            connection?.ws.close();
        }
        catch { /* already closed */ }
    }
}
//# sourceMappingURL=health.js.map