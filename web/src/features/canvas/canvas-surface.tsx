import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  type Anchor,
  applySelection,
  asAssetId,
  asItemId,
  type Camera,
  type CanvasDocument,
  CanvasHistory,
  type CanvasItem,
  type CanvasItemContent,
  type CanvasOperationBody,
  type Crop,
  type CropFrame,
  clampEdges,
  classifyText,
  computeActiveSet,
  cropFrame,
  DEFAULT_CAMERA,
  deleteItemsBodies,
  dropTargets,
  type Edges,
  expandToGroups,
  type FlipAxis,
  fitRect,
  flipSelection,
  fromEdges,
  GRID_PITCH,
  type GroupId,
  groupOutline,
  type ItemId,
  ItemLod,
  type LinkId,
  marqueeSelect,
  membershipBodies,
  movingEdges,
  newLinkId,
  originalTransform,
  outlineWithout,
  panBy,
  type Rect,
  rotateSelection,
  type SelectionMode,
  sameAnchor,
  scaleSelection,
  screenToWorld,
  selectionState,
  slideCrop,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  type Transform,
  textScaleOf,
  toFrame,
  toWorld,
  transformBounds,
  unionRects,
  type VisibleItem,
  visibleEdges,
  visibleWorldRect,
  zoomAt,
} from '@visarium/canvas-core';
import {
  type AggregateContext,
  bakeScale,
  paintAggregate,
  toKonvaAppearance,
  toKonvaAttrs,
  toKonvaCrop,
  toStageAttrs,
} from '@visarium/canvas-renderer-konva';
import Konva from 'konva';
import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  Image as KonvaImage,
  Line as KonvaLine,
  Rect as KonvaRect,
  Text as KonvaText,
  Layer,
  Shape,
  Stage,
  Transformer,
} from 'react-konva';
import { assetsById } from '~/api/assets';
import { loadSnapshotInto, reportElements } from '~/api/boards';
import { type SessionState, sessionKey } from '~/api/session';
import { loadSharedSnapshotInto } from '~/api/sharing';
import { useTheme } from '~/app/theme';
import { useUiStore } from '~/app/ui-store';
import { DEVTOOLS, INSPECTOR_WIDTH } from '~/devtools';
import { Inspector } from '../inspector/load';
import { OpLog } from '../inspector/log';
import { installBench, noteRender } from './bench';
import { useBitmaps } from './bitmap-cache';
import { BoardSync } from './board-sync';
import { canvasTheme } from './canvas-theme';
import { CanvasToolbar, useLinksOnFocus, zEdge } from './canvas-toolbar';
import {
  createItem,
  createPlacement,
  type DraggedAsset,
  outwardAssets,
  placeCapture,
  readCapture,
  readTransfer,
} from './capture';
import { useGifs } from './gif';
import { copySelection, NO_ORIGINALS, NOTICES } from './interchange';
import { nameBlock } from './objects/blocks';
import { type Block, type Layout, noteHtml } from './objects/layout';
import {
  anchorAt,
  anchorBox,
  blockAt,
  contains,
  type DrawnLink,
  defaultLinkType,
  groupDrawing,
  groupLinks,
  isTitle,
  labelBox,
  layoutBox,
  linkCounts,
  linkNear,
  midpoint,
  nextLinkType,
  segmentBetween,
} from './objects/links';
import { loadMarkdown, loaded as objectRenderersLoaded } from './objects/loaders';
import { drawnHeight, isObject, layoutKey, ObjectLayouts, type ObjectView } from './objects/store';
import { useObjectEditing } from './objects/use-editing';
import {
  AgentFocusLabels,
  agentFocusMarks,
  PresenceRoster,
  previewFor,
  RemoteCursors,
  remoteSelectionMarks,
} from './presence-layer';
import { agentIsWorking, BoardRealtime, EMPTY_PRESENCE, type RemotePresence } from './realtime';
import { fallbackText, findResults, type SearchTarget, targetKey } from './search';
import { SearchBar } from './search-bar';
import { SearchMarks } from './search-marks';
import {
  cropTargetOf,
  duplicateSelection,
  opacityBodies,
  SelectionToolbar,
  soleGroupId,
} from './selection-toolbar';
import { ShortcutLegend } from './shortcut-legend';
import { SpaceTap } from './shortcuts';
import { type UploadedAsset, UploadQueue } from './upload';

/**
 * The canvas.
 *
 * Three rules hold this file together:
 *
 *  1. The scene comes from `computeActiveSet` and nowhere else. There is no code
 *     path here that iterates the document's items.
 *  2. Nothing mutates the document except through `history.apply`, which routes
 *     into `CanvasDocument.apply` and keeps the inverse (ADR-0004).
 *  3. Motion during a gesture is Konva's; the document only hears the result.
 *     A React state update per pointermove is how the frame budget is lost.
 */

const IMAGE_LODS = new Set<string>([ItemLod.FULL, ItemLod.PREVIEW, ItemLod.THUMBNAIL]);

/**
 * Ceiling on instantiated scene nodes.
 *
 * `maxItems` in canvas-core bounds the active SET, and an aggregate entry costs
 * a rect in a shared path — nearly nothing. A node costs a Konva shape, a React
 * element and a draw. The benchmark put ~1300 nodes on screen at an intermediate
 * zoom on the 100k board and the frame budget went with them, so the ceiling
 * that matters is this one. Items above it are aggregated, lowest z first,
 * because those are the ones already behind something.
 */
const MAX_NODES = 500;

/**
 * A group's annotation, in screen pixels — divided by zoom at the point of
 * use, like every other interface stroke on the canvas (canvas/group-labels).
 *
 * The label is the annotation face (ADR-0022), uppercase Departure Mono, set
 * only on the face's own 11 px grid: its pixels land on whole screen pixels
 * there and blur anywhere between. 11 px up close; 22 px once the board is
 * zoomed out past `FAR_BELOW`, where a group's name is wayfinding read from a
 * distance. The face is already monospaced and spaced, so no tracking.
 *
 * A framed label sits on its contour over one ground-coloured patch (`PAD`
 * around the text), which stops the line either side. A per-glyph halo left
 * the line showing between the letters, which read as struck-through.
 */
/**
 * How far a press travels before it is a drag, in screen pixels. Also what
 * tells a click on a control inside a note or checklist from moving the object
 * by it (canvas/object-gestures): a little more than a hand's tremor on a
 * trackpad click, a lot less than any deliberate move.
 */
Konva.dragDistance = 4;

/** How long a still press on a grouped item takes to pick it out (canvas/group-member-editing). */
export const HOLD_TO_PICK_MS = 350;

const GROUP_LABEL_SIZE = 11;
const GROUP_LABEL_SIZE_FAR = 22;
const GROUP_LABEL_FAR_BELOW = 0.5;
const GROUP_LABEL_FAMILY = '"Departure Mono", ui-monospace, monospace';
/** The face's advance: every glyph is 7 of the 11 px cell wide. */
const GROUP_LABEL_ADVANCE = 7 / 11;
const GROUP_LABEL_PAD = 4;
const GROUP_LABEL_GAP = 6;
/** A framed group's outline. Screen pixels, subordinate to every image. */
const FRAME_STROKE = 1.5;
/**
 * The ground grid yields as cells approach single-digit screen size: fading
 * out from `FADE_BELOW`, gone entirely below `HIDE_BELOW`. Hypotheses with a
 * milestone attached — see OPEN_QUESTIONS.
 */
const GRID_FADE_BELOW = 12;
const GRID_HIDE_BELOW = 6;
/** A grid dot's radius in screen pixels, the same at every zoom. */
const GRID_DOT_RADIUS = 1;

/** Prefix for the full-strength outline node beside a selected or held item. */
const SELECTION_MARK = 'sel-';
/** Node id prefixes for a group's frame and label, which a drag moves by hand. */
const GROUP_FRAME = 'gframe-';
const GROUP_KNOCKOUT = 'gknock-';
const GROUP_LABEL = 'glabel-';

/** The ghost of the whole original behind an item being cropped (ADR-0029). */
const CROP_GHOST = 'crop-ghost';
const CROP_GHOST_EDGE = 'crop-ghost-edge';
const CROP_GHOST_OPACITY = 0.3;
/** Smallest a crop may make an item, in screen pixels: a guess, like the lab's. */
const MIN_CROP_PX = 12;

/**
 * A crop gesture in flight. Latched when it starts, so letting go of Ctrl+Alt
 * mid-drag changes nothing; `item` and `frame` are the item as committed then.
 */
interface CropGesture {
  readonly kind: 'edges' | 'slide';
  readonly item: CanvasItem;
  readonly frame: CropFrame;
  readonly was: Edges;
  /** Where the node was when a slide started; the node is held there. */
  readonly start: { readonly x: number; readonly y: number };
  /** World pointer at the press that began a slide; the slide is measured from it. */
  readonly pointer: { readonly x: number; readonly y: number };
  last?: { readonly transform: Transform; readonly crop: Crop };
}

/** Konva's Transformer box, in absolute (screen) coordinates. */
interface TransformerBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** One derived contour and the geometry signature it was derived from. */
interface FrameEntry {
  signature: string;
  points: number[];
  minX: number;
  minY: number;
}

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'marquee'; origin: { x: number; y: number } };

