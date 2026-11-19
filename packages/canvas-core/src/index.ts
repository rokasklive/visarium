/**
 * @visarium/canvas-core — the renderer-independent canvas model.
 *
 * Dependency rule: this package imports nothing from React, Konva or the DOM.
 * Enforced by `pnpm test` (see boundaries.test.ts), not by good intentions.
 */

export * from './camera';
export * from './classify';
export * from './crop';
export * from './document';
export * from './geometry';
export * from './history';
export * from './ids';
export * from './lod';
export * from './model';
export * from './operations';
export * from './outline';
export * from './protocol';
export * from './selection';
export * from './spatial-index';
export * from './viewport';
