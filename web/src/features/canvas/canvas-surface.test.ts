import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  asCanvasId,
  asItemId,
  CanvasDocument,
  type CanvasItem,
  DEFAULT_APPEARANCE,
  FULL_CROP,
  GRID_PITCH,
  type GroupId,
  type ItemId,
  newGroupId,
  transformBounds,
} from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import {
  frameFor,
  gridBackground,
  groupLabelsFor,
  itemNodeAttrs,
  selectionMode,
} from './canvas-surface';

/**
 * The two decisions the surface makes about what to draw, extracted so they can
 * be asserted rather than read.
 *
 * Drawing is Konva's; deciding that an interface stroke does NOT inherit an
 * item's opacity, and that a label's size is screen pixels over zoom, is
 * arithmetic — and both are rules that would decay silently.
 */

const canvas = asCanvasId('board-render');

function item(overrides: Partial<CanvasItem> = {}): CanvasItem {
  return {
    id: asItemId('item-a'),
    transform: { x: 10, y: 20, width: 300, height: 200, rotation: 0 },
    z: 1,
    content: { kind: 'placeholder', intrinsicWidth: 300, intrinsicHeight: 200 },
    appearance: DEFAULT_APPEARANCE,
    crop: FULL_CROP,
    ...overrides,
  };
}

describe('an item and its chrome', () => {
  it('draws the item at its opacity', () => {
    const { form } = itemNodeAttrs(
      item({ appearance: { opacity: 0.4, flipX: false, flipY: false } }),
      0.4,
      1,
      false,
    );
    expect(form.opacity).toBe(0.4);
  });

  // Invariant 8: aggregation — and selection — is visible, never silent. An
  // item nobody can see is still an item somebody can find.
  it('draws the selection outline at full strength over an item at zero opacity', () => {
    const invisible = item({ appearance: { opacity: 0, flipX: true, flipY: true } });
    const { form, outline } = itemNodeAttrs(invisible, 0, 2, true);

    expect(form.opacity).toBe(0);
    expect(outline).toBeDefined();
    // Not merely "opacity 1": the outline carries no opacity at all, so there is
    // nothing for a future edit to accidentally set from the item.
    expect(outline).not.toHaveProperty('opacity');
    expect(outline?.strokeWidth).toBe(2 / 2);
  });

  it('does not mirror the outline with the item', () => {
    const flipped = item({ appearance: { opacity: 1, flipX: true, flipY: true } });
    const { form, outline } = itemNodeAttrs(flipped, 1, 1, true);

    expect(form.scaleX).toBe(-1);
    expect(form.scaleY).toBe(-1);
    expect(outline).not.toHaveProperty('scaleX');
  });

  it('costs no second node for an item that is neither selected nor held', () => {
    expect(itemNodeAttrs(item(), 1, 1, false).outline).toBeUndefined();
  });

  it('mirrors about the item, leaving its position and bounds where they were', () => {
    const plain = item();
    const flipped = item({ appearance: { opacity: 1, flipX: true, flipY: false } });

    const before = itemNodeAttrs(plain, 1, 1, false).form;
    const after = itemNodeAttrs(flipped, 1, 1, false).form;

    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    // The domain's bounds are untouched, because appearance is not in them.
    expect(transformBounds(flipped.transform)).toEqual(transformBounds(plain.transform));
  });
});

