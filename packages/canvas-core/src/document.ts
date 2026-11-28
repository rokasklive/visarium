/**
 * The loaded canvas.
 *
 * `CanvasDocument` owns the authoritative in-memory model of one board: its
 * items, its groups, its spatial index and the revision it has caught up to.
 * It is a plain mutable object, not React state — see STATE_OWNERSHIP in
 * docs/architecture/CANVAS_CORE.md. A board of 100k items lives here and nowhere
 * else; React only ever learns about the small subset currently on screen.
 *
 * The only way in is {@link applyOperation}.
 */

import { type Rect, transformBounds, unionRects } from './geometry';
import type { CanvasId, GroupId, ItemId, LinkId } from './ids';
import {
  type Anchor,
  type AppOutput,
  type CanvasGroup,
  type CanvasItem,
  type Centerpiece,
  DEFAULT_APPEARANCE,
  FULL_CROP,
  hasSource,
  isDataLink,
  isFullCrop,
  type Link,
  sameAnchor,
  type Task,
} from './model';
import type { AppOutputRecord, CanvasOperationBody } from './operations';
import { SpatialIndex } from './spatial-index';

/**
 * Where an operation came from.
 *
 * `remote` means it arrived already committed from another client, so it must
 * not be sent back to the server and must not enter this client's undo history:
 * undo is for what you did, not for what you watched someone else do.
 */
export type OperationOrigin = 'local' | 'remote';

export class CanvasDocument {
  readonly canvasId: CanvasId;
  readonly index = new SpatialIndex();

  #items = new Map<ItemId, CanvasItem>();
  #groups = new Map<GroupId, CanvasGroup>();
  #centerpiece: Centerpiece | null = null;
  #links = new Map<LinkId, Link>();
  #revision = 0;
  #applied: ((body: CanvasOperationBody, origin: OperationOrigin) => void) | undefined;

  constructor(canvasId: CanvasId) {
    this.canvasId = canvasId;
  }

  /** Last server revision this document reflects. */
  get revision(): number {
    return this.#revision;
  }

  get itemCount(): number {
    return this.#items.size;
  }

  get groupCount(): number {
    return this.#groups.size;
  }

  items(): IterableIterator<CanvasItem> {
    return this.#items.values();
  }

  item(id: ItemId): CanvasItem | undefined {
    return this.#items.get(id);
  }

  group(id: GroupId): CanvasGroup | undefined {
    return this.#groups.get(id);
  }

  groups(): IterableIterator<CanvasGroup> {
    return this.#groups.values();
  }

  links(): IterableIterator<Link> {
    return this.#links.values();
  }

  link(id: LinkId): Link | undefined {
    return this.#links.get(id);
  }

  /** Every link with this item at either end. A board has tens of links, not thousands. */
  linksOf(itemId: ItemId): Link[] {
    return [...this.#links.values()].filter(
      (l) => l.from.itemId === itemId || l.to.itemId === itemId,
    );
  }

  /**
   * Replace the whole document from a server snapshot.
   *
   * This is the reconnect path: cheaper and far less error-prone than replaying
   * a long operation log, and correct by construction. See ADR-0011.
   */
  loadSnapshot(
    items: readonly CanvasItem[],
    groups: readonly CanvasGroup[],
    revision: number,
    links: readonly Link[] = [],
    centerpiece: Centerpiece | null = null,
  ): void {
    this.#centerpiece = centerpiece;
    this.#items = new Map(items.map((i) => [i.id, i]));
    this.#groups = new Map(groups.map((g) => [g.id, g]));
    this.#links = new Map(links.map((l) => [l.id, l]));
    this.index.clear();
    this.index.load(items.map((i) => [i.id, transformBounds(i.transform)] as const));
    this.#revision = revision;
  }

  /**
   * The centerpiece, when it still names something on the board: a deleted
   * target is no centerpiece (the server clears it too).
   */
  get centerpiece(): Centerpiece | null {
    const c = this.#centerpiece;
    if (!c) return null;
    const [kind, id] = c.split(':') as ['item' | 'group', string];
    const there = kind === 'item' ? this.#items.has(id as ItemId) : this.#groups.has(id as GroupId);
    return there ? c : null;
  }