export function CanvasSurface({
  doc,
  width: fullWidth,
  height,
  bitmapBudgetBytes,
  boardId,
  readOnly = false,
}: {
  doc: CanvasDocument;
  width: number;
  height: number;
  /** Q7's budget, overridable so it can be measured rather than asserted. */
  bitmapBudgetBytes?: number;
  /**
   * The board to persist to. Absent for a generated board — the benchmark
   * fixtures have nowhere to be saved and nothing to be saved from.
   */
  boardId?: string;
  /**
   * A share-link viewer's board (ADR-0026): pan, zoom, select to look closer,
   * and nothing that changes it. Everything durable goes through `commit`, so
   * making that a no-op is the whole of the guarantee on this side — the
   * server refuses a viewer's writes regardless. The socket is the viewer's
   * receive-only one, and nothing is persisted, so there is no queue.
   */
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** Dev builds: the inspector beside the board, which gives up its width. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const width = inspectorOpen ? Math.max(0, fullWidth - INSPECTOR_WIDTH) : fullWidth;
  /** Dev builds: every operation sent and received, and what became of it. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: one log per board, so a new document starts a new log
  const opLog = useMemo(() => (DEVTOOLS ? new OpLog() : null), [doc]);
  const stageRef = useRef<Konva.Stage | null>(null);
  /**
   * Where items moved by someone else — another person, an agent, or a
   * collision push — were drawn, so the next commit eases them to where they
   * now are instead of jumping (canvas/collision, design risks).
   */
  const easeFrom = useRef(new Map<ItemId, { x: number; y: number }>());
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || easeFrom.current.size === 0) return;
    for (const [id, from] of easeFrom.current) {
      const node = stage.findOne(`#${id}`);
      if (!node) continue;
      const to = node.position();
      if (to.x === from.x && to.y === from.y) continue;
      node.position(from);
      new Konva.Tween({
        node,
        x: to.x,
        y: to.y,
        duration: 0.18,
        easing: Konva.Easings.EaseOut,
      }).play();
    }
    easeFrom.current.clear();
  });
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const gesture = useRef<Gesture>({ kind: 'none' });
  const dragOrigins = useRef(new Map<ItemId, { x: number; y: number }>());
  /** Derived group contours, invalidated by the geometry signature inside each entry. */
  const frameCacheRef = useRef(new Map<GroupId, FrameEntry>());
  const spaceHeld = useRef(false);
  /** Tells a tap of Space (search) from a hold (pan), canvas/quick-search. */
  const spaceTap = useRef(new SpaceTap());

  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [marquee, setMarqueeState] = useState<Rect | null>(null);
  // Mirrored in a ref: the native gesture listeners read it without becoming a
  // dependency, and reading it in a state updater would run during render.
  const marqueeRef = useRef<Rect | null>(null);
  const setMarquee = useCallback((area: Rect | null) => {
    marqueeRef.current = area;
    setMarqueeState(area);
  }, []);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [presence, setPresence] = useState<RemotePresence>(EMPTY_PRESENCE);
  /**
   * A gesture is in flight — a drag, a resize, a marquee, a pan.
   *
   * State rather than the `gesture` ref because chrome has to re-render when it
   * changes; it moves twice per gesture, not once per pointermove.
   */
  const [gesturing, setGesturing] = useState(false);
  /** Ctrl+Alt is down: a handle drag now crops instead of resizing. */
  const [cropHeld, setCropHeld] = useState(false);
  /** `P` stops and restarts every GIF. Off from the start for anyone who asked their OS for less motion. */
  const [gifsPaused, setGifsPaused] = useState(
    () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const itemsLayer = useRef<Konva.Layer | null>(null);
  /** A crop gesture is running, which keeps the ghost up if the keys are let go. */
  const [cropLive, setCropLive] = useState(false);
  const cropGesture = useRef<CropGesture | null>(null);
  /** Where the last press on an item landed, in world space: a slide's origin. */
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  /**
   * The opacity under the slider, before it is committed.
   *
   * The same shape the canvas already uses for another actor's in-flight
   * transform: the renderer prefers it to the document's value, and the document
   * — and therefore history, sync and everyone else — hears only the release.
   */
  const [opacityPreview, setOpacityPreview] = useState<number | null>(null);
  /** Bumped by `F2`. The bar opens the same field its own button does. */
  const [labelSignal, setLabelSignal] = useState(0);
  /** The live socket, read by gesture handlers that must not re-subscribe per frame. */
  const realtimeRef = useRef<BoardRealtime | null>(null);
  const syncRef = useRef<BoardSync | null>(null);
  /** Items this gesture claimed, released once its operations are durable. */
  const claimed = useRef<ItemId[]>([]);

  // Re-renders the board on a theme switch; canvasTheme() then reads the new set.
  useTheme();
  const theme = canvasTheme();
  const history = useMemo(() => new CanvasHistory(doc), [doc]);
  /** Notes, diagrams and checklists, laid out for drawing (design D2). */
  /** Set while the board persists: reports a laid-out diagram's element boxes. */
  const reportElementsRef = useRef<((itemId: ItemId, key: string, layout: Layout) => void) | null>(
    null,
  );
  const objects = useMemo(
    () =>
      new ObjectLayouts(doc, redraw, (itemId, key, layout) =>
        reportElementsRef.current?.(itemId, key, layout),
      ),
    [doc],
  );

  // --- links (spec: canvas/links) ---------------------------------------------
  /** The selected link. Selecting a link clears the item selection and back. */
  const [selectedLink, setSelectedLink] = useState<LinkId | null>(null);
  const [hoveredLink, setHoveredLink] = useState<LinkId | null>(null);
  /**
   * The item under the pointer: its links come forward (canvas/links). A ref,
   * redrawing only the links, so crossing items never re-renders the surface.
   */
  const hoveredItem = useRef<ItemId | null>(null);
  const [linksOnFocus, setLinksOnFocus] = useLinksOnFocus();
  /** For the key handler, which is bound once: flips the setting as it is now. */
  const toggleLinksOnFocus = useRef(() => {});
  toggleLinksOnFocus.current = () => setLinksOnFocus(!linksOnFocus);
  /** Every link as last drawn, for hit-testing: the shape draws from live positions. */
  const drawnLinks = useRef<DrawnLink[]>([]);
  const linkShape = useRef<Konva.Shape | null>(null);
  /** The item under the pointer's drag: in `dragOrigins` only once the selection has caught up. */
  const draggingItem = useRef<ItemId | null>(null);
  /** An Alt-drag in progress: from where, to where the pointer is, onto what. */
  const linkDraft = useRef<{
    from: Anchor;
    pointer: { x: number; y: number };
    target: Anchor | null;
    /** A note passage the link starts from, named only when the link lands. */
    block?: Block;
  } | null>(null);
  const linkUi = useRef({ hovered: null as LinkId | null, selected: null as LinkId | null });
  linkUi.current = { hovered: hoveredLink, selected: selectedLink };

  // A dev build's window onto objects, for the specs that pin their layout.
  useEffect(() => {
    if (!DEVTOOLS) return;
    const hook = {
      layout: (id: string) => objects.debug(asItemId(id)),
      /** What search reads and where it would highlight (canvas/quick-search). */
      search: (id: string, query: string) => {
        const item = doc.item(asItemId(id));
        const layout = item && objects.view(item)?.layout;
        return layout ? { text: layout.text, rects: layout.measure(query) } : undefined;
      },
      loaded: objectRenderersLoaded,
      apply: (...bodies: CanvasOperationBody[]) => {
        const changed = history.apply(...bodies);
        redraw();
        return changed;
      },
      /** As if another client sent these: the path realtime takes. */
      remote: (...bodies: CanvasOperationBody[]) => {
        for (const body of bodies) doc.apply(body, 'remote');
        redraw();
      },
      item: (id: string) => doc.item(asItemId(id)),
      links: () =>
        drawnLinks.current.map((d) => ({
          id: d.link.id,
          linkType: d.link.linkType,
          count: d.count,
          faded: d.faded,
          broken: d.from.broken || d.to.broken,
          from: d.segment.from,
          to: d.segment.to,
        })),
      linkUi: () => linkUi.current,
    };
    (window as unknown as { __objects?: typeof hook }).__objects = hook;
    return () => {
      delete (window as unknown as { __objects?: typeof hook }).__objects;
    };
  }, [objects, history, doc]);
  /**
   * The library is beside the canvas now.
   *
   * Before M07 an upload had nothing on screen to tell: the library was a route
   * you navigated to, and it fetched when you got there. The sidebar panel makes
   * a dropped image something that should appear a few hundred pixels to the
   * left without a reload, so the one place that knows an upload finished says
   * so. Invalidation rather than a cache write, because the server decides an
   * asset's identity — the same bytes twice are one asset, and guessing here
   * would put a duplicate in the panel.
   */
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setBoardNotice = useUiStore((s) => s.setBoardNotice);
  useEffect(installBench, []);

  /**
   * Konva paints into a bitmap, so a face that has not arrived yet draws in
   * the fallback and stays there until something else happens to redraw. One
   * load, one redraw; the promise settles immediately once it is cached.
   */
  useEffect(() => {
    let cancelled = false;
    document.fonts.load(`${GROUP_LABEL_SIZE}px "Departure Mono"`).then(() => {
      if (!cancelled) redraw();
    });
    return () => {
      cancelled = true;
    };
    // redraw is a reducer dispatch: stable by construction, so no dependency.
  }, []);

  const tool = useUiStore((s) => s.tool);
  const setSelection = useUiStore((s) => s.setSelection);
  const selection = useUiStore((s) => s.selectedItemIds) as ReadonlySet<ItemId>;
  const cropItemId = useUiStore((s) => s.cropItemId);
  const setCropItemId = useUiStore((s) => s.setCropItemId);
  // Crop acts on exactly one stored image; anything else and every path to it
  // is a resize, exactly as before crop existed.
  const cropTarget = readOnly ? undefined : cropTargetOf(doc, selection);
  const cropSticky = cropTarget !== undefined && cropItemId === cropTarget.id;
  const cropping = cropTarget !== undefined && (cropSticky || cropHeld || cropLive);

  const size = useMemo(() => ({ width, height }), [width, height]);
  // The gesture listeners below are attached once; they read the live camera
  // through a ref rather than being torn down and rebuilt every pan frame.
  const view = useRef({ camera, size });
  view.current = { camera, size };

  const activeSetStart = performance.now();
  const active = computeActiveSet(doc, camera, size, { preloadMargin: 0 });
  const activeSetMs = performance.now() - activeSetStart;
  const stage = toStageAttrs(camera, size);

  // Bitmaps follow the active set: what is drawn is pinned, what has left is
  // aborted, and the tier each item wants comes from its size on screen.
  const bitmaps = useBitmaps(active.visible, camera.zoom, bitmapBudgetBytes, objects);
  // What a search may mark or measure: only what is on screen (canvas/quick-search).
  const visibleIds = useMemo(
    () => new Set<ItemId>(active.visible.map((v) => v.item.id)),
    [active.visible],
  );
  // Only what is on screen plays (the active set has no preload margin); a
  // frame repaints the items layer without a React render.
  const gifs = useGifs(
    active.visible,
    camera.zoom,
    gifsPaused,
    (lod) => IMAGE_LODS.has(lod),
    () => itemsLayer.current?.batchDraw(),
  );

  /** Split the active set: real nodes, and everything painted as aggregate. */
  const nodes: CanvasItem[] = [];
  const aggregated: Rect[] = [];
  const aggregatedGroups = new Set<GroupId>();
  /** Every group the active set touches. Labels are bounded by this, never by the document. */
  const activeGroups = new Set<GroupId>();
  // Walked top down, so the ceiling sheds the items furthest back.
  for (let i = active.visible.length - 1; i >= 0; i--) {
    const { item, lod } = active.visible[i] as VisibleItem;
    if (item.groupId) activeGroups.add(item.groupId);
    if (lod !== ItemLod.AGGREGATE && nodes.length < MAX_NODES) {
      nodes.push(item);
      continue;
    }
    const bounds = doc.index.boundsOf(item.id);
    if (bounds) aggregated.push(bounds);
    if (item.groupId) aggregatedGroups.add(item.groupId);
  }
  nodes.reverse(); // back to painter's order

  // Truncation is not permission to draw less (invariant 8): whatever the
  // ceiling clipped is aggregated instead, from the ids the active set already
  // handed back rather than a second query.
  for (const id of active.overflow) {
    const bounds = doc.index.boundsOf(id);
    if (bounds) aggregated.push(bounds);
    const groupId = doc.item(id)?.groupId;
    if (groupId) {
      aggregatedGroups.add(groupId);
      activeGroups.add(groupId);
    }
  }

  // Only groups with aggregated members: outlining every group on the board
  // would be work proportional to the document, which is exactly what the
  // active set exists to avoid.
  const groupOutlines: Rect[] = [];
  for (const groupId of aggregatedGroups) {
    const bounds = doc.groupBounds(groupId);
    if (bounds) groupOutlines.push(bounds);
  }

  /**
   * Derived contours for framed groups the active set touches.
   *
   * The cache is keyed by a signature of everything a contour depends on —
   * framing plus each member's transform — so it is recomputed only when the
   * document actually changed. And it cannot jitter mid-drag: motion during a
   * gesture is Konva's, the document hears about the move once at release, so
   * this runs then and never per pointermove.
   *
   * Suppression: while every member is aggregated away the aggregate layer's
   * group marks already carry the grouping, and a full contour on top of them
   * would only be noise.
   */
  const instantiatedGroups = new Set<GroupId>();
  for (const item of nodes) {
    if (item.groupId) instantiatedGroups.add(item.groupId);
  }
  const drawnFrames: (FrameEntry & { groupId: GroupId })[] = [];
  for (const groupId of activeGroups) {
    if (!instantiatedGroups.has(groupId)) continue;
    const entry = frameFor(doc, groupId, frameCacheRef.current);
    if (!entry) continue;
    drawnFrames.push({ ...entry, groupId });
  }
  const frames = new Map(drawnFrames.map((f) => [f.groupId, f]));

  // A label that cannot be seen is not a label.
  const groupLabels = groupLabelsFor(doc, activeGroups, camera.zoom, frames, stage);

  noteRender({
    activeSetMs,
    nodes: nodes.length,
    aggregated: aggregated.length,
    items: doc.itemCount,
    decodedBytes: bitmaps.cache.bytes,
    bitmaps: bitmaps.cache.size,
    bitmapFailures: bitmaps.cache.failed,
    truncated: active.truncated,
  });

  /**
   * The colour of the actor holding an item, when it is not us.
   *
   * `undefined` means grabbable. Resolved from a token through the theme, never
   * from a value on the wire — the socket only ever carries a slot index.
   */
  const holderColour = (itemId: ItemId): string | undefined => {
    const holder = realtimeRef.current?.heldByOther(itemId);
    if (!holder) return undefined;
    const actor = presence.actors.get(holder);
    return actor ? (theme.presence[actor.colourIndex] ?? theme.presence[0]) : theme.presence[0];
  };

  /** Another actor's selection, as world rectangles the renderer can stroke. */
  const remoteBounds = (id: ItemId) => {
    const item = doc.item(id);
    return item ? transformBounds(previewFor(presence, id) ?? item.transform) : undefined;
  };
  const remoteMarks = remoteSelectionMarks(presence, remoteBounds, theme);
  const focusMarks = agentFocusMarks(presence, remoteBounds, theme);

  const commit = useCallback(
    (...bodies: CanvasOperationBody[]) => {
      if (readOnly) return;
      if (history.apply(...bodies)) redraw();
    },
    [history, readOnly],
  );

  /**
   * Notes, diagrams and checklists, made and changed by hand: double-click,
   * paste, drop, clicks on the controls inside them, in-place editors.
   */
  const signedInAs = (queryClient.getQueryData(sessionKey) as SessionState | undefined)?.user;
  const objectEditing = useObjectEditing({
    doc,
    history,
    objects,
    commit,
    redraw,
    camera,
    size,
    editable: !readOnly && tool === 'select',
    realtime: () => realtimeRef.current,
    settled: () => syncRef.current?.settled() ?? Promise.resolve(),
    select: (ids) => setSelection(ids),
    notify: (message) => setInterchangeNotice(message),
    me: signedInAs?.id
      ? { id: signedInAs.id, displayName: signedInAs.displayName ?? '' }
      : undefined,
  });
  /** Where the pointer last was over the board, for a paste to land under it (spec). */
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  /** A press that began on a control inside an object: it must not become a drag. */
  const controlPress = useRef<ItemId | null>(null);

  const setSync = useUiStore((s) => s.setSync);
  const setConnection = useUiStore((s) => s.setConnection);
  const setLinkViewers = useUiStore((s) => s.setLinkViewers);
  const setAgentWorking = useUiStore((s) => s.setAgentWorking);
  // The wordmark lights while an agent works here (canvas/presence-indicators).
  const working = agentIsWorking(presence);
  useEffect(() => setAgentWorking(working), [working, setAgentWorking]);
  useEffect(() => () => useUiStore.setState({ agentWorking: false }), []);

  /**
   * Persistence, attached to the one funnel every durable change goes through.
   *
   * Attached HERE and not inside the document, and only after the document
   * exists: a generated board is filled by applying up to 100,000 operations,
   * and a listener present during that would try to persist a benchmark.
   */
  useEffect(() => {
    if (!boardId || !readOnly) return;
    // A viewer: the receive-only socket, and its own snapshot to resync from.
    const realtime = new BoardRealtime({
      boardId,
      doc,
      path: '/ws/shared',
      resync: () => loadSharedSnapshotInto(doc),
      onPresence: () => {},
      onState: setConnection,
      onRemoteChange: redraw,
    });
    realtime.connect();
    return () => {
      realtime.close();
      setConnection('idle');
    };
  }, [boardId, doc, readOnly, setConnection]);

  useEffect(() => {
    if (!boardId || readOnly) return;
    // Why the person last left a board is old news once another opens.
    setBoardNotice(null);
    const sync = new BoardSync({
      boardId,
      doc,
      onStatus: setSync,
      onRemoteChange: redraw,
      ...(opLog ? { onPosted: (batch, outcome) => opLog.posted(batch, outcome) } : {}),
    });
    // Persistence hears every change; the object layouts hear which ones were
    // ours, so that exactly one client writes an object's new height.
    doc.onApplied((body, origin) => {
      if (
        origin === 'remote' &&
        body.type === 'item.transform' &&
        !easeFrom.current.has(body.itemId)
      ) {
        // Still drawn where it was: React has not re-rendered yet.
        const node = stageRef.current?.findOne(`#${body.itemId}`);
        if (node) easeFrom.current.set(body.itemId, node.position());
      }
      sync.applied(body, origin);
      objects.noteApplied(body, origin);
      opLog?.record(body, origin);
    });
    syncRef.current = sync;

    // Once per diagram revision, after our own edits to it are durable, so the
    // revision we name is the server's (agents/placement, design D5).
    const reported = new Set<string>();
    reportElementsRef.current = (itemId, key, layout) => {
      void sync.settled().then(() => {
        const item = doc.item(itemId);
        if (!item || item.revision === undefined || layoutKey(item) !== key) return;
        const once = `${itemId}@${item.revision}`;
        if (reported.has(once)) return;
        reported.add(once);
        void reportElements(boardId, itemId, item.revision, layout.width, layout.elements).catch(
          () => {},
        );
      });
    };

    /*
     * The socket, opened beside persistence and never in front of it.
     *
     * Only for a persisted board: a generated bench board has nobody to
     * collaborate with and no id to be reached at. Note the order of the two —
     * `sync` exists first, because a commit broadcast can arrive before the
     * first local edit and the queue has to be there to be told our actor id.
     */
    const realtime = new BoardRealtime({
      boardId,
      doc,
      resync: () =>
        loadSnapshotInto(doc, boardId).then(() => gestureRecovery.current.afterResync()),
      onPresence: setPresence,
      onState: setConnection,
      onRemoteChange: redraw,
      onLockRefused: (itemIds) => gestureRecovery.current.snapBack(itemIds),
      onViewers: setLinkViewers,
      onRenamed: () => void queryClient.invalidateQueries({ queryKey: ['boards'] }),
      onDeleted: (by) => {
        setBoardNotice(`This board was deleted by ${by}.`);
        void queryClient.invalidateQueries({ queryKey: ['boards'] });
        void navigate({ to: '/' });
      },
    });
    realtimeRef.current = realtime;
    realtime.connect();

    // The queue learns who it is once the handshake lands, so its posts can say
    // which socket made them and the server can skip echoing them back.
    const identify = setInterval(() => sync.setActorId(realtime.actorId), 500);

    // The bounded loss window: an edit applied and the tab killed before the
    // flush timer fires. `keepalive` lets the request outlive the page.
    const onHidden = () => {
      if (globalThis.document.visibilityState === 'hidden') void sync.flush(true);
    };
    globalThis.document.addEventListener('visibilitychange', onHidden);

    return () => {
      globalThis.document.removeEventListener('visibilitychange', onHidden);
      clearInterval(identify);
      doc.onApplied(undefined);
      reportElementsRef.current = null;
      realtime.close();
      setConnection('idle');
      realtimeRef.current = null;
      syncRef.current = null;
      setPresence(EMPTY_PRESENCE);
      setLinkViewers(0);
      sync.stop();
      void sync.flush(true);
    };
  }, [
    boardId,
    doc,
    readOnly,
    setSync,
    setConnection,
    setLinkViewers,
    objects,
    opLog,
    queryClient,
    navigate,
    setBoardNotice,
  ]);

  const setUploads = useUiStore((s) => s.setUploads);
  const addUploadFailure = useUiStore((s) => s.addUploadFailure);
  const uploads = useMemo(
    () => new UploadQueue({ onStatus: setUploads, onFailure: addUploadFailure }),
    [setUploads, addUploadFailure],
  );
  // Deliberately NOT stopped when the board unmounts. An upload already in
  // flight should finish: assets outlive boards, and the resolve callback
  // already copes with an item that is no longer there. Stopping it in a
  // cleanup also breaks under StrictMode, whose mount/cleanup/mount would
  // disable the memoised queue for the life of the page.

  /**
   * A dropped or pasted image, on the board before the network hears about it.
   *
   * Every step after the first is asynchronous and none of it blocks a gesture:
   * the item is created from locally-read dimensions, and the upload resolves it
   * later through `item.content` (ADR-0004 — no second mutation path).
   */
  const capture = useCallback(
    async (files: readonly File[], screenPoint: { x: number; y: number }) => {
      const { camera, size } = view.current;
      const at = screenToWorld(camera, size, screenPoint);
      const world = visibleWorldRect(camera, size);

      // Every file is decoded BEFORE anything is committed. A five-image drop
      // is one gesture, so it is one history entry and one undo press — which
      // is why this is a `Promise.all` and not a loop with a commit in it. The
      // awaits stay here, beside the interaction loop and never inside it.
      const captured = (await Promise.all(files.map((file) => readCapture(file)))).filter(
        (dropped) => dropped !== undefined,
      );
      if (captured.length === 0) return;

      const top = zEdge(doc).max + 1;
      commit(
        ...captured.map((dropped, index) =>
          createItem(dropped, placeCapture(dropped, at, index, world), top + index),
        ),
      );

      for (const dropped of captured) {
        uploads.add(dropped.itemId, dropped.file, (asset: UploadedAsset) => {
          if (!doc.item(dropped.itemId)) {
            // Undone or deleted while it uploaded. The asset is stored and stays
            // stored — assets outlive boards — but nothing on this board wants it.
            URL.revokeObjectURL(dropped.previewUrl);
            return;
          }
          // The pixels are already decoded under the preview's key; move them
          // rather than re-fetching what we just sent.
          bitmaps.cache.adopt(dropped.previewUrl, asset.assetId);

          // Through the document, but NOT through history. Finishing an upload
          // is not something the user did — it is the rest of what they already
          // did. An undo slot here would mean one Ctrl+Z turns the image back
          // into a grey placeholder and a second one removes it, and undoing a
          // drop has to be one press. The `item.create` entry still inverts to
          // `item.delete`, which removes the item whichever content it holds.
          doc.apply({
            type: 'item.content',
            itemId: dropped.itemId,
            content: {
              kind: 'image',
              asset: {
                assetId: asAssetId(asset.assetId),
                intrinsicWidth: asset.width,
                intrinsicHeight: asset.height,
                mimeType: asset.mimeType,
              },
            },
          });
          redraw();
          URL.revokeObjectURL(dropped.previewUrl);
          void queryClient.invalidateQueries({ queryKey: ['library'] });
        });
      }
    },
    [bitmaps, commit, doc, queryClient, uploads],
  );

  /**
   * An asset from the library becoming an item — the short path.
   *
   * Nothing is uploaded, nothing is a placeholder and nothing resolves later:
   * the library already carries the asset id and its intrinsic size, which is
   * exactly what image content needs. One `commit` for the whole batch, so
   * placing eight selected assets is one undo press, like the drag it was.
   *
   * Without a point — a click in the panel rather than a drop — they land at the
   * centre of what is visible, cascaded so a batch is not one stack.
   */
  /*
   * Where the next centre placement continues the cascade from. Separate clicks
   * in the panel used to land on the same centre, eight images in one pile that
   * read as one image. Same camera → carry on down-right; a moved camera is a
   * new place to put things, so it starts again.
   *
   * ponytail: wraps after 10 steps rather than finding free space; add a real
   * free-space search if people place dozens of images per view.
   */
  const cascade = useRef<{ camera: unknown; next: number }>({ camera: null, next: 0 });
  const place = useCallback(
    (assets: readonly DraggedAsset[], screenPoint?: { x: number; y: number }) => {
      if (assets.length === 0) return;
      const { camera, size } = view.current;
      let start = 0;
      if (!screenPoint) {
        start = cascade.current.camera === camera ? cascade.current.next % 10 : 0;
        cascade.current = { camera, next: start + assets.length };
      }
      const at = screenToWorld(
        camera,
        size,
        screenPoint ?? { x: size.width / 2, y: size.height / 2 },
      );
      const world = visibleWorldRect(camera, size);
      const top = zEdge(doc).max + 1;

      commit(
        ...assets.map((asset, index) =>
          createPlacement(
            {
              assetId: asAssetId(asset.assetId),
              width: asset.width,
              height: asset.height,
              mimeType: asset.mimeType,
            },
            placeCapture(asset, at, start + index, world),
            top + index,
          ),
        ),
      );
    },
    [commit, doc],
  );

  /**
   * The same placement, from ids alone.
   *
   * A clipboard carries no private MIME type, so a paste of what Visarium copied
   * arrives as content URLs and the intrinsic sizes have to be fetched back. The
   * await is here, beside the interaction loop, and never inside a pointer
   * handler — a paste is a window event, not a gesture.
   */
  const placeById = useCallback(
    async (assetIds: readonly string[], screenPoint?: { x: number; y: number }) => {
      place(await assetsById(assetIds), screenPoint);
    },
    [place],
  );

  // The sidebar's library panel is a sibling under the shell, not a child, so
  // the board hands it a way in while it is mounted and takes it away when it
  // is not — which is also how the panel knows a board is open.
  const setPlaceAssets = useUiStore((s) => s.setPlaceAssets);
  const setInterchangeNotice = useUiStore((s) => s.setInterchangeNotice);
  const toolbarCollapsed = useUiStore((s) => s.toolbarCollapsed);
  const toggleToolbar = useUiStore((s) => s.toggleToolbar);
  useEffect(() => {
    setPlaceAssets(place);
    return () => setPlaceAssets(null);
  }, [place, setPlaceAssets]);

  // Drop is a native listener on the container, like the wheel handler: React's
  // synthetic drag props on a plain div are an accessibility violation the
  // linter is right about, and the canvas is not a control anyone can tab to.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || readOnly) return;

    // Without preventDefault on dragover the browser navigates to the file.
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      const at = pointerIn(container, event as unknown as PointerEvent);

      // Ours first — the ordering `readTransfer` states once, unchanged in
      // meaning since M04 and now shared with the paste handler below.
      const arrival = readTransfer(event.dataTransfer);
      if (arrival.kind === 'nothing') {
        // Not an image: Markdown, Mermaid or PlantUML files become objects.
        const texts = textFilesOf(event.dataTransfer);
        if (texts.length === 0) return;
        event.preventDefault();
        const { camera: c, size: z } = view.current;
        void Promise.all(texts.map(readTextFile)).then((contents) =>
          placeObjects.current(contents, screenToWorld(c, z, at)),
        );
        return;
      }
      event.preventDefault();
      if (arrival.kind === 'assets' && arrival.origin === doc.canvasId) {
        /*
         * An export of THIS board, let go over THIS board. Nothing happens.
         *
         * Take out sits a few pixels above the selection, so it sits over the
         * canvas, and the resting place of any drag that does not leave the
         * window is the board it came from. Treating that as a placement made
         * every abandoned export silently duplicate the whole selection —
         * Duplicate is the neighbouring control and is how somebody asks for
         * that. A drag from the library still places, and so does an export
         * dropped on a DIFFERENT board: both carry an origin that is not this
         * one.
         */
        return;
      }
      if (arrival.kind === 'assets') place(arrival.assets, at);
      else if (arrival.kind === 'ids') void placeById(arrival.assetIds, at);
      else void capture(arrival.files, at);
    };

    container.addEventListener('dragover', onDragOver);
    container.addEventListener('drop', onDrop);
    return () => {
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
    };
  }, [capture, doc, place, placeById, readOnly]);

  // The latest placement function, for listeners attached once.
  const placeObjects = useRef(objectEditing.place);
  placeObjects.current = objectEditing.place;

  /*
   * Double-click on empty board: a new note, typed where it will be (spec).
   *
   * Native, not Konva's `dblclick`: a press on empty board starts a marquee or
   * a pan that captures the pointer, so Konva never sees the release and never
   * synthesises a click. The browser's own dblclick still arrives here.
   */
  const startNewNote = useRef((_world: { x: number; y: number }) => {});
  startNewNote.current = (world) => {
    if (!readOnly && tool === 'select') objectEditing.startNewNote(world);
  };
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onDblClick = (event: MouseEvent) => {
      const stage = stageRef.current;
      // The board's own surface only (the gesture's pointer capture makes the
      // container the target); an editor's field keeps its double-click.
      if (!stage || (event.target !== container && !(event.target instanceof HTMLCanvasElement)))
        return;
      stage.setPointersPositions(event);
      const world = stage.getRelativePointerPosition();
      if (!world) return;
      // Only EMPTY board: a double-click on an item is that item's. Asked of
      // the document's index, not the drawn hit canvas, which can be a frame
      // behind an item that has just laid out.
      const point = { minX: world.x, minY: world.y, maxX: world.x, maxY: world.y };
      if (doc.index.search(point).length > 0) return;
      // Nor a link: two quick clicks on one are a selection and a retype.
      if (linkNear(drawnLinks.current, world, 8 / stage.scaleX())) return;
      startNewNote.current(world);
    };
    container.addEventListener('dblclick', onDblClick);
    return () => container.removeEventListener('dblclick', onDblClick);
  }, [doc]);

  // Where the pointer is over the board, so a paste lands under it.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMove = (event: PointerEvent) => {
      lastPointer.current = pointerIn(container, event);
    };
    const onLeave = () => {
      lastPointer.current = null;
    };
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerleave', onLeave);
    return () => {
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // Paste is a window event: it has no target inside the canvas to hang off.
  useEffect(() => {
    if (readOnly) return;
    const onPaste = (event: ClipboardEvent) => {
      const arrival = readTransfer(event.clipboardData);
      if (arrival.kind === 'nothing') {
        // Text that is not ours and not an image: a note, a diagram or a
        // checklist (classifyText), under the pointer or mid-view. A field
        // being typed in keeps its own paste.
        if (isTyping(event.target)) return;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!text.trim()) return;
        event.preventDefault();
        const { camera: c, size: z } = view.current;
        const at = lastPointer.current ?? { x: z.width / 2, y: z.height / 2 };
        placeObjects.current([classifyText(text)], screenToWorld(c, z, at));
        return;
      }
      // A text field's paste is its own. Narrow on purpose: only the URL payload
      // is text, so only it can be stolen from a field somebody is typing in —
      // and an image paste keeps behaving exactly as M02 specified.
      if (arrival.kind === 'ids' && isTyping(event.target)) return;
      event.preventDefault();
      const { width: w, height: h } = view.current.size;
      const at = { x: w / 2, y: h / 2 };
      // Pasting what Visarium copied must not re-upload it. `readTransfer` puts
      // our own payload ahead of the image the clipboard also carries, which is
      // the same rule the drop handler above has always had — it just had
      // nothing to protect until Visarium could write a clipboard of its own.
      if (arrival.kind === 'assets') place(arrival.assets, at);
      else if (arrival.kind === 'ids') void placeById(arrival.assetIds, at);
      else void capture(arrival.files, at);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [capture, place, placeById, readOnly]);

  const select = useCallback(
    (ids: Iterable<ItemId>, mode: SelectionMode) => {
      setSelection(applySelection(selection, expandToGroups(doc, ids), mode));
    },
    [doc, selection, setSelection],
  );

  const selectRef = useRef(select);
  selectRef.current = select;
  // The resync callback is built once inside an effect and must not close over
  // a stale selection; it reads through this instead.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  /**
   * A modified wheel gesture still in flight.
   *
   * `before` is where the board was when it started; `ids` is what it is acting
   * on, held here rather than read at settle time because the selection may
   * change under a timer.
   */
  const adjusting = useRef<{
    kind: WheelAdjustment;
    ids: ItemId[];
    before: CanvasOperationBody[];
    timer: number;
  } | null>(null);

  /**
   * End a wheel gesture and give history exactly one entry for it.
   *
   * The gesture ran on the document so it could be SEEN — `doc.apply` and a
   * redraw, the same local-only path an upload's resolve uses — and history has
   * heard nothing at all. So the board goes back to where the gesture started
   * and the finished state is committed once: one undo press, one post, however
   * many notches the wheel turned. Committing per notch would bury every other
   * act on the board under a hundred undo steps.
   */
  const settleAdjustment = useCallback(() => {
    const live = adjusting.current;
    if (!live) return;
    window.clearTimeout(live.timer);
    adjusting.current = null;

    // Only the half the gesture actually moved: an opacity gesture has no
    // business posting a transform per item, and vice versa.
    const wanted = live.kind === 'opacity' ? 'item.appearance' : 'item.transform';
    const after = selectionState(doc, live.ids).filter((body) => body.type === wanted);
    for (const body of live.before) doc.apply(body);
    commit(...after);
  }, [commit, doc]);

  /**
   * The wheel, acting on the selection rather than on the camera.
   *
   * Applied live and locally; `settleAdjustment` above is what makes it durable.
   */
  const adjustSelection = useCallback(
    (kind: WheelAdjustment, deltaY: number) => {
      const ids = [...selectionRef.current];
      if (ids.length === 0) return;

      // A different modifier mid-scroll ends the gesture it interrupted, so the
      // two do not merge into one undo step that did two unrelated things.
      if (adjusting.current?.kind !== kind) {
        settleAdjustment();
        adjusting.current = { kind, ids, before: selectionState(doc, ids), timer: 0 };
      }
      const live = adjusting.current as NonNullable<typeof adjusting.current>;

      const bodies = wheelBodies(doc, live.ids, kind, deltaY);
      for (const body of bodies) doc.apply(body);
      if (bodies.length > 0) redraw();

      // The wheel has no release event, so the gesture ends when it goes quiet.
      window.clearTimeout(live.timer);
      live.timer = window.setTimeout(settleAdjustment, ADJUST_SETTLE_MS);
    },
    [doc, settleAdjustment],
  );
  // Read through a ref for the reason `selectRef` gives: the wheel listener is
  // attached once and must not close over a stale selection.
  const adjustRef = useRef(adjustSelection);
  adjustRef.current = adjustSelection;

  // A gesture left in flight when the board goes away would commit against a
  // document nobody is looking at.
  useEffect(() => settleAdjustment, [settleAdjustment]);

  // --- input ---------------------------------------------------------------

  // Wheel is attached by hand: a passive listener cannot preventDefault, and
  // Chrome makes wheel listeners passive by default. Without this the page
  // zooms instead of the canvas.
  //
  // Coalesced to at most two camera changes per frame. A trackpad flick
  // delivers wheel events faster than the screen has frames, and M01 measured
  // the result at 100k items: p95 33–50 ms with p50 unaffected, which is the
  // signature of more work per frame than there are frames rather than of slow
  // work.
  //
  // Accumulating is exact, not an approximation: multiplicative zoom composes,
  // `exp(-Σd·k) = Π exp(-d·k)`, so applying the sum once gives the same camera
  // as applying each event in turn. The anchor is the NEWEST event's, because
  // that is where the pointer is when the frame is drawn.
  //
  // The first event of a frame is applied AT ONCE rather than waiting for it.
  // A pure trailing-edge version is one line shorter and measurably worse:
  // ordinary wheeling arrives slower than the frame rate, so every event would
  // pay a frame of latency to solve a problem only bursts have.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    let queued = 0;
    let anchor = { x: 0, y: 0 };
    let box = element.getBoundingClientRect();
    let frame = 0;

    const applyZoom = (delta: number) => {
      const factor = Math.exp(-delta);
      setCamera((c) =>
        zoomAt(c, { width: box.width, height: box.height }, anchor, c.zoom * factor),
      );
    };

    const flush = () => {
      frame = 0;
      if (queued === 0) return;
      applyZoom(queued);
      queued = 0;
    };

    const onWheel = (event: WheelEvent) => {
      // Synchronously, on EVERY event. Deferring this would let the page scroll
      // before the handler that meant to stop it ever ran — and it is what stops
      // Alt+wheel reaching Firefox's history navigation.
      event.preventDefault();
      box = element.getBoundingClientRect();
      anchor = { x: event.clientX - box.left, y: event.clientY - box.top };

      // A modifier turns the wheel from the CAMERA onto the SELECTION. Ctrl is
      // not one of them and cannot be: every platform that reports a trackpad
      // pinch at all reports it as ctrl+wheel, so binding it here would cost
      // pinch-to-zoom on every laptop.
      const adjust = adjustmentFor(event);
      if (adjust) {
        adjustRef.current(adjust, event.deltaY);
        return;
      }

      // ctrlKey means trackpad pinch on every platform that reports it at all.
      const delta = event.deltaY * (event.ctrlKey ? 0.01 : 0.002);

      if (frame === 0) {
        // Leading edge. Ordinary wheeling delivers well under one event per
        // frame, and deferring THAT to a frame would add a frame of latency to
        // input that was never the problem — measured, and it did.
        applyZoom(delta);
        frame = requestAnimationFrame(flush);
        return;
      }
      queued += delta;
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', onWheel);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  /**
   * Everything on the board, selected.
   *
   * ponytail: on the 100,000-item board this really does put 100,000 ids in the
   * store — an explicit act with an explicit cost, and the only way "select all"
   * could mean anything else is by lying about how many it selected. What is
   * bounded is what leaves the machine: see `sendSelection`.
   */
  const selectAll = useCallback(() => {
    setSelection([...doc.items()].map((item) => item.id));
  }, [doc, setSelection]);

  /**
   * Drop an in-progress gesture without applying it.
   *
   * Not the same as finishing early: a marquee abandoned here selects nothing,
   * and a pan simply stops. That is what Escape means everywhere else, and a
   * gesture that committed on cancel would be the surprising one.
   */
  const abandonGesture = useCallback(() => {
    gesture.current = { kind: 'none' };
    setGesturing(false);
    setMarquee(null);
  }, [setMarquee]);

  /**
   * Put the camera where the work is.
   *
   * The selection, or the whole board when nothing is selected — one key, two
   * behaviours, no modifier to remember. It changes no item, so it is not an
   * operation and takes no undo slot: pressing undo after framing undoes the
   * last thing that actually changed the board, which is what a person means.
   *
   * Framing everything reads the index's root envelope rather than iterating
   * transforms, so it costs the same on a 100,000-item board as on an empty one.
   * `fitRect` clamps, so framing one 64px icon does not zoom to 32x.
   */
  /** Fit a world rectangle to the canvas: framing and search both land this way. */
  const fitBounds = useCallback((bounds: Rect) => {
    setCamera(fitRect(view.current.size, bounds));
  }, []);

  const frameView = useCallback(() => {
    const selected = selectionRef.current;
    const target =
      selected.size > 0
        ? unionRects(
            [...selected].flatMap((id) => {
              const bounds = doc.index.boundsOf(id);
              return bounds ? [bounds] : [];
            }),
          )
        : // Nothing selected: the board's centerpiece, when it has one (canvas/centerpiece).
          (doc.centerpieceBounds() ?? doc.index.bounds());
    if (!target) return;
    fitBounds(target);
  }, [doc, fitBounds]);

  /** Fit one search target the way framing fits a selection (canvas/quick-search). */
  const fitTarget = useCallback(
    (target: SearchTarget) => {
      const bounds =
        target.kind === 'item' ? doc.index.boundsOf(target.id) : doc.groupBounds(target.id);
      if (bounds) fitBounds(bounds);
    },
    [doc, fitBounds],
  );

  /*
   * Quick search (canvas/quick-search). Never over other work: not while an
   * object is being edited in place, a crop is open, or a gesture is under way.
   * A focused text field is handled where the keys arrive (`isTyping`).
   */
  const editingId = useRef<string | null | undefined>(null);
  editingId.current = objectEditing.editingId;
  const openSearch = useUiStore((s) => s.openSearch);
  const canSearch = useCallback(
    () =>
      !editingId.current && !useUiStore.getState().cropItemId && gesture.current.kind === 'none',
    [],
  );
  /** Esc: close on the current result, which becomes the selection. */
  const closeSearchOnResult = useCallback(() => {
    const state = useUiStore.getState();
    const result = state.search?.results[state.search.current];
    state.closeSearch();
    if (!result) return;
    const { target } = result;
    if (target.kind === 'item') setSelection([target.id]);
    else setSelection([...doc.items()].filter((i) => i.groupId === target.id).map((i) => i.id));
  }, [doc, setSelection]);

  const search = useUiStore((s) => s.search);
  const searchQuery = search?.query;
  // Results once per query, a beat after typing stops. A note not laid out
  // yet is read through the same renderer its drawing will use.
  useEffect(() => {
    if (searchQuery === undefined) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const unlaid = [...doc.items()].some((i) => i.content.kind === 'note' && !objects.view(i));
      const markdown = unlaid ? noteHtml(await loadMarkdown()) : undefined;
      if (cancelled) return;
      const results = findResults(
        doc,
        searchQuery,
        (item) => objects.view(item)?.layout.text ?? fallbackText(item, markdown),
      );
      useUiStore.getState().setSearchResults(results);
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, objects, searchQuery]);

  // The camera follows the current result only when it moves to another item.
  const currentResult = search?.results[search.current];
  const currentKey = currentResult ? targetKey(currentResult.target) : undefined;
  const fittedKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (currentKey === undefined || currentKey === fittedKey.current) return;
    fittedKey.current = currentKey;
    const state = useUiStore.getState().search;
    const result = state?.results[state.current];
    if (result) fitTarget(result.target);
  }, [currentKey, fitTarget]);
  useEffect(() => {
    if (!search) fittedKey.current = undefined;
  }, [search]);
  // Another board, or leaving this one: nothing found here stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closing on a document change is the point
  useEffect(() => () => useUiStore.getState().closeSearch(), [doc]);

  /*
   * Opening a board lands on its centerpiece, fitted to the canvas, once the
   * canvas has a size (canvas/centerpiece). A board without one opens where it
   * always has. Once per document: a resync or a centerpiece set later never
   * moves the camera out from under someone.
   */
  const openedOn = useRef<CanvasDocument | null>(null);
  useEffect(() => {
    if (openedOn.current === doc || width === 0 || height === 0) return;
    openedOn.current = doc;
    const target = doc.centerpieceBounds();
    if (target) setCamera(fitRect({ width, height }, target));
  }, [doc, width, height]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      setCropHeld(event.ctrlKey && event.altKey);
      // Nothing on this canvas is a shortcut while a text field has focus,
      // including the selection toolbar's own label field: otherwise naming a
      // cluster "40s cinema" sets its opacity to 40% and deletes it.
      if (isTyping(event.target)) return;

      if (event.code === 'Space') {
        spaceHeld.current = true;
        spaceTap.current.down(performance.now(), event.repeat);
      } else spaceTap.current.interrupt();
      const mod = event.ctrlKey || event.metaKey;

      // The browser's own find cannot see canvas text, so the key is ours.
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        if (canSearch()) openSearch();
        return;
      }

      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey ? history.redo() : history.undo()) redraw();
        return;
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }
      // Crop mode is left before anything else Escape or Enter would mean: the
      // first press ends the crop, the image stays selected.
      if ((event.key === 'Escape' || event.key === 'Enter') && useUiStore.getState().cropItemId) {
        event.preventDefault();
        setCropItemId(null);
        return;
      }
      if (event.key === 'Escape' && useUiStore.getState().search) {
        event.preventDefault();
        closeSearchOnResult();
        return;
      }
      if (event.key === 'Escape') {
        // Abandon, not commit: a marquee or a drag in progress is cancelled
        // rather than applied, which is what Escape means everywhere else.
        event.preventDefault();
        abandonGesture();
        setSelection([]);
        setSelectedLink(null);
        return;
      }
      // Dev builds: backquote opens and closes the inspector. A text field
      // gets its backquote: this handler has already returned for typing.
      if (DEVTOOLS && !mod && event.key === '`') {
        event.preventDefault();
        setInspectorOpen((open) => !open);
        return;
      }
      if (!mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        frameView();
        return;
      }
      if (!mod && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setGifsPaused((paused) => !paused);
        return;
      }
      if (!mod && !event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        toggleLinksOnFocus.current();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedLink && !readOnly) {
          event.preventDefault();
          commit({ type: 'link.delete', linkId: selectedLink });
          setSelectedLink(null);
          return;
        }
        if (selection.size === 0) return;
        event.preventDefault();
        // Links first, as their own operations, so one undo brings every link
        // back with its items (canvas-core `deleteItemsBodies`).
        commit(...deleteItemsBodies(doc, selection));
        setSelection([]);
        return;
      }
      if (selection.size > 0) {
        /*
         * The bar is the fallback, not the interface — so every slot on it has
         * a key here.
         *
         * `1`-`9` are tenths and `0` is full, which is what every tool with an
         * opacity control does, and without `0` there would be no key for the
         * value people most want to return to. Each press is one discrete act
         * and therefore one operation and one history entry: pressing `5` then
         * `7` is two undos, because it was two acts.
         */
        if (!mod && !event.altKey && event.key.toLowerCase() === 'c') {
          // The store, not this effect's `selection`: a click then C within one
          // frame would otherwise read the selection from before the click.
          const live = useUiStore.getState().selectedItemIds as ReadonlySet<ItemId>;
          const target = cropTargetOf(doc, live);
          if (!target) return;
          event.preventDefault();
          setCropItemId(useUiStore.getState().cropItemId === target.id ? null : target.id);
          return;
        }
        const digit = DIGITS[event.key];
        if (digit !== undefined && !mod) {
          event.preventDefault();
          commit(...opacityBodies(doc, selection, digit));
          return;
        }
        if (event.shiftKey && !mod) {
          const axis = FLIP_KEYS[event.key.toLowerCase()];
          if (axis) {
            event.preventDefault();
            commit(...flipSelection(doc, selection, axis));
            return;
          }
        }
        if (event.key === 'F2') {
          event.preventDefault();
          setLabelSignal((n) => n + 1);
          return;
        }
        if (event.key === 'F4') {
          // The frame toggle's keyboard form: the same act the bar's control
          // commits, guarded the same way — exactly one whole group or nothing.
          event.preventDefault();
          const groupId = soleGroupId(doc, selection);
          const group = groupId ? doc.group(groupId) : undefined;
          if (!group) return;
          commit({ type: 'group.frame', groupId: group.id, frame: !(group.frame ?? false) });
          return;
        }
        if (mod && event.key.toLowerCase() === 'd') {
          // Without this the browser bookmarks the page instead.
          event.preventDefault();
          const copy = duplicateSelection(doc, selection);
          if (copy.bodies.length === 0) return;
          commit(...copy.bodies);
          setSelection(copy.itemIds);
          return;
        }
        if (mod && event.key.toLowerCase() === 'c' && !readOnly) {
          /*
           * The keyboard half of take out. Dragging has no keyboard form, so
           * this is the whole of it.
           *
           * `isTyping` already returned above, which is what leaves the browser's
           * own copy alone when text is selected inside the label field.
           *
           * No warm: a keypress has no hover to precede it, so the original's
           * type is unknown at the instant the clipboard demands one and the
           * write goes out as PNG. Every browser shipping today answers PNG
           * anyway — `ClipboardItem.supports` exists in one of them and says yes
           * to nothing else — and the notice states what was carried either way.
           */
          event.preventDefault();
          const outward = outwardAssets(doc, selection);
          if (outward.length === 0) {
            setInterchangeNotice(NOTICES.notStored);
            return;
          }
          void copySelection(outward, NO_ORIGINALS).then((outcome) =>
            setInterchangeNotice(outcome === 'original' ? null : NOTICES[outcome]),
          );
          return;
        }
      }

      const nudge = NUDGES[event.key];
      if (nudge && selection.size > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        commit(...moveBy(doc, selection, nudge.x * step, nudge.y * step));
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spaceHeld.current = false;
        // A tap rather than a hold: search, unless something else has the keys.
        if (spaceTap.current.up(performance.now()) && !isTyping(event.target) && canSearch())
          openSearch();
      }
      setCropHeld(event.ctrlKey && event.altKey);
    };
    // A press while Space is down makes it a pan, never a tap.
    const onPointer = () => spaceTap.current.interrupt();
    // A keyup that happens in another window never arrives here.
    const onBlur = () => {
      setCropHeld(false);
      spaceTap.current.interrupt();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [
    abandonGesture,
    canSearch,
    closeSearchOnResult,
    openSearch,
    commit,
    doc,
    frameView,
    history,
    readOnly,
    selectAll,
    selection,
    setCropItemId,
    setInterchangeNotice,
    setSelection,
    selectedLink,
  ]);

  /**
   * Pointer capture retargets events to the capturing element, which means
   * Konva's own listeners stop hearing them mid-gesture. So the gesture STARTS
   * through Konva (it owns hit testing) and then continues on native listeners
   * attached to the element holding the capture.
   */
  const onPointerDown = (e: Konva.KonvaEventObject<PointerEvent>) => {
    const hitEmpty = e.target === e.target.getStage();
    const wantsPan = tool === 'pan' || spaceHeld.current || e.evt.button === 1;
    if (hitEmpty) setSelectedLink(null);
    if (!hitEmpty && !wantsPan) return; // the node's own drag handles it

    const container = containerRef.current;
    if (!container) return;
    container.setPointerCapture(e.evt.pointerId);

    setGesturing(true);
    if (wantsPan) {
      gesture.current = { kind: 'pan', x: e.evt.clientX, y: e.evt.clientY };
      return;
    }
    const origin = screenToWorld(camera, size, pointerIn(container, e.evt));
    gesture.current = { kind: 'marquee', origin };
    setMarquee({ minX: origin.x, minY: origin.y, maxX: origin.x, maxY: origin.y });
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onMove = (event: PointerEvent) => {
      // Where this person is on the BOARD, not on their screen: the receiver
      // draws it in world space so it survives their own pan and zoom. The
      // socket throttles, so this costs a subtraction per pointermove.
      const { camera: pc, size: ps } = view.current;
      const at = screenToWorld(pc, ps, pointerIn(container, event));
      realtimeRef.current?.sendCursor(at.x, at.y);

      const g = gesture.current;
      if (g.kind === 'pan') {
        const dx = event.clientX - g.x;
        const dy = event.clientY - g.y;
        gesture.current = { kind: 'pan', x: event.clientX, y: event.clientY };
        setCamera((c) => panBy(c, dx, dy));
        return;
      }
      if (g.kind === 'marquee') {
        const { camera: c, size: s } = view.current;
        const p = screenToWorld(c, s, pointerIn(container, event));
        setMarquee({
          minX: Math.min(g.origin.x, p.x),
          minY: Math.min(g.origin.y, p.y),
          maxX: Math.max(g.origin.x, p.x),
          maxY: Math.max(g.origin.y, p.y),
        });
      }
    };

    const onUp = (event: PointerEvent) => {
      const g = gesture.current;
      gesture.current = { kind: 'none' };
      setGesturing(false);
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
      if (g.kind !== 'marquee') return;

      const area = marqueeRef.current;
      setMarquee(null);
      if (!area) return;
      const dragged = area.maxX - area.minX > 1 || area.maxY - area.minY > 1;
      selectRef.current(dragged ? marqueeSelect(doc, area) : [], selectionMode(event));
    };

    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onUp);
    return () => {
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
    };
  }, [doc, setMarquee]);

  // --- item gestures -------------------------------------------------------

  const onItemPointerDown = (item: CanvasItem, e: Konva.KonvaEventObject<PointerEvent>) => {
    pressedAt.current = stageRef.current?.getRelativePointerPosition() ?? null;
    setSelectedLink(null);
    // Alt-drag from an item, or a node inside a diagram, draws a link (spec).
    // Ctrl+Alt is crop's chord — a drag under it slides the crop, never a link.
    if (e.evt.altKey && !e.evt.ctrlKey && !readOnly && tool === 'select' && pressedAt.current) {
      controlPress.current = item.id;
      startLink(item, pressedAt.current, e.evt);
      return;
    }
    // A press on a checkbox, task marker or link inside an object: released in
    // place it is a click on that control; moved past the drag distance it
    // moves the object like a press anywhere else (canvas/object-gestures).
    // Konva fires no click after a drag, so the control never acts as well.
    controlPress.current = null;
    if (tool === 'pan' || spaceHeld.current || e.evt.button === 1) return;
    // Selecting someone else's item is fine; manipulating it is not. `draggable`
    // already refuses the drag, and this keeps it out of a multi-item gesture.
    if (realtimeRef.current?.heldByOther(item.id)) return;
    const mode = selectionMode(e.evt);
    if (mode === 'replace' && item.groupId && !readOnly && tool === 'select') holdToPick(item.id);
    if (mode === 'replace' && selection.has(item.id)) return; // keep the multi-selection
    select([item.id], mode);
  };

  /**
   * Press and hold on a grouped item picks it out of its group
   * (canvas/group-member-editing): it alone is selected, with its handles, so
   * it can be moved, scaled and rotated while staying a member. A plain click
   * still selects the group; any move before the hold fires is a group drag.
   * The pick lasts as a selection does: clicking it again keeps it, clicking
   * anything else or Escape ends it.
   */
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelHold = () => {
    clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  };
  const holdToPick = (id: ItemId) => {
    cancelHold();
    holdTimer.current = setTimeout(() => {
      holdTimer.current = undefined;
      setSelection([id]);
    }, HOLD_TO_PICK_MS);
    window.addEventListener('pointerup', cancelHold, { once: true });
    window.addEventListener('pointercancel', cancelHold, { once: true });
  };

  /**
   * Double-click: just this image, even inside a group, in crop mode.
   *
   * Picking one member out of a group is the point: a click selects the whole
   * group, and crop acts on exactly one image.
   */
  /** The anchor under a world point: the topmost item there, or one of its diagram's nodes. */
  const anchorUnder = (world: { x: number; y: number }): Anchor | null => {
    const point = { minX: world.x, minY: world.y, maxX: world.x, maxY: world.y };
    const hits = doc.index
      .search(point)
      .flatMap((id) => {
        const it = doc.item(id);
        return it && contains(it, objects.view(it), world) ? [it] : [];
      })
      .sort((a, b) => b.z - a.z);
    const top = hits[0];
    return top ? anchorAt(top, objects.view(top), world) : null;
  };

  const startLink = (item: CanvasItem, world: { x: number; y: number }, evt: PointerEvent) => {
    const stage = stageRef.current;
    const container = containerRef.current;
    if (!stage || !container) return;
    let from = anchorAt(item, objects.view(item), world);
    // From a passage of a note with no name yet: it is named when the link
    // lands, in the same act (canvas/text-anchors).
    const under = from.element ? undefined : blockAt(item, objects.view(item), world);
    const block = under && !isTitle(under) ? under : undefined;
    linkDraft.current = { from, pointer: world, target: null, ...(block ? { block } : {}) };
    container.setPointerCapture(evt.pointerId);
    const move = (ev: PointerEvent) => {
      const draft = linkDraft.current;
      if (!draft) return;
      stage.setPointersPositions(ev);
      const at = stage.getRelativePointerPosition();
      if (!at) return;
      const target = anchorUnder(at);
      draft.pointer = at;
      draft.target = target && !sameAnchor(target, from) ? target : null;
      linkShape.current?.getLayer()?.batchDraw();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const target = linkDraft.current?.target ?? null;
      linkDraft.current = null;
      // Released over empty board: nothing (spec).
      if (target) {
        const linkId = newLinkId();
        const naming: CanvasOperationBody[] = [];
        const current = doc.item(item.id);
        if (block && current?.content.kind === 'note') {
          const named = nameBlock(current.content.source, block.index, block.text);
          if (named) {
            naming.push({
              type: 'item.source',
              itemId: item.id,
              source: named.source,
              ...(current.revision !== undefined ? { baseRevision: current.revision } : {}),
            });
            from = { itemId: item.id, element: named.name };
          }
        }
        commit(...naming, {
          type: 'link.add',
          linkId,
          from,
          to: target,
          linkType: defaultLinkType(item.content),
        });
        setSelection([]);
        setSelectedLink(linkId);
      }
      redraw();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** A click on the links: the nearest link, or its label when it is selected. */
  const onLinkClick = () => {
    const at = stageRef.current?.getRelativePointerPosition();
    if (!at) return;
    // The selected link's label first: a click on it cycles the type (spec).
    const selected = drawnLinks.current.find((d) => d.link.id === selectedLink);
    const label = selected ? labelBox(selected, camera.zoom) : undefined;
    const onLabel =
      label !== undefined &&
      at.x >= label.minX &&
      at.x <= label.maxX &&
      at.y >= label.minY &&
      at.y <= label.maxY;
    if (selected && onLabel && !readOnly) {
      commit({
        type: 'link.set',
        linkId: selected.link.id,
        linkType: nextLinkType(selected.link.linkType),
      });
      return;
    }
    const near = linkNear(drawnLinks.current, at, 8 / camera.zoom);
    if (!near) return;
    if (near.count > 1) {
      // A grouped line is one target: selecting its source fans it out.
      setSelectedLink(null);
      setSelection([near.link.from.itemId]);
      return;
    }
    setSelection([]);
    setSelectedLink(near.link.id);
  };

  const onLinkHover = () => {
    const at = stageRef.current?.getRelativePointerPosition();
    const near = at ? linkNear(drawnLinks.current, at, 8 / camera.zoom) : undefined;
    // On a grouped line this is its first link, which brings the group into focus and fans it out.
    setHoveredLink(near?.link.id ?? null);
  };

  /** Where an item is right now: the dragged node's place while it moves, so lines follow. */
  const liveTransform = (item: CanvasItem): Transform => {
    if (!dragOrigins.current.has(item.id) && draggingItem.current !== item.id)
      return item.transform;
    const node = stageRef.current?.findOne(`#${item.id}`);
    return node ? { ...item.transform, x: node.x(), y: node.y() } : item.transform;
  };

  /**
   * Every link, drawn quietly (spec): a thin line with an arrowhead, edge to
   * edge. A broken one is dashed in the dimmer annotation colour. The type label
   * and the anchors' outlines appear only for the hovered or selected link.
   * Drawn in the items' layer from live node positions, so a line follows an
   * item while it is dragged.
   */
  const paintLinks = (ctx: Konva.Context) => {
    const c = (ctx as unknown as { _context: CanvasRenderingContext2D })._context;
    const zoom = camera.zoom;
    const list: DrawnLink[] = [];
    // Links between the same two items are one line until either end is in
    // focus; then they fan out and the rest recede (canvas/links).
    const focus = {
      items: new Set<ItemId>([...selection, ...(hoveredItem.current ? [hoveredItem.current] : [])]),
      links: new Set<LinkId>([hoveredLink, selectedLink].filter((l): l is LinkId => l !== null)),
    };
    for (const g of groupLinks(doc.links())) {
      const a = doc.item(g.from);
      const b = doc.item(g.to);
      const first = g.links[0];
      if (!a || !b || !first) continue;
      const how = groupDrawing(g, focus, linksOnFocus);
      if (how.strength === 'hidden') continue;
      const faded = how.strength === 'faded';
      if (!how.fanned) {
        const from = anchorBox(a, objects.view(a), null, liveTransform(a));
        const to = anchorBox(b, objects.view(b), null, liveTransform(b));
        const segment = segmentBetween(from.box, to.box, zoom);
        list.push({
          link: first,
          segment,
          from,
          to,
          count: g.links.length,
          faded,
          labelled: false,
        });
        continue;
      }
      for (const link of g.links) {
        const from = anchorBox(a, objects.view(a), link.from.element, liveTransform(a));
        const to = anchorBox(b, objects.view(b), link.to.element, liveTransform(b));
        const segment = segmentBetween(from.box, to.box, zoom);
        list.push({ link, segment, from, to, count: 1, faded, labelled: how.labelled });
      }
    }
    drawnLinks.current = list;
    const arrow = (seg: { from: { x: number; y: number }; to: { x: number; y: number } }) => {
      const angle = Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x);
      const head = 7 / zoom;
      c.beginPath();
      c.moveTo(seg.from.x, seg.from.y);
      c.lineTo(seg.to.x, seg.to.y);
      c.stroke();
      c.beginPath();
      c.moveTo(seg.to.x, seg.to.y);
      c.lineTo(seg.to.x - head * Math.cos(angle - 0.45), seg.to.y - head * Math.sin(angle - 0.45));
      c.lineTo(seg.to.x - head * Math.cos(angle + 0.45), seg.to.y - head * Math.sin(angle + 0.45));
      c.closePath();
      c.fill();
    };
    const outline = (r: { minX: number; minY: number; maxX: number; maxY: number }) => {
      const pad = 3 / zoom;
      c.strokeRect(
        r.minX - pad,
        r.minY - pad,
        r.maxX - r.minX + 2 * pad,
        r.maxY - r.minY + 2 * pad,
      );
    };
    c.save();
    c.font = `${11 / zoom}px ui-sans-serif, system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.lineJoin = 'round';
    const halo = (text: string, x: number, y: number, colour: string) => {
      c.strokeStyle = theme.ground;
      c.fillStyle = colour;
      c.lineWidth = 4 / zoom;
      c.strokeText(text, x, y);
      c.fillText(text, x, y);
    };
    for (const d of list) {
      const hot = d.count === 1 && (d.link.id === hoveredLink || d.link.id === selectedLink);
      const broken = d.count === 1 && (d.from.broken || d.to.broken);
      const colour = hot
        ? theme.accent
        : broken
          ? theme.frame
          : d.faded
            ? theme.linkFaded
            : theme.label;
      c.strokeStyle = colour;
      c.fillStyle = colour;
      c.lineWidth = (d.link.id === selectedLink && d.count === 1 ? 2.5 : 1.5) / zoom;
      c.setLineDash(broken ? [5 / zoom, 4 / zoom] : []);
      arrow(d.segment);
      c.setLineDash([]);
      const m = midpoint(d.segment);
      if (d.count > 1) {
        // Where the type label would be: how many links this line stands for.
        halo(`×${d.count}`, m.x, m.y - 3 / zoom, colour);
        continue;
      }
      if (hot) {
        c.lineWidth = 1.5 / zoom;
        outline(d.from.box);
        outline(d.to.box);
      }
      if (hot || d.labelled)
        halo(broken ? `broken · ${d.link.linkType}` : d.link.linkType, m.x, m.y - 3 / zoom, colour);
    }
    // With links on focus only, each item says how many it has, so none looks unlinked.
    if (linksOnFocus) {
      c.textAlign = 'right';
      for (const [id, n] of linkCounts(doc.links())) {
        const item = doc.item(id);
        if (!item) continue;
        const box = anchorBox(item, objects.view(item), null, liveTransform(item)).box;
        halo(`${n} link${n === 1 ? '' : 's'}`, box.maxX, box.minY - 3 / zoom, theme.label);
      }
      c.textAlign = 'center';
    }
    // The link being dragged out, and what it would land on.
    const draft = linkDraft.current;
    const a = draft ? doc.item(draft.from.itemId) : undefined;
    if (draft && a) {
      const view = objects.view(a);
      const from =
        draft.block && view
          ? { box: layoutBox(liveTransform(a), view, draft.block.rect), broken: false }
          : anchorBox(a, view, draft.from.element, liveTransform(a));
      const target = draft.target ? doc.item(draft.target.itemId) : undefined;
      const to =
        target && draft.target
          ? anchorBox(target, objects.view(target), draft.target.element, liveTransform(target))
          : undefined;
      const end = to?.box ?? {
        minX: draft.pointer.x,
        minY: draft.pointer.y,
        maxX: draft.pointer.x,
        maxY: draft.pointer.y,
      };
      c.strokeStyle = theme.accent;
      c.fillStyle = theme.accent;
      c.lineWidth = 1.5 / zoom;
      c.setLineDash([6 / zoom, 4 / zoom]);
      arrow(segmentBetween(from.box, end, zoom));
      c.setLineDash([]);
      outline(from.box);
      if (to) outline(to.box);
    }
    c.restore();
  };

  /** A click on an object: its checkboxes, task markers, links, task text and title. */
  const onItemClick = (item: CanvasItem, e: Konva.KonvaEventObject<MouseEvent>) => {
    const at = stageRef.current?.getRelativePointerPosition();
    if (!at || !isObject(item) || tool !== 'select') return;
    if (objectEditing.click(item, at, e.evt.shiftKey)) redraw();
  };

  /** Double-click: an image's crop, an object's in-place editor. */
  const onItemDoubleClick = (item: CanvasItem) => {
    if (item.content.kind === 'image') enterCrop(item);
    else if (!readOnly && tool === 'select') objectEditing.doubleClick(item);
  };

  const onItemHover = (item: CanvasItem | null, e: Konva.KonvaEventObject<MouseEvent>) => {
    const at = stageRef.current?.getRelativePointerPosition();
    if (!at) return;
    const id = item?.id ?? null;
    if (hoveredItem.current !== id) {
      hoveredItem.current = id;
      linkShape.current?.getLayer()?.batchDraw();
    }
    if (item && !isObject(item)) return;
    objectEditing.hover(item, at, pointerIn(containerRef.current, e.evt as PointerEvent));
  };

  const enterCrop = (item: CanvasItem) => {
    if (readOnly || tool !== 'select' || item.content.kind !== 'image') return;
    if (realtimeRef.current?.heldByOther(item.id)) return;
    setSelection([item.id]);
    setCropItemId(item.id);
  };

  /**
   * Claim what the gesture touches, and start dragging in the same frame.
   *
   * Optimistic on purpose: waiting for the grant would put a round trip inside a
   * gesture, which is invariant 6. A refusal arrives as a `lock` frame naming
   * someone else and snaps those items back — rare, because it needs two people
   * to grab the same image within the same moment, and a better failure than a
   * canvas that hesitates at the start of every drag.
   */
  const claim = (ids: readonly ItemId[]) => {
    if (ids.length === 0) return;
    claimed.current = [...ids];
    realtimeRef.current?.acquire(ids);
  };

  /**
   * Give the claim back once the gesture's operations are DURABLE.
   *
   * Not on pointerup: until the batch is posted the item's committed state is
   * still the old one, and someone who grabbed it in that window could have
   * their commit overwritten by the one still in our queue. If persistence is
   * failing this never resolves and the ~10 s expiry is the backstop — an item
   * briefly ungrabbable beats an edit quietly lost.
   */
  /*
   * The socket is created once per board, but the two recovery callbacks it
   * needs close over live gesture state. Naming them as effect dependencies
   * would tear the connection down and rebuild it on every render, so they are
   * read through a ref that is refreshed each pass — the same bargain `view` and
   * `selectRef` above already make with the native listeners.
   */
  const gestureRecovery = useRef({
    afterResync: () => {},
    snapBack: (_ids: readonly ItemId[]) => {},
  });

  /** The full-strength outline beside an item, moved by hand exactly as its item is. */
  const markAt = (id: ItemId, x: number, y: number) => {
    stageRef.current?.findOne(`#${SELECTION_MARK}${id}`)?.position({ x, y });
  };

  /**
   * The frame and label of every group the drag carries whole, with where each
   * node started. They are drawn from the document, which hears about the move
   * only at release, so like the siblings they follow by hand.
   */
  const groupDrag = useRef<{ node: Konva.Node; x: number; y: number }[]>([]);
  const startGroupDrag = (moving: ReadonlySet<ItemId>) => {
    groupDrag.current = [];
    const stage = stageRef.current;
    if (!stage) return;
    const groups = new Set<GroupId>();
    for (const id of moving) {
      const g = doc.item(id)?.groupId;
      if (g) groups.add(g);
    }
    for (const g of groups) {
      if (!doc.group(g)?.memberIds.every((m) => moving.has(m))) continue;
      for (const prefix of [GROUP_FRAME, GROUP_KNOCKOUT, GROUP_LABEL]) {
        const node = stage.findOne(`#${prefix}${g}`);
        if (node) groupDrag.current.push({ node, x: node.x(), y: node.y() });
      }
    }
  };
  const moveGroupDrag = (dx: number, dy: number) => {
    for (const g of groupDrag.current) g.node.position({ x: g.x + dx, y: g.y + dy });
  };
  /** Back where they were, before the commit redraws them from the moved document. */
  const endGroupDrag = () => {
    moveGroupDrag(0, 0);
    groupDrag.current = [];
    endFramePreview();
  };

  /**
   * What the drop would do to frames, shown while the drag is still going
   * (canvas/group-frames): the frame an item would join is drawn in the accent,
   * and a frame a member would leave is drawn around the members that stay.
   * The drop's own rule on live positions, at most once per animation frame,
   * drawn onto the frame nodes by hand like the rest of a drag. Each touched
   * node's attributes are kept so they go back before the commit redraws —
   * React re-applies only props that changed, so a stroke left in the accent
   * would stay.
   */
  const framePreview = useRef({
    raf: 0,
    latest: new Map<ItemId, Transform>() as ReadonlyMap<ItemId, Transform>,
    saved: new Map<
      GroupId,
      { node: Konva.Line; stroke: string | CanvasGradient; points: number[] }
    >(),
  });
  const endFramePreview = () => {
    const p = framePreview.current;
    cancelAnimationFrame(p.raf);
    p.raf = 0;
    for (const { node, stroke, points } of p.saved.values()) node.setAttrs({ stroke, points });
    if (p.saved.size > 0) stageRef.current?.batchDraw();
    p.saved.clear();
  };
  const previewFrames = (moved: ReadonlyMap<ItemId, Transform>) => {
    if (readOnly) return;
    const p = framePreview.current;
    p.latest = moved;
    if (p.raf !== 0) return;
    p.raf = requestAnimationFrame(() => {
      p.raf = 0;
      const join = new Set<GroupId>();
      const leaving = new Map<GroupId, Set<ItemId>>();
      for (const [id, target] of dropTargets(doc, p.latest)) {
        if (target !== null) join.add(target);
        const from = doc.item(id)?.groupId;
        if (from !== undefined) leaving.set(from, (leaving.get(from) ?? new Set()).add(id));
      }
      const wanted = new Set([...join, ...leaving.keys()]);
      for (const [g, { node, stroke, points }] of p.saved) {
        if (wanted.has(g)) continue;
        node.setAttrs({ stroke, points });
        p.saved.delete(g);
      }
      for (const g of wanted) {
        const node = stageRef.current?.findOne<Konva.Line>(`#${GROUP_FRAME}${g}`);
        if (!node) continue; // not drawn: off screen, nothing to show
        const saved = p.saved.get(g) ?? { node, stroke: node.stroke(), points: node.points() };
        p.saved.set(g, saved);
        const without = leaving.get(g);
        const ring = without ? outlineWithout(doc, g, without) : [];
        node.setAttrs({
          stroke: join.has(g) ? theme.accent : saved.stroke,
          points: ring.length > 0 ? ring.flatMap((pt) => [pt.x, pt.y]) : saved.points,
        });
      }
      stageRef.current?.batchDraw();
    });
  };

  /**
   * Give up items the server refused, mid-gesture.
   *
   * Two people grabbed the same image within the same moment and this client
   * lost. The nodes are put back where the document says they are — the document
   * was never changed, because a drag only commits at the end — and they drop
   * out of the gesture so the rest of a multi-item drag carries on.
   */
  const snapBack = (itemIds: readonly ItemId[]) => {
    // A member left the gesture, so its group is no longer carried whole.
    endGroupDrag();
    for (const id of itemIds) {
      dragOrigins.current.delete(id);
      claimed.current = claimed.current.filter((held) => held !== id);
      const node = stageRef.current?.findOne(`#${id}`);
      const committed = doc.item(id);
      if (node && committed) {
        node.position({ x: committed.transform.x, y: committed.transform.y });
        markAt(id, committed.transform.x, committed.transform.y);
        node.stopDrag?.();
      }
    }
    stageRef.current?.batchDraw();
  };

  /**
   * Put the interface back together after the board was replaced underneath it.
   *
   * A resync swaps every item, so anything holding an item id from before is now
   * holding a reference to something that may not exist. A gesture is ended
   * rather than continued — its origins describe a board that is gone — and the
   * selection is pruned to what survived, because a selection naming missing
   * items is a transformer attached to nothing.
   *
   * The camera is deliberately untouched: the person is looking at a region, and
   * moving them somewhere else because the network hiccuped is worse than
   * whatever they missed.
   */
  const afterResync = () => {
    gesture.current = { kind: 'none' };
    dragOrigins.current.clear();
    claimed.current = [];
    setMarquee(null);
    setGesturing(false);
    const surviving = [...selectionRef.current].filter((id) => doc.item(id));
    if (surviving.length !== selectionRef.current.size) setSelection(surviving);
    redraw();
  };

  gestureRecovery.current = { afterResync, snapBack };

  const releaseWhenDurable = () => {
    const ids = claimed.current;
    claimed.current = [];
    if (ids.length === 0) return;
    const sync = syncRef.current;
    const realtime = realtimeRef.current;
    if (!realtime) return;
    if (!sync) {
      realtime.release(ids);
      return;
    }
    void sync.settled().then(() => realtime.release(ids));
  };

  const onDragStart = (item: CanvasItem) => {
    // Moving before the hold fires is an ordinary drag of what is selected.
    cancelHold();
    if (controlPress.current === item.id) {
      stageRef.current?.findOne(`#${item.id}`)?.stopDrag();
      return;
    }
    if (cropping && cropTarget?.id === item.id) {
      const node = stageRef.current?.findOne(`#${item.id}`);
      if (!node) return;
      const frame = cropFrame(item);
      cropGesture.current = {
        kind: 'slide',
        item,
        frame,
        was: visibleEdges(item, frame),
        start: { x: node.x(), y: node.y() },
        pointer: pressedAt.current ?? { x: 0, y: 0 },
      };
      setGesturing(true);
      setCropLive(true);
      claim([item.id]);
      return;
    }
    setGesturing(true);
    draggingItem.current = item.id;
    dragOrigins.current.clear();
    for (const id of selection) {
      const node = stageRef.current?.findOne(`#${id}`);
      if (node) dragOrigins.current.set(id, { x: node.x(), y: node.y() });
    }
    const touched = dragOrigins.current.size > 0 ? [...dragOrigins.current.keys()] : [item.id];
    startGroupDrag(new Set(touched));
    claim(touched);
  };

  /** Siblings follow imperatively — no React render per pointermove. */
  const onDragMove = (item: CanvasItem, e: Konva.KonvaEventObject<DragEvent>) => {
    const slide = cropGesture.current;
    if (slide?.kind === 'slide') {
      // The window stays; the original moves under it.
      //
      // Measured from the POINTER, not from the node: Konva fires `dragmove`
      // even for an event that did not move the node (WebKit and trackpads send
      // repeats at one position), and the node is pinned back to `start` every
      // time — so a node-based delta reads zero on a repeat and the crop snaps
      // back to where the slide began, then forward again on the next move.
      const pointer = e.target.getStage()?.getRelativePointerPosition();
      e.target.position(slide.start);
      if (!pointer) return;
      const delta = { x: pointer.x - slide.pointer.x, y: pointer.y - slide.pointer.y };
      const crop = slideCrop(slide.item, delta);
      slide.last = { transform: slide.item.transform, crop };
      showCrop(slide.item, slide.last);
      return;
    }
    const origin = dragOrigins.current.get(item.id);
    const moved = new Map<ItemId, Transform>();
    const at = (id: ItemId, x: number, y: number) => {
      const current = doc.item(id);
      if (current) moved.set(id, { ...current.transform, x, y });
    };

    if (!origin) {
      at(item.id, e.target.x(), e.target.y());
      markAt(item.id, e.target.x(), e.target.y());
      moveGroupDrag(e.target.x() - item.transform.x, e.target.y() - item.transform.y);
      previewNow(moved);
      previewFrames(moved);
      return;
    }
    const dx = e.target.x() - origin.x;
    const dy = e.target.y() - origin.y;
    moveGroupDrag(dx, dy);
    at(item.id, e.target.x(), e.target.y());
    // The selection outline is its own node so it keeps full strength over a
    // faded item, which means it has to be moved by hand exactly as its item is.
    markAt(item.id, e.target.x(), e.target.y());
    for (const [id, start] of dragOrigins.current) {
      if (id === item.id) continue;
      stageRef.current?.findOne(`#${id}`)?.position({ x: start.x + dx, y: start.y + dy });
      markAt(id, start.x + dx, start.y + dy);
      at(id, start.x + dx, start.y + dy);
    }
    previewNow(moved);
    previewFrames(moved);
  };

  /**
   * Show the gesture to everyone else while it is still happening.
   *
   * Whole transforms, never deltas: a dropped preview is corrected by the next
   * one instead of leaving permanent error. The whole selection goes in one
   * frame, and the socket throttles — this is called per pointermove and must
   * cost nothing.
   */
  const previewNow = (moved: ReadonlyMap<ItemId, Transform>) => {
    if (moved.size > 0) realtimeRef.current?.sendPreview(moved);
  };

  const onDragEnd = (item: CanvasItem) => {
    draggingItem.current = null;
    // A press that was for a control or a link: its drag was stopped at once,
    // and there is nothing to commit.
    if (controlPress.current === item.id) return;
    if (cropGesture.current?.kind === 'slide') {
      endCrop();
      return;
    }
    setGesturing(false);
    endGroupDrag();
    // A drag without recorded origins moved only the pressed item.
    const ids = dragOrigins.current.size > 0 ? [...dragOrigins.current.keys()] : [item.id];
    dragOrigins.current.clear();
    const positions = new Map<ItemId, Transform>();
    for (const id of ids) {
      const node = stageRef.current?.findOne(`#${id}`);
      const current = doc.item(id);
      if (node && current) positions.set(id, { ...current.transform, x: node.x(), y: node.y() });
    }
    // Moving and joining or leaving a frame are one undo step and one batch.
    commit(
      ...[...positions].map(
        ([itemId, transform]): CanvasOperationBody => ({
          type: 'item.transform',
          itemId,
          transform,
        }),
      ),
      ...membershipBodies(doc, positions),
    );
    releaseWhenDurable();
  };

  /**
   * Draw a crop in flight straight onto the nodes — the item, its outline and
   * the ghost — with no React render per pointermove. The commit at the end
   * redraws them from the document with the same values.
   */
  const showCrop = (item: CanvasItem, next: { transform: Transform; crop: Crop }) => {
    const stage = stageRef.current;
    const node = stage?.findOne(`#${item.id}`);
    if (!stage || !node) return;
    const attrs = toKonvaAttrs(next.transform);
    const { scaleX, scaleY } = toKonvaAppearance(item.appearance);
    // The colour-rect LOD has no image, and no crop to show.
    const image = (node as Konva.Image).image?.() as { width: number; height: number } | undefined;
    node.setAttrs({ ...attrs, scaleX, scaleY, ...(image ? toKonvaCrop(next.crop, image) : {}) });
    stage.findOne(`#${SELECTION_MARK}${item.id}`)?.setAttrs(attrs);
    const original = toKonvaAttrs(originalTransform(cropFrame({ ...item, ...next })));
    stage.findOne(`#${CROP_GHOST}`)?.setAttrs(original);
    stage.findOne(`#${CROP_GHOST_EDGE}`)?.setAttrs(original);
    transformerRef.current?.forceUpdate();
    stage.batchDraw();
  };

  /** One operation for the whole gesture: undo restores box and crop together. */
  const endCrop = () => {
    const g = cropGesture.current;
    cropGesture.current = null;
    setCropLive(false);
    setGesturing(false);
    if (g?.last) {
      commit({ type: 'item.transform', itemId: g.item.id, ...g.last });
    } else {
      redraw();
    }
    releaseWhenDurable();
  };

  /** The handle a transform started from: a corner scales a note's text with it. */
  const transformAnchor = useRef('');
  const onTransformStart = () => {
    setGesturing(true);
    const anchor = transformerRef.current?.getActiveAnchor() ?? '';
    transformAnchor.current = anchor;
    if (!cropping || !cropTarget || anchor.startsWith('rotater')) return;
    const frame = cropFrame(cropTarget);
    cropGesture.current = {
      kind: 'edges',
      item: cropTarget,
      frame,
      was: visibleEdges(cropTarget, frame),
      start: { x: 0, y: 0 },
      pointer: { x: 0, y: 0 },
    };
    setCropLive(true);
  };

  /**
   * The Transformer's proposed box, reduced to the edges the handle owns and
   * clamped to the original.
   *
   * Konva forces centred scaling whenever Alt is down, so under Ctrl+Alt the
   * proposal moves BOTH sides; taking only the dragged edges from it is what
   * keeps the far side still. Boxes are in absolute coordinates, so they go
   * through the stage's transform to reach the item's frame and back.
   */
  const cropBoundBox = (_old: TransformerBox, box: TransformerBox): TransformerBox => {
    const g = cropGesture.current;
    const stage = stageRef.current;
    if (g?.kind !== 'edges' || !stage) return box;
    const toAbsolute = stage.getAbsoluteTransform();
    const fromAbsolute = toAbsolute.copy().invert();
    const cos = Math.cos(box.rotation);
    const sin = Math.sin(box.rotation);
    const corners = [
      [0, 0],
      [box.width, 0],
      [0, box.height],
      [box.width, box.height],
    ].map(([u = 0, v = 0]) =>
      toFrame(
        g.frame,
        fromAbsolute.point({ x: box.x + u * cos - v * sin, y: box.y + u * sin + v * cos }),
      ),
    );
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const proposed = {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    };
    // A mirrored node can report its box turned half round; its "left" anchor
    // then sits on the frame's right, and every edge name swaps with it.
    let moving = movingEdges(transformerRef.current?.getActiveAnchor() ?? '');
    if (Math.cos(box.rotation - g.frame.rotation) < 0) {
      moving = { left: moving.right, right: moving.left, top: moving.bottom, bottom: moving.top };
    }
    const zoom = stage.scaleX();
    const edges = clampEdges(g.frame, g.was, proposed, moving, MIN_CROP_PX / zoom);
    const width = (edges.right - edges.left) * zoom;
    const height = (edges.bottom - edges.top) * zoom;
    const centre = toAbsolute.point(
      toWorld(g.frame, { x: (edges.left + edges.right) / 2, y: (edges.top + edges.bottom) / 2 }),
    );
    return {
      x: centre.x - (width / 2) * cos + (height / 2) * sin,
      y: centre.y - (width / 2) * sin - (height / 2) * cos,
      width,
      height,
      rotation: box.rotation,
    };
  };

  const onTransform = () => {
    const g = cropGesture.current;
    const node = transformerRef.current?.nodes()[0];
    if (g?.kind !== 'edges' || !node) return;
    const t = nodeTransform(node);
    const c = toFrame(g.frame, { x: t.x, y: t.y });
    g.last = fromEdges(g.item, g.frame, {
      left: c.x - t.width / 2,
      right: c.x + t.width / 2,
      top: c.y - t.height / 2,
      bottom: c.y + t.height / 2,
    });
    showCrop(g.item, g.last);
    // Others see the edge move the way they see a drag: the outline follows.
    previewNow(new Map([[g.item.id, g.last.transform]]));
  };

  const onTransformEnd = () => {
    if (cropGesture.current?.kind === 'edges') {
      endCrop();
      return;
    }
    setGesturing(false);
    const bodies: CanvasOperationBody[] = [];
    for (const node of transformerRef.current?.nodes() ?? []) {
      const id = node.id() as ItemId;
      if (!doc.item(id)) continue;
      const transform = nodeTransform(node);
      // Scale lives in width/height from here on, so the node must not keep it.
      node.scaleX(1);
      node.scaleY(1);
      bodies.push({
        type: 'item.transform',
        itemId: id,
        transform,
        ...textScaleFor(doc.item(id), transform, transformAnchor.current),
      });
    }
    commit(...bodies);
    releaseWhenDurable();
  };

  /*
   * Broadcast the selection whenever it changes.
   *
   * Ephemeral: it shows other people what this person is working on and never
   * touches their own selection. Not throttled, because selecting is a discrete
   * act — a person cannot produce these at 60 Hz the way a pointer can.
   */
  useEffect(() => {
    realtimeRef.current?.sendSelection([...selection]);
  }, [selection]);

  // Konva's Transformer takes node instances, so it is synced after render.
  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    // Not on an object being edited in place: the editor is its frame then.
    const attached = [...selection]
      .filter((id) => id !== objectEditing.editingId)
      .map((id) => stageRef.current?.findOne(`#${id}`))
      .filter((n): n is Konva.Node => Boolean(n));
    transformer.nodes(attached);
  });

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none select-none"
        // The ground grid sits beneath the Stage as the container's own background.
        style={{
          ...gridBackground(camera, size, theme.grid),
          ...(inspectorOpen ? { right: INSPECTOR_WIDTH } : {}),
        }}
      >
        <Stage
          ref={stageRef}
          width={width}
          height={height}
          x={stage.x}
          y={stage.y}
          scaleX={stage.scaleX}
          scaleY={stage.scaleY}
          onPointerDown={onPointerDown}
          // macOS makes Ctrl+click a right-click, and Ctrl+Alt is the crop
          // modifier. A plain right-click keeps the browser's menu.
          onContextMenu={(e) => {
            if (e.evt.ctrlKey) e.evt.preventDefault();
          }}
        >
          <Layer listening={false}>
            <Shape
              perfectDrawEnabled={false}
              sceneFunc={(ctx) =>
                paintAggregate(
                  ctx as unknown as AggregateContext,
                  { items: aggregated, groups: groupOutlines, zoom: camera.zoom },
                  { itemColor: theme.itemEdge, groupColor: theme.groupEdge },
                )
              }
            />
          </Layer>

          {/*
          Group annotations, between the aggregate marks and the images so the
          references stay dominant: a frame reads around its members, and its
          label interrupts the line with a ground-coloured halo. Screen pixels
          divided by zoom, like every interface stroke.
        */}
          <Layer listening={false}>
            {drawnFrames.map((frame) => (
              <KonvaLine
                key={frame.groupId}
                id={`${GROUP_FRAME}${frame.groupId}`}
                points={frame.points}
                closed
                stroke={theme.frame}
                strokeWidth={FRAME_STROKE / camera.zoom}
                perfectDrawEnabled={false}
                hitStrokeWidth={0}
              />
            ))}
          </Layer>

          <Layer ref={itemsLayer}>
            {nodes.map((item) => {
              const bitmap = gifs.canvasFor(item) ?? bitmaps.bitmapFor(item);
              const node = (
                <ItemNode
                  key={item.id}
                  item={item}
                  lod={lodOf(active.visible, item.id)}
                  bitmap={bitmap}
                  view={isObject(item) ? objects.view(item) : undefined}
                  opacity={
                    opacityPreview !== null && selection.has(item.id)
                      ? opacityPreview
                      : item.appearance.opacity
                  }
                  selected={selection.has(item.id)}
                  draggable={tool === 'select' && !readOnly}
                  heldBy={holderColour(item.id)}
                  zoom={camera.zoom}
                  onPointerDown={onItemPointerDown}
                  onDragStart={onDragStart}
                  onDragMove={onDragMove}
                  onDragEnd={onDragEnd}
                  onDoubleClick={onItemDoubleClick}
                  onClick={onItemClick}
                  onHover={onItemHover}
                  cropping={cropping && cropTarget?.id === item.id}
                />
              );
              // The whole original, faded, directly beneath the item it frames.
              if (!cropping || cropTarget?.id !== item.id || !bitmap) return node;
              return [
                <CropGhost
                  key={`${item.id}-ghost`}
                  item={item}
                  bitmap={bitmap}
                  zoom={camera.zoom}
                />,
                node,
              ];
            })}
            {/*
            Another actor's selection: the same interface stroke as the local
            one, in their colour, specified in screen pixels and divided by zoom
            so it stays one thickness however far the camera is.
          */}
            {/* Links over the items they join, under the selection chrome. */}
            <Shape
              ref={linkShape}
              sceneFunc={paintLinks}
              hitFunc={(ctx, shape) => {
                ctx.beginPath();
                for (const d of drawnLinks.current) {
                  ctx.moveTo(d.segment.from.x, d.segment.from.y);
                  ctx.lineTo(d.segment.to.x, d.segment.to.y);
                }
                ctx.strokeShape(shape);
                // The selected link's label is clickable too: it cycles the type.
                const selected = drawnLinks.current.find((d) => d.link.id === selectedLink);
                if (selected) {
                  const r = labelBox(selected, camera.zoom);
                  ctx.beginPath();
                  ctx.rect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
                  ctx.fillShape(shape);
                }
              }}
              stroke={theme.label}
              fill={theme.label}
              hitStrokeWidth={12 / camera.zoom}
              perfectDrawEnabled={false}
              onClick={onLinkClick}
              onTap={onLinkClick}
              onMouseMove={onLinkHover}
              onMouseLeave={() => setHoveredLink(null)}
            />
            {remoteMarks.map((mark) => (
              <KonvaRect
                key={mark.key}
                x={mark.rect.minX}
                y={mark.rect.minY}
                width={mark.rect.maxX - mark.rect.minX}
                height={mark.rect.maxY - mark.rect.minY}
                stroke={mark.colour}
                strokeWidth={1.5 / camera.zoom}
                dash={[6 / camera.zoom, 4 / camera.zoom]}
                listening={false}
                perfectDrawEnabled={false}
              />
            ))}
            {search && search.results.length > 0 && (
              <SearchMarks
                doc={doc}
                query={search.query}
                results={search.results}
                current={search.current}
                visible={visibleIds}
                viewport={visibleWorldRect(camera, size)}
                viewOf={(item) => objects.view(item)}
                zoom={camera.zoom}
                accent={theme.accent}
              />
            )}
            {focusMarks.map((mark) => (
              <KonvaRect
                key={mark.key}
                name="agent-focus"
                x={mark.rect.minX - 4 / camera.zoom}
                y={mark.rect.minY - 4 / camera.zoom}
                width={mark.rect.maxX - mark.rect.minX + 8 / camera.zoom}
                height={mark.rect.maxY - mark.rect.minY + 8 / camera.zoom}
                stroke={mark.colour}
                strokeWidth={2 / camera.zoom}
                listening={false}
                perfectDrawEnabled={false}
              />
            ))}
            {/*
            Konva's Transformer ships with its own blue and white anchors, which
            is a third palette nobody chose. It is the most visible thing on a
            selected item, so it wears the accent like everything else.
          */}
            {/*
            Konva's Transformer ships with its own blue and white anchors, which
            is a third palette nobody chose. It is the most visible thing on a
            selected item, so it wears the accent like everything else.
          */}
            {!readOnly && (
              <Transformer
                ref={transformerRef}
                // Cropping: no rotation, free aspect (Shift keeps it, Konva's own
                // rule), and the box run through cropBoundBox. The dash that says
                // "crop" is on the item's own outline, which is drawn over this.
                rotateEnabled={!cropping}
                keepRatio={!cropping}
                boundBoxFunc={cropBoundBox}
                ignoreStroke
                borderStroke={theme.accent}
                borderStrokeWidth={1}
                anchorStroke={theme.accent}
                anchorFill={theme.surface}
                anchorSize={8}
                onTransformStart={onTransformStart}
                onTransform={onTransform}
                onTransformEnd={onTransformEnd}
              />
            )}
          </Layer>

          {/*
            Group labels over the items (canvas/group-labels): far out a label is
            larger than its group, and wayfinding is the one thing still legible
            there, so nothing is drawn through it.
          */}
          <Layer listening={false}>
            {groupLabels.map((group) => (
              <Fragment key={group.groupId}>
                <KonvaRect
                  name="group-label-knockout"
                  id={`${GROUP_KNOCKOUT}${group.groupId}`}
                  {...group.knockout}
                  fill={theme.ground}
                  listening={false}
                  perfectDrawEnabled={false}
                />
                <KonvaText
                  name="group-label"
                  id={`${GROUP_LABEL}${group.groupId}`}
                  x={group.x}
                  y={group.y}
                  text={group.label}
                  fontSize={group.fontSize}
                  fontFamily={GROUP_LABEL_FAMILY}
                  fill={theme.label}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              </Fragment>
            ))}
          </Layer>

          {marquee && (
            <Layer listening={false}>
              <KonvaRect
                x={marquee.minX}
                y={marquee.minY}
                width={marquee.maxX - marquee.minX}
                height={marquee.maxY - marquee.minY}
                fill={theme.accentWash}
                stroke={theme.accent}
                strokeWidth={1 / camera.zoom}
              />
            </Layer>
          )}
        </Stage>

        {/* In-place editors and the task hover, over the canvas while they last. */}
        {objectEditing.overlays}

        <RemoteCursors presence={presence} camera={camera} size={size} theme={theme} />
        <AgentFocusLabels marks={focusMarks} presence={presence} camera={camera} size={size} />
        <PresenceRoster
          presence={presence}
          selfActorId={realtimeRef.current?.actorId}
          theme={theme}
        />
        {!readOnly && (
          <CanvasToolbar
            history={history}
            onHistory={redraw}
            linksOnFocus={linksOnFocus}
            onLinksOnFocus={setLinksOnFocus}
            onFrame={frameView}
            onChecklist={() =>
              objectEditing.newChecklist(
                screenToWorld(camera, size, { x: size.width / 2, y: size.height / 3 }),
              )
            }
          />
        )}
        <SearchBar onClose={closeSearchOnResult} />
        <ShortcutLegend readOnly={readOnly} width={width} />
        {!readOnly && (
          <SelectionToolbar
            doc={doc}
            camera={camera}
            size={size}
            selection={selection}
            commit={commit}
            setSelection={setSelection}
            onOpacityPreview={setOpacityPreview}
            hidden={gesturing}
            labelSignal={labelSignal}
            collapsed={toolbarCollapsed}
            onToggleCollapsed={toggleToolbar}
            cropping={cropSticky}
            onToggleCrop={() => setCropItemId(cropSticky ? null : (cropTarget?.id ?? null))}
          />
        )}

        <div
          className="pointer-events-none absolute bottom-2 left-2 rounded bg-surface/90 px-2 py-1 text-[11px] text-ink-dim tabular-nums"
          data-testid="canvas-stats"
        >
          {/*
           * The renderer's counters are for measuring it, not for the person — and
           * a share link shows this to a client. Dev builds (which the e2e suite
           * runs against) and `?debug` keep them.
           */}
          {SHOW_RENDER_COUNTERS ? (
            <>
              {doc.itemCount.toLocaleString()} items · {active.candidateCount.toLocaleString()}{' '}
              candidates · {nodes.length} rendered · {aggregated.length.toLocaleString()} aggregated
              · {selection.size} selected · {(camera.zoom * 100).toFixed(0)}%
              {active.truncated ? ' · truncated' : ''}
            </>
          ) : (
            <>
              {doc.itemCount.toLocaleString()} items
              {selection.size > 0 ? ` · ${selection.size} selected` : ''} ·{' '}
              {(camera.zoom * 100).toFixed(0)}%
            </>
          )}
        </div>
      </div>
      {/* Dev builds only: beside the board, never over it (spec: canvas/inspector). */}
      {Inspector && inspectorOpen ? (
        <Suspense fallback={null}>
          <Inspector
            doc={doc}
            objects={objects}
            selection={selection}
            selectedLink={selectedLink}
            drawnLinks={() => drawnLinks.current}
            log={opLog}
            commit={commit}
          />
        </Suspense>
      ) : null}
    </>
  );
}

