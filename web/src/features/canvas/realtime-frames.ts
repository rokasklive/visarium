/**
 * Parsing what the socket says, without believing any of it.
 *
 * **This file is Q5's answer.** The choice was hand-written guards or Zod, and
 * it was deliberately left open until there was a real protocol to validate.
 * There is now, and it is a dozen flat messages: Zod's real value is schemas
 * that double as documentation and derive their types, but the types here are
 * already written and hand-maintained on both sides of a language boundary, and
 * `protocol.ts` is already the documentation. That left ~14 kB gzipped buying
 * line count, which invariant 12 does not permit.
 *
 * Everything is checked: no field is assumed to exist, no number is assumed to
 * be finite, no array is assumed to be bounded. A frame that does not parse
 * returns `null` and is counted — the session is NOT closed, because a malformed
 * frame from our own server is a bug, and killing the connection would hide it
 * behind a reconnect that looks like a network blip.
 */

import {
  LINK_TYPES,
  type LinkType,
  MAX_FRAME_ITEMS,
  PRESENCE_COLOUR_SLOTS,
  type PresenceActor,
  type PreviewItem,
  type ServerMessage,
  TASK_STATES,
  type TaskState,
  type Transform,
} from '@visarium/canvas-core';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Finite, not merely `typeof 'number'` — `NaN` and `Infinity` are both numbers. */
const num = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const str = (value: unknown): value is string => typeof value === 'string';

const int = (value: unknown): value is number => num(value) && Number.isInteger(value);

/** A bounded array of ids. The bound is the point: this is untrusted input. */
function ids(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FRAME_ITEMS) return null;
  return value.every(str) ? (value as string[]) : null;
}

/**
 * Opacity is BOUNDED here, not merely checked for finiteness.
 *
 * Every other numeric field on the wire is checked for finiteness because the
 * thing downstream is the spatial index and a `NaN` corrupts it. Opacity has a
 * range and the schema has a `CHECK` for it, so the boundary that exists to keep
 * untrusted input out of domain code enforces the range rather than leaving the
 * database to be the first thing that notices.
 */
function appearance(value: unknown): boolean {
  if (!isObject(value)) return false;
  const { opacity, flipX, flipY } = value;
  if (!num(opacity) || opacity < 0 || opacity > 1) return false;
  return typeof flipX === 'boolean' && typeof flipY === 'boolean';
}

/**
 * An optional crop: absent is "unchanged" or "whole image", present must be a
 * non-empty window inside the original. The server already refused anything
 * else; this is the same line drawn again where a frame enters the document.
 */
function optionalCrop(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  const { x, y, width, height } = value;
  if (!num(x) || !num(y) || !num(width) || !num(height)) return false;
  const TOLERANCE = 1e-9;
  return (
    x >= 0 &&
    y >= 0 &&
    width > 0 &&
    height > 0 &&
    x + width <= 1 + TOLERANCE &&
    y + height <= 1 + TOLERANCE
  );
}

function transform(value: unknown): Transform | null {
  if (!isObject(value)) return null;
  const { x, y, width, height, rotation } = value;
  if (!num(x) || !num(y) || !num(width) || !num(height) || !num(rotation)) return null;
  return { x, y, width, height, rotation };
}

function previewItems(value: unknown): readonly PreviewItem[] | null {
  if (!Array.isArray(value) || value.length > MAX_FRAME_ITEMS) return null;
  const items: PreviewItem[] = [];
  for (const entry of value) {
    if (!isObject(entry) || !str(entry.itemId)) return null;
    const t = transform(entry.transform);
    if (!t) return null;
    items.push({ itemId: entry.itemId as PreviewItem['itemId'], transform: t });
  }
  return items;
}

function actor(value: unknown): PresenceActor | null {
  if (!isObject(value)) return null;
  const { actorId, displayName, colourIndex, kind, person } = value;
  if (!str(actorId) || !str(displayName) || !int(colourIndex)) return null;
  // Out-of-range would index past the token list and paint nothing.
  if (colourIndex < 0 || colourIndex >= PRESENCE_COLOUR_SLOTS) return null;
  // An agent says so, and whom it acts for; anything else there is ignored.
  return {
    actorId,
    displayName,
    colourIndex,
    ...(kind === 'agent' ? { kind } : {}),
    ...(kind === 'agent' && str(person) ? { person } : {}),
  } as PresenceActor;
}

