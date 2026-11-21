import { buildDesktopBackgroundCleanup, buildDesktopBackgroundInjection, } from "../../adapter-desktop-cdp/dist/index.js";
import { CURSOR_CDP_SPEC } from "./spec.js";
export { CURSOR_HOST_DESCRIPTOR } from "./host-descriptor.js";
export { CURSOR_CDP_SPEC, cursorExecutableCandidates } from "./spec.js";
export function buildCursorBackgroundInjection(galleryUrl = "") {
    return buildDesktopBackgroundInjection(CURSOR_CDP_SPEC, galleryUrl);
}
export function buildCursorBackgroundCleanup() {
    return buildDesktopBackgroundCleanup("cursor");
}
//# sourceMappingURL=index.js.map