/**
 * What a click, a key or a paste means for an object, as pure functions.
 *
 * The surface turns pointer events into item-local points and calls these;
 * nothing here touches the DOM or Konva, so every rule is a unit test.
 */

import type {
  CanvasItem,
  CanvasItemContent,
  CanvasOperationBody,
  ItemId,
  Task,
  TaskState,
  Transform,
  Vec2,
} from '@visarium/canvas-core';
import type { Hit, Layout, LocalRect } from './layout';

/** The control under an item-local point (in layout units), if any. */
export function hitAt(
  layout: Layout,
  point: Vec2,
): (Hit & { readonly rect: LocalRect }) | undefined {
  // A little slack around small targets: a checkbox is 14 units, and a click
  // on its edge is a click on it.
  const SLOP = 3;
  return layout.hits.find(
    ({ rect }) =>
      point.x >= rect.x - SLOP &&
      point.x <= rect.x + rect.width + SLOP &&
      point.y >= rect.y - SLOP &&
      point.y <= rect.y + rect.height + SLOP,
  );
}

const TASK_BOX = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;

/**
 * The note source with its `index`-th task checkbox set or cleared, and no
 * other byte changed (spec: a checkbox in a note is a real control).
 *
 * ponytail: counts task lines in source order, which is the order marked
 * renders them in. A `- [ ]` inside a fenced code block would be miscounted;
 * walk marked's tokens if that ever matters.
 */
export function setTaskBox(source: string, index: number, checked: boolean): string {
  let n = -1;
  return source.replace(TASK_BOX, (whole, open: string, _mark: string, close: string) =>
    ++n === index ? `${open}${checked ? 'x' : ' '}${close}` : whole,
  );
}

/** Whether the `index`-th task checkbox in the source is ticked. */
export function taskBoxChecked(source: string, index: number): boolean {
  let n = -1;
  for (const m of source.matchAll(TASK_BOX)) if (++n === index) return m[2] !== ' ';
  return false;
}

/** A click moves a task on; Shift marks it blocked, or unblocks it (spec). */
export function nextState(state: TaskState, shift: boolean): TaskState {
  if (shift) return state === 'blocked' ? 'todo' : 'blocked';
  return state === 'todo' ? 'doing' : state === 'doing' ? 'done' : 'todo';
}

/** An id unique within the checklist: `t` and one past the highest number in use. */
export function newTaskId(tasks: readonly Task[]): string {
  let max = 0;
  for (const t of tasks) {
    const n = /^t(\d+)$/.exec(t.id)?.[1];
    if (n !== undefined) max = Math.max(max, Number(n));
  }
  let id = `t${max + 1}`;
  while (tasks.some((t) => t.id === id)) id = `${id}x`;
  return id;
}

/** How wide an object starts. Height follows its content as soon as it lays out. */
export function startingWidth(content: CanvasItemContent): number {
  return content.kind === 'diagram' ? 480 : 320;
}

/** The creation of an object centred on a world point, on top of everything. */
export function createObject(
  itemId: ItemId,
  content: CanvasItemContent,
  at: Vec2,
  z: number,
): CanvasOperationBody {
  const width = startingWidth(content);
  // A provisional height: the layout writes the real one (this client authored it).
  const height = content.kind === 'diagram' ? 240 : 80;
  return {
    type: 'item.create',
    itemId,
    transform: { x: at.x, y: at.y + height / 2, width, height, rotation: 0 },
    z,
    content,
  };
}

/**
 * An item-local point (origin at the item's top-left, in world units, before
 * rotation) in world coordinates. The editors are placed with this.
 */
export function localToWorld(t: Transform, p: Vec2): Vec2 {
  // The node's offset keeps the STORED half-height, so a drawn box of another
  // height still hangs from the stored top edge (see ItemNode): local y is
  // measured from that edge whatever the drawn height.
  const lx = p.x - t.width / 2;
  const ly = p.y - t.height / 2;
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return { x: t.x + lx * c - ly * s, y: t.y + lx * s + ly * c };
}

/** A world point in item-local coordinates: the inverse of {@link localToWorld}. */
export function worldToLocal(t: Transform, p: Vec2): Vec2 {
  const dx = p.x - t.x;
  const dy = p.y - t.y;
  const c = Math.cos(-t.rotation);
  const s = Math.sin(-t.rotation);
  return { x: dx * c - dy * s + t.width / 2, y: dx * s + dy * c + t.height / 2 };
}

/** Item-local units to layout units: the item may be drawn wider than it was laid out. */
export function toLayout(item: CanvasItem, layout: Layout, local: Vec2): Vec2 {
  const k = layout.width / item.transform.width;
  return { x: local.x * k, y: local.y * k };
}
