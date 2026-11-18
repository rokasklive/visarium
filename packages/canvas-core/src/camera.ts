/**
 * Camera and viewport.
 *
 * The camera is a pure scale + translate: no rotation, no skew. World and screen
 * axes stay aligned, which keeps the visible region an axis-aligned rect and
 * therefore a direct spatial-index query.
 *
 * `zoom` is screen pixels per world unit. At zoom 1 an item 512 world units wide
 * covers 512 screen pixels.
 */

import { type Rect, rect, type Vec2 } from './geometry';

export interface Camera {
  /** World coordinate at the centre of the viewport. */
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Size of the rendering surface in CSS pixels. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export const MIN_ZOOM = 0.005;
export const MAX_ZOOM = 32;

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function worldToScreen(camera: Camera, size: ViewportSize, p: Vec2): Vec2 {
  return {
    x: (p.x - camera.x) * camera.zoom + size.width / 2,
    y: (p.y - camera.y) * camera.zoom + size.height / 2,
  };
}

export function screenToWorld(camera: Camera, size: ViewportSize, p: Vec2): Vec2 {
  return {
    x: (p.x - size.width / 2) / camera.zoom + camera.x,
    y: (p.y - size.height / 2) / camera.zoom + camera.y,
  };
}

/** The world-space rect currently visible. */
export function visibleWorldRect(camera: Camera, size: ViewportSize): Rect {
  const halfW = size.width / 2 / camera.zoom;
  const halfH = size.height / 2 / camera.zoom;
  return rect(camera.x - halfW, camera.y - halfH, camera.x + halfW, camera.y + halfH);
}

export function panBy(camera: Camera, screenDx: number, screenDy: number): Camera {
  return { ...camera, x: camera.x - screenDx / camera.zoom, y: camera.y - screenDy / camera.zoom };
}

/**
 * Zoom while keeping the world point under `anchor` (a screen position) fixed —
 * the behaviour every pointer-driven zoom needs.
 */
export function zoomAt(camera: Camera, size: ViewportSize, anchor: Vec2, nextZoom: number): Camera {
  const zoom = clampZoom(nextZoom);
  const worldAnchor = screenToWorld(camera, size, anchor);
  return {
    zoom,
    x: worldAnchor.x - (anchor.x - size.width / 2) / zoom,
    y: worldAnchor.y - (anchor.y - size.height / 2) / zoom,
  };
}

/** A camera that frames `target` with a little breathing room. */
export function fitRect(size: ViewportSize, target: Rect, padding = 0.1): Camera {
  const w = Math.max(target.maxX - target.minX, Number.EPSILON);
  const h = Math.max(target.maxY - target.minY, Number.EPSILON);
  const zoom = clampZoom(Math.min(size.width / w, size.height / h) * (1 - padding));
  return { x: (target.minX + target.maxX) / 2, y: (target.minY + target.maxY) / 2, zoom };
}
