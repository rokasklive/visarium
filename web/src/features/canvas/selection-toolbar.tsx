import {
  type Camera,
  type CanvasDocument,
  type CanvasOperationBody,
  type FlipAxis,
  flipSelection,
  type GroupId,
  type ItemId,
  newGroupId,
  newItemId,
  selectionBounds,
  type ViewportSize,
  worldToScreen,
} from '@visarium/canvas-core';
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useUiStore } from '~/app/ui-store';
import { zEdge } from './canvas-toolbar';
import { outwardAssets, writeAssetTransfer } from './capture';
import {
  copySelection,
  dragNotice,
  NO_ORIGINALS,
  NOTICES,
  type Warm,
  warmOriginals,
} from './interchange';
import { nativeDragReady, stageOriginal, startNativeDrag } from './native-drag';

/**
 * Everything a person does to a selection, anchored to the selection.
 *
 * This is what the inspector column was going to be, and it is not a column:
 * front, back, group and ungroup used to live in a bar centred above a canvas
 * two thousand pixels wide, and the gesture was pick up an image at the
 * bottom-right, cross the board, press, cross back.
 *
 * Two rules hold it together:
 *
 *  1. **The order never changes.** The same slots in the same places for one
 *     item and for fifty. Context decides what a control does and what it
 *     reads, never whether it is there — a tool that appears and disappears is
 *     a tool nobody can build a habit around.
 *  2. **It is absent, not empty.** Nothing selected means no surface at all,
 *     and the canvas has those pixels back.
 *
 * Delete is last, behind its own divider, and wears the same quiet ghost style
 * as everything else: position protects it, not colour. It is undoable, and the
 * Destructive-Act Rule governs the irreversible.
 *
 * Take out is the one control with two gestures — press to copy, drag to carry
 * the originals out of the browser — because both mean "take this out of
 * Visarium" and two controls for one intention would have cost a slot for a
 * distinction nobody makes. It is also the bar's only reason to exist as a DOM
 * element rather than as canvas pixels: a native drag needs a `draggable`
 * element, and the canvas is one `<canvas>` whose press-and-move is already
 * three gestures. See openspec `asset-interchange`.
 *
 * In the desktop app the drag carries the originals out as real files, with
 * their names, through a native drag the app starts (native-drag.ts). In a
 * browser it carries what it always has: the private types, the files for a
 * drop inside the browser, the URLs for anything else.
 */

/** Screen pixels between the selection's bounds and the bar. Never scaled by zoom. */
const ANCHOR_GAP = 10;
/**
 * The gap when the bar sits ABOVE: clear of the Transformer's rotate handle,
 * which Konva draws 50px over the box (its default `rotateAnchorOffset`) as an
 * 8px anchor (`anchorSize` in canvas-surface.tsx). At 10px the bar lay across
 * the handle's stem and squeezed the handle above it. Below has no handle.
 */
const ABOVE_GAP = 50 + 8 / 2 + 8;
/** Keeps the bar clear of the viewport's edges and of the canvas toolbar above. */
const VIEWPORT_MARGIN = 8;
/** The cascade a placement already uses, so a copy is offset the way a drop is. */
const DUPLICATE_OFFSET = 24;
/**
 * How long a selection must sit still before its originals are worth fetching,
 * and how many of them that is worth doing for. Guesses; see OPEN_QUESTIONS Q20.
 *
 * The settle is SHORT on purpose. Its only job is to keep a marquee — which
 * changes the selection every frame — from fetching anything, and the timer is
 * cleared on every change, so any delay at all does that. Every millisecond
 * beyond it is taken straight out of the head start the fetch needs.
 *
 * The bound exists because select-all on a large board would otherwise fetch
 * every original on it.
 */
const WARM_SETTLE_MS = 150;
const WARM_ON_SELECT_MAX = 8;
/** Pixels a press must travel before it becomes the desktop app's native drag. */
const NATIVE_DRAG_SLOP = 3;