  /** The centerpiece's bounds, or `undefined` when there is none. */
  centerpieceBounds(): Rect | undefined {
    const c = this.centerpiece;
    if (!c) return undefined;
    const [kind, id] = c.split(':') as ['item' | 'group', string];
    return kind === 'item' ? this.index.boundsOf(id as ItemId) : this.groupBounds(id as GroupId);
  }

  /** Bounds of a group, or `undefined` if it is empty or unknown. */
  groupBounds(groupId: GroupId): Rect | undefined {
    const group = this.#groups.get(groupId);
    if (!group) return undefined;
    const rects: Rect[] = [];
    for (const id of group.memberIds) {
      const bounds = this.index.boundsOf(id);
      if (bounds) rects.push(bounds);
    }
    return unionRects(rects);
  }

  setRevision(revision: number): void {
    this.#revision = revision;
  }

  /**
   * Observe every operation that actually changed this document.
   *
   * This exists so persistence has ONE place to watch. Invariant 9 already
   * promises that every durable change arrives through `apply` — local edits,
   * undo, redo, and an upload resolving a placeholder all do — so a listener
   * here cannot be bypassed by a caller who forgot, which a `sync.send()` beside
   * each call site can.
   *
   * Set it AFTER the document is populated, never before: `buildBoard` fills a
   * benchmark board by applying up to 100,000 `item.create` operations, and a
   * listener attached first would hear every one of them.
   *
   * No-ops are not reported. The listener fires only when `apply` returns an
   * inverse, which is exactly when something changed.
   *
   * The origin says where the operation came from. Persistence uses it to ignore
   * what it must not echo: an operation that arrived from another client is
   * already durable, and sending it back would be this client claiming someone
   * else's edit as its own.
   */
  onApplied(
    listener: ((body: CanvasOperationBody, origin: OperationOrigin) => void) | undefined,
  ): void {
    this.#applied = listener;
  }

  // --- mutation -----------------------------------------------------------

