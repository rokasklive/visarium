import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useRecentAssets } from '~/api/assets';
import { useBoardDocument } from '~/api/boards';
import { useElementSize } from '~/components/use-element-size';
import { BENCH_IMAGES } from '~/features/canvas/bench-images';
import { buildBoard } from '~/features/canvas/board-fixture';
import { CanvasSurface } from '~/features/canvas/canvas-surface';
import { ShareButton } from '~/features/sharing/share-panel';

export const Route = createFileRoute('/boards/$boardId')({
  component: BoardCanvas,
  /**
   * `?budget=<MB>` caps decoded-bitmap memory for this board.
   *
   * Q7 requires the budget to be a parameter rather than a constant, and the
   * only way to observe eviction on a real board is to set it below what that
   * board wants. Absent, the default in bitmap-cache.ts applies.
   */
  validateSearch: (search: Record<string, unknown>): { budget?: number } =>
    typeof search.budget === 'string' && Number.isFinite(Number(search.budget))
      ? { budget: Number(search.budget) }
      : {},
});

/**
 * The generated boards, which stay generated.
 *
 * M01's and M02's numbers are reproducible only if the boards they were measured
 * on are reproducible, and a 100,000-item board is not something to persist in
 * order to benchmark drawing it. These four names never touch the server; every
 * other id is a real board.
 */
const SIZES: Record<string, number> = {
  smoke: 10_000,
  small: 1_000,
  large: 100_000,
  /**
   * The memory board: built from whatever real assets the library holds, so
   * every item carries a real intrinsic size and the tiers the cache ends up
   * holding are the tiers a real board would hold. Eight reused fixtures cannot
   * exercise a byte budget — see OPEN_QUESTIONS Q7.
   */
  assets: 2_000,
};

function BoardCanvas() {
  const { boardId } = Route.useParams();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const { budget } = Route.useSearch();

  const bench = boardId in SIZES;
  const fromLibrary = boardId === 'assets';
  const assets = useRecentAssets(200, fromLibrary);
  const loaded = useBoardDocument(boardId, !bench);

  const generated = useMemo(
    () =>
      bench
        ? buildBoard({
            count: SIZES[boardId] ?? 10_000,
            seed: 1,
            groupSize: 6,
            ...(fromLibrary ? { assets: assets.data ?? [] } : { images: BENCH_IMAGES }),
          })
        : undefined,
    [bench, boardId, fromLibrary, assets.data],
  );

  const doc = generated ?? loaded.data;

  return (
    <div ref={ref} className="absolute inset-0 bg-surface-sunken">
      {/*
        A board that failed to load must never look like an empty board: they are
        indistinguishable on screen, and one of them invites re-creating work
        that already exists.
      */}
      {loaded.isError && <Notice>this board could not be loaded — reload to try again</Notice>}
      {!doc && !loaded.isError && <Notice>loading…</Notice>}
      {doc && size.width > 0 && (
        <CanvasSurface
          doc={doc}
          width={size.width}
          height={size.height}
          {...(bench ? {} : { boardId })}
          {...(budget && budget > 0 ? { bitmapBudgetBytes: budget * 1024 * 1024 } : {})}
        />
      )}
      {!bench && <ShareButton boardId={boardId} />}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="absolute inset-0 flex items-center justify-center text-[11px] text-ink-dim">
      {children}
    </p>
  );
}
