/**
 * An app, under the hood (canvas/app-inspector): double-clicking an app shows
 * its HTML source beside what it reads and what it leaves, the way a note or a
 * diagram shows its source. Every change is an ordinary board change: one
 * undoable `app.set`, `link.set` or `link.delete`, the same an agent makes.
 *
 * What the app reads is resolved by the server (`GET …/inputs`), so the names,
 * fields and values here are exactly what its view receives.
 */

import {
  type AppState,
  appStates,
  type Camera,
  type CanvasDocument,
  type CanvasItem,
  type CanvasOperationBody,
  type ItemId,
  type LinkId,
  OWN_SETUP,
  OWN_SOURCE,
  type ViewportSize,
  worldToScreen,
} from '@visarium/canvas-core';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type AppInventory, appInventory } from '~/api/boards';
import { canvasAppsOn } from '~/app/labs';
import { localToWorld } from './interact';
import { appStateLabel } from './layout';
import { viewsOf } from './links';
import { APP_BAND } from './style';

/** Smallest the inspector is drawn, in screen px, however small the app. */
const MIN_W = 640;
const MIN_H = 420;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** A whole HTML document, as the server requires of an app's source. */
export function isHtmlDocument(html: string): boolean {
  const head = html.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/** A value, short: what a row previews. */
export function preview(v: unknown, max = 60): string {
  const s = v === undefined ? '' : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Why an app is stale, in words: `n1 changed`, `source changed`, `inputs changed`. */
export function staleReasons(state: AppState | undefined, refOf: (id: string) => string): string {
  if (state?.state !== 'stale') return '';
  return state.moved
    .map((m) =>
      m.itemId === OWN_SOURCE
        ? 'source changed'
        : m.itemId === OWN_SETUP
          ? 'inputs changed'
          : m.was === undefined
            ? `${refOf(m.itemId)} connected`
            : m.now === undefined
              ? `${refOf(m.itemId)} disconnected`
              : `${refOf(m.itemId)} changed`,
    )
    .join(', ');
}

/** "2 min ago", from an ISO time. */
function ago(at: string | null | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

type Row = AppInventory['inputs'][number];

export interface AppInspectorProps {
  readonly item: CanvasItem;
  readonly doc: CanvasDocument;
  /** Bumps with every applied change: what the inventory is read again on. */
  readonly revision: number;
  readonly boardId: string;
  readonly readOnly: boolean;
  /** Screen px of the app's top-left corner, and its size on screen. */
  readonly at: { x: number; y: number; width: number; height: number };
  readonly state: AppState | undefined;
  /** Resolves when everything posted so far is durable. */
  readonly settled: () => Promise<void>;
  /** A person's change: undoable, saved. */
  readonly commit: (...bodies: CanvasOperationBody[]) => void;
  readonly onClose: () => void;
  /** This server has no sandbox origin: apps show as cards only. */
  readonly noSandbox: boolean;
  /** Runs it: on screen, or hidden in whichever client the board picks. */
  readonly onRun: () => void;
}

export function AppInspector(p: AppInspectorProps) {
  const { item, readOnly, commit } = p;
  const app = item.content.kind === 'app' ? item.content : undefined;
  const root = useRef<HTMLDivElement | null>(null);
  const sourceField = useRef<HTMLTextAreaElement | null>(null);
  const [source, setSource] = useState(app?.html ?? '');
  const [error, setError] = useState('');
  const [inv, setInv] = useState<AppInventory | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [adding, setAdding] = useState(false);

  // What it reads, read again whenever the board changes, once local edits are saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger
  useEffect(() => {
    let current = true;
    void p
      .settled()
      .then(() => appInventory(p.boardId, item.id))
      .catch(() => null)
      .then((i) => {
        if (!current) return;
        if (i) setInv(i);
        else setUnavailable(true);
      });
    return () => {
      current = false;
    };
  }, [p.revision, p.boardId, item.id]);

  /** Saves the source if it changed; false when it cannot be saved. */
  const save = (): boolean => {
    if (!app || readOnly || source === app.html) return true;
    if (!isHtmlDocument(source)) {
      setError(
        "An app's source must be a whole HTML document, starting with <!doctype html> or <html>.",
      );
      return false;
    }
    setError('');
    commit({ type: 'app.set', itemId: item.id, html: source });
    return true;
  };
  const close = () => {
    if (save()) p.onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Keys go to it from the start, as to any in-place editor: Escape closes it.
  useEffect(() => {
    sourceField.current?.focus({ preventScroll: true });
    sourceField.current?.setSelectionRange(0, 0);
  }, []);

  // A press anywhere else on the page closes it, saving what changed; so does
  // Escape, unless a field elsewhere has the keys (one it removed leaves none).
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) closeRef.current();
    };
    const onEscape = (e: KeyboardEvent) => {
      const at = document.activeElement;
      const ours = !at || at === document.body || root.current?.contains(at);
      if (e.key === 'Escape' && !e.defaultPrevented && ours) {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);

  if (!app) return null;

  const names = new Set(inv?.inputs.map((r) => r.name) ?? []);
  const literals = app.literals ?? {};
  /** A new name for an input, checked as the server checks it. */
  const nameOk = (name: string, was: string): boolean => {
    if (name === was) return false;
    if (!NAME.test(name)) {
      setError(`An input name is 1-64 letters, digits, '_', '-' or '.'; '${name}' is not.`);
      return false;
    }
    if (names.has(name)) {
      setError(`This app already has an input named '${name}'.`);
      return false;
    }
    setError('');
    return true;
  };
  const setLiterals = (next: Record<string, unknown>) =>
    commit({ type: 'app.set', itemId: item.id, literals: next });

  const renameLink = (r: Row, name: string) => {
    if (!nameOk(name, r.name) || !r.linkId) return;
    // The default name is no name at all: it follows the source's ref and view.
    commit({
      type: 'link.set',
      linkId: r.linkId as LinkId,
      linkType: 'feeds',
      name: name === `${r.ref}.${r.view}` ? '' : name,
    });
  };
  const renameLiteral = (was: string, name: string) => {
    if (!nameOk(name, was)) return;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(literals)) next[k === was ? name : k] = v;
    setLiterals(next);
  };
  const setLiteral = (name: string, text: string): boolean => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      setError(`'${text}' is not a JSON value: a number, "text", true, [..] or {..}.`);
      return false;
    }
    setError('');
    setLiterals({ ...literals, [name]: value });
    return true;
  };

  const width = Math.max(MIN_W, p.at.width);
  const height = Math.max(MIN_H, p.at.height);
  const label = appStateLabel(p.state);
  const output = app.output;
  const refOf = (id: string) => inv?.inputs.find((r) => r.itemId === id)?.ref ?? 'an input';
  const why = staleReasons(p.state, refOf);
  const declaredOpen = inv?.declared.filter((d) => !d.connected) ?? [];

  return (
    <div
      ref={root}
      data-testid="app-inspector"
      role="dialog"
      aria-label={`${app.title || 'App'}: source, inputs and outputs`}
      className="absolute flex flex-col overflow-hidden rounded border border-item-edge bg-surface text-[13px] text-ink"
      style={{ left: p.at.x, top: p.at.y, width, height }}
      onKeyDown={(e) => {
        if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
      }}
    >
      <div
        className="flex flex-none items-center gap-2 whitespace-nowrap border-line border-b bg-surface-raised px-3 text-[12px] text-ink-dim uppercase tracking-[0.025em]"
        style={{ height: APP_BAND }}
      >
        <span>App</span>
        <span className="min-w-0 flex-1 truncate text-[15px] text-ink normal-case tracking-normal">
          {app.title || 'App'}
        </span>
        {readOnly ? <span>read only</span> : null}
        {readOnly || p.noSandbox ? null : (
          <button
            type="button"
            data-testid="inspector-run"
            onClick={() => {
              if (save()) p.onRun();
            }}
            className="rounded px-1.5 uppercase hover:text-ink"
          >
            Run
          </button>
        )}
        <button
          type="button"
          data-testid="inspector-close"
          onClick={close}
          className="rounded px-1.5 uppercase hover:text-ink"
        >
          Close
        </button>
      </div>
      {p.noSandbox ? (
        <p
          className="flex-none border-line border-b px-3 py-1 text-ink-dim"
          data-testid="no-sandbox"
        >
          Apps need a sandbox origin to run: this server has none, so apps show as cards. Open the
          board in the desktop app, or ask its operator to set one.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="flex-none border-line border-b bg-surface-raised px-3 py-1 text-ink"
        >
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        {app?.mcp ? (
          // An MCP app's view comes from its server: nothing to edit here, an
          // update to apply when its server serves a new one (canvas/app-sources).
          <div
            className="flex min-w-0 flex-[3] flex-col gap-2 border-line border-r bg-surface-sunken px-3 py-2"
            data-testid="inspector-mcp"
          >
            <Section title="From an MCP server" testid="mcp-source">
              <li className="break-all text-ink">
                {inv?.mcp?.server ?? 'Its connection was removed.'}
              </li>
              <li className="break-all text-ink-dim">View {app.mcp.resourceUri}</li>
              <li className="text-ink-dim">
                {app.mcp.tool
                  ? `Tool ${app.mcp.tool}: runs on the server, with no view open.`
                  : 'Its view runs here, and calls its server for what it needs.'}
              </li>
              <li className="font-mono text-[12px] text-ink-dim">
                Pinned {app.mcp.sha256.slice(0, 12)}
              </li>
            </Section>
            {inv?.mcp?.updateAvailable ? (
              <div className="flex items-center gap-2" data-testid="mcp-update">
                <span className="text-ink">Update available</span>
                <button
                  type="button"
                  disabled={readOnly}
                  className="rounded-[4px] border border-line-strong px-2 text-ink-dim enabled:hover:bg-surface-raised enabled:hover:text-ink"
                  onClick={() =>
                    commit({
                      type: 'app.set',
                      itemId: item.id,
                      mcpSha256: inv.mcp?.updateAvailable as string,
                    })
                  }
                >
                  Apply
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <textarea
            ref={sourceField}
            aria-label="App source"
            data-testid="inspector-source"
            value={source}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
            className="min-w-0 flex-[3] resize-none border-0 border-line border-r bg-surface-sunken px-3 py-2 font-mono text-[12px] text-ink leading-[1.45] outline-none"
          />
        )}
        <div className="flex min-w-0 flex-[2] flex-col gap-4 overflow-auto px-3 py-2">
          <Section title="Inputs" testid="inspector-inputs">
            {inv === null ? (
              <p className="text-ink-dim">
                {unavailable ? 'Not shown on this board.' : 'Reading…'}
              </p>
            ) : null}
            {inv?.inputs.length === 0 && declaredOpen.length === 0 ? (
              <p className="text-ink-dim">Nothing feeds it. Alt-drag an item onto it.</p>
            ) : null}
            {inv?.inputs.map((r) => {
              const source = r.itemId ? p.doc.item(r.itemId as ItemId) : undefined;
              return (
                <li
                  key={r.linkId ?? `literal:${r.name}`}
                  className="flex flex-col gap-0.5"
                  data-testid="input-row"
                >
                  <div className="flex items-center gap-1">
                    <NameField
                      value={r.name}
                      disabled={readOnly}
                      onCommit={(n) =>
                        r.origin === 'link' ? renameLink(r, n) : renameLiteral(r.name, n)
                      }
                    />
                    {readOnly ? null : (
                      <button
                        type="button"
                        aria-label={`Remove ${r.name}`}
                        className="ml-auto rounded px-1 text-ink-dim hover:text-ink"
                        onClick={() => {
                          if (r.origin === 'link' && r.linkId)
                            commit({ type: 'link.delete', linkId: r.linkId as LinkId });
                          else {
                            const { [r.name]: _, ...rest } = literals;
                            setLiterals(rest);
                          }
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {r.origin === 'link' ? (
                    <div className="flex items-center gap-1 text-[12px] text-ink-dim">
                      <span>← {r.ref} ·</span>
                      <select
                        aria-label={`${r.name}: view`}
                        value={r.view}
                        disabled={readOnly}
                        onChange={(e) =>
                          commit({
                            type: 'link.set',
                            linkId: r.linkId as LinkId,
                            linkType: 'feeds',
                            view: e.target.value,
                          })
                        }
                        className="rounded border border-line bg-surface px-1 text-ink"
                      >
                        {(source ? viewsOf(source.content) : [r.view ?? '']).map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                      <PathField
                        row={r}
                        disabled={readOnly}
                        onCommit={(path) =>
                          commit({
                            type: 'link.set',
                            linkId: r.linkId as LinkId,
                            linkType: 'feeds',
                            path,
                          })
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-[12px] text-ink-dim">
                      <span>literal =</span>
                      <TextField
                        label={`${r.name}: value`}
                        value={JSON.stringify(r.value)}
                        disabled={readOnly}
                        onCommit={(t) => setLiteral(r.name, t)}
                      />
                    </div>
                  )}
                  {r.origin === 'link' ? (
                    <span
                      className="truncate font-mono text-[12px] text-ink-dim"
                      data-testid="input-value"
                    >
                      {r.missing ? 'field missing' : preview(r.value)}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {declaredOpen.map((d) => (
              <li
                key={`declared:${d.name}`}
                className="flex flex-col text-ink-dim"
                data-testid="input-declared"
              >
                <span>
                  <span className="text-ink">{d.name}</span> · not connected
                </span>
                {d.description ? <span className="text-[12px]">{d.description}</span> : null}
              </li>
            ))}
            {readOnly ? null : adding ? (
              <NewLiteral
                onAdd={(name, text) => {
                  if (nameOk(name, '') && setLiteral(name, text)) setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <li>
                <button
                  type="button"
                  className="rounded text-[12px] text-ink-dim uppercase hover:text-ink"
                  onClick={() => setAdding(true)}
                >
                  + Literal
                </button>
              </li>
            )}
          </Section>
          <Section title="Outputs" testid="inspector-outputs">
            <li className="text-ink" data-testid="output-status">
              {why ? 'stale' : label.text}
              {why ? <span className="text-ink-dim"> ({why})</span> : null}
              {inv?.held ? (
                <span className="block text-[12px] text-ink-dim" data-testid="output-held">
                  Not run automatically: {inv.held}.
                </span>
              ) : null}
            </li>
            {output ? (
              <>
                <li className="text-[12px] text-ink-dim" data-testid="output-credit">
                  {[`v${output.version}`, inv?.ranBy, ago(inv?.ranAt ?? output.at)]
                    .filter(Boolean)
                    .join(' · ')}
                </li>
                {output.status === 'error' && output.error ? (
                  <li className="text-ink">{output.error}</li>
                ) : null}
                {Object.entries(output.outputs).map(([k, v]) => (
                  <li key={k} className="flex gap-2 font-mono text-[12px]">
                    <span className="text-ink-dim">{k}</span>
                    <span className="truncate">{preview(v)}</span>
                  </li>
                ))}
              </>
            ) : (
              <li className="text-ink-dim">It has not run yet.</li>
            )}
            {inv?.feeds.length ? (
              <li className="text-ink-dim" data-testid="output-feeds">
                → {inv.feeds.map((f) => f.ref).join(', ')}
              </li>
            ) : null}
            {inv?.updates.length ? (
              <li className="text-ink-dim" data-testid="output-updates">
                updates {inv.updates.map((f) => f.ref).join(', ')}
              </li>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testid}>
      <h3 className="mb-1 text-[12px] text-ink-dim uppercase tracking-[0.025em]">{title}</h3>
      <ul className="flex flex-col gap-2">{children}</ul>
    </section>
  );
}

/** A small field that commits on Enter or when it loses focus, and reverts on Escape. */
export function TextField({
  label,
  value,
  disabled,
  list,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  list?: string;
  placeholder?: string;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text !== value) onCommit(text);
  };
  return (
    <input
      aria-label={label}
      value={text}
      disabled={disabled}
      list={list}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape' && text !== value) {
          e.preventDefault();
          e.stopPropagation();
          setText(value);
        }
      }}
      className="min-w-0 flex-1 rounded border border-line bg-surface px-1 font-mono text-[12px] text-ink outline-none focus:border-accent disabled:border-transparent"
    />
  );
}

function NameField(p: { value: string; disabled: boolean; onCommit: (name: string) => void }) {
  return <TextField label={`Input ${p.value}: name`} {...p} />;
}

/** A field within the view: typed, or picked from the fields its current value has. */
function PathField({
  row,
  disabled,
  onCommit,
}: {
  row: Row;
  disabled: boolean;
  onCommit: (path: string) => void;
}) {
  const list = `fields-${row.linkId}`;
  return (
    <>
      <TextField
        label={`${row.name}: field`}
        value={row.path ?? ''}
        placeholder="whole view"
        disabled={disabled}
        list={list}
        onCommit={onCommit}
      />
      <datalist id={list}>
        {(row.fields ?? []).map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </>
  );
}

function NewLiteral({
  onAdd,
  onCancel,
}: {
  onAdd: (name: string, text: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  return (
    <li className="flex items-center gap-1">
      <input
        aria-label="New literal: name"
        placeholder="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-24 rounded border border-line bg-surface px-1 font-mono text-[12px] outline-none focus:border-accent"
      />
      <span className="text-ink-dim">=</span>
      <input
        aria-label="New literal: value"
        placeholder="0.05"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onAdd(name, text);
        }}
        className="min-w-0 flex-1 rounded border border-line bg-surface px-1 font-mono text-[12px] outline-none focus:border-accent"
      />
      <button
        type="button"
        className="rounded px-1 text-[12px] uppercase hover:text-ink"
        onClick={() => onAdd(name, text)}
      >
        Add
      </button>
      <button
        type="button"
        aria-label="Cancel"
        className="rounded px-1 text-ink-dim hover:text-ink"
        onClick={onCancel}
      >
        ×
      </button>
    </li>
  );
}

export interface AppInspectorDeps {
  readonly doc: CanvasDocument;
  readonly camera: Camera;
  readonly size: ViewportSize;
  readonly boardId: string | undefined;
  readonly readOnly: boolean;
  readonly select: (ids: ItemId[]) => void;
  readonly notify: (message: string) => void;
  readonly settled: () => Promise<void>;
  readonly commit: (...bodies: CanvasOperationBody[]) => void;
  readonly noSandbox: boolean;
  readonly run: (id: ItemId) => void;
}

/** Which app's inspector is open, and its overlay (canvas/app-inspector). */
export function useAppInspector(d: AppInspectorDeps) {
  const [open, setOpen] = useState<ItemId | null>(null);
  /** Bumped by every applied operation while it is open: it reads the board again. */
  const [applied, setApplied] = useState(0);
  const item = open ? d.doc.item(open) : undefined;
  // Deleted, or no longer an app: nothing to inspect.
  useEffect(() => {
    if (open && item?.content.kind !== 'app') setOpen(null);
  }, [open, item]);

  const inspect = (target: CanvasItem) => {
    if (target.content.kind !== 'app' || !d.boardId) return;
    if (!canvasAppsOn()) {
      d.notify('Canvas apps are a Labs experiment: turn them on in Settings → Labs.');
      return;
    }
    d.select([target.id]);
    setOpen(target.id);
  };
  const noteApplied = () => {
    if (open) setApplied((n) => n + 1);
  };

  let overlay: ReactNode = null;
  if (item && d.boardId) {
    const t = item.transform;
    const corner = worldToScreen(d.camera, d.size, localToWorld(t, { x: 0, y: 0 }));
    overlay = (
      <AppInspector
        key={item.id}
        item={item}
        doc={d.doc}
        revision={applied}
        boardId={d.boardId}
        readOnly={d.readOnly}
        at={{
          x: corner.x,
          y: corner.y,
          width: t.width * d.camera.zoom,
          height: t.height * d.camera.zoom,
        }}
        state={appStates(d.doc).get(item.id)}
        settled={d.settled}
        commit={d.commit}
        onClose={() => setOpen(null)}
        noSandbox={d.noSandbox}
        onRun={() => d.run(item.id)}
      />
    );
  }
  return { inspect, noteApplied, overlay, open };
}
