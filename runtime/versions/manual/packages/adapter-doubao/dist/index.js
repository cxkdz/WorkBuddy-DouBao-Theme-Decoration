import { buildDesktopBackgroundCleanup, buildDesktopBackgroundInjection, } from "../../adapter-desktop-cdp/dist/index.js";
import { DOUBAO_CDP_SPEC } from "./spec.js";
export { DOUBAO_HOST_DESCRIPTOR } from "./host-descriptor.js";
export { DOUBAO_CDP_SPEC } from "./spec.js";
export function buildDoubaoBackgroundInjection(galleryUrl = "") {
    return buildDesktopBackgroundInjection(DOUBAO_CDP_SPEC, galleryUrl);
}
export function buildDoubaoBackgroundCleanup() {
    return buildDesktopBackgroundCleanup("doubao");
}
//# sourceMappingURL=index.js.map