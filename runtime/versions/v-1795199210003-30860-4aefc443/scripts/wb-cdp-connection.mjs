const MAX_CDP_JSON_BYTES = 1_000_000;
async function fetchBoundedJson(url) {
  const r = await fetch(url, { redirect: 'error' });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  const declared = Number(r.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_CDP_JSON_BYTES) {
    throw new Error(`CDP JSON exceeded ${MAX_CDP_JSON_BYTES} bytes`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_CDP_JSON_BYTES) {
    throw new Error(`CDP JSON exceeded ${MAX_CDP_JSON_BYTES} bytes`);
  }
  return JSON.parse(buf.toString('utf8'));
}
export async function fetchTargets(port) {
  const list = await fetchBoundedJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) throw new Error('/json/list is not an array');
  if (list.length > 500) throw new Error('/json/list exceeded target count safety cap');
  return list;
}
export function openWs(wsUrl, openTimeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    const send = (method, params = {}, timeoutMs = 0) => new Promise((res, rej) => {
      const i = ++id;
      const timer = timeoutMs ? setTimeout(() => { pending.delete(i); rej(new Error('CDP command timed out')); }, timeoutMs) : null;
      pending.set(i, { res, rej, timer });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (p.timer) clearTimeout(p.timer);
        m.error ? p.rej(new Error(`${m.error.code || ''} ${m.error.message || ''}`.trim())) : p.res(m.result);
        return;
      }
      if (m.method) for (const cb of handlers) { try { cb(m); } catch {} }
    });
    const onEvent = (cb) => handlers.push(cb);
    let openTimer = null;
    if (openTimeoutMs > 0) openTimer = setTimeout(() => { ws.close(); reject(new Error('CDP WebSocket open timed out')); }, openTimeoutMs);
    ws.addEventListener('open', () => {
      if (openTimer) clearTimeout(openTimer);
      resolve({ ws, send, onEvent, close: () => ws.close() });
    }, { once: true });
    ws.addEventListener('error', (e) => { if (openTimer) clearTimeout(openTimer); reject(new Error(`WS error: ${e.message || e}`)); }, { once: true });
    ws.addEventListener('close', () => {
      for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.rej(new Error('CDP WebSocket disconnected')); }
      pending.clear();
    });
  });
}
export async function evaluate(c, expression, timeoutMs = 0) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '').slice(0, 200));
  return r.result?.value;
}