function actors(value: unknown): readonly PresenceActor[] | null {
  if (!Array.isArray(value) || value.length > MAX_FRAME_ITEMS) return null;
  const parsed: PresenceActor[] = [];
  for (const entry of value) {
    const one = actor(entry);
    if (!one) return null;
    parsed.push(one);
  }
  return parsed;
}

/**
 * Operation bodies are checked for shape, not re-derived.
 *
 * Every variant is verified to the depth that matters — a discriminator we know,
 * an item id, and every numeric field finite — because these go straight into
 * `CanvasDocument.apply` and from there into the spatial index. A NaN transform
 * here is a corrupted index, and the index is not something a reload fixes for
 * everyone else.
 */
function operation(value: unknown): unknown | null {
  if (!isObject(value) || !str(value.type)) return null;

  switch (value.type) {
    case 'item.create': {
      if (!str(value.itemId) || !num(value.z) || !transform(value.transform)) return null;
      if (!content(value.content)) return null;
      if (value.groupId !== undefined && !str(value.groupId)) return null;
      // Optional, so an older client's creation is still a frame we accept.
      if (value.appearance !== undefined && !appearance(value.appearance)) return null;
      return optionalCrop(value.crop) ? value : null;
    }
    case 'item.delete':
      return str(value.itemId) ? value : null;
    case 'item.transform':
      return str(value.itemId) && transform(value.transform) && optionalCrop(value.crop)
        ? value
        : null;
    case 'item.content':
      return str(value.itemId) && content(value.content) ? value : null;
    case 'item.z':
      return str(value.itemId) && num(value.z) ? value : null;
    case 'item.appearance':
      return str(value.itemId) && appearance(value.appearance) ? value : null;
    case 'group.create':
      return str(value.groupId) &&
        ids(value.memberIds) &&
        (value.label === undefined || str(value.label)) &&
        (value.frame === undefined || typeof value.frame === 'boolean')
        ? value
        : null;
    case 'group.delete':
      return str(value.groupId) ? value : null;
    case 'group.members':
      return str(value.groupId) && ids(value.memberIds) ? value : null;
    case 'group.label':
      return str(value.groupId) && str(value.label) ? value : null;
    case 'group.frame':
      return str(value.groupId) && typeof value.frame === 'boolean' ? value : null;
    // Board objects and links: as small as what they change, and stamped by the
    // server (`by`, `at`), which is why those two may be absent or null.
    case 'item.source':
      return str(value.itemId) &&
        typeof value.source === 'string' &&
        (value.baseRevision === undefined || int(value.baseRevision))
        ? value
        : null;
    case 'checklist.title':
      return str(value.itemId) && typeof value.title === 'string' ? value : null;
    case 'task.add':
      return str(value.itemId) &&
        task(value.task) &&
        (value.index === undefined || (int(value.index) && value.index >= 0))
        ? value
        : null;
    case 'task.set':
      return str(value.itemId) &&
        str(value.taskId) &&
        (value.text === undefined || typeof value.text === 'string') &&
        (value.state === undefined || TASK_STATES.includes(value.state as TaskState)) &&
        stamp(value)
        ? value
        : null;
    case 'task.remove':
      return str(value.itemId) && str(value.taskId) ? value : null;
    case 'link.add':
      return str(value.linkId) &&
        anchor(value.from) &&
        anchor(value.to) &&
        LINK_TYPES.includes(value.linkType as LinkType) &&
        stamp(value)
        ? value
        : null;
    case 'link.set':
      return str(value.linkId) && LINK_TYPES.includes(value.linkType as LinkType) ? value : null;
    case 'link.delete':
      return str(value.linkId) ? value : null;
    default:
      return null;
  }
}

const optionalString = (v: unknown) => v === undefined || v === null || typeof v === 'string';

/** `by` and `at`: the server's stamp, absent on what a client has not had stamped yet. */
function stamp(value: Record<string, unknown>): boolean {
  return optionalString(value.by) && optionalString(value.at);
}

function task(value: unknown): boolean {
  return (
    isObject(value) &&
    str(value.id) &&
    typeof value.text === 'string' &&
    TASK_STATES.includes(value.state as TaskState) &&
    stamp(value)
  );
}

function anchor(value: unknown): boolean {
  return isObject(value) && str(value.itemId) && optionalString(value.element);
}

