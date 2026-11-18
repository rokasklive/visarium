/**
 * Camera → Konva stage attributes.
 *
 * The stage is moved, not the items. One transform on the stage costs nothing;
 * repositioning every node would cost everything.
 */

import type { Camera, ViewportSize } from '@visarium/canvas-core';

export interface StageAttrs {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export function toStageAttrs(camera: Camera, size: ViewportSize): StageAttrs {
  return {
    x: size.width / 2 - camera.x * camera.zoom,
    y: size.height / 2 - camera.y * camera.zoom,
    scaleX: camera.zoom,
    scaleY: camera.zoom,
  };
}
