/**
 * @visarium/canvas-renderer-konva
 *
 * The Konva adapter layer. Depends on canvas-core; core never depends on this.
 *
 * Scope today is the conversion boundary — the part of the renderer choice that
 * is genuinely architectural. The scene graph itself arrives with M01, when
 * there is a real canvas to draw.
 */

export * from './aggregate';
export * from './stage-camera';
export * from './transform';
