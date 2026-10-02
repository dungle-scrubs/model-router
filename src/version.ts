/**
 * The version written into every answer and printed by --version. The build
 * injects the package version; tests inject it through vitest's define.
 */
export const ROUTER_VERSION = process.env.MODEL_ROUTER_VERSION ?? "0.0.0-dev";
