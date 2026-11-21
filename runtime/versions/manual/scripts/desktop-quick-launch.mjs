/** Cursor/Doubao shortcuts follow guardian replacements but never relaunch a
 * running client. Two observations bind a receipt to one process generation,
 * its advertised host-approved port and the same matched page. */
export async function launchDesktopQuickHost(spec, operations) {
  const { listProcesses, findExecutable, pickPort, launchWithCdp, discover,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = operations;
  const deadline = now() + 30_000;
  const allowedPorts = new Set([spec.defaultPort, ...spec.candidatePorts]);
  const initial = await listProcesses(spec);
  if (initial.length > 1) throw new Error('multiple-main-processes');
  if (initial.length === 1 && initial[0].port == null) throw new Error('already-running-without-cdp');
  const launched = initial.length === 0;
  if (launched) {
    const executable = findExecutable(spec);
    if (!executable) throw new Error('executable-not-found');
    const port = await pickPort(spec);
    await launchWithCdp(executable, port);
  }
  let previous = null;
  while (now() < deadline) {
    const processes = await listProcesses(spec);
    if (processes.length > 1) throw new Error('multiple-main-processes');
    const client = processes.length === 1 ? processes[0] : null;
    if (client && Number.isInteger(client.pid) && client.pid > 0 &&
        Number.isFinite(client.createdAtMs) && client.createdAtMs > 0 && allowedPorts.has(client.port)) {
      // Discover only the live client's allowlisted port: an old requested port
      // may belong to another process after the guardian has replaced a client.
      const endpoint = await discover(spec, [client.port]);
      const confirmation = await listProcesses(spec);
      const same = confirmation.length === 1 && confirmation[0].pid === client.pid &&
        confirmation[0].createdAtMs === client.createdAtMs && confirmation[0].port === client.port;
      const key = endpoint?.port === client.port && endpoint.target?.id && same
        ? `${client.pid}:${client.createdAtMs}:${client.port}:${endpoint.target.id}` : null;
      if (key && key === previous && now() < deadline) {
        return { result: launched ? 'connected' : 'already-connected', verification: {
          pid: client.pid, clientGeneration: `${client.pid}:${client.createdAtMs}`,
          port: client.port, verifiedAt: new Date(now()).toISOString(),
        } };
      }
      previous = key;
    } else previous = null;
    if (now() < deadline) await sleep(Math.min(250, deadline - now()));
  }
  throw new Error('cdp-target-unavailable');
}