// Dev builds only: a production bundle has no switch for these, `?debug` included.
const SHOW_RENDER_COUNTERS =
  DEVTOOLS &&
  (import.meta.env.DEV || new URLSearchParams(globalThis.location?.search).has('debug'));

// --- pieces ----------------------------------------------------------------

/**
 * One item, as the two sets of attributes it is drawn from.
 *
 * The split IS the invariant. `form` carries the item's appearance — its
 * opacity, and each flip as a scale of -1 about the centre `toKonvaAttrs`
 * already offsets to. `outline` carries the same geometry and deliberately
 * neither: Konva applies a node's opacity once for the whole shape, so an
 * interface stroke sharing the faded node would fade with it, and an item at
 * zero opacity would be selected with nothing on screen to say so. Invariant 8
 * is what that would break.
 */
export function itemNodeAttrs(
  item: CanvasItem,
  opacity: number,
  zoom: number,
  chrome: boolean,
): {
  form: ReturnType<typeof toKonvaAttrs> & ReturnType<typeof toKonvaAppearance>;
  outline: (ReturnType<typeof toKonvaAttrs> & { strokeWidth: number }) | undefined;
} {
  const attrs = toKonvaAttrs(item.transform);
  return {
    form: { ...attrs, ...toKonvaAppearance({ ...item.appearance, opacity }) },
    outline: chrome ? { ...attrs, strokeWidth: 2 / zoom } : undefined,
  };
}

