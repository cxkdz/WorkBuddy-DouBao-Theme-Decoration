/** Build a fresh environment for launching a desktop Electron host. */
export function createDesktopHostEnvironment(inherited = process.env, overrides = {}) {
    const env = { ...inherited, ...overrides };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}
//# sourceMappingURL=desktop-host-environment.js.map