  #put(item: CanvasItem): void {
    this.#items.set(item.id, item);
    this.index.update(item.id, transformBounds(item.transform));
  }

  #drop(id: ItemId): void {
    this.#items.delete(id);
    this.index.remove(id);
  }

  /** Mirrors the server's per-item revision bump. Unknown stays unknown. */
  #bumped(item: CanvasItem, change: Partial<CanvasItem>): CanvasItem {
    return {
      ...item,
      ...change,
      ...(item.revision !== undefined ? { revision: item.revision + 1 } : {}),
    };
  }

  /** What the item shows changed: its revision and its content revision bump. */
  #contentChanged(item: CanvasItem, content: CanvasItem['content']): CanvasItem {
    return {
      ...this.#bumped(item, { content }),
      ...(item.contentRev !== undefined ? { contentRev: item.contentRev + 1 } : {}),
    };
  }

  /** A checklist's tasks replaced; the item's revision bumps once. */
  #setTasks(item: CanvasItem, tasks: readonly Task[]): void {
    if (item.content.kind !== 'checklist') return;
    this.#items.set(item.id, this.#contentChanged(item, { ...item.content, tasks }));
  }

  /**
   * An app's next output, as the server stores it (canvas/apps): its version
   * after the last, its inputs stamped with their content revisions now, and
   * the app's own content revision bumped only when the values changed. A
   * record from the server is taken as it is.
   */
  #output(
    app: CanvasItem,
    next: Omit<AppOutput, 'version' | 'inputRevs'>,
    inputRevs?: AppOutput['inputRevs'],
    record?: AppOutputRecord,
  ): AppOutput | undefined {
    if (app.content.kind !== 'app') return undefined;
    const last = app.content.output;
    let output: AppOutput;
    let contentRev = app.contentRev;
    if (record) {
      const { contentRev: rev, ...stored } = record;
      output = stored;
      contentRev = rev;
    } else {
      output = {
        ...next,
        version: (last?.version ?? 0) + 1,
        inputRevs: inputRevs ?? this.#inputRevs(app.id),
      };
      const changed =
        !last ||
        JSON.stringify(last.outputs) !== JSON.stringify(output.outputs) ||
        (last.text ?? null) !== (output.text ?? null);
      if (changed && contentRev !== undefined) contentRev += 1;
    }
    this.#items.set(app.id, {
      ...this.#bumped(app, { content: { ...app.content, output } }),
      ...(contentRev !== undefined ? { contentRev } : {}),
    });
    return last;
  }

  /** Every item feeding an app, with its content revision now, and the app's own counters. */
  #inputRevs(app: ItemId): Record<string, number> {
    const revs: Record<string, number> = {};
    for (const l of this.#links.values())
      if (l.linkType === 'feeds' && l.to.itemId === app)
        revs[l.from.itemId] = this.#items.get(l.from.itemId)?.contentRev ?? 0;
    const c = this.#items.get(app)?.content;
    if (c?.kind === 'app') {
      revs['#source'] = c.sourceRev ?? 0;
      revs['#setup'] = c.setupRev ?? 0;
    }
    return revs;
  }

  /** A change to how an app's inputs are set up: its `#setup` counter moves. */
  #setupChanged(app: ItemId): void {
    const item = this.#items.get(app);
    if (item?.content.kind !== 'app') return;
    this.#items.set(
      app,
      this.#bumped(item, {
        content: { ...item.content, setupRev: (item.content.setupRev ?? 0) + 1 },
      }),
    );
  }

  #checklist(id: ItemId) {
    const item = this.#items.get(id);
    return item?.content.kind === 'checklist' ? { item, list: item.content } : undefined;
  }

  #anchorExists(a: Anchor): boolean {
    return this.#items.has(a.itemId);
  }

  /**
   * Apply one operation.
   *
   * Returns the operation that would undo it, or `undefined` when the operation
   * was a no-op (unknown target, already-applied delete). An unknown target is
   * not an error: with optimistic local application and out-of-order delivery it
   * is a normal, benign race.
   *
   * Remote operations take this same path — invariant 9 has no exception for the
   * network — and differ only in the origin they carry.
   */
  apply(
    body: CanvasOperationBody,
    origin: OperationOrigin = 'local',
  ): CanvasOperationBody | undefined {
    const inverse = this.#applyBody(body);
    if (inverse) this.#applied?.(body, origin);
    return inverse;
  }

  #applyBody(body: CanvasOperationBody): CanvasOperationBody | undefined {
    switch (body.type) {
      case 'item.create': {
        if (this.#items.has(body.itemId)) return undefined;
        this.#put({
          id: body.itemId,
          transform: body.transform,
          z: body.z,
          content: body.content,
          appearance: body.appearance ?? DEFAULT_APPEARANCE,
          crop: body.crop ?? FULL_CROP,
          // A created row starts at revision 0 on the server too.
          revision: 0,
          ...(body.groupId !== undefined ? { groupId: body.groupId } : {}),
          ...(body.collides ? { collides: true } : {}),
          ...(body.textScale !== undefined && body.textScale !== 1
            ? { textScale: body.textScale }
            : {}),
        });
        return { type: 'item.delete', itemId: body.itemId };
      }

      case 'item.delete': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#drop(body.itemId);
        // The server cascades links with their items; so does this. A client
        // that wants links back on undo deletes them first, as their own
        // operations (`deleteItemsBodies`), and there is nothing left here.
        for (const l of this.linksOf(body.itemId)) this.#links.delete(l.id);
        return {
          type: 'item.create',
          itemId: existing.id,
          transform: existing.transform,
          z: existing.z,
          content: existing.content,
          // The field this literal is most likely to be missing, and the one
          // whose absence is silent: without it, delete-then-undo is an
          // appearance reset that gets reported as "undo is broken" weeks later.
          appearance: existing.appearance,
          ...(isFullCrop(existing.crop) ? {} : { crop: existing.crop }),
          ...(existing.groupId !== undefined ? { groupId: existing.groupId } : {}),
          ...(existing.collides ? { collides: true } : {}),
          ...(existing.textScale !== undefined ? { textScale: existing.textScale } : {}),
        };
      }

      case 'item.transform': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        const { textScale: _, ...rest } = existing;
        const scaled =
          body.textScale === undefined
            ? existing
            : body.textScale === 1
              ? rest
              : { ...existing, textScale: body.textScale };
        this.#put(
          this.#bumped(scaled, { transform: body.transform, crop: body.crop ?? existing.crop }),
        );
        // The inverse names the crop and the text scale exactly when the body
        // did: a plain move's undo must not overwrite a crop or a scale someone
        // else made in between.
        return {
          type: 'item.transform',
          itemId: body.itemId,
          transform: existing.transform,
          ...(body.crop ? { crop: existing.crop } : {}),
          ...(body.textScale !== undefined ? { textScale: existing.textScale ?? 1 } : {}),
        };
      }

      case 'item.content': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#put(this.#contentChanged(existing, body.content));
        return { type: 'item.content', itemId: body.itemId, content: existing.content };
      }

      case 'item.z': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        this.#put(this.#bumped(existing, { z: body.z }));
        return { type: 'item.z', itemId: body.itemId, z: existing.z };
      }

      case 'item.appearance': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        // Not `#put`: appearance never changes bounds, so the index has nothing
        // to hear. Keeping it out is the structural reason opacity and flip are
        // one operation rather than two.
        this.#items.set(body.itemId, this.#bumped(existing, { appearance: body.appearance }));
        return {
          type: 'item.appearance',
          itemId: body.itemId,
          appearance: existing.appearance,
        };
      }

      case 'group.create': {
        if (this.#groups.has(body.groupId)) return undefined;
        this.#groups.set(body.groupId, {
          id: body.groupId,
          memberIds: [...body.memberIds],
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.frame !== undefined ? { frame: body.frame } : {}),
          ...(body.collides ? { collides: true } : {}),
        });
        for (const id of body.memberIds) {
          const item = this.#items.get(id);
          if (item) this.#items.set(id, { ...item, groupId: body.groupId });
        }
        return { type: 'group.delete', groupId: body.groupId };
      }

      case 'group.delete': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.delete(body.groupId);
        for (const id of existing.memberIds) {
          const item = this.#items.get(id);
          if (item?.groupId === body.groupId) {
            const { groupId: _dropped, ...rest } = item;
            this.#items.set(id, rest);
          }
        }
        return {
          type: 'group.create',
          groupId: existing.id,
          memberIds: existing.memberIds,
          ...(existing.label !== undefined ? { label: existing.label } : {}),
          ...(existing.frame !== undefined ? { frame: existing.frame } : {}),
          ...(existing.collides ? { collides: true } : {}),
        };
      }

      case 'group.members': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        const previous = existing.memberIds;
        this.#groups.set(body.groupId, { ...existing, memberIds: [...body.memberIds] });
        for (const id of previous) {
          const item = this.#items.get(id);
          if (item?.groupId === body.groupId) {
            const { groupId: _dropped, ...rest } = item;
            this.#items.set(id, rest);
          }
        }
        for (const id of body.memberIds) {
          const item = this.#items.get(id);
          if (item) this.#items.set(id, { ...item, groupId: body.groupId });
        }
        return { type: 'group.members', groupId: body.groupId, memberIds: previous };
      }

      case 'group.label': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.set(body.groupId, { ...existing, label: body.label });
        // A group that had no label inverts to the empty string rather than to
        // an absent one: `label` carries absolute state and an inverse that
        // omitted it would be a rename to nothing in particular.
        return { type: 'group.label', groupId: body.groupId, label: existing.label ?? '' };
      }

      case 'group.frame': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.set(body.groupId, { ...existing, frame: body.frame });
        // The same absolute-state rule as `group.label`: a group that had no
        // flag inverts to `false`, not to a field nobody set.
        return { type: 'group.frame', groupId: body.groupId, frame: existing.frame ?? false };
      }

      case 'item.collides': {
        const existing = this.#items.get(body.itemId);
        if (!existing) return undefined;
        // Not `#put`: bounds are unchanged. Absolute state; absent inverts to false.
        this.#items.set(body.itemId, this.#bumped(existing, { collides: body.collides }));
        return { type: 'item.collides', itemId: body.itemId, collides: existing.collides ?? false };
      }

      case 'group.collides': {
        const existing = this.#groups.get(body.groupId);
        if (!existing) return undefined;
        this.#groups.set(body.groupId, { ...existing, collides: body.collides });
        return {
          type: 'group.collides',
          groupId: body.groupId,
          collides: existing.collides ?? false,
        };
      }

      case 'item.source': {
        const existing = this.#items.get(body.itemId);
        if (!existing || !hasSource(existing.content)) return undefined;
        const previous = existing.content.source;
        // Not `#put`: text never moves an item's box; height follows on the
        // client that measured it, as its own transform.
        this.#items.set(
          body.itemId,
          this.#contentChanged(existing, { ...existing.content, source: body.source }),
        );
        return { type: 'item.source', itemId: body.itemId, source: previous };
      }

      case 'checklist.title': {
        const found = this.#checklist(body.itemId);
        if (!found) return undefined;
        this.#items.set(
          body.itemId,
          this.#contentChanged(found.item, { ...found.list, title: body.title }),
        );
        return { type: 'checklist.title', itemId: body.itemId, title: found.list.title };
      }

      case 'task.add': {
        const found = this.#checklist(body.itemId);
        if (!found || found.list.tasks.some((t) => t.id === body.task.id)) return undefined;
        const tasks = [...found.list.tasks];
        tasks.splice(Math.min(body.index ?? tasks.length, tasks.length), 0, body.task);
        this.#setTasks(found.item, tasks);
        return { type: 'task.remove', itemId: body.itemId, taskId: body.task.id };
      }

      case 'task.set': {
        const found = this.#checklist(body.itemId);
        const task = found?.list.tasks.find((t) => t.id === body.taskId);
        if (!found || !task) return undefined;
        const { byApp: _, ...rest } = task;
        const next: Task = {
          ...rest,
          ...(body.byApp !== undefined ? { byApp: body.byApp } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.state !== undefined ? { state: body.state } : {}),
          ...(body.by !== undefined ? { by: body.by } : {}),
          ...(body.byAgent !== undefined ? { byAgent: body.byAgent } : {}),
          ...(body.at !== undefined ? { at: body.at } : {}),
        };
        this.#setTasks(
          found.item,
          found.list.tasks.map((t) => (t.id === task.id ? next : t)),
        );
        // Only the fields this body named: undoing "done" restores the state
        // and leaves the text, and anyone else's edit to it, alone.
        return {
          type: 'task.set',
          itemId: body.itemId,
          taskId: task.id,
          ...(body.text !== undefined ? { text: task.text } : {}),
          ...(body.state !== undefined ? { state: task.state } : {}),
        };
      }

      case 'task.remove': {
        const found = this.#checklist(body.itemId);
        const index = found?.list.tasks.findIndex((t) => t.id === body.taskId) ?? -1;
        if (!found || index < 0) return undefined;
        const task = found.list.tasks[index] as Task;
        this.#setTasks(
          found.item,
          found.list.tasks.filter((t) => t.id !== body.taskId),
        );
        return { type: 'task.add', itemId: body.itemId, task, index };
      }

      case 'link.add': {
        if (this.#links.has(body.linkId) || sameAnchor(body.from, body.to)) return undefined;
        if (!this.#anchorExists(body.from) || !this.#anchorExists(body.to)) return undefined;
        this.#links.set(body.linkId, {
          id: body.linkId,
          from: body.from,
          to: body.to,
          linkType: body.linkType,
          ...(body.view !== undefined ? { view: body.view } : {}),
          ...(body.path ? { path: body.path } : {}),
          ...(body.name ? { name: body.name } : {}),
          ...(body.by !== undefined ? { by: body.by } : {}),
          ...(body.byAgent !== undefined ? { byAgent: body.byAgent } : {}),
          ...(body.at !== undefined ? { at: body.at } : {}),
        });
        return { type: 'link.delete', linkId: body.linkId };
      }

      case 'link.set': {
        const existing = this.#links.get(body.linkId);
        if (!existing) return undefined;
        // The server refuses these; a client never applies one either.
        if (isDataLink(existing.linkType) !== isDataLink(body.linkType)) return undefined;
        if (isDataLink(existing.linkType) && existing.linkType !== body.linkType) return undefined;
        const { path: _p, name: _n, ...rest } = existing;
        const path = body.path !== undefined ? body.path : (existing.path ?? '');
        const name = body.name !== undefined ? body.name : (existing.name ?? '');
        this.#links.set(body.linkId, {
          ...rest,
          linkType: body.linkType,
          ...(body.view !== undefined ? { view: body.view } : {}),
          ...(path ? { path } : {}),
          ...(name ? { name } : {}),
        });
        // What a feeds link carries changed: the app it feeds is behind.
        const moved =
          (body.view !== undefined && body.view !== existing.view) ||
          (body.path !== undefined && body.path !== (existing.path ?? '')) ||
          (body.name !== undefined && body.name !== (existing.name ?? ''));
        if (existing.linkType === 'feeds' && moved) this.#setupChanged(existing.to.itemId);
        return {
          type: 'link.set',
          linkId: body.linkId,
          linkType: existing.linkType,
          ...(body.view !== undefined && existing.view ? { view: existing.view } : {}),
          ...(body.path !== undefined ? { path: existing.path ?? '' } : {}),
          ...(body.name !== undefined ? { name: existing.name ?? '' } : {}),
        };
      }

      case 'app.output': {
        const app = this.#items.get(body.itemId);
        if (app?.content.kind !== 'app') return undefined;
        // A failed run with no values keeps the last ones, as the server does.
        const keep = body.status === 'error' && Object.keys(body.outputs).length === 0;
        const last = app.content.output;
        const was = this.#output(
          app,
          {
            outputs: keep && last ? last.outputs : body.outputs,
            text: body.text ?? (keep ? (last?.text ?? null) : null),
            status: body.status,
            error: body.error ?? null,
            by: body.by ?? null,
            byAgent: body.byAgent ?? null,
            at: body.at ?? null,
          },
          undefined,
          body.record,
        );
        // Undo is the last values committed again, never history rewritten.
        // The first run's undo is "never run" (version 0): local only, a run is
        // never on a person's undo stack (canvas/apps).
        return was
          ? { type: 'app.output.revert', itemId: body.itemId, toVersion: was.version, was }
          : { type: 'app.output.revert', itemId: body.itemId, toVersion: 0 };
      }

      case 'app.set': {
        const app = this.#items.get(body.itemId);
        if (app?.content.kind !== 'app') return undefined;
        const c = app.content;
        const { literals: _l, run: _r, ...base } = c;
        const literals = body.literals ?? c.literals ?? {};
        const run = body.run ?? c.run ?? 'auto';
        const shaMoved =
          body.mcpSha256 !== undefined && c.mcp !== undefined && body.mcpSha256 !== c.mcp.sha256;
        const sourceMoved = (body.html !== undefined && body.html !== c.html) || shaMoved;
        const setupMoved =
          body.literals !== undefined &&
          JSON.stringify(body.literals) !== JSON.stringify(c.literals ?? {});
        this.#items.set(
          app.id,
          this.#bumped(app, {
            content: {
              ...base,
              ...(body.title !== undefined ? { title: body.title } : {}),
              ...(body.html !== undefined ? { html: body.html } : {}),
              ...(Object.keys(literals).length ? { literals } : {}),
              ...(run === 'manual' ? { run } : {}),
              ...(sourceMoved ? { sourceRev: (c.sourceRev ?? 0) + 1 } : {}),
              ...(setupMoved ? { setupRev: (c.setupRev ?? 0) + 1 } : {}),
              ...(shaMoved && c.mcp ? { mcp: { ...c.mcp, sha256: body.mcpSha256 as string } } : {}),
            },
          }),
        );
        return {
          type: 'app.set',
          itemId: body.itemId,
          ...(body.title !== undefined ? { title: c.title } : {}),
          ...(body.html !== undefined ? { html: c.html } : {}),
          ...(body.literals !== undefined ? { literals: c.literals ?? {} } : {}),
          ...(body.run !== undefined ? { run: c.run ?? 'auto' } : {}),
          ...(body.mcpSha256 !== undefined && c.mcp ? { mcpSha256: c.mcp.sha256 } : {}),
        };
      }

      case 'app.card': {
        const app = this.#items.get(body.itemId);
        if (app?.content.kind !== 'app') return undefined;
        const output = app.content.output;
        if (output?.version !== body.version) return undefined;
        // A picture of what is already there: no revision. Its inverse puts
        // the last picture back; nothing puts a card on anyone's undo stack.
        this.#items.set(app.id, {
          ...app,
          content: { ...app.content, output: { ...output, card: body.html } },
        });
        return {
          type: 'app.card',
          itemId: app.id,
          version: output.version,
          html: output.card ?? '',
        };
      }

      case 'app.output.revert': {
        const app = this.#items.get(body.itemId);
        if (app?.content.kind !== 'app') return undefined;
        if (body.toVersion === 0 && !body.record && app.content.output) {
          const { output: _, ...never } = app.content;
          this.#items.set(app.id, this.#bumped(app, { content: never }));
          return undefined;
        }
        if (!body.record && !body.was) return undefined;
        const restored = body.was;
        const was = this.#output(
          app,
          {
            outputs: restored?.outputs ?? {},
            text: restored?.text ?? null,
            status: restored?.status ?? 'ok',
            error: restored?.error ?? null,
            by: body.by ?? null,
            byAgent: body.byAgent ?? null,
            at: body.at ?? null,
          },
          restored?.inputRevs,
          body.record,
        );
        return was
          ? { type: 'app.output.revert', itemId: body.itemId, toVersion: was.version, was }
          : undefined;
      }

      case 'board.centerpiece': {
        const was = this.#centerpiece;
        this.#centerpiece = body.target;
        return { type: 'board.centerpiece', target: was };
      }

      case 'link.delete': {
        const existing = this.#links.get(body.linkId);
        if (!existing) return undefined;
        this.#links.delete(body.linkId);
        return {
          type: 'link.add',
          linkId: existing.id,
          from: existing.from,
          to: existing.to,
          linkType: existing.linkType,
          ...(existing.view ? { view: existing.view } : {}),
          ...(existing.path ? { path: existing.path } : {}),
          ...(existing.name ? { name: existing.name } : {}),
          ...(existing.by !== undefined ? { by: existing.by } : {}),
          ...(existing.byAgent !== undefined ? { byAgent: existing.byAgent } : {}),
          ...(existing.at !== undefined ? { at: existing.at } : {}),
        };
      }
    }
  }
}

/**
 * The bodies that delete items so that ONE undo brings them back with every
 * link they had: each touching link is deleted as its own operation first (so
 * its inverse restores it), then the items. Deleting the items alone would
 * cascade the links away with no inverse to restore them.
 */
export function deleteItemsBodies(
  doc: CanvasDocument,
  itemIds: Iterable<ItemId>,
): CanvasOperationBody[] {
  const ids = [...itemIds];
  const links = new Map<LinkId, true>();
  for (const id of ids) for (const l of doc.linksOf(id)) links.set(l.id, true);
  return [
    ...[...links.keys()].map((linkId): CanvasOperationBody => ({ type: 'link.delete', linkId })),
    ...ids.map((itemId): CanvasOperationBody => ({ type: 'item.delete', itemId })),
  ];
}
