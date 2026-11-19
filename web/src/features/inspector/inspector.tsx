/**
 * The inspector (spec: canvas/inspector): the board's model, links and
 * operations, beside the board, in dev builds only.
 *
 * This module is reached only through a `DEVTOOLS ? lazy(import(...)) : null`
 * in the canvas surface, so a production build never emits it. The marker in
 * `data-testid` below is what `scripts/check-bundle.mjs` looks for.
 */

import type {
  CanvasDocument,
  CanvasItem,
  CanvasOperationBody,
  ItemId,
  Link,
  LinkId,
} from '@visarium/canvas-core';
import { useState, useSyncExternalStore } from 'react';
import { personName } from '~/api/boards';
import { INSPECTOR_WIDTH } from '~/devtools';
import type { DrawnLink } from '../canvas/objects/links';
import type { ObjectLayouts } from '../canvas/objects/store';
import type { LogEntry, OpLog } from './log';

export interface InspectorProps {
  readonly doc: CanvasDocument;
  readonly objects: ObjectLayouts;
  readonly selection: ReadonlySet<ItemId>;
  readonly selectedLink: LinkId | null;
  readonly drawnLinks: () => readonly DrawnLink[];
  readonly log: OpLog | null;
  readonly commit: (...bodies: CanvasOperationBody[]) => void;
}

type Tab = 'selected' | 'tables' | 'log' | 'console';

