import type { CanvasDocument, CanvasHistory } from '@visarium/canvas-core';
import type { ReactNode } from 'react';
import { useUiStore } from '~/app/ui-store';

/**
 * The canvas' own chrome: what does NOT depend on what is selected.
 *
 * The tool, a new checklist, undo and redo, and framing — and that list is the rule. Front,
 * back, group and ungroup left in M08 for the selection toolbar, which is
 * anchored to the thing they act on; two ways to press Front is the seam that
 * milestone closed, and nothing that operates on a selection comes back here.
 *
 * Everything here goes through `commit`, so undo covers it like anything else.
 */
export function CanvasToolbar({
  history,
  onHistory,
  onFrame,
  onChecklist,
}: {
  history: CanvasHistory;
  onHistory: () => void;
  /** Moves the camera and nothing else, so it is not a `commit` and takes no undo slot. */
  onFrame: () => void;
  /** Makes an empty checklist mid-view, its title open: the one object type a person could not otherwise discover how to make. */
  onChecklist: () => void;
}) {
  const selectionSize = useUiStore((s) => s.selectedItemIds.size);
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);

  return (
    <div className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded border border-line-strong bg-surface/95 px-1 py-1 text-[11px]">
      <Button onClick={() => setTool('select')} pressed={tool === 'select'}>
        Select
      </Button>
      <Button onClick={() => setTool('pan')} pressed={tool === 'pan'}>
        Pan
      </Button>
      <Divider />
      <Button onClick={onChecklist} title="New checklist">
        Checklist
      </Button>
      <Divider />
      <Button
        onClick={() => {
          if (history.undo()) onHistory();
        }}
        disabled={!history.canUndo}
      >
        Undo
      </Button>
      <Button
        onClick={() => {
          if (history.redo()) onHistory();
        }}
        disabled={!history.canRedo}
      >
        Redo
      </Button>
      <Divider />
      {/*
       * One fixed word: a label that changed width ("Frame board" / "Frame
       * selection") moved every control in this centred bar. "Fit", not
       * "Frame": the selection toolbar's Frame makes a group into a frame.
       */}
      <Button onClick={onFrame} title={selectionSize > 0 ? 'Fit selection (F)' : 'Fit board (F)'}>
        Fit
      </Button>
    </div>
  );
}

/**
 * Highest and lowest z on the board.
 *
 * Stays here and stays exported: the selection toolbar's Front, Back and
 * Duplicate all need it, and it is about the document rather than about either
 * bar.
 *
 * ponytail: a full scan per reorder — O(n), so ~100k comparisons on the torture
 * board, on an explicit click. If it ever shows up in a profile, the document
 * can track its own extremes on `#put`.
 */
export function zEdge(doc: CanvasDocument): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const item of doc.items()) {
    if (item.z < min) min = item.z;
    if (item.z > max) max = item.z;
  }
  return { min, max };
}

function Button({
  onClick,
  disabled,
  pressed,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      className={`rounded px-2 py-0.5 disabled:text-ink-disabled ${
        pressed
          ? 'bg-surface-raised text-ink'
          : 'text-ink-dim enabled:hover:bg-surface-raised enabled:hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-line" />;
}