/**
 * The labels to draw, for the groups handed in.
 *
 * The caller passes the groups the ACTIVE SET touches, which is the bound that
 * matters: a board holding a thousand labelled groups draws as many labels as
 * the viewport has groups in it and no more. Size and offset are screen pixels
 * divided by zoom, like every other interface stroke on the canvas, so a label
 * is one size however far the camera is. No zoom threshold — that would be a
 * number nobody has measured.
 *
 * `anchors` carries the derived contours of framed groups: an anchored label
 * sits ON its contour's top-left, interrupting the line, because that is what
 * makes "this label describes these things" true at a glance. Everyone else
 * floats above their bounds as before.
 */
export interface GroupLabel {
  readonly groupId: GroupId;
  readonly label: string;
  /** The text's top-left and size, world units. */
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  /** The text's box, world units: the knockout is this box padded. */
  readonly width: number;
  readonly height: number;
  /** The ground-coloured patch behind it, world units. */
  readonly knockout: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export function groupLabelsFor(
  doc: CanvasDocument,
  groupIds: Iterable<GroupId>,
  zoom: number,
  anchors?: ReadonlyMap<GroupId, { minX: number; minY: number }>,
  /** Where world (0, 0) is on screen, to put the text on whole screen pixels. */
  origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): GroupLabel[] {
  const px = zoom < GROUP_LABEL_FAR_BELOW ? GROUP_LABEL_SIZE_FAR : GROUP_LABEL_SIZE;
  const fontSize = px / zoom;
  const snap = (v: number, o: number) => (Math.round(v * zoom + o) - o) / zoom;
  const candidates: (GroupLabel & { area: number })[] = [];
  for (const groupId of groupIds) {
    const label = doc.group(groupId)?.label;
    if (!label) continue;
    const bounds = doc.groupBounds(groupId);
    if (!bounds) continue;
    const anchor = anchors?.get(groupId);
    const text = label.toUpperCase();
    const x = snap(anchor ? anchor.minX + (GROUP_LABEL_PAD * 2) / zoom : bounds.minX, origin.x);
    const y = snap(
      anchor ? anchor.minY - px / 2 / zoom : bounds.minY - (px + GROUP_LABEL_GAP) / zoom,
      origin.y,
    );
    const width = (text.length * px * GROUP_LABEL_ADVANCE) / zoom;
    const pad = GROUP_LABEL_PAD / zoom;
    candidates.push({
      groupId,
      label: text,
      x,
      y,
      fontSize,
      width,
      height: fontSize,
      knockout: { x: x - pad, y: y - pad, width: width + 2 * pad, height: fontSize + 2 * pad },
      area: (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY),
    });
  }
  // Two labels never overlap: the larger group's is drawn, the other waits
  // until zooming in separates them. Greedy, largest first.
  // ponytail: O(n²) over the labels on screen — tens, not thousands.
  candidates.sort((a, b) => b.area - a.area);
  const kept: GroupLabel[] = [];
  for (const { area: _, ...c } of candidates) {
    const k = c.knockout;
    const hit = kept.some(
      ({ knockout: o }) =>
        k.x < o.x + o.width && o.x < k.x + k.width && k.y < o.y + o.height && o.y < k.y + k.height,
    );
    if (!hit) kept.push(c);
  }
  return kept;
}

/**
 * The cached contour of one framed group, or nothing when there is nothing to
 * frame. The signature is every input the contour has: the flag itself plus
 * each member's transform. A member that vanished mid-flight returns nothing —
 * the next document change settles it.
 */
export function frameFor(
  doc: CanvasDocument,
  groupId: GroupId,
  cache: Map<GroupId, FrameEntry>,
): FrameEntry | undefined {
  const group = doc.group(groupId);
  if (!group?.frame) return undefined;
  let signature = `${group.memberIds.length}`;
  for (const id of group.memberIds) {
    const t = doc.item(id)?.transform;
    if (!t) return undefined;
    signature += `|${t.x},${t.y},${t.width},${t.height},${t.rotation}`;
  }
  const cached = cache.get(groupId);
  if (cached && cached.signature === signature) return cached;

  const memberRects: Rect[] = [];
  for (const id of group.memberIds) {
    const bounds = doc.index.boundsOf(id);
    if (bounds) memberRects.push(bounds);
  }
  const ring = groupOutline(memberRects);
  if (ring.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  for (const p of ring) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  const entry: FrameEntry = {
    signature,
    points: ring.flatMap((p) => [p.x, p.y]),
    minX,
    minY,
  };
  cache.set(groupId, entry);
  return entry;
}

/**
 * The ground grid: a dot at every world grid intersection.
 *
 * World-anchored so it pans and zooms with the content — that is the whole
 * point of it, a sense of scale. A tiled CSS background on the container rather
 * than a Konva path: the browser repeats one gradient, so there is no per-dot
 * work per camera frame, and the dot stays one screen size at every zoom.
 * Fades out before cells get small enough to moiré.
 */
export function gridBackground(
  camera: Camera,
  size: { width: number; height: number },
  colour: string,
): { backgroundImage: string; backgroundSize: string; backgroundPosition: string } | undefined {
  const cellPx = GRID_PITCH * camera.zoom;
  if (cellPx < GRID_HIDE_BELOW) {
    return undefined;
  }
  const strength =
    cellPx >= GRID_FADE_BELOW
      ? 100
      : Math.round((100 * (cellPx - GRID_HIDE_BELOW)) / (GRID_FADE_BELOW - GRID_HIDE_BELOW));
  const ink =
    strength === 100 ? colour : `color-mix(in oklch, ${colour} ${strength}%, transparent)`;
  const stage = toStageAttrs(camera, size);
  return {
    backgroundImage: `radial-gradient(circle, ${ink} ${GRID_DOT_RADIUS}px, transparent ${GRID_DOT_RADIUS + 0.5}px)`,
    backgroundSize: `${cellPx}px ${cellPx}px`,
    // The gradient centres its dot in the tile; half a cell back puts the dots
    // on world multiples of the pitch, where stage.x/y is world (0, 0).
    backgroundPosition: `${stage.x - cellPx / 2}px ${stage.y - cellPx / 2}px`,
  };
}

function ItemNode({
  item,
  lod,
  bitmap,
  opacity,
  selected,
  draggable,
  heldBy,
  zoom,
  onPointerDown,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDoubleClick,
  onClick,
  onHover,
  cropping,
  view,
}: {
  item: CanvasItem;
  lod: string;
  bitmap: ImageBitmap | HTMLCanvasElement | undefined;
  /** A note, diagram or checklist's layout; absent for images and before it lands. */
  view?: ObjectView | undefined;
  /** The item's opacity, or the value under a slider that has not been released. */
  opacity: number;
  selected: boolean;
  draggable: boolean;
  /** Colour of the actor holding this item, when it is not us. Held means not grabbable. */
  heldBy: string | undefined;
  zoom: number;
  onPointerDown: (item: CanvasItem, e: Konva.KonvaEventObject<PointerEvent>) => void;
  onDragStart: (item: CanvasItem) => void;
  onDragMove: (item: CanvasItem, e: Konva.KonvaEventObject<DragEvent>) => void;
  onDragEnd: (item: CanvasItem) => void;
  onDoubleClick: (item: CanvasItem) => void;
  onClick: (item: CanvasItem, e: Konva.KonvaEventObject<MouseEvent>) => void;
  onHover: (item: CanvasItem | null, e: Konva.KonvaEventObject<MouseEvent>) => void;
  /** Being cropped: the outline goes dashed, the one sign the cage changed job. */
  cropping: boolean;
}) {
  const theme = canvasTheme();
  const attrs = itemNodeAttrs(item, opacity, zoom, selected || heldBy !== undefined);
  // An object's height follows its drawing with the top edge fixed (spec). The
  // offset keeps the stored half-height, so a different drawn height grows or
  // shrinks downward from the same top, rotation included. Until the author's
  // height lands, every client draws the height it derives itself.
  const derived = view ? drawnHeight(item, view.layout) : undefined;
  const form = derived === undefined ? attrs.form : { ...attrs.form, height: derived };
  const outlineAttrs =
    derived === undefined || !attrs.outline ? attrs.outline : { ...attrs.outline, height: derived };
  const shared = {
    id: item.id,
    ...form,
    // Someone else is manipulating this. It stays visible and stays moving —
    // their previews keep arriving — it simply cannot be grabbed.
    draggable: draggable && heldBy === undefined,
    onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => onPointerDown(item, e),
    onDragStart: () => onDragStart(item),
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onDragMove(item, e),
    onDragEnd: () => onDragEnd(item),
    onDblClick: () => onDoubleClick(item),
    onDblTap: () => onDoubleClick(item),
    onClick: (e: Konva.KonvaEventObject<MouseEvent>) => onClick(item, e),
    // Hovering any item brings its links forward; only objects also say who changed a task.
    onMouseMove: (e: Konva.KonvaEventObject<MouseEvent>) => onHover(item, e),
    onMouseLeave: (e: Konva.KonvaEventObject<MouseEvent>) => onHover(null, e),
    perfectDrawEnabled: false,
    shadowForStrokeEnabled: false,
  };

  /*
   * Chrome does not inherit appearance — invariant 8.
   *
   * Konva applies a node's opacity once for the whole shape, image and stroke
   * together, so an interface stroke on the faded node would fade with it and an
   * item at 0 would be selected with nothing on screen to say so. The outline is
   * therefore its own node at full strength, and only for the selected and held
   * items: everything else stays one node, which is the bound the renderer's
   * performance rests on.
   */
  const outline = outlineAttrs ? (
    <KonvaRect
      id={`${SELECTION_MARK}${item.id}`}
      {...outlineAttrs}
      stroke={heldBy ?? theme.accent}
      dash={cropping ? [4 / zoom, 3 / zoom] : []}
      listening={false}
      perfectDrawEnabled={false}
      shadowForStrokeEnabled={false}
    />
  ) : null;

  // MICRO is a colour blob by definition: decoding an image for a few pixels is
  // exactly the cost LOD exists to avoid.
  if (isObject(item)) {
    const mark = 6 / zoom;
    return (
      <>
        {bitmap && IMAGE_LODS.has(lod) ? (
          <KonvaImage {...shared} image={bitmap} />
        ) : (
          // Not yet drawn, or too small to be worth drawing: still something to
          // select and drag, and nothing painted (objects have no background).
          <KonvaRect {...shared} fill="transparent" />
        )}
        {view?.stale ? (
          // The source no longer parses and this is its last good drawing: a
          // small dim mark in the corner, not an alarm.
          <KonvaRect
            id={`stale-${item.id}`}
            x={form.x}
            y={form.y}
            rotation={form.rotation}
            width={mark}
            height={mark}
            cornerRadius={mark / 2}
            offsetX={form.offsetX - (item.transform.width - mark * 1.5)}
            offsetY={form.offsetY - mark / 2}
            fill={theme.label}
            listening={false}
            perfectDrawEnabled={false}
          />
        ) : null}
        {outline}
      </>
    );
  }

  return (
    <>
      {bitmap && IMAGE_LODS.has(lod) ? (
        <KonvaImage {...shared} image={bitmap} {...toKonvaCrop(item.crop, bitmap)} />
      ) : (
        <KonvaRect
          {...shared}
          fill={theme.item}
          // The item's OWN edge, which is part of the item and fades with it.
          // The selection stroke above is not.
          stroke={theme.itemEdge}
          strokeWidth={1 / zoom}
        />
      )}
      {outline}
    </>
  );
}

/** `1`-`9` are tenths; `0` is full, the value a person most often returns to. */
const DIGITS: Record<string, number> = {
  '0': 1,
  '1': 0.1,
  '2': 0.2,
  '3': 0.3,
  '4': 0.4,
  '5': 0.5,
  '6': 0.6,
  '7': 0.7,
  '8': 0.8,
  '9': 0.9,
};

/** Shift is deliberate: a flip is an act, never a side effect of a stray key. */
const FLIP_KEYS: Record<string, FlipAxis> = { h: 'x', v: 'y' };

/**
 * Whether a keystroke belongs to a text field rather than to the canvas.
 *
 * The canvas has had no text input in it until this milestone, so every binding
 * above was safe by accident. The label field ends that, and the guard belongs
 * at the one place every binding passes through rather than in each of them.
 */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * What a modified wheel adjusts.
 *
 * Ctrl is deliberately absent and cannot be added: every platform that reports a
 * trackpad pinch at all reports it as ctrl+wheel, so binding it here would cost
 * pinch-to-zoom on every laptop. Meta is left alone for the same class of reason
 * — it is the browser's own page zoom.
 *
 * Alt is the "act on the selection" modifier and Shift picks which act, which is
 * why rotate is Alt+Shift rather than a third bare modifier: there is no third
 * bare modifier left that is safe.
 */
type WheelAdjustment = 'opacity' | 'scale' | 'rotate';

function adjustmentFor(event: WheelEvent): WheelAdjustment | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.altKey) return event.shiftKey ? 'rotate' : 'opacity';
  if (event.shiftKey) return 'scale';
  return null;
}

