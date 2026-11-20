import {
  type CanvasDocument,
  type CanvasItem,
  type ItemId,
  type Rect,
  rectsIntersect,
} from '@visarium/canvas-core';
import { toKonvaAppearance, toKonvaAttrs } from '@visarium/canvas-renderer-konva';
import { useRef } from 'react';
import { Group, Rect as KonvaRect } from 'react-konva';
import type { LocalRect } from './objects/layout';
import type { ObjectView } from './objects/store';
import { type SearchResult, targetKey } from './search';

/**
 * What a search shows on the board (canvas/quick-search): an outline on every
 * matching item or group in view, stronger on the one holding the current
 * result, and a translucent highlight over each occurrence inside objects in
 * view, stronger on the current one.
 *
 * Chrome, like the selection: strokes in screen pixels over zoom, no hit test.
 * Word rects are measured once per drawing and query, then only redrawn.
 */
export function SearchMarks({
  doc,
  query,
  results,
  current,
  visible,
  viewport,
  viewOf,
  zoom,
  accent,
}: {
  doc: CanvasDocument;
  query: string;
  results: readonly SearchResult[];
  current: number;
  /** Items in the active set: the only ones worth marking or measuring. */
  visible: ReadonlySet<ItemId>;
  viewport: Rect;
  viewOf: (item: CanvasItem) => ObjectView | undefined;
  zoom: number;
  accent: string;
}) {
  const measured = useRef(new Map<string, LocalRect[][]>());
  const live = results[current];
  const liveKey = live ? targetKey(live.target) : undefined;
  const outlines: { key: string; bounds: Rect }[] = [];
  const words: { item: CanvasItem; view: ObjectView; rects: LocalRect[][] }[] = [];
  const seen = new Set<string>();

  for (const { target } of results) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    if (target.kind === 'group') {
      const bounds = doc.groupBounds(target.id);
      if (bounds && rectsIntersect(bounds, viewport)) outlines.push({ key, bounds });
      continue;
    }
    if (!visible.has(target.id)) continue;
    const item = doc.item(target.id);
    const bounds = doc.index.boundsOf(target.id);
    if (!item || !bounds) continue;
    outlines.push({ key, bounds });
    const view = viewOf(item);
    if (!view) continue; // not laid out yet: outlined, highlighted once it is
    const cacheKey = `${item.id}|${view.key}|${query}`;
    let rects = measured.current.get(cacheKey);
    if (!rects) {
      rects = view.layout.measure(query);
      if (measured.current.size > 500) measured.current.clear();
      measured.current.set(cacheKey, rects);
    }
    words.push({ item, view, rects });
  }

  const stroke = 1 / zoom;
  return (
    <>
      {outlines.map(({ key, bounds }) => {
        const strong = key === liveKey;
        const pad = (strong ? 4 : 2) / zoom;
        return (
          <KonvaRect
            key={`search-${key}`}
            name="search-outline"
            x={bounds.minX - pad}
            y={bounds.minY - pad}
            width={bounds.maxX - bounds.minX + 2 * pad}
            height={bounds.maxY - bounds.minY + 2 * pad}
            stroke={accent}
            strokeWidth={(strong ? 2 : 1) / zoom}
            opacity={strong ? 1 : 0.45}
            listening={false}
            perfectDrawEnabled={false}
          />
        );
      })}
      {words.map(({ item, view, rects }) => {
        // Drawn the way the item's own node is: about its centre, rotated and
        // mirrored with it, laid-out units scaled to its width.
        const at = toKonvaAttrs(item.transform);
        const flip = toKonvaAppearance({ ...item.appearance, opacity: 1 });
        const k = item.transform.width / view.layout.width;
        const nth =
          live && live.target.kind === 'item' && live.target.id === item.id ? live.nth : -1;
        return (
          <Group
            key={`search-words-${item.id}`}
            name="search-words"
            x={at.x}
            y={at.y}
            rotation={at.rotation}
            offsetX={at.offsetX}
            offsetY={at.offsetY}
            scaleX={flip.scaleX}
            scaleY={flip.scaleY}
            listening={false}
          >
            {rects.flatMap((parts, i) =>
              parts.map((r, j) => (
                <KonvaRect
                  // biome-ignore lint/suspicious/noArrayIndexKey: occurrences have no identity but their order
                  key={`${i}-${j}`}
                  name={i === nth ? 'search-word-current' : 'search-word'}
                  x={r.x * k}
                  y={r.y * k}
                  width={r.width * k}
                  height={r.height * k}
                  fill={accent}
                  opacity={i === nth ? 0.55 : 0.3}
                  {...(i === nth ? { stroke: accent, strokeWidth: stroke } : {})}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              )),
            )}
          </Group>
        );
      })}
    </>
  );
}
