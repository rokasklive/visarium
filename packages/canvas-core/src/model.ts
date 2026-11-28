/**
 * The logical contents of a canvas.
 *
 * A {@link CanvasItem} is the placement of something on a board. An
 * {@link AssetRef} is the identity of the underlying stored file. They are
 * deliberately separate: one asset may appear on many boards, many times, or
 * nowhere, and its file is never duplicated to make that work.
 */

import type { Transform } from './geometry';
import type { AssetId, GroupId, ItemId, LinkId } from './ids';

/**
 * A reference to a stored asset.
 *
 * `intrinsicWidth`/`intrinsicHeight` are the ORIGINAL pixel dimensions. They let
 * the canvas lay out and size an item before a single byte of image data has
 * been decoded, which is what makes a dropped image appear instantly.
 *
 * Note what is absent: no path, no URL, no storage key. See invariant 3.
 */
export interface AssetRef {
  readonly assetId: AssetId;
  readonly intrinsicWidth: number;
  readonly intrinsicHeight: number;
  /** The original's type, when known. `image/gif` is what animates. */
  readonly mimeType?: string | undefined;
}

export type TaskState = 'todo' | 'doing' | 'done' | 'blocked';
export const TASK_STATES: readonly TaskState[] = ['todo', 'doing', 'done', 'blocked'];

/**
 * One task of a checklist. `id` is unique within its checklist and never
 * changes, so a person and an agent can each change a different task without
 * either overwriting the other. `by`/`at` are the server's stamp of who last
 * changed it; a client never writes them.
 */
export interface Task {
  readonly id: string;
  readonly text: string;
  readonly state: TaskState;
  readonly by?: string | null;
  /** The agent that acted for `by`, when one did (ADR-0031). Stamped by the server. */
  readonly byAgent?: string | null;
  /** The app whose run made the last change (canvas/apps), when one did. */
  readonly byApp?: string | null;
  readonly at?: string | null;
}

export type DiagramLang = 'mermaid' | 'plantuml';

/**
 * What an item shows. Notes and diagrams store their source and nothing
 * rendered: the picture is derived wherever it is drawn.
 */
export type CanvasItemContent =
  | { readonly kind: 'image'; readonly asset: AssetRef }
  /** A local, not-yet-uploaded drop. Carries no asset id until the upload resolves. */
  | {
      readonly kind: 'placeholder';
      readonly intrinsicWidth: number;
      readonly intrinsicHeight: number;
      /** Object URL or data URL for optimistic display. Never persisted. */
      readonly previewUrl?: string;
    }
  /** Markdown. Plain text is Markdown with no syntax, so there is no text kind. */
  | { readonly kind: 'note'; readonly source: string }
  | { readonly kind: 'diagram'; readonly lang: DiagramLang; readonly source: string }
  | { readonly kind: 'checklist'; readonly title: string; readonly tasks: readonly Task[] }
  /** An interactive HTML view run in a sandbox (canvas/apps, ADR-0034). */
  | {
      readonly kind: 'app';
      readonly title: string;
      readonly html: string;
      /** Named values the app reads with no link (canvas/app-inspector). */
      readonly literals?: Readonly<Record<string, unknown>>;
      /** Absent is `auto`: the app reruns when its inputs change. */
      readonly run?: AppRunMode;
      /**
       * Count changes to the source, and to how its inputs are set up (literals,
       * a `feeds` link's view, field or name). An output stamps both as `#source`
       * and `#setup`, so changing either makes the app stale. Kept by the
       * server; absent is 0.
       */
      readonly sourceRev?: number;
      readonly setupRev?: number;
      /** The latest run's result; absent until the app has run. */
      readonly output?: AppOutput;
      /**
       * Where its view comes from instead of `html`: an MCP server's `ui://`
       * resource, pinned by hash, and the tool that runs it on the server
       * when there is one (canvas/app-sources).
       */
      readonly mcp?: AppMcpSource;
    }
  /**
   * A kind this client does not know: a newer server's. Kept so the item still
   * occupies its place and can be moved or deleted, never edited or rendered.
   */
  | { readonly kind: 'unknown'; readonly original: string };