/**
 * How far one notch of the wheel goes. Guesses, named rather than buried, and
 * listed in OPEN_QUESTIONS Q19 with the observation that would settle them.
 *
 * A notch is `deltaY` 100 on the platforms that quantise it at all, which makes
 * these about 10% of a size, a tenth of the opacity range, and 11° of turn.
 * Scale is multiplicative so that scrolling back returns exactly where it
 * started; the other two are additive because their ranges are not ratios.
 */
const WHEEL_SCALE = 0.001;
const WHEEL_OPACITY = 0.001;
const WHEEL_ROTATE = 0.002;

/** The wheel has no release event, so a gesture ends when it goes quiet. */
const ADJUST_SETTLE_MS = 350;

function wheelBodies(
  doc: CanvasDocument,
  ids: readonly ItemId[],
  kind: WheelAdjustment,
  deltaY: number,
): CanvasOperationBody[] {
  // Scrolling UP is the positive direction of all three, which is what every
  // wheel-driven value in every other application does.
  if (kind === 'scale') return scaleSelection(doc, ids, Math.exp(-deltaY * WHEEL_SCALE));
  if (kind === 'rotate') return rotateSelection(doc, ids, deltaY * WHEEL_ROTATE);
  const first = doc.item(ids[0] as ItemId);
  if (!first) return [];
  const next = Math.min(1, Math.max(0, first.appearance.opacity - deltaY * WHEEL_OPACITY));
  return opacityBodies(doc, ids, next);
}