export function SelectionToolbar({
  doc,
  camera,
  size,
  selection,
  commit,
  setSelection,
  onOpacityPreview,
  hidden,
  labelSignal,
  collapsed,
  onToggleCollapsed,
}: {
  doc: CanvasDocument;
  camera: Camera;
  size: ViewportSize;
  selection: ReadonlySet<ItemId>;
  commit: (...bodies: CanvasOperationBody[]) => void;
  setSelection: (ids: Iterable<ItemId>) => void;
  /** The in-flight value, which the surface draws instead of the document's. */
  onOpacityPreview: (opacity: number | null) => void;
  /** A gesture is in flight: the bar must not follow it or cover what it moves. */
  hidden: boolean;
  /** Bumped by `F2`, so the keyboard opens the same field the bar does. */
  labelSignal: number;
  /** Folded down to its handle. A prop, not a store read, because the bar is
   * rendered by a test that has no store — and because everything else the bar
   * needs already arrives this way. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const bar = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [labelling, setLabelling] = useState(false);
  const [draft, setDraft] = useState('');
  /** Non-null only while the slider is held. Nothing enters the document until release. */
  const [pending, setPending] = useState<number | null>(null);
  /**
   * Originals fetched ahead of a drag that has not started yet.
   *
   * `dragstart` is synchronous — `DataTransfer.items.add` needs a `File` in hand
   * at the instant it runs — so the bytes are warmed when a pointer ENTERS this
   * control, hundreds of milliseconds earlier, and abandoned when it leaves.
   * Invariant 6 is untouched: no pointer handler on the CANVAS awaits a request,
   * and a hover on a button is not that handler.
   */
  const warm = useRef<Warm | null>(null);
  /** The asset set the warm above is for, so enter-then-press does not restart it. */
  const warmedFor = useRef('');
  /**
   * Bumped as originals land, purely so the control can redraw.
   *
   * A ref holds the files because `dragstart` reads them synchronously; this is
   * the render's half of the same fact.
   */
  const [arrived, setArrived] = useState(0);
  /** Sized off-screen rather than hidden: `setDragImage` ignores what is not rendered. */
  const dragImage = useRef<HTMLImageElement | null>(null);
  /**
   * Where the press on take out began. In the desktop app, moving from it is
   * what starts the native drag — there is no HTML drag to start it from; see
   * native-drag.ts for why.
   */
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const setInterchangeNotice = useUiStore((s) => s.setInterchangeNotice);

  // A selection cleared while the warm is in flight should not keep fetching
  // originals for a bar that no longer exists. Escape is the common way in.
  useEffect(() => () => warm.current?.abort(), []);

  /**
   * What this selection can hand to the operating system: distinct assets,
   * bottom of the stack first, placeholders excluded. Excluded for the reason
   * `duplicateSelection` already gives — an item with no asset id has nothing
   * stored to hand over — rather than for a new one.
   *
   * Computed above the early return below, because the warm hangs off it and a
   * hook cannot.
   */
  const outward = outwardAssets(doc, selection);
  const outwardKey = outward.map((asset) => asset.assetId).join();

  // Stable: it touches only refs and a setter, so the settle effect below can
  // depend on it without restarting its timer on every render.
  const startWarm = useCallback((assetIds: readonly string[]) => {
    // Settle, enter and press all call this within a few hundred milliseconds.
    // Restarting would abort the fetch the earliest one began, which is the
    // whole head start.
    if (warmedFor.current === assetIds.join()) return;
    warm.current?.abort();
    warmedFor.current = assetIds.join();
    setArrived(0);
    warm.current = warmOriginals(assetIds, () => {
      setArrived((n) => n + 1);
      // The desktop app's drag needs each original on disk before the press,
      // for the reason this warm exists. A browser stages nothing.
      for (const [assetId, file] of warm.current?.originals ?? []) {
        stageOriginal(assetId, file)?.then(
          () => setArrived((n) => n + 1),
          // Refused or failed: nothing is staged and the ordinary drag stays.
          // Said, because a drag that quietly leaves as a URL looks like no
          // feature at all.
          (error: unknown) => console.warn('drag out: could not stage', assetId, error),
        );
      }
    });
  }, []);

  /**
   * Fetch the originals when the SELECTION settles, not when the control is
   * hovered.
   *
   * This was hover-only and it lost the race almost every time. A person moves
   * onto the control and presses within a couple of hundred milliseconds, and an
   * original is megabytes — so `dragstart` arrived with nothing in hand and the
   * drag had to be refused, which looks exactly like a broken control.
   *
   * Selecting something is the earliest honest signal that it might be dragged,
   * and it precedes the press by the pointer's whole journey to the bar. The
   * settle is what makes it safe: a marquee changes the selection every frame
   * and never sits still, so it never reaches the timer.
   *
   * Bounded, because select-all on a large board would otherwise fetch every
   * original on it. Above the bound the hover is still the signal — an explicit
   * act, and the same two-step this used to force on everybody.
   */
  useEffect(() => {
    const assetIds = outwardKey.length === 0 ? [] : outwardKey.split(',');
    if (assetIds.length === 0 || assetIds.length > WARM_ON_SELECT_MAX) return;
    const timer = window.setTimeout(() => startWarm(assetIds), WARM_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [outwardKey, startWarm]);

  // Measured rather than assumed, because the clamp needs the real width and the
  // label field changes it. Runs every pass and writes only on a change, like
  // the Transformer sync in the surface.
  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const next = { width: element.offsetWidth, height: element.offsetHeight };
    setBox((current) =>
      current.width === next.width && current.height === next.height ? current : next,
    );
  });

  const groupId = soleGroupId(doc, selection);
  const framed = groupId ? (doc.group(groupId)?.frame ?? false) : false;

  useEffect(() => {
    if (labelSignal === 0) return;
    setDraft((groupId && doc.group(groupId)?.label) || '');
    setLabelling(true);
  }, [labelSignal, doc, groupId]);

  // Committed bounds, never another actor's in-flight preview: chrome that
  // chased someone else's drag would move under the local pointer, which is the
  // one thing chrome must never do.
  const bounds = selectionBounds(doc, selection);
  if (selection.size === 0 || !bounds || hidden) return null;

  const above = worldToScreen(camera, size, {
    x: (bounds.minX + bounds.maxX) / 2,
    y: bounds.minY,
  });
  const below = worldToScreen(camera, size, {
    x: (bounds.minX + bounds.maxX) / 2,
    y: bounds.maxY,
  });

  // Above the selection when there is room, below it when there is not — which
  // is also what keeps it clear of the canvas toolbar at the top of the screen.
  const wanted = above.y - ABOVE_GAP - box.height;
  const top = clamp(
    wanted < VIEWPORT_MARGIN ? below.y + ANCHOR_GAP : wanted,
    VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, size.height - box.height - VIEWPORT_MARGIN),
  );
  /*
   * Clamped as a CENTRE and written as a left edge, which is the whole of it.
   *
   * `above.x` is the centre of the selection and the bar wants to be centred on
   * it, so the clamp is expressed in centres — then `- half` converts to the
   * edge CSS actually positions by. Writing the centre straight into `left` put
   * the bar half a bar-width right of where it belonged everywhere, and pushed
   * its right edge past the viewport at the upper clamp, which is what put a
   * horizontal scrollbar on a canvas that has no business having one.
   */
  const half = box.width / 2;
  const left =
    clamp(
      above.x,
      VIEWPORT_MARGIN + half,
      Math.max(VIEWPORT_MARGIN + half, size.width - VIEWPORT_MARGIN - half),
    ) - half;

  const first = doc.item([...selection][0] as ItemId);
  const opacity = pending ?? first?.appearance.opacity ?? 1;

  const previewOpacity = (value: number) => {
    setPending(value);
    onOpacityPreview(value);
  };

  const commitOpacity = () => {
    if (pending === null) return;
    commit(...opacityBodies(doc, selection, pending));
    setPending(null);
    onOpacityPreview(null);
  };

  const abandonOpacity = () => {
    setPending(null);
    onOpacityPreview(null);
  };

  const reorder = (toFront: boolean) => {
    const edge = zEdge(doc);
    let step = 1;
    commit(
      ...[...selection].map(
        (itemId): CanvasOperationBody => ({
          type: 'item.z',
          itemId,
          z: toFront ? edge.max + step++ : edge.min - step++,
        }),
      ),
    );
  };

  const confirmLabel = () => {
    const label = draft.trim();
    setLabelling(false);
    if (label.length === 0) return;
    commit(...labelBodies(doc, selection, label));
  };

  /**
   * What this selection can hand to the operating system: distinct assets,
   * bottom of the stack first, placeholders excluded. Excluded for the reason
   * `duplicateSelection` already gives — an item with no asset id has nothing
   * stored to hand over — rather than for a new one.
   */
  const topmost = outward.at(-1);
  /**
   * Whether a drag would carry anything.
   *
   * Drawn rather than discovered: a control that looks draggable and then
   * refuses is indistinguishable from a broken one, which is exactly what the
   * first version of this was. `arrived` is read here only to make the render
   * depend on it — the files themselves come off the ref, synchronously, when
   * `dragstart` actually runs.
   */
  const ready = arrived > 0 && (warm.current?.originals.size ?? 0) > 0;
  /** Desktop app only: every original is on disk, so a drag leaves as files. */
  const native = nativeDragReady(outward.map((asset) => asset.assetId));

  const runDuplicate = () => {
    const copy = duplicateSelection(doc, selection);
    if (copy.bodies.length === 0) return;
    commit(...copy.bodies);
    setSelection(copy.itemIds);
  };

  return (
    <div
      ref={bar}
      data-testid="selection-toolbar"
      style={{ left, top }}
      className="absolute flex max-w-[calc(100%-16px)] origin-top-left items-center gap-1 rounded border border-line-strong bg-surface/95 px-1 py-1 text-[11px]"
    >
      {/*
        The order, and it is fixed: take out, label, frame, the flips, front and
        back, group, duplicate │ opacity │ delete. Context changes what a control
        does and never whether it is there — a group of one is permitted precisely
        so that group has no reason to vanish for a single selection.

        Delete is still last behind its own divider, away from everything pressed
        repeatedly, and opacity sits between the two: it moved off the front of
        the bar because it is the one control you drag rather than press, and a
        slider is a poor thing to meet first.
      */}
      {collapsed ? null : (
        <>
          {/* Slot 1 — out of Visarium: press to copy, drag to carry the files. */}
          <Button
            label="Take out"
            hint={
              ready
                ? 'Copy to the clipboard, or drag out to carry the original files'
                : 'Copy to the clipboard — fetching the originals before they can be dragged'
            }
            // Not draggable until there is something to drag. The browser then
            // never starts a drag that would have to be cancelled, so there is no
            // moment where it looks like it is working and is not.
            draggable={ready && !native}
            dim={!ready}
            onPointerEnter={() => startWarm(outward.map((a) => a.assetId))}
            // A press is a stronger intent signal than a hover and costs nothing
            // extra: the endpoint is immutable-cached, so a warm already running
            // is not restarted and a repeat is served from the browser's cache.
            onPointerDown={(event) => {
              startWarm(outward.map((a) => a.assetId));
              pressedAt.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerMove={(event) => {
              const at = pressedAt.current;
              if (!native || !at || event.buttons !== 1) return;
              if (Math.hypot(event.clientX - at.x, event.clientY - at.y) < NATIVE_DRAG_SLOP) return;
              pressedAt.current = null;
              startNativeDrag(outward.map((asset) => asset.assetId));
            }}
            onPointerLeave={() => {
              warm.current?.abort();
              warmedFor.current = '';
            }}
            onDragStart={(event) => {
              // Nothing is awaited here, and nothing may be — `dragstart` is
              // synchronous, which is the whole reason the warm above exists.
              const originals = warm.current?.originals ?? NO_ORIGINALS;
              const problem = dragNotice(outward, originals);
              if (problem) {
                /*
                 * Refuse the drag rather than start an empty one.
                 *
                 * A drag carrying no file looks exactly like a drag carrying one
                 * until it lands somewhere and nothing arrives, and the person is
                 * watching the pointer rather than the status strip while it
                 * happens. Cancelling is the honest form of "no file was
                 * carried": nothing is dragged, the reason is on screen, and the
                 * warm this press started means the next attempt is the one that
                 * works.
                 */
                event.preventDefault();
                setInterchangeNotice(problem);
                return;
              }
              writeAssetTransfer(event.dataTransfer, outward, originals, doc.canvasId);
              if (dragImage.current) event.dataTransfer.setDragImage(dragImage.current, 0, 0);
              setInterchangeNotice(null);
            }}
            onClick={() => {
              if (outward.length === 0) {
                setInterchangeNotice(NOTICES.notStored);
                return;
              }
              // Deliberately not awaited: `copySelection` reaches the clipboard
              // write synchronously inside this gesture, which is what Safari
              // requires, and only the OUTCOME arrives later.
              void copySelection(outward, warm.current?.originals ?? NO_ORIGINALS).then((outcome) =>
                setInterchangeNotice(outcome === 'original' ? null : NOTICES[outcome]),
              );
            }}
          >
            <TakeOutIcon />
          </Button>

          {/* Slot 2 — naming, which is grouping said another way. */}
          {labelling ? (
            <input
              // Inline, not a modal: UX_PRINCIPLES reserves modals for
              // destructive confirmations, and naming a cluster of references is
              // not one.
              //
              // Focused through a ref rather than `autoFocus`, which is an
              // accessibility violation on a page that merely loads. This field
              // does not merely load — it exists because someone pressed Label or
              // F2, and typing into it at once is the whole point.
              ref={focusOnMount}
              aria-label="Group label"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') confirmLabel();
                if (e.key === 'Escape') setLabelling(false);
              }}
              onBlur={() => setLabelling(false)}
              className="w-28 rounded border border-line-strong bg-surface-sunken px-1 py-0.5 text-ink"
            />
          ) : (
            <Button
              label="Label"
              onClick={() => {
                setDraft((groupId && doc.group(groupId)?.label) || '');
                setLabelling(true);
              }}
            >
              <LabelIcon />
            </Button>
          )}
          {/*
            Framing, which bounds what the label names. Present for every
            selection — the order never changes — and able to act only when the
            selection is exactly one whole group, which is what its dimness and
            its hint say before anyone presses it. F4 is its keyboard form.
          */}
          <Button
            label={framed ? 'Unframe' : 'Frame'}
            hint={groupId ? undefined : 'Select exactly one whole group to frame it'}
            dim={!groupId}
            pressed={framed || undefined}
            onClick={() => {
              if (!groupId) return;
              commit({ type: 'group.frame', groupId, frame: !framed });
            }}
          >
            <FrameIcon framed={framed} />
          </Button>
          <Divider />

          {/* Slot 3 — the two flips. */}
          <Button label="Flip H" onClick={() => commit(...flipSelection(doc, selection, 'x'))}>
            <FlipIcon vertical={false} />
          </Button>
          <Button label="Flip V" onClick={() => commit(...flipSelection(doc, selection, 'y'))}>
            <FlipIcon vertical />
          </Button>
          <Divider />

          {/* Slot 4 — z-order, which left the canvas toolbar to be here. */}
          <Button label="Front" onClick={() => reorder(true)}>
            <StackIcon toFront />
          </Button>
          <Button label="Back" onClick={() => reorder(false)}>
            <StackIcon toFront={false} />
          </Button>
          <Divider />

          {/*
            Slot 5 — structure, then the copy that lands on the board. A group of
            one is permitted, which is what lets this slot be present and active
            for every selection rather than disabled for a single item. Arrange is
            appended AFTER group when it ships, so nothing already learned moves.
          */}
          <Button
            label={groupId ? 'Ungroup' : 'Group'}
            onClick={() => {
              if (groupId) {
                commit({ type: 'group.delete', groupId });
                setSelection(selection);
                return;
              }
              commit({ type: 'group.create', groupId: newGroupId(), memberIds: [...selection] });
            }}
          >
            <GroupIcon grouped={groupId !== undefined} />
          </Button>
          <Button label="Duplicate" onClick={runDuplicate}>
            <DuplicateIcon />
          </Button>
          <Divider />

          {/* Slot 6 — opacity, the one control you drag rather than press. */}
          <Opacity
            value={opacity}
            onPreview={previewOpacity}
            onCommit={commitOpacity}
            onAbandon={abandonOpacity}
          />
          <Divider />

          {/*
            Slot 7 — delete, last and behind its own divider, away from everything
            pressed repeatedly. Same ghost button as the rest: it is undoable, so
            position protects it rather than colour. An X rather than a bin, for
            the reason DESIGN_SYSTEM gives about glyphs that need a legend.
          */}
          <Button
            label="Delete"
            onClick={() => {
              commit(
                ...[...selection].map(
                  (itemId): CanvasOperationBody => ({ type: 'item.delete', itemId }),
                ),
              );
              setSelection([]);
            }}
          >
            <DeleteIcon />
          </Button>
        </>
      )}

      {/*
        The fold. Last, so it does not move when the bar behind it does, and it
        is the one control still there when everything else is folded away —
        otherwise folding would be a one-way door.
      */}
      <Button label={collapsed ? 'Show tools' : 'Hide tools'} onClick={onToggleCollapsed}>
        <ChevronIcon pointingRight={collapsed} />
      </Button>

      {topmost && (
        /*
          So the drag reads as dragging the image rather than dragging a button.
          The 256 derivative of the topmost selected item, which is already in
          the browser's cache because the canvas is drawing it.
        */
        <img
          ref={dragImage}
          src={`/api/assets/${topmost.assetId}/derivatives/256`}
          alt=""
          width={128}
          className="pointer-events-none absolute -left-[9999px] top-0"
        />
      )}
    </div>
  );
}

