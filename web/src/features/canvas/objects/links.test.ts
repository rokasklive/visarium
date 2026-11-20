import {
  asItemId,
  asLinkId,
  type CanvasItem,
  DEFAULT_APPEARANCE,
  FULL_CROP,
} from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import type { Layout } from './layout';
import {
  anchorBox,
  defaultLinkType,
  distanceToSegment,
  elementAt,
  linkNear,
  linkPoints,
  nearestPoints,
  nextLinkType,
  segmentBetween,
} from './links';
import type { ObjectView } from './store';

const flow: CanvasItem = {
  id: asItemId('flow'),
  transform: { x: 0, y: 0, width: 400, height: 200, rotation: 0 },
  z: 1,
  content: { kind: 'diagram', lang: 'mermaid', source: 'flowchart LR\n  API --> Pay' },
  appearance: DEFAULT_APPEARANCE,
  crop: FULL_CROP,
};
const layout = {
  width: 400,
  height: 200,
  hits: [],
  elements: new Map([
    ['API', { x: 20, y: 80, width: 100, height: 40 }],
    ['Pay', { x: 260, y: 80, width: 120, height: 40 }],
  ]),
  svg: () => '',
} as unknown as Layout;
const view: ObjectView = { layout, key: 'k', stale: false };

describe('links', () => {
  it('start with a type that says what they are dragged from', () => {
    expect(defaultLinkType({ kind: 'checklist', title: '', tasks: [] })).toBe('implements');
    expect(defaultLinkType(flow.content)).toBe('depends-on');
    expect(defaultLinkType({ kind: 'note', source: '' })).toBe('describes');
    expect(
      ['describes', 'comments', 'implements', 'depends-on'].map((t) => nextLinkType(t as never)),
    ).toEqual(['comments', 'implements', 'depends-on', 'describes']);
  });

  it('find the smallest element under a point', () => {
    expect(elementAt(layout, { x: 300, y: 100 })).toBe('Pay');
    expect(elementAt(layout, { x: 200, y: 100 })).toBeUndefined();
  });

  it('attach to an element where it is, and to the whole item when it is gone', () => {
    // The item's top-left is (-200, -100): Pay is at world (60..180, -20..20).
    expect(anchorBox(flow, view, 'Pay', flow.transform)).toEqual({
      box: { minX: 60, minY: -20, maxX: 180, maxY: 20 },
      broken: false,
    });
    const gone = anchorBox(flow, view, 'Payments', flow.transform);
    expect(gone.broken).toBe(true);
    expect(gone.box).toEqual({ minX: -200, minY: -100, maxX: 200, maxY: 100 });
    expect(
      anchorBox(flow, undefined, 'Pay', flow.transform).broken,
      'not laid out yet is unknown, not broken',
    ).toBe(false);
  });

  it('run edge to edge and are found near their line', () => {
    const s = segmentBetween(
      { minX: -100, minY: -10, maxX: -50, maxY: 10 },
      { minX: 50, minY: -10, maxX: 100, maxY: 10 },
      1,
    );
    expect(s.from).toEqual({ x: -46, y: 0 });
    expect(s.to).toEqual({ x: 44, y: 0 });
    expect(distanceToSegment({ x: 0, y: 5 }, s)).toBe(5);
    const link = {
      id: asLinkId('l'),
      from: { itemId: flow.id },
      to: { itemId: flow.id },
      linkType: 'describes' as const,
    };
    const drawn = [
      {
        link,
        segment: s,
        from: { box: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, broken: false },
        to: { box: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, broken: false },
      },
    ];
    expect(linkNear(drawn, { x: 0, y: 5 }, 6)?.link.id).toBe('l');
    expect(linkNear(drawn, { x: 0, y: 9 }, 6)).toBeUndefined();
  });

  it('join the nearest points of their anchors (canvas/link-geometry)', () => {
    const r = (minX: number, minY: number, maxX: number, maxY: number) => ({
      minX,
      minY,
      maxX,
      maxY,
    });
    // Overlapping x: a vertical line through the middle of the overlap.
    expect(nearestPoints(r(0, 0, 100, 50), r(60, 200, 200, 300))).toEqual({
      from: { x: 80, y: 50 },
      to: { x: 80, y: 200 },
    });
    // Overlapping y: horizontal.
    expect(nearestPoints(r(0, 0, 100, 100), r(300, 50, 400, 300))).toEqual({
      from: { x: 100, y: 75 },
      to: { x: 300, y: 75 },
    });
    // Neither: corner to corner.
    expect(nearestPoints(r(0, 0, 100, 100), r(300, 300, 400, 400))).toEqual({
      from: { x: 100, y: 100 },
      to: { x: 300, y: 300 },
    });
    // A note above and left of a tall lifeline lands on the lifeline's head.
    const note = r(100, -260, 500, -140);
    const lifeline = r(410, 0, 430, 800);
    const s = segmentBetween(note, lifeline, 1);
    expect(Math.abs(s.to.x - 420)).toBeLessThan(6); // pad pulls the end back along the diagonal
    expect(s.to.y).toBeLessThan(0);
    expect(s.to.y).toBeGreaterThan(-10);
    expect(s.from.x).toBeLessThan(310); // origin near the note's bottom-edge middle (300)
  });

  it('start at the middle of the source edge facing the target', () => {
    const r = (minX: number, minY: number, maxX: number, maxY: number) => ({
      minX,
      minY,
      maxX,
      maxY,
    });
    expect(linkPoints(r(0, 0, 100, 50), r(60, 200, 200, 300))).toEqual({
      from: { x: 50, y: 50 },
      to: { x: 80, y: 200 },
    });
    expect(linkPoints(r(0, 0, 100, 100), r(300, 50, 400, 300))).toEqual({
      from: { x: 100, y: 50 },
      to: { x: 300, y: 75 },
    });
    // Apart on both axes: the wider gap's edge.
    expect(linkPoints(r(0, 0, 100, 100), r(300, 150, 400, 250))).toEqual({
      from: { x: 100, y: 50 },
      to: { x: 300, y: 150 },
    });
  });
});