export default function Inspector(props: InspectorProps) {
  const [tab, setTab] = useState<Tab>('selected');
  return (
    <aside
      data-testid="visarium-inspector"
      aria-label="Inspector"
      className="absolute inset-y-0 right-0 flex flex-col border-line border-l bg-surface text-[12px] text-ink"
      style={{ width: INSPECTOR_WIDTH }}
    >
      <div role="tablist" className="flex gap-1 border-line border-b px-2 py-1.5">
        {(['selected', 'tables', 'log', 'console'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className="rounded px-2 py-0.5 capitalize text-ink-dim aria-selected:bg-surface-raised aria-selected:text-ink"
          >
            {t}
          </button>
        ))}
        <span className="ml-auto self-center text-[11px] text-ink-dim">` to close</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'selected' && <Selected {...props} />}
        {tab === 'tables' && <Tables {...props} />}
        {tab === 'log' && <Log log={props.log} />}
        {tab === 'console' && <Console commit={props.commit} />}
      </div>
    </aside>
  );
}

const Code = ({ value }: { value: unknown }) => (
  <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface-sunken p-2 font-mono text-[11px] leading-snug">
    {JSON.stringify(value, null, 2)}
  </pre>
);

const Heading = ({ children }: { children: string }) => (
  <h3 className="mt-3 mb-1 font-medium text-[11px] text-ink-dim uppercase tracking-wide">
    {children}
  </h3>
);

const anchorText = (a: Link['from']) => `${short(a.itemId)}${a.element ? `#${a.element}` : ''}`;
const short = (id: string) => id.slice(-6);
const isBroken = (d: DrawnLink | undefined) => d !== undefined && (d.from.broken || d.to.broken);

/** The model as stored: what the server holds and what an agent will read. */
function modelOf(item: CanvasItem) {
  return {
    id: item.id,
    content: item.content,
    transform: item.transform,
    z: item.z,
    revision: item.revision,
    appearance: item.appearance,
    ...(item.groupId ? { groupId: item.groupId } : {}),
  };
}

function Selected({ doc, objects, selection, selectedLink, drawnLinks }: InspectorProps) {
  const drawn = new Map(drawnLinks().map((d) => [d.link.id, d]));
  if (selectedLink) {
    const link = doc.link(selectedLink);
    if (!link) return <p className="text-ink-dim">That link is gone.</p>;
    const d = drawn.get(link.id);
    return (
      <>
        <p>
          Link <span className="font-mono">{anchorText(link.from)}</span> —{link.linkType}→{' '}
          <span className="font-mono">{anchorText(link.to)}</span>
          {isBroken(d) ? <strong className="ml-1 text-ink-dim">broken</strong> : null}
        </p>
        <Code
          value={{ ...link, broken: d ? { from: d.from.broken, to: d.to.broken } : 'not drawn' }}
        />
      </>
    );
  }
  const [only] = selection;
  const item = selection.size === 1 && only ? doc.item(only) : undefined;
  if (!item) {
    return (
      <p className="text-ink-dim">
        {selection.size > 1 ? `${selection.size} items selected.` : 'Select an item or a link.'}
      </p>
    );
  }
  const view = objects.view(item);
  const links = doc.linksOf(item.id);
  const elements = view ? [...view.layout.elements.keys()] : [];
  return (
    <>
      <Code value={modelOf(item)} />
      {item.content.kind === 'diagram' && (
        <>
          <Heading>Elements</Heading>
          {elements.length === 0 ? (
            <p className="text-ink-dim">{view ? 'No named elements.' : 'Not laid out yet.'}</p>
          ) : (
            <ul className="font-mono text-[11px]">
              {elements.map((name) => (
                <li key={name}>
                  {name}{' '}
                  <span className="text-ink-dim">
                    {
                      links.filter((l) =>
                        [l.from, l.to].some((a) => a.itemId === item.id && a.element === name),
                      ).length
                    }{' '}
                    links
                  </span>
                </li>
              ))}
            </ul>
          )}
          {view?.error ? (
            <p className="mt-1 text-ink-dim">Source error: {view.error.split('\n')[0]}</p>
          ) : null}
        </>
      )}
      <Heading>Links</Heading>
      {links.length === 0 ? (
        <p className="text-ink-dim">None.</p>
      ) : (
        <ul className="font-mono text-[11px]">
          {links.map((l) => (
            <li key={l.id}>
              {anchorText(l.from)} —{l.linkType}→ {anchorText(l.to)}
              {isBroken(drawn.get(l.id)) ? (
                <strong className="ml-1 text-ink-dim">broken</strong>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const Cell = ({ children }: { children: React.ReactNode }) => (
  <td className="border-line border-b px-1.5 py-0.5 align-top whitespace-nowrap">{children}</td>
);
const Th = ({ children }: { children: string }) => (
  <th className="border-line border-b px-1.5 py-0.5 text-left font-medium text-ink-dim">
    {children}
  </th>
);

/** The board as the server stores it: one row per item, one per link. */
function Tables({ doc }: InspectorProps) {
  const items = [...doc.items()];
  const links = [...doc.links()];
  const body = (item: CanvasItem) => {
    const c = item.content;
    if (c.kind === 'note' || c.kind === 'diagram')
      return c.source.slice(0, 24).replaceAll('\n', '⏎');
    if (c.kind === 'checklist') return `${c.title || '(untitled)'} · ${c.tasks.length} tasks`;
    return '';
  };
  return (
    <div className="overflow-x-auto font-mono text-[11px]">
      <Heading>canvas_item</Heading>
      <table data-testid="inspector-items">
        <thead>
          <tr>
            <Th>id</Th>
            <Th>kind</Th>
            <Th>lang</Th>
            <Th>asset</Th>
            <Th>body</Th>
            <Th>w×h</Th>
            <Th>rev</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <Cell>{short(i.id)}</Cell>
              <Cell>{i.content.kind}</Cell>
              <Cell>{i.content.kind === 'diagram' ? i.content.lang : ''}</Cell>
              <Cell>{i.content.kind === 'image' ? short(i.content.asset.assetId) : ''}</Cell>
              <Cell>{body(i)}</Cell>
              <Cell>
                {Math.round(i.transform.width)}×{Math.round(i.transform.height)}
              </Cell>
              <Cell>{i.revision ?? ''}</Cell>
            </tr>
          ))}
        </tbody>
      </table>
      <Heading>canvas_link</Heading>
      <table data-testid="inspector-links">
        <thead>
          <tr>
            <Th>id</Th>
            <Th>from</Th>
            <Th>element</Th>
            <Th>to</Th>
            <Th>element</Th>
            <Th>type</Th>
            <Th>by</Th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.id}>
              <Cell>{short(l.id)}</Cell>
              <Cell>{short(l.from.itemId)}</Cell>
              <Cell>{l.from.element ?? ''}</Cell>
              <Cell>{short(l.to.itemId)}</Cell>
              <Cell>{l.to.element ?? ''}</Cell>
              <Cell>{l.linkType}</Cell>
              <Cell>{personName(l.by) ?? (l.by ? short(l.by) : '')}</Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NO_ENTRIES: readonly LogEntry[] = [];
const noSubscription = () => () => {};

/** Every operation sent and received, newest first, with what became of it. */
function Log({ log }: { log: OpLog | null }) {
  const entries = useSyncExternalStore(
    log?.subscribe ?? noSubscription,
    log?.entries ?? (() => NO_ENTRIES),
  );
  if (!log) return <p className="text-ink-dim">This board does not persist, so nothing is sent.</p>;
  if (entries.length === 0) return <p className="text-ink-dim">No operations yet.</p>;
  return (
    <ol data-testid="inspector-log" className="space-y-1 font-mono text-[11px]">
      {entries.map((e) => {
        const target =
          'itemId' in e.body
            ? e.body.itemId
            : 'linkId' in e.body
              ? e.body.linkId
              : 'groupId' in e.body
                ? e.body.groupId
                : '';
        const by =
          'by' in e.body && typeof e.body.by === 'string'
            ? (personName(e.body.by) ?? short(e.body.by))
            : undefined;
        return (
          <li key={e.seq} data-outcome={e.outcome}>
            <span className="text-ink-dim tabular-nums">{e.at.toTimeString().slice(0, 8)}</span>{' '}
            {e.dir === 'sent' ? 'you →' : `← ${by ?? 'another client'}`} {e.body.type}{' '}
            <span className="text-ink-dim">{target ? short(String(target)) : ''}</span>{' '}
            <strong className={e.outcome === 'rejected' ? 'text-ink' : 'text-ink-dim'}>
              {e.outcome}
            </strong>
            {e.message ? <div className="text-ink-dim">{e.message}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

const EXAMPLE = '[\n  { "type": "task.set", "itemId": "…", "taskId": "t1", "state": "done" }\n]';

/**
 * Raw operations through the board's own path: the same history, persistence
 * and broadcast as a click, so the result is exactly what a click would make.
 * Takes one body, an array of bodies, or `{ "operations": [{ "body": … }] }`.
 */
function Console({ commit }: { commit: InspectorProps['commit'] }) {
  const [text, setText] = useState(EXAMPLE);
  const [status, setStatus] = useState('');
  const send = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setStatus(`Not JSON: ${(e as Error).message}`);
      return;
    }
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { operations?: unknown })?.operations)
        ? (parsed as { operations: { body: unknown }[] }).operations.map((o) => o.body)
        : [parsed];
    if (!raw.every((b) => typeof (b as { type?: unknown })?.type === 'string')) {
      setStatus('Every operation needs a "type".');
      return;
    }
    commit(...(raw as CanvasOperationBody[]));
    setStatus(
      `Applied ${raw.length} operation${raw.length === 1 ? '' : 's'}; see Log for the server's answer.`,
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Operations as JSON"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        className="h-48 resize-y rounded border border-line bg-surface-sunken p-2 font-mono text-[11px] text-ink outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={send}
        className="self-start rounded border border-line-strong px-2 py-0.5 hover:border-accent"
      >
        Send
      </button>
      {status ? (
        <p role="status" className="text-ink-dim">
          {status}
        </p>
      ) : null}
    </div>
  );
}
