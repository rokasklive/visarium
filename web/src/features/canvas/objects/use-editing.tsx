/**
 * Creating and editing objects by direct manipulation (specs: notes, diagrams,
 * checklists). The surface hands pointer events in as world points; this
 * decides what they mean and owns the in-place editors.
 *
 * Every change goes through the same operations as everything else: `commit`
 * (one undo step) for clicks, `doc.apply` plus one `history.record` for an
 * editing session that saved as it went (design D7).
 */

import {
  type Camera,
  type CanvasDocument,
  type CanvasHistory,
  type CanvasItem,
  type CanvasItemContent,
  type CanvasOperationBody,
  classifyText,
  hasSource,
  type ItemId,
  newItemId,
  type Task,
  type Vec2,
  type ViewportSize,
  worldToScreen,
} from '@visarium/canvas-core';
import { type ReactNode, useCallback, useRef, useState } from 'react';
import { personName } from '~/api/boards';
import type { BoardRealtime } from '../realtime';
import { FieldEditor, type Placement, SourceEditor } from './editor';
import {
  createObject,
  hitAt,
  localToWorld,
  newTaskId,
  nextState,
  setTaskBox,
  taskBoxChecked,
  toLayout,
  worldToLocal,
} from './interact';
import { type LocalRect, laidWidth } from './layout';
import type { ObjectLayouts } from './store';

/** How long typing pauses before the source is saved: a closed tab loses less than this. */
const SAVE_AFTER_MS = 400;
/** The server's limit on an object's text (64 KiB), less room for a checklist's JSON. */
const MAX_TEXT = 60_000;

type Editing =
  | { readonly kind: 'source'; readonly itemId: ItemId }
  | { readonly kind: 'new-note'; readonly at: Vec2 }
  | { readonly kind: 'task'; readonly itemId: ItemId; readonly taskId: string }
  | { readonly kind: 'task-new'; readonly itemId: ItemId; readonly index: number }
  | { readonly kind: 'title'; readonly itemId: ItemId };

export interface EditingDeps {
  readonly doc: CanvasDocument;
  readonly history: CanvasHistory;
  readonly objects: ObjectLayouts;
  readonly commit: (...bodies: CanvasOperationBody[]) => void;
  readonly redraw: () => void;
  readonly camera: Camera;
  readonly size: ViewportSize;
  readonly editable: boolean;
  readonly realtime: () => BoardRealtime | null;
  /** Resolves when everything posted so far is durable; the lock is released then. */
  readonly settled: () => Promise<void>;
  readonly select: (ids: ItemId[]) => void;
  readonly notify: (message: string) => void;
  readonly me: { readonly id: string; readonly displayName: string } | undefined;
}