export type AppRunMode = 'auto' | 'manual';

export interface AppMcpSource {
  readonly connection: string;
  readonly resourceUri: string;
  readonly tool?: string;
  readonly sha256: string;
}

function mcpFrom(v: unknown): AppMcpSource | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.connection !== 'string' || typeof m.resourceUri !== 'string') return undefined;
  if (typeof m.sha256 !== 'string') return undefined;
  return {
    connection: m.connection,
    resourceUri: m.resourceUri,
    sha256: m.sha256,
    ...(typeof m.tool === 'string' ? { tool: m.tool } : {}),
  };
}

/**
 * One run of an app, as the server stored it (canvas/apps): named values, the
 * content revision of every input it read, and who ran it.
 */
export interface AppOutput {
  readonly version: number;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly text?: string | null;
  /**
   * Input item id → its content revision when this run committed, plus the
   * app's own `#source` and `#setup` counters.
   */
  readonly inputRevs: Readonly<Record<string, number>>;
  readonly status: 'ok' | 'error';
  readonly error?: string | null;
  readonly by?: string | null;
  readonly byAgent?: string | null;
  readonly at?: string | null;
  /** A snapshot of the view as it drew this version: no scripts, nothing from outside. */
  readonly card?: string | null;
}

/** A stored output from the wire, or undefined when it is not one. */
export function outputFrom(raw: unknown): AppOutput | undefined {
  const o = (raw ?? null) as Record<string, unknown> | null;
  if (!o || typeof o.version !== 'number' || typeof o.outputs !== 'object' || !o.outputs)
    return undefined;
  const revs: Record<string, number> = {};
  for (const [k, v] of Object.entries((o.inputRevs ?? {}) as Record<string, unknown>))
    if (typeof v === 'number') revs[k] = v;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    version: o.version,
    outputs: o.outputs as Record<string, unknown>,
    text: str(o.text),
    inputRevs: revs,
    status: o.status === 'error' ? 'error' : 'ok',
    error: str(o.error),
    by: str(o.by),
    byAgent: str(o.byAgent),
    at: str(o.at),
    ...(typeof o.card === 'string' ? { card: o.card } : {}),
  };
}

/** Content whose source text the person or an agent edits. */
export function hasSource(
  content: CanvasItemContent,
): content is Extract<CanvasItemContent, { kind: 'note' | 'diagram' }> {
  return content.kind === 'note' || content.kind === 'diagram';
}

/**
 * Wire content (a snapshot row or a remote operation) to a model value.
 *
 * Anything this client cannot model becomes `unknown` rather than being
 * dropped or guessed at, so an older client on a newer server still shows the
 * board's shape. Returns `undefined` only for content that cannot be an item at
 * all (an image with no asset id: the contract broke).
 */