describe('group labels', () => {
  function board(labels: readonly (string | undefined)[]): {
    doc: CanvasDocument;
    groupIds: GroupId[];
  } {
    const doc = new CanvasDocument(canvas);
    const groupIds: GroupId[] = [];
    labels.forEach((label, i) => {
      const itemId = asItemId(`i-${i}`) as ItemId;
      doc.apply({
        type: 'item.create',
        itemId,
        transform: { x: i * 1000, y: 0, width: 100, height: 100, rotation: 0 },
        z: i,
        content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 100 },
      });
      const groupId = newGroupId();
      groupIds.push(groupId);
      doc.apply({
        type: 'group.create',
        groupId,
        memberIds: [itemId],
        ...(label !== undefined ? { label } : {}),
      });
    });
    return { doc, groupIds };
  }

  it('is set on the face grid: 11 screen px up close, 22 far out', () => {
    const { doc, groupIds } = board(['corner']);
    expect(groupLabelsFor(doc, groupIds, 1)[0]?.fontSize).toBe(11);
    expect(groupLabelsFor(doc, groupIds, 4)[0]?.fontSize).toBe(11 / 4);
    // Multiplied by the zoom the stage is drawn at: 22 screen pixels far out.
    expect((groupLabelsFor(doc, groupIds, 0.25)[0]?.fontSize as number) * 0.25).toBe(22);
  });

  it('lands the text on whole screen pixels', () => {
    const { doc, groupIds } = board(['corner']);
    const [l] = groupLabelsFor(doc, groupIds, 0.37, undefined, { x: 13.3, y: 7.9 });
    expect(Number.isInteger(Math.round(((l?.x as number) * 0.37 + 13.3) * 1e6) / 1e6)).toBe(true);
    expect(Number.isInteger(Math.round(((l?.y as number) * 0.37 + 7.9) * 1e6) / 1e6)).toBe(true);
  });

  it('has a knockout covering the whole text', () => {
    const { doc, groupIds } = board(['corner']);
    const [l] = groupLabelsFor(doc, groupIds, 1);
    const k = l?.knockout;
    expect(
      k &&
        l &&
        k.x < l.x &&
        k.y < l.y &&
        k.x + k.width > l.x + l.width &&
        k.y + k.height > l.y + l.height,
    ).toBe(true);
  });

  it('reads as an annotation — uppercase — not as body text', () => {
    const { doc, groupIds } = board(['corner']);
    expect(groupLabelsFor(doc, groupIds, 1)[0]?.label).toBe('CORNER');
  });

  it('floats above an unframed group it names, by a gap that is also screen pixels', () => {
    const { doc, groupIds } = board(['corner']);
    const bounds = doc.groupBounds(groupIds[0] as GroupId);
    expect(groupLabelsFor(doc, groupIds, 2)[0]?.y).toBe((bounds?.minY as number) - (11 + 6) / 2);
    expect(groupLabelsFor(doc, groupIds, 2)[0]?.x).toBe(bounds?.minX);
  });

  it('sits on a framed contour so the label and the line read as one system', () => {
    const { doc, groupIds } = board(['corner']);
    const groupId = groupIds[0] as GroupId;
    doc.apply({ type: 'group.frame', groupId, frame: true });
    const frame = frameFor(doc, groupId, new Map());
    if (!frame) throw new Error('a framed group derives a contour');
    const [label] = groupLabelsFor(doc, [groupId], 2, new Map([[groupId, frame]]));
    // The label sits just in from the contour's corner, its middle riding the
    // top edge, where its knockout breaks the line (to within a screen pixel).
    expect(Math.abs((label?.x as number) - (frame.minX + 8 / 2))).toBeLessThanOrEqual(0.5);
    expect(Math.abs((label?.y as number) - (frame.minY - 11 / 2 / 2))).toBeLessThanOrEqual(0.5);
    const k = label?.knockout;
    expect(k && k.y < frame.minY && k.y + k.height > frame.minY).toBe(true);
  });

  it('draws only the larger of two labels that would overlap, both once apart', () => {
    const doc = new CanvasDocument(canvas);
    const make = (n: number, x: number, size: number, label: string) => {
      const itemId = asItemId(`o-${n}`) as ItemId;
      doc.apply({
        type: 'item.create',
        itemId,
        transform: { x, y: 0, width: size, height: size, rotation: 0 },
        z: n,
        content: { kind: 'placeholder', intrinsicWidth: size, intrinsicHeight: size },
      });
      const groupId = newGroupId();
      doc.apply({ type: 'group.create', groupId, memberIds: [itemId], label });
      return groupId;
    };
    const small = make(1, 0, 400, 'STARTUP & TRANSPORT');
    const big = make(2, 600, 1000, 'TOOL SURFACES');
    // At 8%, the labels' screen boxes collide; zoomed in, they do not.
    expect(groupLabelsFor(doc, [small, big], 0.08).map((l) => l.groupId)).toEqual([big]);
    expect(groupLabelsFor(doc, [small, big], 1)).toHaveLength(2);
  });

  it('draws nothing for a group with no label', () => {
    const { doc, groupIds } = board([undefined, 'named', undefined]);
    expect(groupLabelsFor(doc, groupIds, 1).map((l) => l.label)).toEqual(['NAMED']);
  });

  // The bound is the point. A board with far more groups than the viewport
  // shows draws as many labels as it was handed groups, never as many as the
  // document holds.
  it('is bounded by the groups it is handed rather than by the document', () => {
    const { doc, groupIds } = board(Array.from({ length: 40 }, (_, i) => `g${i}`));
    expect(doc.groupCount).toBe(40);
    expect(groupLabelsFor(doc, groupIds.slice(0, 3), 1)).toHaveLength(3);
  });
});

