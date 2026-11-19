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
  /**
   * A kind this client does not know: a newer server's. Kept so the item still
   * occupies its place and can be moved or deleted, never edited or rendered.
   */
  | { readonly kind: 'unknown'; readonly original: string };

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
              at: str(t.at) ?? null,
            },
          ];
        }),
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
   * Collision on: the board pushes this item aside when something overlaps it.
   * Off or absent: it never moves, though others keep clear of it
   * (canvas/collision). A group's setting wins for its members.
   */
  readonly collides?: boolean;
}

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

export type LinkType = 'describes' | 'comments' | 'implements' | 'depends-on';
export const LINK_TYPES: readonly LinkType[] = [
  'describes',
  'comments',
  'implements',
  'depends-on',
];

/** What relates to what. Its own record, not part of either item. */
export interface Link {
  readonly id: LinkId;
  readonly from: Anchor;
  readonly to: Anchor;
  readonly linkType: LinkType;
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