/**
 * The group every selected item belongs to, when there is exactly one and it
 * holds nothing else.
 *
 * `undefined` means the selection is not a group — either ungrouped, spanning
 * two groups, or part of one — and every act that branches on it treats those
 * three the same way, because to the person they are the same thing: this is
 * not a named cluster yet.
 */
export function soleGroupId(doc: CanvasDocument, ids: Iterable<ItemId>): GroupId | undefined {
  let found: GroupId | undefined;
  let count = 0;
  for (const id of ids) {
    const groupId = doc.item(id)?.groupId;
    if (groupId === undefined) return undefined;
    if (found === undefined) found = groupId;
    else if (found !== groupId) return undefined;
    count++;
  }
  if (found === undefined) return undefined;
  return doc.group(found)?.memberIds.length === count ? found : undefined;
}

/** One operation per item, carrying the whole appearance the item ends up with. */
export function opacityBodies(
  doc: CanvasDocument,
  ids: Iterable<ItemId>,
  opacity: number,
): CanvasOperationBody[] {
  const bodies: CanvasOperationBody[] = [];
  for (const id of ids) {
    const item = doc.item(id);
    if (item)
      bodies.push({
        type: 'item.appearance',
        itemId: id,
        appearance: { ...item.appearance, opacity },
      });
  }
  return bodies;
}