export function contentFrom(raw: unknown): CanvasItemContent | undefined {
  const c = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const kind = str(c.kind) ?? 'image';
  switch (kind) {
    case 'image': {
      const a = (c.asset ?? {}) as Record<string, unknown>;
      const assetId = str(a.assetId);
      if (!assetId) return undefined;
      return {
        kind: 'image',
        asset: {
          assetId: assetId as AssetId,
          intrinsicWidth: Number(a.intrinsicWidth) || 0,
          intrinsicHeight: Number(a.intrinsicHeight) || 0,
          ...(str(a.mimeType) ? { mimeType: str(a.mimeType) } : {}),
        },
      };
    }
    case 'note':
      return { kind: 'note', source: str(c.source) ?? '' };
    case 'diagram': {
      const lang = str(c.lang);
      if (lang !== 'mermaid' && lang !== 'plantuml')
        return { kind: 'unknown', original: `diagram:${lang}` };
      return { kind: 'diagram', lang, source: str(c.source) ?? '' };
    }
    case 'checklist': {
      const tasks = Array.isArray(c.tasks) ? c.tasks : [];
      return {
        kind: 'checklist',
        title: str(c.title) ?? '',
        tasks: tasks.flatMap((t: Record<string, unknown>) => {
          const id = str(t?.id);
          if (!id) return [];
          const state = TASK_STATES.includes(t.state as TaskState)
            ? (t.state as TaskState)
            : 'todo';
          return [
            {
              id,
              text: str(t.text) ?? '',
              state,
              by: str(t.by) ?? null,
              ...(typeof t.byAgent === 'string' ? { byAgent: t.byAgent } : {}),
              ...(typeof t.byApp === 'string' ? { byApp: t.byApp } : {}),
              at: str(t.at) ?? null,
            },
          ];
        }),
      };
    }
    case 'app': {
      const output = outputFrom(c.output);
      const literals =
        c.literals && typeof c.literals === 'object' && !Array.isArray(c.literals)
          ? (c.literals as Record<string, unknown>)
          : undefined;
      const count = (v: unknown) => (typeof v === 'number' ? v : undefined);
      const sourceRev = count(c.sourceRev);
      const setupRev = count(c.setupRev);
      const mcp = mcpFrom(c.mcp);
      return {
        kind: 'app',
        title: str(c.title) ?? '',
        html: str(c.html) ?? '',
        ...(literals && Object.keys(literals).length ? { literals } : {}),
        ...(c.run === 'manual' ? { run: 'manual' as const } : {}),
        ...(sourceRev ? { sourceRev } : {}),
        ...(setupRev ? { setupRev } : {}),
        ...(output ? { output } : {}),
        ...(mcp ? { mcp } : {}),
      };
    }
    default:
      return { kind: 'unknown', original: kind };
  }
}

/**
 * What an item looks like, as opposed to where it is or what it shows.
 *
 * Opacity and flip are one value because they share the fact that decides how
 * every layer treats them: neither changes an item's bounds, so neither touches
 * the spatial index. A flip is a boolean here and NEVER a negative width — the
 * schema's `CHECK (width > 0)`, `transformBounds` and every size comparison in
 * the codebase all assume a positive size, and Konva's negative scale is a
 * rendering trick that stays on the renderer's side of the boundary.
 */
export interface Appearance {
  /** 0 … 1. Bounded at every boundary, including the schema. */
  readonly opacity: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

/**
 * The one default.
 *
 * `appearance` is required on {@link CanvasItem} rather than optional precisely
 * so this constant is the only place the default is written. An optional field
 * would mean a `?? 1` at every read, and every one of those is a place the
 * default can drift.
 */
export const DEFAULT_APPEARANCE: Appearance = { opacity: 1, flipX: false, flipY: false };

/**
 * The part of the original an item shows, as fractions of the original's width
 * and height, in source orientation (before any flip). ADR-0029.
 *
 * The transform stays the VISIBLE box, so nothing that only needs bounds ever
 * learns about crop; the image's scale is derived, never stored.
 */
export interface Crop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The one default, for the same reason as {@link DEFAULT_APPEARANCE}. */
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1 };

export function isFullCrop(crop: Crop): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

export interface CanvasItem {
  readonly id: ItemId;
  readonly transform: Transform;
  /** Sparse ordering key. Items are drawn low-to-high. */
  readonly z: number;
  readonly groupId?: GroupId;
  readonly content: CanvasItemContent;
  readonly appearance: Appearance;
  readonly crop: Crop;
  /**
   * The item's own server revision, mirrored locally: every operation the
   * server counts against the item (transform, z, appearance, content, source,
   * checklist changes) adds one here too. `item.source` sends it as
   * `baseRevision` so a stale edit is refused, never silently applied.
   * Absent until a snapshot says otherwise; an edit without one is unchecked.
   */
  readonly revision?: number;
  /**
   * Counts changes to what the item shows (source, tasks, asset, an app's
   * outputs), never where it is: an app's outputs are stamped with their inputs'
   * content revisions, so moving a note does not make its apps stale
   * (canvas/apps). Mirrors the server; absent until a snapshot says otherwise.
   */
  readonly contentRev?: number;
  /**
   * Collision on: the board pushes this item aside when something overlaps it.
   * Off or absent: it never moves, though others keep clear of it
   * (canvas/collision). A group's setting wins for its members.
   */
  readonly collides?: boolean;
  /**
   * A note's or checklist's text scale (canvas/text-scaling): its content is
   * laid out at `width / textScale` and drawn `textScale` times larger, so a
   * corner resize scales the text while a side resize reflows it. Absent is 1.
   */
  readonly textScale?: number;
}