describe('derived frames', () => {
  function framedBoard(): { doc: CanvasDocument; groupId: GroupId } {
    const doc = new CanvasDocument(canvas);
    const ids = [asItemId('f-a') as ItemId, asItemId('f-b') as ItemId];
    ids.forEach((itemId, i) => {
      doc.apply({
        type: 'item.create',
        itemId,
        transform: { x: i * 300, y: i * 300, width: 200, height: 200, rotation: 0 },
        z: i,
        content: { kind: 'placeholder', intrinsicWidth: 200, intrinsicHeight: 200 },
      });
    });
    const groupId = newGroupId();
    doc.apply({ type: 'group.create', groupId, memberIds: ids });
    return { doc, groupId };
  }

  it('derives a closed orthogonal ring only when the flag asks for one', () => {
    const { doc, groupId } = framedBoard();
    expect(frameFor(doc, groupId, new Map())).toBeUndefined();
    doc.apply({ type: 'group.frame', groupId, frame: true });
    const entry = frameFor(doc, groupId, new Map());
    expect(entry?.points.length).toBeGreaterThanOrEqual(8);
  });

  it('recomputes only when the geometry actually changed', () => {
    const { doc, groupId } = framedBoard();
    doc.apply({ type: 'group.frame', groupId, frame: true });
    const cache = new Map();
    const first = frameFor(doc, groupId, cache);
    expect(frameFor(doc, groupId, cache)).toBe(first); // same object: cache hit
    doc.apply({
      type: 'item.transform',
      itemId: asItemId('f-a') as ItemId,
      transform: { x: -500, y: 0, width: 200, height: 200, rotation: 0 },
    });
    expect(frameFor(doc, groupId, cache)).not.toBe(first);
  });

  it('follows an L-shaped arrangement rather than its bounding box', () => {
    const doc = new CanvasDocument(canvas);
    const arm = asItemId('arm') as ItemId;
    const foot = asItemId('foot') as ItemId;
    doc.apply({
      type: 'item.create',
      itemId: arm,
      transform: { x: 150, y: 50, width: 300, height: 100, rotation: 0 },
      z: 0,
      content: { kind: 'placeholder', intrinsicWidth: 300, intrinsicHeight: 100 },
    });
    doc.apply({
      type: 'item.create',
      itemId: foot,
      transform: { x: 50, y: 200, width: 100, height: 300, rotation: 0 },
      z: 1,
      content: { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 300 },
    });
    const groupId = newGroupId();
    doc.apply({ type: 'group.create', groupId, memberIds: [arm, foot], frame: true });
    const points = frameFor(doc, groupId, new Map())?.points ?? [];
    expect(points.length).toBeGreaterThan(0);
    // The empty lower-right region of the L's bounding box stays outside.
    expect(insideRing(points, { x: 250, y: 250 })).toBe(false);
    expect(insideRing(points, { x: 50, y: 200 })).toBe(true);
  });

  /** Even-odd ray cast over a flat Konva-style points array. */
  function insideRing(points: number[], p: { x: number; y: number }): boolean {
    let hit = false;
    for (let i = 0, j = points.length / 2 - 1; i < points.length / 2; j = i++) {
      const ax = points[i * 2] as number;
      const ay = points[i * 2 + 1] as number;
      const bx = points[j * 2] as number;
      const by = points[j * 2 + 1] as number;
      if (ay > p.y !== by > p.y && p.x < ((bx - ax) * (p.y - ay)) / (by - ay) + ax) hit = !hit;
    }
    return hit;
  }
});