/**
 * Labelling a selection is grouping it.
 *
 * A label belongs to a group, so naming an ungrouped selection creates the
 * group — of one item if that is what was selected. `group.create` carries the
 * label; `group.label` renames, because `group.create` is defined to do nothing
 * to a group that already exists.
 */
export function labelBodies(
  doc: CanvasDocument,
  ids: ReadonlySet<ItemId>,
  label: string,
): CanvasOperationBody[] {
  const groupId = soleGroupId(doc, ids);
  return groupId
    ? [{ type: 'group.label', groupId, label }]
    : [{ type: 'group.create', groupId: newGroupId(), memberIds: [...ids], label }];
}

/**
 * Copies of a selection, as operations — no new operation type needed.
 *
 * A still-uploading item is skipped, and that is not a shortcut: its content
 * has no asset id, and only the ORIGINAL's upload will ever produce an
 * `item.content` for the ORIGINAL's id. A copy of it would be a placeholder
 * `BoardSync` defers forever — an item the server can never hold. The tool
 * stays present and copies what can be copied.
 */
export function duplicateSelection(
  doc: CanvasDocument,
  ids: ReadonlySet<ItemId>,
): { bodies: CanvasOperationBody[]; itemIds: ItemId[] } {
  const top = zEdge(doc).max;
  const bodies: CanvasOperationBody[] = [];
  const itemIds: ItemId[] = [];

  for (const id of ids) {
    const item = doc.item(id);
    if (item?.content.kind !== 'image') continue;
    const itemId = newItemId();
    itemIds.push(itemId);
    bodies.push({
      type: 'item.create',
      itemId,
      transform: {
        ...item.transform,
        x: item.transform.x + DUPLICATE_OFFSET,
        y: item.transform.y + DUPLICATE_OFFSET,
      },
      z: top + itemIds.length,
      content: item.content,
      appearance: item.appearance,
    });
  }
  if (bodies.length === 0) return { bodies, itemIds };

  const groupId = soleGroupId(doc, ids);
  const label = groupId === undefined ? undefined : doc.group(groupId)?.label;
  if (groupId !== undefined) {
    bodies.push({
      type: 'group.create',
      groupId: newGroupId(),
      memberIds: itemIds,
      ...(label !== undefined ? { label } : {}),
    });
  }
  return { bodies, itemIds };
}

