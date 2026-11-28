/**
 * Apps, live (canvas/apps, ADR-0034, openspec canvas-apps-live design §3).
 *
 * At rest an app is a card drawn like any object. While it is on screen at a
 * readable size, up to {@link LIVE_MAX} at once, its view runs over the card:
 * an iframe at the item's bounds, loaded from the sandbox origin (another
 * origin than the board's, with its own CSP), and spoken to over the MCP Apps
 * bridge, JSON-RPC over `postMessage`. Zooming out, scrolling it away, turning
 * it or losing its place unmounts it after the teardown handshake. A live view
 * takes no pointer until its app is selected, so the board still pans and
 * zooms over it.
 *
 * ponytail: a hand-written host for the stable message subset apps use, not
 * `@modelcontextprotocol/ext-apps`' AppBridge, which brings the MCP client,
 * server and zod into the bundle. An MCP app's `tools/call` and
 * `resources/read` go to its server through the board (canvas/app-sources).
 * Adopt AppBridge when apps need more of the host protocol than this.
 */

import { fetchServerInfo } from '@visarium/api-client';
import {
  appStates,
  type Camera,
  type CanvasDocument,
  type CanvasItem,
  type CanvasOperationBody,
  type ItemId,
  type OperationOrigin,
  rectsIntersect,
  transformBounds,
  type ViewportSize,
  worldToScreen,
} from '@visarium/canvas-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { appInputs, appMcp, mountApp } from '~/api/boards';
import { canvasAppsOn } from '~/app/labs';
import { resolvedTheme } from '~/app/theme';
import type { BoardRealtime, RunEvent } from '../realtime';
import { cleanCard, kitLook, MAX_CARD, sizedCard } from './app-card';
import { localToWorld } from './interact';
import { appStateLabel } from './layout';
import { APP_BAND } from './style';

/** How long a view may take to answer the teardown request before it goes anyway. */
const TEARDOWN_MS = 2000;
const PROTOCOL = '2026-01-26';
/** How long a selected view waits before it takes the pointer: past a double-click. */
const ACTIVATE_MS = 500;
/** Task changes one run may propose (the server holds the same line). */
const MAX_PROPOSALS = 20;

export interface AppViewDeps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly size: ViewportSize;
  readonly boardId: string | undefined;
  readonly selection: ReadonlySet<ItemId>;
  readonly notify: (message: string) => void;
  /** Resolves when everything posted so far is durable. */
  readonly settled: () => Promise<void>;
  readonly realtime: () => BoardRealtime | null;
  readonly commit: (...bodies: CanvasOperationBody[]) => void;
  /** A person's change (its run mode): undoable, saved. */
  readonly edit: (...bodies: CanvasOperationBody[]) => void;
  /** App id → the actor running it now. */
  readonly runs: ReadonlyMap<ItemId, string>;
  /** Who an actor is, for "running for …". */
  readonly nameOf: (actorId: string) => string;
}

interface Open {
  readonly itemId: ItemId;
  readonly url: string;
  readonly origin: string;
  /** Leaving: the teardown handshake is under way. */
  readonly closing: boolean;
  /** Running in the background, off screen: a run this client was granted. */
  readonly hidden: boolean;
}

/** Hidden views one client runs at once; further runs wait their turn. */
const HIDDEN_MAX = 2;
/** How long a hidden view stays after its run, for the picture it leaves. */
const CARD_GRACE_MS = 1500;
/**
 * How long a hidden run may take before it ends in an error: inside the run's
 * 30-second lease, so the error still commits.
 */
const HIDDEN_RUN_MS = 25_000;

let serverInfo: Promise<{ appsOrigin?: string | null }> | undefined;
/** Whether this server has a sandbox origin, asked once. */
function sandboxOrigin(): Promise<boolean> {
  serverInfo ??= fetchServerInfo();
  return serverInfo.then((i) => !!i.appsOrigin);
}