export function useObjectEditing(d: EditingDeps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const session = useRef<{
    itemId: ItemId;
    original: string;
    lastSent: string;
    timer?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const deps = useRef(d);
  deps.current = d;

  const heldByOther = (id: ItemId) => d.realtime()?.heldByOther(id) !== undefined;
  const canEdit = (item: CanvasItem) => d.editable && !heldByOther(item.id);
  /** Our own stamp on a task change: shown at once, replaced by the server's. */
  const stamp = () => (d.me ? { by: d.me.id, at: new Date().toISOString() } : {});

  // --- source: notes and diagrams -----------------------------------------

  const saveSource = useCallback((text: string) => {
    const s = session.current;
    const { doc, redraw } = deps.current;
    if (!s || text === s.lastSent) return;
    const item = doc.item(s.itemId);
    if (!item || !hasSource(item.content)) return;
    if (text.length > MAX_TEXT) return; // finishSource says so; nothing half-saved
    // Not through history: these saves are one session, recorded once at the end.
    doc.apply({
      type: 'item.source',
      itemId: s.itemId,
      source: text,
      ...(item.revision !== undefined ? { baseRevision: item.revision } : {}),
    });
    s.lastSent = text;
    redraw();
  }, []);

  const openSource = (item: CanvasItem): boolean => {
    if (!hasSource(item.content) || !canEdit(item)) return false;
    d.realtime()?.acquire([item.id]);
    session.current = {
      itemId: item.id,
      original: item.content.source,
      lastSent: item.content.source,
    };
    d.select([item.id]);
    setEditing({ kind: 'source', itemId: item.id });
    return true;
  };

  const finishSource = (text: string) => {
    const s = session.current;
    if (!s) return;
    clearTimeout(s.timer);
    if (text.length > MAX_TEXT)
      d.notify('That is more text than one object holds (64 KB). The rest was not saved.');
    saveSource(text.slice(0, MAX_TEXT));
    if (s.lastSent !== s.original)
      d.history.record({ type: 'item.source', itemId: s.itemId, source: s.original });
    // A note whose text now opens a diagram becomes that diagram.
    convertIfDiagram(s.itemId);
    session.current = null;
    setEditing(null);
    const id = s.itemId;
    void d.settled().then(() => deps.current.realtime()?.release([id]));
  };

  /**
   * A note whose source now starts a Mermaid or PlantUML diagram is turned into
   * that diagram: same id, place, z-order, group and links, one undo step. Its
   * links are removed and put back around the swap because deleting an item
   * cascades them; taking them out as their own operations is what lets undo
   * return them (as `deleteItemsBodies` does).
   */
  const convertIfDiagram = (itemId: ItemId) => {
    const item = d.doc.item(itemId);
    if (item?.content.kind !== 'note') return;
    const content = classifyText(item.content.source);
    if (content.kind !== 'diagram') return;
    const links = d.doc.linksOf(itemId);
    d.commit(
      ...links.map((l): CanvasOperationBody => ({ type: 'link.delete', linkId: l.id })),
      { type: 'item.delete', itemId },
      {
        type: 'item.create',
        itemId,
        transform: item.transform,
        z: item.z,
        content,
        appearance: item.appearance,
        ...(item.groupId !== undefined ? { groupId: item.groupId } : {}),
      },
      ...links.map(
        (l): CanvasOperationBody => ({
          type: 'link.add',
          linkId: l.id,
          from: l.from,
          to: l.to,
          linkType: l.linkType,
        }),
      ),
    );
  };

  // --- creating ------------------------------------------------------------

  /** Pasted or dropped objects, cascading from one world point, then selected. */
  const place = (contents: readonly CanvasItemContent[], at: Vec2) => {
    const z = topZ(d.doc);
    const tooBig = contents.some(
      (c) => (hasSource(c) ? c.source.length : JSON.stringify(c).length) > MAX_TEXT,
    );
    if (tooBig) {
      d.notify('That is more text than one object holds (64 KB), so nothing was added.');
      return;
    }
    const bodies = contents.map((c, i) =>
      createObject(newItemId(), c, { x: at.x + i * 24, y: at.y + i * 24 }, z + i),
    );
    d.commit(...bodies);
    d.select(bodies.flatMap((b) => (b.type === 'item.create' ? [b.itemId] : [])));
  };

  const startNewNote = (at: Vec2) => {
    if (!d.editable) return;
    setEditing({ kind: 'new-note', at });
  };

  const finishNewNote = (at: Vec2, text: string) => {
    setEditing(null);
    // Left empty, nothing was made (spec). Typed text is classified exactly as
    // pasted text is: diagram source makes a diagram, task lines a checklist.
    if (text.trim()) place([classifyText(text)], at);
  };

  // --- checklists ------------------------------------------------------------

  /** An empty checklist at a world point, its title open for typing; Enter moves on to the first task. */
  const newChecklist = (at: Vec2) => {
    if (!d.editable) return;
    const itemId = newItemId();
    d.commit(createObject(itemId, { kind: 'checklist', title: '', tasks: [] }, at, topZ(d.doc)));
    d.select([itemId]);
    setEditing({ kind: 'title', itemId });
  };

  const tasksOf = (itemId: ItemId): readonly Task[] => {
    const c = d.doc.item(itemId)?.content;
    return c?.kind === 'checklist' ? c.tasks : [];
  };

  const commitTaskText = (itemId: ItemId, taskId: string, text: string) => {
    const task = tasksOf(itemId).find((t) => t.id === taskId);
    if (!task) return;
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) d.commit({ type: 'task.remove', itemId, taskId });
    else if (trimmed !== task.text)
      d.commit({ type: 'task.set', itemId, taskId, text: trimmed, ...stamp() });
  };

  const addTask = (itemId: ItemId, index: number, text: string): boolean => {
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return false;
    const task: Task = { id: newTaskId(tasksOf(itemId)), text: trimmed, state: 'todo', ...stamp() };
    d.commit({ type: 'task.add', itemId, task, index });
    return true;
  };

  // --- pointer -------------------------------------------------------------

  /** The control of an object under a world point, with its rectangle in item units. */
  const controlAt = (item: CanvasItem, world: Vec2) => {
    const view = d.objects.view(item);
    if (!view) return undefined;
    const k = view.layout.width / item.transform.width;
    const hit = hitAt(
      view.layout,
      toLayout(item, view.layout, worldToLocal(item.transform, world)),
    );
    return hit ? { ...hit, rect: scaleRect(hit.rect, 1 / k) } : undefined;
  };

  /** A click on an object. True when it was a control, which the caller must not treat as a press on the item. */
  const click = (item: CanvasItem, world: Vec2, shift: boolean): boolean => {
    const hit = controlAt(item, world);
    if (!hit) return false;
    if (hit.kind === 'link') {
      window.open(hit.href, '_blank', 'noopener,noreferrer');
      return true;
    }
    if (!canEdit(item)) return true;
    const c = item.content;
    if (hit.kind === 'checkbox' && c.kind === 'note') {
      const source = setTaskBox(c.source, hit.index, !taskBoxChecked(c.source, hit.index));
      d.commit({
        type: 'item.source',
        itemId: item.id,
        source,
        ...(item.revision !== undefined ? { baseRevision: item.revision } : {}),
      });
    } else if (hit.kind === 'task-state' && c.kind === 'checklist') {
      const task = c.tasks.find((t) => t.id === hit.taskId);
      if (task) {
        d.commit({
          type: 'task.set',
          itemId: item.id,
          taskId: task.id,
          state: nextState(task.state, shift),
          ...stamp(),
        });
      }
    } else if (hit.kind === 'task-text') {
      setEditing({ kind: 'task', itemId: item.id, taskId: hit.taskId });
    } else if (hit.kind === 'title') {
      setEditing({ kind: 'title', itemId: item.id });
    }
    return true;
  };

  /** Double-click edits a note or diagram's source; a checklist's title. */
  const doubleClick = (item: CanvasItem): boolean => {
    if (hasSource(item.content)) return openSource(item);
    if (item.content.kind === 'checklist' && canEdit(item)) {
      setEditing({ kind: 'title', itemId: item.id });
      return true;
    }
    return false;
  };

  /** Over a task: who last changed it, and when (spec: shown only on request). */
  const hover = (item: CanvasItem | null, world: Vec2, screen: Vec2) => {
    const hit = item?.content.kind === 'checklist' ? controlAt(item, world) : undefined;
    const task =
      hit &&
      (hit.kind === 'task-state' || hit.kind === 'task-text') &&
      item?.content.kind === 'checklist'
        ? item.content.tasks.find((t) => t.id === hit.taskId)
        : undefined;
    const text = task?.by
      ? `${credit(task, d.me, personName)} · ${task.state}${task.at ? ` · ${when(task.at)}` : ''}`
      : null;
    setTip((current) =>
      text === null
        ? null
        : current?.text === text && current.x === screen.x
          ? current
          : { text, x: screen.x, y: screen.y },
    );
  };

  // --- what is drawn over the canvas -------------------------------------------

  const placeAt = (item: CanvasItem, local: Vec2, width: number): Placement => {
    const at = worldToScreen(d.camera, d.size, localToWorld(item.transform, local));
    // A note with a text scale is edited at that scale (canvas/text-scaling):
    // the field is laid out at the width the text is, and drawn as large.
    const k = item.transform.width / laidWidth(item);
    return {
      left: at.x,
      top: at.y,
      rotation: (item.transform.rotation * 180) / Math.PI,
      zoom: d.camera.zoom * k,
      width: width / k,
    };
  };

  const fieldFor = (item: CanvasItem, rect: LocalRect | undefined, below = 0): Placement => {
    const x = (rect?.x ?? 0) - 3;
    return placeAt(item, { x, y: (rect?.y ?? 0) + below - 2 }, item.transform.width - x);
  };

  const rectOf = (
    item: CanvasItem,
    kind: 'task-text' | 'title',
    taskId?: string,
  ): LocalRect | undefined => {
    const view = d.objects.view(item);
    const hit = view?.layout.hits.find(
      (h) => h.kind === kind && (kind === 'title' || ('taskId' in h && h.taskId === taskId)),
    );
    if (!hit || !view) return undefined;
    return scaleRect(hit.rect, item.transform.width / view.layout.width);
  };

  let overlay: ReactNode = null;
  const e = editing;
  const item = e && 'itemId' in e ? d.doc.item(e.itemId) : undefined;
  if (e?.kind === 'source' && item && hasSource(item.content)) {
    overlay = (
      <SourceEditor
        key={`source-${item.id}`}
        placement={placeAt(item, { x: 0, y: 0 }, item.transform.width)}
        initial={item.content.source}
        label={item.content.kind === 'note' ? 'Note text' : 'Diagram source'}
        error={d.objects.view(item)?.error}
        onChange={(text) => {
          const s = session.current;
          if (!s) return;
          clearTimeout(s.timer);
          s.timer = setTimeout(() => saveSource(text), SAVE_AFTER_MS);
        }}
        onDone={finishSource}
      />
    );
  } else if (e?.kind === 'new-note') {
    const at = worldToScreen(d.camera, d.size, { x: e.at.x - 160, y: e.at.y });
    overlay = (
      <SourceEditor
        key="new-note"
        placement={{ left: at.x, top: at.y, rotation: 0, zoom: d.camera.zoom, width: 320 }}
        initial=""
        label="New note"
        onChange={() => {}}
        onDone={(text) => finishNewNote(e.at, text)}
      />
    );
  } else if (e?.kind === 'task' && item?.content.kind === 'checklist') {
    const task = item.content.tasks.find((t) => t.id === e.taskId);
    const index = item.content.tasks.findIndex((t) => t.id === e.taskId);
    if (task) {
      overlay = (
        <FieldEditor
          key={`task-${item.id}-${task.id}`}
          placement={fieldFor(item, rectOf(item, 'task-text', task.id))}
          initial={task.text}
          label="Task"
          fontSize={14}
          onEnter={(text) => {
            commitTaskText(item.id, task.id, text);
            setEditing({ kind: 'task-new', itemId: item.id, index: index + 1 });
          }}
          onBackspaceEmpty={() => {
            d.commit({ type: 'task.remove', itemId: item.id, taskId: task.id });
            const previous =
              item.content.kind === 'checklist' ? item.content.tasks[index - 1] : undefined;
            setEditing(previous ? { kind: 'task', itemId: item.id, taskId: previous.id } : null);
          }}
          onDone={(text) => {
            commitTaskText(item.id, task.id, text);
            setEditing(null);
          }}
        />
      );
    }
  } else if (e?.kind === 'task-new' && item?.content.kind === 'checklist') {
    const tasks = item.content.tasks;
    const before = tasks[e.index - 1];
    const above = before ? rectOf(item, 'task-text', before.id) : rectOf(item, 'title');
    overlay = (
      <FieldEditor
        key={`task-new-${item.id}-${e.index}-${tasks.length}`}
        placement={fieldFor(
          item,
          above && { ...above, x: rectOf(item, 'task-text', tasks[0]?.id)?.x ?? 24 },
          above ? above.height + 6 : 0,
        )}
        initial=""
        label="New task"
        fontSize={14}
        onEnter={(text) => {
          // Enter on an empty new line ends the list, as in any editor.
          if (addTask(item.id, e.index, text))
            setEditing({ kind: 'task-new', itemId: item.id, index: e.index + 1 });
          else setEditing(null);
        }}
        onBackspaceEmpty={() =>
          setEditing(before ? { kind: 'task', itemId: item.id, taskId: before.id } : null)
        }
        onDone={(text) => {
          addTask(item.id, e.index, text);
          setEditing(null);
        }}
      />
    );
  } else if (e?.kind === 'title' && item?.content.kind === 'checklist') {
    const title = item.content.title;
    overlay = (
      <FieldEditor
        key={`title-${item.id}`}
        placement={fieldFor(item, rectOf(item, 'title'))}
        initial={title}
        label="Checklist title"
        fontSize={17}
        bold
        onEnter={(text) => {
          if (text.trim() !== title)
            d.commit({
              type: 'checklist.title',
              itemId: item.id,
              title: text.trim().slice(0, 200),
            });
          setEditing(
            item.content.kind === 'checklist' && item.content.tasks.length === 0
              ? { kind: 'task-new', itemId: item.id, index: 0 }
              : null,
          );
        }}
        onDone={(text) => {
          if (text.trim() !== title)
            d.commit({
              type: 'checklist.title',
              itemId: item.id,
              title: text.trim().slice(0, 200),
            });
          setEditing(null);
        }}
      />
    );
  }

  const tooltip = tip ? (
    <div
      role="tooltip"
      data-testid="object-tip"
      className="pointer-events-none absolute rounded bg-surface-raised px-2 py-1 text-[11px] text-ink-dim tabular-nums"
      style={{ left: tip.x + 12, top: tip.y + 14 }}
    >
      {tip.text}
    </div>
  ) : null;

  return {
    editing: editing !== null,
    /** The item being edited in place, which the resize frame leaves alone. */
    editingId: editing && 'itemId' in editing ? editing.itemId : null,
    click,
    doubleClick,
    startNewNote,
    newChecklist,
    place,
    hover,
    overlays: (
      <>
        {overlay}
        {tooltip}
      </>
    ),
  };
}

function scaleRect(r: LocalRect, k: number): LocalRect {
  return { x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k };
}

function topZ(doc: CanvasDocument): number {
  let z = 0;
  for (const item of doc.items()) z = Math.max(z, item.z);
  return z + 1;
}

/**
 * Who last changed a task: the person, or the agent that acted for them
 * (ADR-0031) — "Claude Code (agent) for Ada", so an agent's work is never
 * mistaken for the person's own.
 */
export function credit(
  stamp: { readonly by?: string | null; readonly byAgent?: string | null },
  me: { readonly id: string; readonly displayName: string } | undefined,
  personName: (id: string) => string | undefined,
): string {
  const person = stamp.by
    ? stamp.by === me?.id
      ? me.displayName
      : personName(stamp.by)
    : undefined;
  if (stamp.byAgent) return `${stamp.byAgent} (agent) for ${person ?? 'someone'}`;
  return person ?? 'Someone';
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