/**
 * A continuous control that introduces no new shape.
 *
 * A restyled native `<input type="range">` — a 2px track, an 8×16 handle at the
 * system's one 4px radius, no circle and no second radius — so arrow-key
 * stepping and the platform's screen-reader semantics are the platform's rather
 * than a div with a pointer handler. See `.slider` in app.css.
 */
function Opacity({
  value,
  onPreview,
  onCommit,
  onAbandon,
}: {
  value: number;
  onPreview: (value: number) => void;
  onCommit: () => void;
  onAbandon: () => void;
}) {
  const percent = Math.round(value * 100);
  return (
    <span className="flex items-center gap-1 px-1">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label="Opacity"
        className="slider"
        style={{ '--slider-fill': `${percent}%` } as React.CSSProperties}
        onChange={(e) => onPreview(Number(e.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onAbandon();
        }}
      />
      {/* Tabular, because it changes while the person is watching it. */}
      <span className="w-8 text-right text-ink-dim tabular-nums">{percent}%</span>
    </span>
  );
}

/** A callback ref, so the field takes focus the moment it exists and not before. */
function focusOnMount(element: HTMLInputElement | null): void {
  element?.focus();
  element?.select();
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * One slot on the bar.
 *
 * `label` is the control's name in three places at once — the tooltip, the
 * accessible name, and what a test asks for it by. An icon-only control with no
 * accessible name is a control a screen reader cannot describe and a keyboard
 * user cannot find, so the label is required rather than optional: there is no
 * way to build a nameless button here.
 *
 * `hint` is for the one control whose tooltip has to say more than its name,
 * because it has two gestures.
 *
 * The drag props are here rather than in a second component because take out is
 * a Button that also drags — the bar has one control shape and adding a second
 * would be the first place its quiet uniformity broke.
 */
function Button({
  onClick,
  label,
  hint,
  dim,
  pressed,
  children,
  ...drag
}: {
  onClick: () => void;
  label: string;
  hint?: string | undefined;
  /** Present and pressable, but with less to offer than usual — see `ready`. */
  dim?: boolean | undefined;
  /** A toggle's state, made permanent the way DESIGN_SYSTEM gives ghost buttons. */
  pressed?: boolean | undefined;
  children: ReactNode;
} & Pick<
  ComponentProps<'button'>,
  | 'draggable'
  | 'onDragStart'
  | 'onPointerDown'
  | 'onPointerMove'
  | 'onPointerEnter'
  | 'onPointerLeave'
>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint ?? label}
      aria-label={label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...drag}
      className={`rounded p-1 hover:bg-surface-raised hover:text-ink ${
        pressed ? 'bg-surface-raised text-ink' : dim ? 'text-ink-disabled' : 'text-ink-dim'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The glyphs.
 *
 * Hand-drawn rather than a dependency: the product needed nine icons and an icon
 * package is a thousand, a build step and a version to keep. They are line
 * drawings on a 14px box at `currentColor`, so they inherit the same `ink-dim`
 * the words did and introduce no colour, no fill and no second radius. Nothing
 * is circular, per DESIGN_SYSTEM.
 *
 * Every one of them is decorative: the button above carries the name.
 */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="square"
      aria-hidden
      // Transparent to the pointer, so the button is always the event target and
      // always the drag source. A glyph that can be the target of a `mousedown`
      // is a glyph that can be the thing a native drag tries to start from.
      className="pointer-events-none"
    >
      {children}
    </svg>
  );
}

/** An arrow leaving an open box — the only one of these that goes outward. */
function TakeOutIcon() {
  return (
    <Glyph>
      <path d="M6.5 2.5H2.5v9h9V7.5" />
      <path d="M7.5 6.5L11.5 2.5" />
      <path d="M8 2.5h3.5V6" />
    </Glyph>
  );
}

/** A tag: naming a selection is what makes it a group. */
function LabelIcon() {
  return (
    <Glyph>
      <path d="M2.5 2.5h5l4 4-5 5-4-4z" />
      <path d="M5 5h.01" />
    </Glyph>
  );
}

/**
 * A stepped outline around two items — the shape a frame draws, which is why it
 * is stepped rather than rectangular: the icon lies if the contour cannot.
 * Solid when framed, dashed when not, mirroring the group glyph's grammar.
 */
function FrameIcon({ framed }: { framed: boolean }) {
  return (
    <Glyph>
      <path d="M1.5 3.5h6v2h4v6H5V9.5h-3.5z" strokeDasharray={framed ? undefined : '2 2'} />
      <path d="M4 6.5h2.5v3H4z" />
      <path d="M8.5 8h2.5v2.5H8.5z" />
    </Glyph>
  );
}

/** Two shapes mirrored across the axis they are flipped about, which is dashed. */
function FlipIcon({ vertical }: { vertical: boolean }) {
  return (
    <Glyph>
      <g transform={vertical ? 'rotate(90 7 7)' : undefined}>
        <path d="M7 1.5v11" strokeDasharray="2 2" />
        <path d="M5.5 3.5v7h-4z" />
        <path d="M8.5 3.5v7h4z" />
      </g>
    </Glyph>
  );
}

/** Two plates, the moving one drawn solid and the other behind or in front of it. */
function StackIcon({ toFront }: { toFront: boolean }) {
  return (
    <Glyph>
      {toFront ? (
        <>
          <path d="M2 5.5h4.5V10H2z" />
          <path d="M5.5 3.5h6.5V10H5.5z" fill="currentColor" stroke="none" />
        </>
      ) : (
        <>
          <path d="M2 3.5h6.5V10H2z" fill="currentColor" stroke="none" />
          <path d="M7.5 5.5H12V10H7.5z" />
        </>
      )}
    </Glyph>
  );
}

/** Two items inside a dashed boundary — solid once they are actually one group. */
function GroupIcon({ grouped }: { grouped: boolean }) {
  return (
    <Glyph>
      <path d="M1.5 1.5h11v11h-11z" strokeDasharray={grouped ? undefined : '2 2'} />
      <path d="M3.5 3.5h3v3h-3z" />
      <path d="M7.5 7.5h3v3h-3z" />
    </Glyph>
  );
}

/** Two of the same thing, offset the way a duplicate lands. */
function DuplicateIcon() {
  return (
    <Glyph>
      <path d="M1.5 4.5h8v8h-8z" />
      <path d="M4.5 1.5h8v8" />
    </Glyph>
  );
}

/** An X, not a bin: DESIGN_SYSTEM is explicit that a bin glyph needs a legend. */
function DeleteIcon() {
  return (
    <Glyph>
      <path d="M3 3l8 8" />
      <path d="M11 3l-8 8" />
    </Glyph>
  );
}

/** The fold, pointing the way the bar will go. */
function ChevronIcon({ pointingRight }: { pointingRight: boolean }) {
  return (
    <Glyph>
      <path d={pointingRight ? 'M5.5 2.5l5 4.5-5 4.5' : 'M8.5 2.5l-5 4.5 5 4.5'} />
    </Glyph>
  );
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-line" />;
}

/** Re-exported so the surface's keyboard shortcuts act through the same code. */
export type { FlipAxis };