describe('the ground grid', () => {
  const grid = (zoom: number, cameraX = 0, cameraY = 0) =>
    gridBackground(
      { zoom, x: cameraX, y: cameraY } as never,
      { width: 1200, height: 800 },
      'colour-from-token',
    );

  it('draws nothing once cells would render below the floor', () => {
    expect(grid(0.2)).toBeUndefined(); // 24 * 0.2 = 4.8px cells
  });

  it('is at full faint strength at working zoom and fades on the way out', () => {
    expect(grid(1)?.backgroundImage).toContain('colour-from-token 1px');
    expect(grid(0.3)?.backgroundImage).toContain('colour-from-token 20%'); // (7.2 - 6) / (12 - 6)
  });

  it('anchors to world coordinates: the tile is one pitch, pan moves the dots', () => {
    expect(grid(0.5)?.backgroundSize).toBe(`${GRID_PITCH * 0.5}px ${GRID_PITCH * 0.5}px`);
    // World (0, 0) at the viewport centre, minus half a 12px cell.
    expect(grid(0.5)?.backgroundPosition).toBe('594px 394px');
    expect(grid(0.5, 37, 11)?.backgroundPosition).toBe('575.5px 388.5px');
  });
});

/**
 * The seam M08 exists to close, as a test.
 *
 * Front, back, group and ungroup used to live in the canvas toolbar as well as
 * being things you do to a selection. Two ways to press Front is not a
 * convenience, it is two places to fix a bug in — and the reason this is a
 * source-text assertion rather than a rendered one is that the failure it
 * guards against is somebody adding a button back, which is visible in the
 * source before it is visible anywhere else.
 */
describe('an act on a selection is reachable from one place', () => {
  const here = join(import.meta.dirname);
  /** The code, with the prose removed — a comment naming Front is not a Front button. */
  const code = (file: string) =>
    readFileSync(join(here, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  const canvasToolbar = code('canvas-toolbar.tsx');
  const selectionToolbar = code('selection-toolbar.tsx');

  const SELECTION_ACTS = [
    'Front',
    'Back',
    'Group',
    'Ungroup',
    'Label',
    'Duplicate',
    'Delete',
    'Flip H',
    'Flip V',
  ];

  for (const act of SELECTION_ACTS) {
    it(`offers ${act} from the selection and not from the canvas chrome`, () => {
      expect(selectionToolbar).toContain(act);
      expect(canvasToolbar).not.toContain(act);
    });
  }

  it('leaves the canvas toolbar only what does not depend on a selection', () => {
    for (const act of ['Select', 'Pan', 'Undo', 'Redo', 'Frame']) {
      expect(canvasToolbar).toContain(act);
    }
  });
});

describe('selecting with modifiers', () => {
  const press = (keys: Partial<Pick<MouseEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>>) =>
    ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...keys }) as MouseEvent;

  it('keeps Ctrl as toggle but never for Ctrl+Alt, which is crop', () => {
    expect(selectionMode(press({ ctrlKey: true }))).toBe('toggle');
    expect(selectionMode(press({ ctrlKey: true, altKey: true }))).toBe('replace');
    expect(selectionMode(press({ shiftKey: true }))).toBe('add');
  });
});
