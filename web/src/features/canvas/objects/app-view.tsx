/**
 * An app, live (canvas/apps, ADR-0034, design §7).
 *
 * At rest an app is a card drawn like any object. Double-clicking it mounts its
 * view: an iframe over the card, at the item's bounds, loaded from the sandbox
 * origin (another origin than the board's, with its own CSP), and spoken to
 * over the MCP Apps bridge, JSON-RPC over `postMessage`. The view mounts only
 * while it is open and in sight; leaving it, scrolling it away or turning it
 * unmounts it after the teardown handshake.
 *
 * ponytail: a hand-written host for the stable message subset an inline app
 * needs, not `@modelcontextprotocol/ext-apps`' AppBridge, which brings the MCP
 * client, server and zod into the bundle. Adopt AppBridge when apps come from
 * MCP servers (Phase 2) and need `tools/call` proxied.
 */

import {
  appStates,
  type Camera,
  type CanvasDocument,
  type CanvasItem,
  type CanvasOperationBody,
  type ItemId,
  type OperationOrigin,
  type ViewportSize,
  worldToScreen,
} from '@visarium/canvas-core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { itemView, mountApp } from '~/api/boards';
import { canvasAppsOn } from '~/app/labs';
import { resolvedTheme } from '~/app/theme';
import type { BoardRealtime, RunEvent } from '../realtime';
import { localToWorld } from './interact';
import { appStateLabel } from './layout';
import { APP_BAND } from './style';

/** How long a view may take to answer the teardown request before it goes anyway. */
const TEARDOWN_MS = 2000;
const PROTOCOL = '2026-01-26';
/** Task changes one run may propose (the server holds the same line). */
const MAX_PROPOSALS = 20;

export interface AppViewDeps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly size: ViewportSize;
  readonly boardId: string | undefined;
  readonly selection: ReadonlySet<ItemId>;
  readonly select: (ids: ItemId[]) => void;
  readonly notify: (message: string) => void;
  /** Resolves when everything posted so far is durable. */
  readonly settled: () => Promise<void>;
  readonly realtime: () => BoardRealtime | null;
  readonly commit: (...bodies: CanvasOperationBody[]) => void;
  /** App id → the actor running it now. */
  readonly runs: ReadonlyMap<ItemId, string>;
  /** Who an actor is, for "running for …". */
  readonly nameOf: (actorId: string) => string;
}

interface Open {
  readonly itemId: ItemId;
  readonly url: string;
  readonly origin: string;
}

/** What the views an app reads come to: `n3.frontmatter` → its value. */
async function resolveInputs(
  doc: CanvasDocument,
  boardId: string,
  appId: ItemId,
): Promise<Record<string, unknown>> {
  const feeds = [...doc.links()].filter(
    (l) => l.linkType === 'feeds' && l.to.itemId === appId && l.view,
  );
  const views = await Promise.all(
    feeds.map((l) => itemView(boardId, l.from.itemId, l.view as string).catch(() => null)),
  );
  const inputs: Record<string, unknown> = {};
  feeds.forEach((l, i) => {
    const v = views[i];
    if (v) inputs[`${v.ref}.${l.view}`] = v.value;
  });
  return inputs;
}

