/**
 * Whether this build carries the developer tools (spec: canvas/inspector).
 *
 * Decided when the bundle is built, never at run time: `vite dev`, or
 * `pnpm build:dev` (Vite's `devtools` mode). Vite replaces both operands with
 * literals, so in a production build this is `false`, every branch on it is
 * dead code, and Rollup never emits what only those branches import. No query
 * parameter, key or setting can bring the tools back into a production bundle,
 * because they are not in it — `scripts/check-bundle.mjs` checks that.
 */
/** Width the board gives up while the inspector is open, in CSS px. */
export const INSPECTOR_WIDTH = 380;

export const DEVTOOLS: boolean = import.meta.env.DEV || import.meta.env.VITE_DEVTOOLS === '1';