/** The bounds every boundary holds a text scale to, the schema's included. */
export const TEXT_SCALE_MIN = 0.25;
export const TEXT_SCALE_MAX = 8;

/** An item's text scale, 1 when it has none; clamped like at every boundary. */
export function textScaleOf(item: CanvasItem): number {
  const s = item.textScale ?? 1;
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, s));
}

/**
 * The board's centerpiece (canvas/centerpiece): the item or group framed when
 * the board opens, as the server stores it.
 */
export type Centerpiece = `item:${string}` | `group:${string}`;

/**
 * One end of a link: a whole item, or one named element inside a diagram
 * (a Mermaid node id, a PlantUML participant or class). The element is a name
 * from the source, never a position, so a renamed element breaks its links
 * visibly rather than re-pointing them.
 */
export interface Anchor {
  readonly itemId: ItemId;
  readonly element?: string | null;
}

/** What relates to what. Grants nothing. */
export type SemanticLinkType = 'describes' | 'comments' | 'implements' | 'depends-on';
/**
 * A connection that grants an app access (canvas/links): `feeds` lets the app
 * read one view of its source, `updates` lets it propose changes to a checklist.
 */
export type DataLinkType = 'feeds' | 'updates';
export type LinkType = SemanticLinkType | DataLinkType;
export const SEMANTIC_LINK_TYPES: readonly SemanticLinkType[] = [
  'describes',
  'comments',
  'implements',
  'depends-on',
];
export const LINK_TYPES: readonly LinkType[] = [...SEMANTIC_LINK_TYPES, 'feeds', 'updates'];

export function isDataLink(type: LinkType): type is DataLinkType {
  return type === 'feeds' || type === 'updates';
}

/** What relates to what. Its own record, not part of either item. */
export interface Link {
  readonly id: LinkId;
  readonly from: Anchor;
  readonly to: Anchor;
  readonly linkType: LinkType;
  /** A `feeds` link's view of its source (canvas/item-views); absent otherwise. */
  readonly view?: string | null;
  /** A `feeds` link's field within its view (`age`, `rows.0.total`); absent is the whole view. */
  readonly path?: string | null;
  /** The input name the app sees; absent is `<source ref>.<view>`. */
  readonly name?: string | null;
  readonly by?: string | null;
  /** The agent that acted for `by`, when one did (ADR-0031). Stamped by the server. */
  readonly byAgent?: string | null;
  readonly at?: string | null;
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  return a.itemId === b.itemId && (a.element ?? null) === (b.element ?? null);
}

export interface CanvasGroup {
  readonly id: GroupId;
  readonly label?: string;
  /**
   * Whether the renderer draws the derived annotation outline around the
   * members. Presentation state, not identity: absent means unframed, which
   * keeps every group written before the flag existed exactly as it was. The
   * contour itself is never stored — it is recomputed from member bounds.
   */
  readonly frame?: boolean;
  /** Collision for the group as one body; see {@link CanvasItem.collides}. */
  readonly collides?: boolean;
  /** Groups do not nest in v1. See OPEN_QUESTIONS. */
  readonly memberIds: readonly ItemId[];
}

/**
 * The size at which an item's content is shown one-to-one. For an image that is
 * the original's pixels; text and diagrams are laid out at their box, so their
 * box IS their intrinsic size.
 */
export function itemIntrinsicSize(item: CanvasItem): { width: number; height: number } {
  switch (item.content.kind) {
    case 'image':
      return {
        width: item.content.asset.intrinsicWidth,
        height: item.content.asset.intrinsicHeight,
      };
    case 'placeholder':
      return { width: item.content.intrinsicWidth, height: item.content.intrinsicHeight };
    default:
      return { width: item.transform.width, height: item.transform.height };
  }
}