/** The board's look, as this person has it, for the kit the view is dressed in. */
function look(): { theme: 'light' | 'dark'; tokens: Record<string, string> } {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--color-${name}`).trim();
  const names: Record<string, string> = {
    surface: 'surface',
    raised: 'surface-raised',
    sunken: 'surface-sunken',
    line: 'line',
    'line-strong': 'line-strong',
    ink: 'ink',
    'ink-dim': 'ink-dim',
    'ink-disabled': 'ink-disabled',
    accent: 'accent',
    'accent-wash': 'accent-wash',
  };
  return {
    theme: resolvedTheme(),
    tokens: Object.fromEntries(Object.entries(names).map(([k, t]) => [k, token(t)])),
  };
}

function onScreen(item: CanvasItem, camera: Camera, size: ViewportSize): boolean {
  // A transform's x and y are the item's centre.
  const t = item.transform;
  const a = worldToScreen(camera, size, { x: t.x - t.width / 2, y: t.y - t.height / 2 });
  const b = worldToScreen(camera, size, { x: t.x + t.width / 2, y: t.y + t.height / 2 });
  return b.x > 0 && b.y > 0 && a.x < size.width && a.y < size.height;
}

export function useAppViews(d: AppViewDeps) {
  const [open, setOpen] = useState<Open | null>(null);
  const [closing, setClosing] = useState(false);
  /** Bumped when what the open app reads may have changed. */
  const [inputsTick, setInputsTick] = useState(0);
  /** Bumped when this client is granted the open app's run. */
  const [runTick, setRunTick] = useState(0);
  /** Bumped by every applied operation while an app is open: what its band reads. */
  const [applied, setApplied] = useState(0);
  const deps = useRef(d);
  deps.current = d;

  // The room knows who has which app open: only they can run it.
  const openId = open?.itemId;
  useEffect(() => {
    if (!openId) return;
    deps.current.realtime()?.mounted(openId, true);
    return () => deps.current.realtime()?.mounted(openId, false);
  }, [openId]);

  /** What became of a run of the open app. */
  const onRun = (e: RunEvent) => {
    if (e.itemId !== openId) return;
    const { realtime, notify, nameOf } = deps.current;
    if (e.kind === 'lease' && realtime()?.runsHere(e.itemId)) setRunTick((n) => n + 1);
    else if (e.kind === 'busy') notify(`Already running for ${nameOf(e.holder)}.`);
    else if (e.kind === 'none') notify('Nobody has this app open to run it.');
    else if (e.kind === 'done')
      notify('Up to date: nothing it reads has changed since its last run.');
  };

  const run = () => {
    if (openId) deps.current.realtime()?.requestRun(openId);
  };

  const close = () => {
    if (open) setClosing(true);
  };

  const openApp = async (item: CanvasItem): Promise<boolean> => {
    if (item.content.kind !== 'app') return false;
    const { notify, boardId, select } = deps.current;
    if (!canvasAppsOn()) {
      notify('Canvas apps are a Labs experiment: turn them on in Settings → Labs.');
      return true;
    }
    if (!boardId) return true;
    if (item.transform.rotation !== 0) {
      notify('Straighten the app to open it.');
      return true;
    }
    let mounted: { url: string; origin: string } | null;
    try {
      mounted = await mountApp(boardId, item.id, look());
    } catch {
      notify('The app could not be opened.');
      return true;
    }
    if (!mounted) {
      notify('This app runs in the desktop app: this server has no place to run it.');
      return true;
    }
    select([item.id]);
    setClosing(false);
    setOpen({ itemId: item.id, ...mounted });
    return true;
  };

  // Clicking elsewhere on the board, deleting, turning or scrolling the app
  // away closes it.
  const item = open ? d.doc.item(open.itemId) : undefined;
  const away =
    !!open &&
    (!item ||
      !d.selection.has(open.itemId) ||
      item.transform.rotation !== 0 ||
      !onScreen(item, d.camera, d.size));
  useEffect(() => {
    if (away) setClosing(true);
  }, [away]);

  /** Every applied operation passes here: re-read inputs when a fed item or a link changed. */
  const noteApplied = (body: CanvasOperationBody, origin: OperationOrigin) => {
    const current = open;
    if (!current) return;
    setApplied((n) => n + 1);
    const feeds = new Set(
      [...deps.current.doc.links()]
        .filter((l) => l.linkType === 'feeds' && l.to.itemId === current.itemId)
        .map((l) => l.from.itemId as string),
    );
    const touches =
      body.type.startsWith('link.') ||
      ('itemId' in body &&
        feeds.has(body.itemId as string) &&
        [
          'item.source',
          'item.content',
          'checklist.title',
          'task.add',
          'task.set',
          'task.remove',
          'app.output',
          'app.output.revert',
        ].includes(body.type));
    if (!touches) return;
    // A local edit is read back from the server once it is there.
    const bump = () => setInputsTick((n) => n + 1);
    if (origin === 'local') void deps.current.settled().then(bump);
    else bump();
  };

  const overlay =
    open && item && d.boardId ? (
      <AppFrame
        key={`${open.itemId}|${open.url}`}
        item={item}
        open={open}
        doc={d.doc}
        boardId={d.boardId}
        camera={d.camera}
        size={d.size}
        inputsTick={inputsTick}
        applied={applied}
        runTick={runTick}
        runner={d.runs.get(open.itemId)}
        me={d.realtime()?.actorId}
        nameOf={d.nameOf}
        realtime={d.realtime}
        commit={d.commit}
        onRun={run}
        closing={closing}
        onClose={close}
        onClosed={() => {
          setOpen(null);
          setClosing(false);
        }}
      />
    ) : null;

  return { open: openApp, close, overlay, noteApplied, onRun, openId: open?.itemId ?? null };
}

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
  closing,
  onClose,
  onClosed,
}: {
  item: CanvasItem;
  open: Open;
  doc: CanvasDocument;
  boardId: string;
  camera: Camera;
  size: ViewportSize;
  inputsTick: number;
  applied: number;
  runTick: number;
  runner: string | undefined;
  me: string | undefined;
  nameOf: (actorId: string) => string;
  realtime: () => BoardRealtime | null;
  commit: (...bodies: CanvasOperationBody[]) => void;
  onRun: () => void;
  closing: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const bridge = useRef<{
    initialized: boolean;
    inputs: Record<string, unknown> | undefined;
    send: (m: Message) => void;
    request: (method: string, params: unknown) => Promise<Message>;
    start: () => void;
  } | null>(null);
  const latest = useRef({ item, onClose, doc, realtime, commit });
  latest.current = { item, onClose, doc, realtime, commit };
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
      /** The first inputs, then the latest output: what the view starts from. */
      start: () => {
        send({ method: 'ui/notifications/tool-input', params: { arguments: b.inputs ?? {} } });
        toolResult();
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
          latest.current.onClose();
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

  // Inputs: read on mount and whenever a fed item or a feeds link changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputsTick is the trigger
  useEffect(() => {
    let current = true;
    void resolveInputs(doc, boardId, item.id).then((inputs) => {
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
    let current = true;
    void resolveInputs(doc, boardId, item.id).then((inputs) => {
      const b = bridge.current;
      if (!current || !b?.initialized) return;
      b.inputs = inputs;
      b.send({ method: 'visarium/notifications/run', params: { arguments: inputs } });
    });
    return () => {
      current = false;
    };
  }, [runTick]);

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
  return (
    <div
      data-testid="app-view"
      className="absolute flex flex-col overflow-hidden rounded border border-item-edge bg-surface"
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
        <button
          type="button"
          data-testid="app-run"
          onClick={onRun}
          disabled={running}
          className="ml-1 rounded px-1.5 uppercase hover:text-ink disabled:text-ink-disabled"
        >
          Run
        </button>
        <button
          type="button"
          aria-label="Close app"
          data-testid="app-close"
          onClick={onClose}
          className="rounded px-1.5 uppercase hover:text-ink"
        >
          Close
        </button>
      </div>
      <iframe
        ref={frame}
        title={title || 'App'}
        src={open.url}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="block min-h-0 w-full flex-1 border-0 bg-surface"
      />
    </div>
  );
}