/** How many app views one client runs at once. */
// ponytail: one constant; raise it once a board of chart apps is profiled (task 11.3).
export const LIVE_MAX = 4;
/** Narrower than this on screen, in px, an app shows its card. */
export const LIVE_MIN_WIDTH = 200;

/**
 * The apps whose views should be live now: on screen, at least
 * {@link LIVE_MIN_WIDTH} px wide, straight, and with nothing drawn over them
 * (a view is a DOM layer above the whole canvas). The largest on screen first,
 * at most `max`.
 */
export function liveApps(
  doc: CanvasDocument,
  camera: Camera,
  size: ViewportSize,
  max = LIVE_MAX,
): ItemId[] {
  const items = [...doc.items()];
  const found: { id: ItemId; area: number }[] = [];
  for (const i of items) {
    if (i.content.kind !== 'app' || i.transform.rotation !== 0) continue;
    const t = i.transform;
    const a = worldToScreen(camera, size, { x: t.x - t.width / 2, y: t.y - t.height / 2 });
    const b = worldToScreen(camera, size, { x: t.x + t.width / 2, y: t.y + t.height / 2 });
    if (b.x - a.x < LIVE_MIN_WIDTH) continue;
    if (b.x <= 0 || b.y <= 0 || a.x >= size.width || a.y >= size.height) continue;
    const box = transformBounds(t);
    const covered = items.some(
      (o) => o.id !== i.id && o.z > i.z && rectsIntersect(transformBounds(o.transform), box),
    );
    if (!covered) found.push({ id: i.id, area: (b.x - a.x) * (b.y - a.y) });
  }
  return found
    .sort((x, y) => y.area - x.area)
    .slice(0, max)
    .map((f) => f.id);
}

/** Whether an operation changes what an app reads. */
function touchesInputs(doc: CanvasDocument, app: ItemId, body: CanvasOperationBody): boolean {
  if (body.type.startsWith('link.')) return true;
  if (body.type === 'app.set') return body.itemId === app;
  if (!('itemId' in body)) return false;
  const fed = [...doc.links()].some(
    (l) => l.linkType === 'feeds' && l.to.itemId === app && l.from.itemId === body.itemId,
  );
  return (
    fed &&
    [
      'item.source',
      'item.content',
      'checklist.title',
      'task.add',
      'task.set',
      'task.remove',
      'app.output',
      'app.output.revert',
    ].includes(body.type)
  );
}

const bump = (m: ReadonlyMap<ItemId, number>, id: ItemId) =>
  new Map(m).set(id, (m.get(id) ?? 0) + 1);