function content(value: unknown): boolean {
  if (!isObject(value) || !str(value.kind)) return false;
  switch (value.kind) {
    case 'placeholder':
      return num(value.intrinsicWidth) && num(value.intrinsicHeight);
    case 'note':
      return typeof value.source === 'string';
    case 'diagram':
      return (
        (value.lang === 'mermaid' || value.lang === 'plantuml') && typeof value.source === 'string'
      );
    case 'checklist':
      return (
        typeof value.title === 'string' &&
        Array.isArray(value.tasks) &&
        value.tasks.length <= MAX_FRAME_ITEMS &&
        value.tasks.every(task)
      );
    case 'image': {
      if (!isObject(value.asset)) return false;
      const { assetId, intrinsicWidth, intrinsicHeight } = value.asset;
      return str(assetId) && num(intrinsicWidth) && num(intrinsicHeight);
    }
    default:
      return false;
  }
}

function operations(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || value.length > MAX_FRAME_ITEMS) return null;
  const parsed: unknown[] = [];
  for (const entry of value) {
    const one = operation(entry);
    if (!one) return null;
    parsed.push(one);
  }
  return parsed;
}

/**
 * The one way in.
 *
 * @returns the frame, or `null` if anything about it was wrong. There is no
 *   partial success: a frame is either entirely trustworthy or it is dropped.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || !str(value.t)) return null;

  switch (value.t) {
    case 'welcome': {
      const list = actors(value.actors);
      if (!str(value.actorId) || !int(value.revision) || !list) return null;
      return {
        t: 'welcome',
        actorId: value.actorId,
        revision: value.revision,
        actors: list,
      } as ServerMessage;
    }
    case 'presence': {
      const joined = value.joined === undefined ? undefined : actors(value.joined);
      const left = value.left === undefined ? undefined : ids(value.left);
      if (value.joined !== undefined && !joined) return null;
      if (value.left !== undefined && !left) return null;
      return {
        t: 'presence',
        ...(joined ? { joined } : {}),
        ...(left ? { left } : {}),
      } as ServerMessage;
    }
    case 'cursor':
      if (!str(value.actorId) || !num(value.x) || !num(value.y)) return null;
      return { t: 'cursor', actorId: value.actorId, x: value.x, y: value.y } as ServerMessage;
    case 'selection': {
      const itemIds = ids(value.itemIds);
      if (!str(value.actorId) || !itemIds) return null;
      return { t: 'selection', actorId: value.actorId, itemIds } as ServerMessage;
    }
    case 'transform.preview': {
      const items = previewItems(value.items);
      if (!str(value.actorId) || !items) return null;
      return { t: 'transform.preview', actorId: value.actorId, items } as ServerMessage;
    }
    case 'op': {
      const ops = operations(value.operations);
      if (!int(value.fromRevision) || !int(value.toRevision) || !ops) return null;
      // A range that runs backwards is not a frame we produced.
      if (value.toRevision < value.fromRevision) return null;
      return {
        t: 'op',
        fromRevision: value.fromRevision,
        toRevision: value.toRevision,
        operations: ops,
      } as ServerMessage;
    }
    case 'lock': {
      const itemIds = ids(value.itemIds);
      if (!itemIds || !num(value.expiresAt)) return null;
      if (value.heldBy !== null && !str(value.heldBy)) return null;
      return {
        t: 'lock',
        itemIds,
        heldBy: value.heldBy,
        expiresAt: value.expiresAt,
      } as ServerMessage;
    }
    case 'resync':
      return int(value.revision)
        ? ({ t: 'resync', revision: value.revision } as ServerMessage)
        : null;
    case 'viewers':
      return int(value.count) && value.count >= 0
        ? ({ t: 'viewers', count: value.count } as ServerMessage)
        : null;
    case 'focus':
      return str(value.actorId) &&
        str(value.itemId) &&
        (value.verb === 'reading' || value.verb === 'editing')
        ? ({
            t: 'focus',
            actorId: value.actorId,
            itemId: value.itemId,
            verb: value.verb,
          } as ServerMessage)
        : null;
    case 'board':
      return str(value.title) && str(value.by)
        ? ({ t: 'board', title: value.title, by: value.by } as ServerMessage)
        : null;
    case 'board-deleted':
      return str(value.by) ? ({ t: 'board-deleted', by: value.by } as ServerMessage) : null;
    default:
      // An older client meeting a newer server. Dropping is the compatible half
      // of the evolution rule, and it is not an error.
      return null;
  }
}