const NUDGES: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

function moveBy(
  doc: CanvasDocument,
  ids: Iterable<ItemId>,
  dx: number,
  dy: number,
): CanvasOperationBody[] {
  const bodies: CanvasOperationBody[] = [];
  for (const id of ids) {
    const item = doc.item(id);
    if (!item) continue;
    const transform: Transform = {
      ...item.transform,
      x: item.transform.x + dx,
      y: item.transform.y + dy,
    };
    bodies.push({ type: 'item.transform', itemId: id, transform });
  }
  return bodies;
}

/**
 * A corner handle on a note or checklist scales its text with its box; a side
 * handle only changes its width, and the text reflows (canvas/text-scaling).
 * The text scale to send with the transform, or nothing.
 */
export function textScaleFor(
  item: CanvasItem | undefined,
  next: Transform,
  anchor: string,
): { textScale: number } | Record<string, never> {
  if (!item || (item.content.kind !== 'note' && item.content.kind !== 'checklist')) return {};
  if (!/^(top|bottom)-(left|right)$/.test(anchor)) return {};
  const factor = next.width / item.transform.width;
  if (!Number.isFinite(factor) || Math.abs(factor - 1) < 1e-6) return {};
  const scaled = textScaleOf(item) * factor;
  return { textScale: Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, scaled)) };
}

