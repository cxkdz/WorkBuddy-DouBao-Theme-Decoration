import { pickWorkBuddyTarget } from "./target.js";
/** Hard cap for CDP discovery JSON (same bound as Codex / upstream #280). */
export const MAX_CDP_JSON_BYTES = 1_000_000;
export const WORKBUDDY_CDP_ENV_KEY = "WORKBUDDY_REMOTE_DEBUGGING_PORT";
export const DEFAULT_WORKBUDDY_CDP_PORT = 9336;
/** New WorkBuddy launches use ports outside Codex's bounded candidate set. */
export const WORKBUDDY_CDP_LAUNCH_PORTS = Object.freeze([
    9336,
    9360,
    9361,
    9362,
    9363,
    9364,
    9365,
    9366,
    9367,
    9368,
    9369,
]);
/** Discovery also checks 9335 to recognize older WorkBuddy installs safely. */
export const DEFAULT_WORKBUDDY_CDP_PORTS = Object.freeze([
    9336,
    9335,
    9222,
    9223,
    9229,
    9230,
    9300,
    9310,
    9320,
    9340,
    9350,
]);
/** Return the bounded, deterministic port order used for WorkBuddy only. */
export function workBuddyCdpPortCandidates(preferred = DEFAULT_WORKBUDDY_CDP_PORT) {
    return WORKBUDDY_CDP_LAUNCH_PORTS.includes(preferred)
        ? [preferred, ...WORKBUDDY_CDP_LAUNCH_PORTS.filter((port) => port !== preferred)]
        : [...WORKBUDDY_CDP_LAUNCH_PORTS];
}
/** Select the first unblocked WorkBuddy candidate without scanning arbitrary ports. */
export function selectWorkBuddyCdpPort(preferred, blocked) {
    return workBuddyCdpPortCandidates(preferred).find((port) => !blocked.has(port)) ?? null;
}
const LOOPBACK_ADDRS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function parseRemoteDebuggingFlags(commandLine) {
    if (typeof commandLine !== "string" || !commandLine) {
        return { port: null, address: null, safe: false };
    }
    const portMatch = commandLine.match(/--remote-debugging-port\s*=\s*(?:"(\d{1,5})"|'(\d{1,5})'|(\d{1,5})\b)/i);
    const addrMatch = commandLine.match(/--remote-debugging-address\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i);
    const portValue = portMatch?.[1] ?? portMatch?.[2] ?? portMatch?.[3];
    const addressValue = addrMatch?.[1] ?? addrMatch?.[2] ?? addrMatch?.[3];
    const port = portValue ? Number(portValue) : null;
    const address = addressValue ? String(addressValue).trim() : null;
    if (port == null || !Number.isInteger(port) || port < 1 || port > 65535) {
        return { port: null, address, safe: false };
    }
    if (address && !LOOPBACK_ADDRS.has(address.toLowerCase())) {
        return { port, address, safe: false };
    }
    return { port, address, safe: true };
}
export async function readBoundedJson(url, opts = {}) {
    const maxBytes = opts.maxBytes ?? MAX_CDP_JSON_BYTES;
    const timeoutMs = opts.timeoutMs ?? 3_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
        if (!res.ok)
            throw new Error(`CDP HTTP ${res.status} for ${url}`);
        const declaredLength = Number(res.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
            throw new Error(`CDP response exceeded ${maxBytes} bytes (declared ${declaredLength}).`);
        }
        if (!res.body)
            throw new Error(`CDP response had no readable body for ${url}`);
        const chunks = [];
        let total = 0;
        const reader = res.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                total += value.byteLength;
                if (total > maxBytes) {
                    await reader.cancel("response exceeded safety cap").catch(() => { });
                    throw new Error(`CDP response exceeded ${maxBytes} bytes while streaming.`);
                }
                chunks.push(value);
            }
        }
        finally {
            reader.releaseLock();
        }
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            buf.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return JSON.parse(new TextDecoder("utf-8").decode(buf));
    }
    finally {
        clearTimeout(timer);
    }
}
export async function probeCdpPort(port, opts = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        return null;
    const browserUrl = `http://127.0.0.1:${port}`;
    try {
        const version = (await readBoundedJson(`${browserUrl}/json/version`, {
            timeoutMs: opts.timeoutMs ?? 450,
        }));
        if (!version || typeof version !== "object")
            return null;
        const endpoint = { browserUrl };
        if (typeof version.webSocketDebuggerUrl === "string") {
            endpoint.webSocketDebuggerUrl = version.webSocketDebuggerUrl;
        }
        if (typeof version.Browser === "string")
            endpoint.browser = version.Browser;
        return endpoint;
    }
    catch {
        return null;
    }
}
async function listTargets(port, timeoutMs) {
    const raw = await readBoundedJson(`http://127.0.0.1:${port}/json/list`, {
        timeoutMs,
    });
    if (!Array.isArray(raw) || raw.length > 500)
        return [];
    const out = [];
    for (const row of raw) {
        if (!row || typeof row !== "object")
            continue;
        const rec = row;
        if (typeof rec.id !== "string" || typeof rec.type !== "string")
            continue;
        const target = {
            id: rec.id,
            type: rec.type,
            url: typeof rec.url === "string" ? rec.url : "",
        };
        if (typeof rec.title === "string")
            target.title = rec.title;
        if (typeof rec.webSocketDebuggerUrl === "string") {
            target.webSocketDebuggerUrl = rec.webSocketDebuggerUrl;
        }
        out.push(target);
    }
    return out;
}
/**
 * Probe a loopback port and keep it only when the page identity is WorkBuddy.
 * Codex often sits on 9335 too — attaching to the wrong host is fail-closed.
 */
