/**
 * What a data link carries, adjusted where it is drawn (canvas/links): a click
 * on a selected `feeds` link's label opens this beside it, with the view, the
 * field within it and the input name the app sees. An `updates` link shows
 * its target and what the app's last run changed there. Every change is one
 * undoable `link.set`, the same the inspector makes.
 */

import type {
  CanvasDocument,
  CanvasOperationBody,
  Link,
  ViewportSize,
} from '@visarium/canvas-core';
import { useEffect, useRef, useState } from 'react';
import { type AppInventory, appInventory } from '~/api/boards';
import { TextField } from './app-inspector';
import { viewsOf } from './links';

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function LinkPopover({
  link,
  doc,
  boardId,
  at,
  size,
  revision,
  settled,
  commit,
  onClose,
}: {
  link: Link;
  doc: CanvasDocument;
  boardId: string;
  /** Screen px of the label's centre. */
  at: { x: number; y: number };
  size: ViewportSize;
  /** Bumps with every applied change. */
  revision: number;
  settled: () => Promise<void>;
  commit: (...bodies: CanvasOperationBody[]) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const [inv, setInv] = useState<AppInventory | null>(null);
  const [error, setError] = useState('');
  const app = link.linkType === 'feeds' ? link.to.itemId : link.from.itemId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger
  useEffect(() => {
    let current = true;
    void settled()
      .then(() => appInventory(boardId, app))
      .catch(() => null)
      .then((i) => {
        if (current) setInv(i);
      });
    return () => {
      current = false;
    };
  }, [revision, boardId, app]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, []);

  const row = inv?.inputs.find((r) => r.linkId === link.id);
  const set = (change: { view?: string; path?: string; name?: string }) =>
    commit({ type: 'link.set', linkId: link.id, linkType: 'feeds', ...change });
  const rename = (name: string) => {
    if (!row || name === row.name) return;
    if (!NAME.test(name)) {
      setError(`An input name is 1-64 letters, digits, '_', '-' or '.'; '${name}' is not.`);
      return;
    }
    if (inv?.inputs.some((r) => r.name === name)) {
      setError(`This app already has an input named '${name}'.`);
      return;
    }
    setError('');
    set({ name: name === `${row.ref}.${row.view}` ? '' : name });
  };

  const source = doc.item(link.from.itemId);
  const target = doc.item(link.to.itemId);
  // Kept on screen: it opens below the label, or above it near the bottom edge.
  const width = 280;
  const left = Math.min(Math.max(8, at.x - width / 2), size.width - width - 8);
  const below = at.y + 200 < size.height;

  const changed =
    link.linkType === 'updates' && target?.content.kind === 'checklist'
      ? target.content.tasks.filter((t) => t.byApp === app)
      : [];

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="What this link carries"
      data-testid="link-popover"
      className="absolute flex flex-col gap-2 rounded border border-line-strong bg-surface-raised px-3 py-2 text-[13px] text-ink"
      style={{ left, width, ...(below ? { top: at.y + 8 } : { bottom: size.height - at.y + 20 }) }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      {link.linkType === 'feeds' ? (
        <>
          <label className="flex items-center gap-2">
            <span className="w-12 text-[12px] text-ink-dim uppercase">View</span>
            <select
              aria-label="View"
              value={link.view ?? ''}
              onChange={(e) => set({ view: e.target.value })}
              className="flex-1 rounded border border-line bg-surface px-1 text-ink"
            >
              {(source ? viewsOf(source.content) : [link.view ?? '']).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <span className="w-12 text-[12px] text-ink-dim uppercase">Field</span>
            <TextField
              label="Field"
              value={link.path ?? ''}
              placeholder="whole view"
              disabled={false}
              list={`popover-fields-${link.id}`}
              onCommit={(path) => set({ path })}
            />
            <datalist id={`popover-fields-${link.id}`}>
              {(row?.fields ?? []).map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 text-[12px] text-ink-dim uppercase">Name</span>
            <TextField
              label="Input name"
              value={row?.name ?? link.name ?? ''}
              disabled={!row}
              onCommit={rename}
            />
          </div>
          {error ? (
            <p role="alert" className="text-ink">
              {error}
            </p>
          ) : null}
          <p className="truncate font-mono text-[12px] text-ink-dim" data-testid="link-value">
            {row ? (row.missing ? 'field missing' : JSON.stringify(row.value)) : ''}
          </p>
        </>
      ) : (
        <>
          <p>
            Updates{' '}
            {inv?.updates.find((u) => u.itemId === link.to.itemId)?.ref ??
              (target?.content.kind === 'checklist' ? target.content.title : 'a checklist')}
          </p>
          {changed.length ? (
            <ul className="flex flex-col gap-0.5 text-[12px]" data-testid="link-changes">
              {changed.map((t) => (
                <li key={t.id}>
                  <span className="text-ink-dim">{t.state}</span> {t.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-ink-dim">Its runs have changed nothing here yet.</p>
          )}
        </>
      )}
    </div>
  );
}