export function useAppViews(d: AppViewDeps) {
  const [views, setViews] = useState<ReadonlyMap<ItemId, Open>>(new Map());
  /** Per app: bumped when what it reads may have changed. */
  const [inputsTicks, setInputsTicks] = useState<ReadonlyMap<ItemId, number>>(new Map());
  /** Per app: bumped when this client is granted its run. */
  const [runTicks, setRunTicks] = useState<ReadonlyMap<ItemId, number>>(new Map());
  /** Bumped by every applied operation while any view is live: what the bands read. */
  const [applied, setApplied] = useState(0);
  /** Set once the server says it has no sandbox origin: then apps stay cards. */
  const [noSandbox, setNoSandbox] = useState(false);
  const mounting = useRef(new Set<ItemId>());
  /** Runs this client was granted while it could not start them yet. */
  const queued = useRef<ItemId[]>([]);
  const deps = useRef(d);
  deps.current = d;

  // Whether the server can show apps at all: then this client offers to run
  // any of them, hidden, for anyone (canvas/apps: background runs).
  const [sandbox, setSandbox] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!d.boardId) return;
    void sandboxOrigin()
      .then((has) => {
        setSandbox(has);
        if (!has) setNoSandbox(true);
      })
      .catch(() => {});
  }, [d.boardId]);
  const ready = !!d.boardId && canvasAppsOn() && sandbox === true && !noSandbox;
  const rt = d.realtime();
  useEffect(() => {
    rt?.ready(ready);
  }, [rt, ready]);

  const want = d.boardId && canvasAppsOn() && !noSandbox ? liveApps(d.doc, d.camera, d.size) : [];
  const wantKey = want.join(',');

  // Mount what came into the pool; tear down what left it. A view that left
  // finishes its teardown, and comes back fresh if it is wanted again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: wantKey stands for want
  useEffect(() => {
    const { boardId } = deps.current;
    if (!boardId) return;
    // A hidden run that came on screen carries on in place.
    if (want.some((id) => views.get(id)?.hidden))
      setViews((v) => {
        const next = new Map(v);
        for (const id of want) {
          const o = next.get(id);
          if (o?.hidden && !o.closing) next.set(id, { ...o, hidden: false });
        }
        return next;
      });
    for (const id of want) {
      if (views.has(id) || mounting.current.has(id)) continue;
      mounting.current.add(id);
      mountApp(boardId, id, kitLook())
        .then((m) => {
          mounting.current.delete(id);
          if (!m) setNoSandbox(true);
          else
            setViews((v) =>
              v.has(id)
                ? v
                : new Map(v).set(id, { itemId: id, ...m, closing: false, hidden: false }),
            );
        })
        .catch(() => mounting.current.delete(id));
    }
    const keep = new Set(want);
    if ([...views.values()].some((v) => !v.closing && !v.hidden && !keep.has(v.itemId)))
      setViews((v) => {
        const next = new Map(v);
        for (const [id, o] of v)
          if (!o.closing && !o.hidden && !keep.has(id)) next.set(id, { ...o, closing: true });
        return next;
      });
  }, [wantKey, views]);

  /** A run this client was granted for an app it does not show: run it hidden. */
  const runHidden = (id: ItemId) => {
    const { boardId } = deps.current;
    if (!boardId || mounting.current.has(id)) return;
    const hidden = [...views.values()].filter((v) => v.hidden).length;
    if (views.has(id) || hidden >= HIDDEN_MAX) {
      if (!queued.current.includes(id)) queued.current.push(id);
      return;
    }
    mounting.current.add(id);
    mountApp(boardId, id, kitLook())
      .then((m) => {
        mounting.current.delete(id);
        if (!m) {
          setNoSandbox(true);
          return;
        }
        setViews((v) => new Map(v).set(id, { itemId: id, ...m, closing: false, hidden: true }));
        setRunTicks((t) => bump(t, id));
      })
      .catch(() => mounting.current.delete(id));
  };

  /** What became of a run: granted here, ended, or answered. */
  const onRun = (e: RunEvent) => {
    const { realtime, notify, nameOf } = deps.current;
    if (e.kind === 'lease') {
      if (!realtime()?.runsHere(e.itemId)) return;
      const v = views.get(e.itemId);
      if (v && !v.closing) setRunTicks((m) => bump(m, e.itemId));
      else runHidden(e.itemId);
    } else if (e.kind === 'end') {
      // A hidden view stays a moment for the picture it leaves, then goes.
      if (views.get(e.itemId)?.hidden)
        setTimeout(
          () =>
            setViews((vs) => {
              const o = vs.get(e.itemId);
              return o?.hidden && !o.closing
                ? new Map(vs).set(e.itemId, { ...o, closing: true })
                : vs;
            }),
          CARD_GRACE_MS,
        );
    } else if (e.kind === 'busy') notify(`Already running for ${nameOf(e.holder)}.`);
    else if (e.kind === 'none')
      notify('Nobody can run it: open the board with Settings → Labs → Canvas apps on.');
    else if (e.kind === 'done')
      notify('Up to date: nothing it reads has changed since its last run.');
  };

  const runHiddenRef = useRef(runHidden);
  runHiddenRef.current = runHidden;

  /** Run an app: on screen, or hidden in whichever client the board picks. */
  const requestRun = (id: ItemId) => deps.current.realtime()?.requestRun(id);

  /** Every applied operation passes here: re-read the inputs of the views it touches. */
  const noteApplied = (body: CanvasOperationBody, origin: OperationOrigin) => {
    if (views.size === 0) return;
    setApplied((n) => n + 1);
    const touched = [...views.keys()].filter((id) => touchesInputs(deps.current.doc, id, body));
    if (touched.length === 0) return;
    // A local edit is read back from the server once it is there.
    const go = () => setInputsTicks((m) => touched.reduce(bump, m));
    if (origin === 'local') void deps.current.settled().then(go);
    else go();
  };

  const selectedOnly = d.selection.size === 1 ? [...d.selection][0] : undefined;
  const overlay = d.boardId
    ? [...views.values()].map((open) => {
        const item = d.doc.item(open.itemId);
        if (item?.content.kind !== 'app') return null;
        return (
          <AppFrame
            // A saved source is a new page: the view loads it again (canvas/app-inspector).
            key={`${open.itemId}|${open.url}|${item.content.sourceRev ?? 0}`}
            item={item}
            open={open}
            doc={d.doc}
            boardId={d.boardId as string}
            camera={d.camera}
            size={d.size}
            selected={selectedOnly === open.itemId && !open.hidden}
            inputsTick={inputsTicks.get(open.itemId) ?? 0}
            applied={applied}
            runTick={runTicks.get(open.itemId) ?? 0}
            runner={d.runs.get(open.itemId)}
            me={d.realtime()?.actorId}
            nameOf={d.nameOf}
            realtime={d.realtime}
            commit={d.commit}
            onRun={() => requestRun(open.itemId)}
            onMode={(run) => deps.current.edit({ type: 'app.set', itemId: open.itemId, run })}
            onClosed={() => {
              setViews((v) => {
                const next = new Map(v);
                next.delete(open.itemId);
                return next;
              });
              // A run that waited for this view, or for a free hidden one.
              const waiting = queued.current;
              queued.current = [];
              for (const id of waiting)
                if (deps.current.realtime()?.runsHere(id))
                  setTimeout(() => runHiddenRef.current(id), 0);
            }}
          />
        );
      })
    : null;

  return {
    overlay,
    noteApplied,
    onRun,
    requestRun,
    noSandbox,
    live: [...views.values()].filter((v) => !v.hidden).map((v) => v.itemId),
  };
}