/** A node's placement after a Transformer gesture, with Konva's scale baked into the size. */
function nodeTransform(node: Konva.Node): Transform {
  return bakeScale({
    x: node.x(),
    y: node.y(),
    width: node.width(),
    height: node.height(),
    rotation: node.rotation(),
    offsetX: node.offsetX(),
    offsetY: node.offsetY(),
    scaleX: node.scaleX(),
    scaleY: node.scaleY(),
  });
}

/**
 * The whole original behind an item being cropped: what un-cropping would
 * bring back. Faded, outlined in the accent at screen thickness, never
 * hit-testable, and mirrored with the item so it lines up with what shows.
 */
function CropGhost({
  item,
  bitmap,
  zoom,
}: {
  item: CanvasItem;
  bitmap: ImageBitmap | HTMLCanvasElement;
  zoom: number;
}) {
  const theme = canvasTheme();
  const attrs = toKonvaAttrs(originalTransform(cropFrame(item)));
  const { scaleX, scaleY } = toKonvaAppearance(item.appearance);
  return (
    <>
      <KonvaImage
        id={CROP_GHOST}
        {...attrs}
        scaleX={scaleX}
        scaleY={scaleY}
        image={bitmap}
        opacity={CROP_GHOST_OPACITY}
        listening={false}
        perfectDrawEnabled={false}
      />
      <KonvaRect
        id={CROP_GHOST_EDGE}
        {...attrs}
        stroke={theme.accent}
        strokeWidth={1 / zoom}
        dash={[4 / zoom, 3 / zoom]}
        listening={false}
        perfectDrawEnabled={false}
      />
    </>
  );
}