export async function probeWorkBuddyCdp(port, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 450;
    const endpoint = await probeCdpPort(port, { timeoutMs });
    if (!endpoint)
        return null;
    let targets = [];
    try {
        targets = await listTargets(port, timeoutMs);
    }
    catch {
        return null;
    }
    if (!pickWorkBuddyTarget(targets))
        return null;
    const found = {
        port,
        browserUrl: endpoint.browserUrl,
        source: "probe",
    };
    if (endpoint.webSocketDebuggerUrl) {
        found.webSocketDebuggerUrl = endpoint.webSocketDebuggerUrl;
    }
    if (endpoint.browser)
        found.browser = endpoint.browser;
    return found;
}
/**
 * Distinguish a foreign CDP owner from a port that is merely settling.
 * An open /json/version response is not enough: Chromium may bind before its
 * first page exists. Only a non-WorkBuddy page target is positive evidence of
 * a foreign owner; an empty target list keeps the normal settling grace.
 */
export async function probeForeignCdp(port, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 200;
    const endpoint = await probeCdpPort(port, { timeoutMs });
    if (!endpoint)
        return false;
    let targets;
    try {
        targets = await listTargets(port, timeoutMs);
    }
    catch {
        return false;
    }
    const pages = targets.filter((target) => target.type === "page" && target.url.length > 0);
    if (pages.length === 0 || pickWorkBuddyTarget(pages))
        return false;
    return true;
}
export async function discoverWorkBuddyCdp(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 450;
    const probe = opts.probe ?? probeWorkBuddyCdp;
    const portSet = new Set();
    for (const p of opts.ports ?? DEFAULT_WORKBUDDY_CDP_PORTS) {
        if (Number.isInteger(p) && p >= 1 && p <= 65535)
            portSet.add(p);
    }
    // Checking a dozen closed ports serially could consume most of the 10 s
    // fresh-process repair window. Probe only the bounded candidates in parallel,
    // then select in the configured priority order regardless of response order.
    const hits = await Promise.all([...portSet].map((port) => probe(port, { timeoutMs })));
    return hits.find((hit) => hit !== null) ?? null;
}
//# sourceMappingURL=discovery.js.map