/** What a view sends when it settles (the kit's `kit.js`). */
type Snapshot = { html?: unknown; width?: unknown; height?: unknown };

type Message = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

function AppFrame({
  item,
  open,
  doc,
  boardId,
  camera,
  size,
  inputsTick,
  applied,
  runTick,
  runner,
  me,
  nameOf,
  realtime,
  commit,
  onRun,
  onMode,
  selected,
  onClosed,
}: {
  item: CanvasItem;
  open: Open;
  doc: CanvasDocument;
  boardId: string;
  camera: Camera;
  size: ViewportSize;
  /** Its app alone is selected: the view takes the pointer, the band its controls. */
  selected: boolean;
  inputsTick: number;
  applied: number;
  runTick: number;
  runner: string | undefined;
  me: string | undefined;
  nameOf: (actorId: string) => string;
  realtime: () => BoardRealtime | null;
  commit: (...bodies: CanvasOperationBody[]) => void;
  onRun: () => void;
  onMode: (run: 'auto' | 'manual') => void;
  onClosed: () => void;
}) {
  const closing = open.closing;
  // Selected, it takes the pointer once a double-click could no longer be
  // under way: the click that selects it is often the first of one, and the
  // second must reach the board, which opens the inspector.
  // ponytail: a fixed pause; read the platform's double-click time if one is exposed.
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!selected) {
      setActive(false);
      return;
    }
    const t = setTimeout(() => setActive(true), ACTIVATE_MS);
    return () => clearTimeout(t);
  }, [selected]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const bridge = useRef<{
    initialized: boolean;
    inputs: Record<string, unknown> | undefined;
    send: (m: Message) => void;
    request: (method: string, params: unknown) => Promise<Message>;
    result: () => void;
    start: () => void;
  } | null>(null);
  const latest = useRef({ item, doc, realtime, commit, runner, boardId });
  latest.current = { item, doc, realtime, commit, runner, boardId };
  /** The view's last picture, kept until it can become a card. */
  const snapshot = useRef<Snapshot | null>(null);
  /** A run granted before the view was ready for it: sent once it is. */
  const pendingRun = useRef(false);

  /**
   * The view's picture becomes its card: the first one of each output
   * version, while what it shows is that version, and not while it runs.
   */
  const takeCard = () => {
    const p = snapshot.current;
    const { item: app, doc: board, runner: busy } = latest.current;
    const out = app.content.kind === 'app' ? app.content.output : undefined;
    const state = appStates(board).get(app.id)?.state;
    const shows = state !== 'stale' && state !== 'never run';
    if (!p || !out || out.card || !shows || busy !== undefined || typeof p.html !== 'string')
      return;
    snapshot.current = null;
    const version = out.version;
    const t = app.transform;
    void cleanCard(p.html).then((clean) => {
      const card = sizedCard(
        clean,
        typeof p.width === 'number' ? p.width : t.width - 2,
        typeof p.height === 'number' ? p.height : t.height - 2 - APP_BAND,
      );
      const now = latest.current.item.content;
      if (card.length > MAX_CARD || now.kind !== 'app' || now.output?.version !== version) return;
      if (now.output.card) return;
      latest.current.commit({ type: 'app.card', itemId: app.id, version, html: card });
    });
  };
  const takeCardRef = useRef(takeCard);
  takeCardRef.current = takeCard;
  // A picture taken during a run waits for the run to end.
  const version = item.content.kind === 'app' ? item.content.output?.version : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: takeCard reads latest
  useEffect(() => {
    if (runner === undefined) takeCard();
  }, [runner, version]);

  // The room knows who has which app open: only they can run it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per view
  useEffect(() => {
    realtime()?.mounted(item.id, true);
    return () => realtime()?.mounted(item.id, false);
  }, [item.id]);
  /** Task changes proposed during the current run. */
  const proposed = useRef(0);

  useEffect(() => {
    const win = () => frame.current?.contentWindow ?? null;
    const send = (m: Message) => win()?.postMessage({ jsonrpc: '2.0', ...m }, open.origin);
    const pending = new Map<number, (m: Message) => void>();
    let next = 1;
    const request = (method: string, params: unknown) =>
      new Promise<Message>((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        send({ id, method, params });
      });
    const b = {
      initialized: false,
      inputs: undefined as Record<string, unknown> | undefined,
      send,
      request,
      /** The latest output, as a tool's result: on start and after every run. */
      result: () => toolResult(),
      /** The first inputs, then the latest output: what the view starts from. */
      start: () => {
        send({ method: 'ui/notifications/tool-input', params: { arguments: b.inputs ?? {} } });
        toolResult();
        if (pendingRun.current) {
          pendingRun.current = false;
          send({ method: 'visarium/notifications/run', params: { arguments: b.inputs ?? {} } });
        }
      },
    };
    bridge.current = b;

    const toolResult = () => {
      const c = latest.current.item.content;
      const out = c.kind === 'app' ? c.output : undefined;
      if (!out) return;
      send({
        method: 'ui/notifications/tool-result',
        params: {
          content: out.text ? [{ type: 'text', text: out.text }] : [],
          structuredContent: out.outputs,
          ...(out.status === 'error' ? { isError: true } : {}),
        },
      });
    };

    const onMessage = (e: MessageEvent) => {
      // Only this view, from its sandbox origin: nothing else on the page speaks for it.
      if (e.source !== win() || e.origin !== open.origin) return;
      const m = e.data as Message;
      if (m?.jsonrpc !== '2.0') return;
      if (m.id !== undefined && m.method === undefined) {
        pending.get(m.id as number)?.(m);
        pending.delete(m.id as number);
        return;
      }
      const reply = (result: unknown) => send({ id: m.id as number, result });
      const fail = (code: number, message: string) =>
        send({ id: m.id as number, error: { code, message } });
      const t = latest.current.item.transform;
      switch (m.method) {
        case 'ui/initialize':
          reply({
            protocolVersion: PROTOCOL,
            hostInfo: { name: 'visarium', version: '0' },
            hostCapabilities: {
              logging: {},
              experimental: { 'dev.visarium/canvas': { version: 1 } },
            },
            hostContext: {
              theme: resolvedTheme(),
              displayMode: 'inline',
              availableDisplayModes: ['inline'],
              // The frame the view gets: the box less its edge and the host band.
              containerDimensions: { width: t.width - 2, height: t.height - 2 - APP_BAND },
              platform: 'desktop',
              locale: navigator.language,
            },
          });
          return;
        case 'ui/notifications/initialized':
          // Nothing goes to the view before this (MCP Apps: host behaviour), and
          // tool-input goes once, complete: now if the inputs are read, else
          // when they are.
          b.initialized = true;
          if (b.inputs !== undefined) b.start();
          return;
        case 'ping':
          reply({});
          return;
        case 'ui/notifications/request-teardown':
          // On a board a view lives while its app is in sight: there is
          // nothing to close it to but its card, which is where it goes when
          // it leaves the screen.
          return;
        case 'visarium/outputs/publish': {
          // Only the run's holder commits, for the inputs it was granted (canvas/apps).
          const { item: app, realtime: rt, commit: put } = latest.current;
          if (!rt()?.runsHere(app.id)) return fail(-32001, 'no_lease: run the app first');
          const p = (m.params ?? {}) as Record<string, unknown>;
          const outputs = p.outputs;
          if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs))
            return fail(-32602, 'outputs must be an object');
          put({
            type: 'app.output',
            itemId: app.id,
            outputs: outputs as Record<string, unknown>,
            status: p.status === 'error' ? 'error' : 'ok',
            ...(typeof p.text === 'string' ? { text: p.text } : {}),
            ...(typeof p.error === 'string' ? { error: p.error } : {}),
          });
          reply({});
          return;
        }
        case 'visarium/items/propose': {
          // Task changes on checklists this app updates, during its run, bounded.
          const { item: app, realtime: rt, commit: put, doc: board } = latest.current;
          if (!rt()?.runsHere(app.id)) return fail(-32001, 'no_lease: run the app first');
          const changes = (m.params as { changes?: unknown })?.changes;
          if (!Array.isArray(changes)) return fail(-32602, 'changes must be a list');
          if (proposed.current + changes.length > MAX_PROPOSALS)
            return fail(-32004, `a run may change at most ${MAX_PROPOSALS} tasks`);
          const updates = new Set(
            [...board.links()]
              .filter((l) => l.linkType === 'updates' && l.from.itemId === app.id)
              .map((l) => l.to.itemId as string),
          );
          const bodies: CanvasOperationBody[] = [];
          for (const c of changes as Record<string, unknown>[]) {
            // An app that updates one checklist need not know its id.
            const list = c?.itemId ?? (updates.size === 1 ? [...updates][0] : undefined);
            if (typeof list !== 'string' || !updates.has(list))
              return fail(-32003, `no_grant: this app does not update ${String(list)}`);
            const state =
              c.state === 'todo' ||
              c.state === 'doing' ||
              c.state === 'done' ||
              c.state === 'blocked'
                ? c.state
                : undefined;
            if (c.type === 'task.set' && typeof c.taskId === 'string')
              bodies.push({
                type: 'task.set',
                itemId: list as ItemId,
                taskId: c.taskId,
                byApp: app.id,
                ...(state ? { state } : {}),
                ...(typeof c.text === 'string' ? { text: c.text } : {}),
              });
            else if (c.type === 'task.add' && typeof c.text === 'string')
              bodies.push({
                type: 'task.add',
                itemId: list as ItemId,
                task: {
                  id: `t-${crypto.randomUUID().slice(0, 8)}`,
                  text: c.text,
                  state: state ?? 'todo',
                  byApp: app.id,
                },
              });
            else return fail(-32602, 'a change is task.add (text) or task.set (taskId)');
          }
          proposed.current += bodies.length;
          put(...bodies);
          reply({});
          return;
        }
        case 'tools/call':
        case 'resources/read': {
          // An MCP app's view asks its own server, through the board, which
          // calls only tools visible to apps (canvas/app-sources).
          const { item: app, boardId: board } = latest.current;
          if (app.content.kind !== 'app' || !app.content.mcp)
            return fail(-32601, `Method not found: ${m.method}`);
          void appMcp(board, app.id, m.method, m.params).then(reply, (e: Error) =>
            fail(-32000, e.message),
          );
          return;
        }
        case 'visarium/card':
          // The view settled: its picture may become its card (takeCard).
          snapshot.current = (m.params ?? {}) as Snapshot;
          takeCardRef.current();
          return;
        case 'ui/notifications/size-changed':
        case 'notifications/message':
          // The box is the app's frame; a log line is the app's own business.
          return;
        default:
          if (m.id !== undefined) fail(-32601, `Method not found: ${m.method}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      bridge.current = null;
    };
  }, [open.origin]);

  // A new output, from any run (a tool-backed app's runs on the server): the
  // view hears it as the tool's result, as an MCP Apps host tells it.
  const outputVersion = item.content.kind === 'app' ? item.content.output?.version : undefined;
  useEffect(() => {
    const b = bridge.current;
    if (b?.initialized && outputVersion !== undefined) b.result();
  }, [outputVersion]);

  // Inputs: read on mount and whenever a fed item or a feeds link changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputsTick is the trigger
  useEffect(() => {
    let current = true;
    void appInputs(boardId, item.id)
      .catch(() => ({}))
      .then((inputs) => {
        const b = bridge.current;
        if (!current || !b) return;
        const first = b.inputs === undefined;
        b.inputs = inputs;
        if (!b.initialized) return;
        if (first) b.start();
        else
          b.send({
            method: 'visarium/notifications/inputs-changed',
            params: { arguments: inputs },
          });
      });
    return () => {
      current = false;
    };
  }, [inputsTick, boardId, item.id]);

  // Granted the run: the view computes from the inputs as they are now, then publishes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runTick is the trigger
  useEffect(() => {
    if (runTick === 0) return;
    proposed.current = 0;
    // Not ready yet (a hidden view just mounted): it runs once it is.
    if (!bridge.current?.initialized || bridge.current.inputs === undefined) {
      pendingRun.current = true;
      return;
    }
    let current = true;
    void appInputs(boardId, item.id)
      .catch(() => ({}))
      .then((inputs) => {
        const b = bridge.current;
        if (!current || !b?.initialized) return;
        b.inputs = inputs;
        b.send({ method: 'visarium/notifications/run', params: { arguments: inputs } });
      });
    return () => {
      current = false;
    };
  }, [runTick]);

  // A hidden run that never finishes ends in an error, so the app says so and
  // the run is free for someone else (canvas/apps: background runs).
  useEffect(() => {
    if (!open.hidden || runTick === 0) return;
    const timer = setTimeout(() => {
      const { item: app, realtime: rt, commit: put } = latest.current;
      if (!rt()?.runsHere(app.id)) return;
      put({
        type: 'app.output',
        itemId: app.id,
        outputs: {},
        status: 'error',
        error: 'It did not finish in the background within 25 seconds.',
      });
    }, HIDDEN_RUN_MS);
    return () => clearTimeout(timer);
  }, [runTick, open.hidden]);

  // Teardown: ask the view, wait for its answer or the deadline, then unmount.
  // A view replaced meanwhile (another app opened) is gone already: its late
  // answer must not close its successor.
  const closed = useRef(onClosed);
  closed.current = onClosed;
  useEffect(() => {
    if (!closing) return;
    const b = bridge.current;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      closed.current();
    };
    const timer = setTimeout(finish, TEARDOWN_MS);
    if (b?.initialized) void b.request('ui/resource-teardown', { reason: 'closed' }).then(finish);
    else finish();
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [closing]);

  const at = worldToScreen(camera, size, localToWorld(item.transform, { x: 0, y: 0 }));
  const title = item.content.kind === 'app' ? item.content.title : 'App';
  // The band is the card's own (layout.ts appBandHtml), now with the run in it.
  // Every app's state walks the board: once per applied operation, not per camera frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: applied is the trigger
  const states = useMemo(() => appStates(doc), [doc, applied]);
  const state = appStateLabel(states.get(item.id));
  const running = runner !== undefined;
  const word = !running ? state.text : runner === me ? 'running' : `running for ${nameOf(runner)}`;
  const lamp = running
    ? runner === me
      ? 'border-accent bg-accent'
      : 'border-ink bg-ink'
    : {
        never: 'border-ink-dim',
        fresh: 'border-ink-dim bg-ink-dim',
        stale: 'border-dashed border-ink',
        'upstream-stale': 'border-dashed border-ink',
        error: 'border-ink bg-ink',
        'upstream-error': 'border-ink bg-ink',
      }[state.cls];
  const loud = running || (state.cls !== 'never' && state.cls !== 'fresh');
  const mode = item.content.kind === 'app' && item.content.run === 'manual' ? 'manual' : 'auto';
  if (open.hidden)
    // Running for the board, seen by no one: off screen, at its own size.
    return (
      <div
        data-testid="app-hidden"
        data-item-id={item.id}
        aria-hidden
        className="pointer-events-none fixed flex flex-col"
        style={{
          left: -100_000,
          top: 0,
          width: item.transform.width,
          height: item.transform.height,
        }}
      >
        <iframe
          ref={frame}
          title={title || 'App'}
          tabIndex={-1}
          src={open.url}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="block min-h-0 w-full flex-1 border-0"
          style={{ marginTop: APP_BAND }}
        />
      </div>
    );
  return (
    <div
      data-testid="app-view"
      data-item-id={item.id}
      // The board under it keeps the pointer: a press there selects, drags,
      // pans and zooms as anywhere else (canvas/apps: inert until selected).
      className="pointer-events-none absolute flex flex-col overflow-hidden rounded border border-item-edge bg-surface"
      style={{
        left: at.x,
        top: at.y,
        width: item.transform.width,
        height: item.transform.height,
        transformOrigin: '0 0',
        transform: `scale(${camera.zoom})`,
      }}
    >
      <div
        className="flex flex-none items-center gap-2 whitespace-nowrap border-line border-b bg-surface-raised px-3 text-[12px] text-ink-dim uppercase tracking-[0.025em]"
        style={{ height: APP_BAND }}
      >
        <span>App</span>
        <span className="min-w-0 flex-1 truncate text-[15px] text-ink normal-case tracking-normal">
          {title || 'App'}
        </span>
        <span className={`flex flex-none items-center gap-1.5 ${loud ? 'text-ink' : ''}`}>
          <span className={`box-border size-2 flex-none border ${lamp}`} />
          <span data-testid="app-running">{word}</span>
        </span>
        {selected ? (
          <>
            <button
              type="button"
              data-testid="app-mode"
              aria-label={`Runs ${mode === 'auto' ? 'automatically' : 'when asked'}: switch`}
              onClick={() => onMode(mode === 'auto' ? 'manual' : 'auto')}
              className="pointer-events-auto ml-1 rounded px-1.5 uppercase hover:text-ink"
            >
              {mode}
            </button>
            <button
              type="button"
              data-testid="app-run"
              onClick={onRun}
              disabled={running}
              className="pointer-events-auto rounded px-1.5 uppercase hover:text-ink disabled:text-ink-disabled"
            >
              Run
            </button>
          </>
        ) : null}
      </div>
      <iframe
        ref={frame}
        title={title || 'App'}
        src={open.url}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className={`block min-h-0 w-full flex-1 border-0 bg-surface ${active ? 'pointer-events-auto' : ''}`}
      />
    </div>
  );
}