export function selectionMode(event: PointerEvent | MouseEvent): SelectionMode {
  // Ctrl+Alt is the crop modifier, so it must not also be Ctrl's "toggle".
  if (event.ctrlKey && event.altKey) return 'replace';
  if (event.shiftKey) return 'add';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}

/** Dropped files that are text Visarium turns into objects, by name. */
function textFilesOf(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((f) =>
    /\.(md|markdown|txt|mmd|mermaid|puml|plantuml|pu)$/i.test(f.name),
  );
}

/** A dropped file's text as content: its extension decides a diagram, otherwise `classifyText`. */
async function readTextFile(file: File): Promise<CanvasItemContent> {
  const text = await file.text();
  if (/\.(mmd|mermaid)$/i.test(file.name))
    return { kind: 'diagram', lang: 'mermaid', source: text.trim() };
  if (/\.(puml|plantuml|pu)$/i.test(file.name))
    return { kind: 'diagram', lang: 'plantuml', source: text.trim() };
  return classifyText(text);
}

function pointerIn(element: HTMLElement | null, event: PointerEvent) {
  const rect = element?.getBoundingClientRect();
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
}

function lodOf(visible: readonly { item: CanvasItem; lod: string }[], id: ItemId): string {
  return visible.find((v) => v.item.id === id)?.lod ?? ItemLod.FULL;
}
