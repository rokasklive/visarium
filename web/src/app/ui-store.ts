import { create } from 'zustand';
import { SYNCED, type SyncStatus } from '~/features/canvas/board-sync';
import type { DraggedAsset } from '~/features/canvas/capture';
import type { ConnectionState } from '~/features/canvas/realtime';
import type { SearchResult } from '~/features/canvas/search';
import { IDLE, type UploadFailure, type UploadStatus } from '~/features/canvas/upload';

/**
 * Transient UI state — and nothing else.
 *
 * What belongs here: which tool is active, whether a panel is open, what the
 * context menu is showing. What must never come here: canvas items. A board of
 * 100,000 items lives in a `CanvasDocument` inside canvas-core, because putting
 * it in a store would mean re-rendering React for every pointer move.
 *
 * `inspectorOpen` and `toggleInspector` were here from bootstrap and were read
 * by nothing. M08 decided there is no inspector column — the acts of a selection
 * belong to a surface anchored to that selection — so they left with it. State
 * for a panel that will not be built is not a placeholder, it is a claim the
 * code makes about the product and the product does not.
 *
 * See docs/architecture/CANVAS_CORE.md, "State ownership".
 */

export type Tool = 'select' | 'pan';

interface UiState {
  tool: Tool;
  /**
   * Upload progress. Transient by definition and read by the status strip,
   * which is outside the canvas — so it belongs here. The items being uploaded
   * do not: those are in the CanvasDocument, where every item is.
   */
  uploads: UploadStatus;
  /**
   * A reference that did not land. Kept until acknowledged: routine success is
   * silent, but an image the user believes they filed and did not is not
   * routine, and a toast that has already faded cannot be acted on.
   */
  uploadFailures: readonly UploadFailure[];
  /**
   * Whether the board is caught up with the server.
   *
   * The board itself is never in here — this is a count and a flag, read by the
   * status strip. North star 3 means it is a readout and not a save button, and
   * the only reason it is visible at all is that a board the user believes is
   * stored and is not is the one failure this product cannot swallow.
   */
  sync: SyncStatus;
  /**
   * Whether other people would be visible if there were any.
   *
   * Distinct from `sync` on purpose, and the distinction is the whole point of
   * putting durable writes on REST: the socket can be down while persistence is
   * perfectly healthy. The status strip has to say that in a way that does not
   * read as unsaved work, because it is not.
   */
  /** `idle` until a board opens a socket, and again once it closes: no socket is not a lost one. */
  connection: ConnectionState | 'idle';
  /** People with the open board on screen through a read-only share link (ADR-0026). */
  linkViewers: number;
  /**
   * An agent on the open board is working: it has a live focus, or had one
   * moments ago (canvas/presence-indicators). Read by the wordmark in the shell,
   * which is outside the canvas, so it lives here; the presence it is derived
   * from stays in the canvas.
   */
  agentWorking: boolean;
  /**
   * What the last outward gesture could not do, and what to do instead.
   *
   * Three outcomes have to be sayable — the clipboard changed the format to PNG,
   * this origin has no clipboard at all, the originals were not ready — and a
   * copy that carried the original's format is not one of them. Routine success
   * is silent, exactly as it is for an upload.
   *
   * Not `uploadFailures`: that shape is `{ id, name, reason }` and the strip
   * counts it. Not a toast: nothing in this product has one, and a notice that
   * fades cannot be read by someone who looked away. One line in the status
   * strip, replaced by the next gesture and cleared by a dismiss.
   */
  interchangeNotice: string | null;
  /** Why the person was returned to the boards list, e.g. "Deleted by Claude for Rokas". */
  boardNotice: string | null;
  /**
   * The selection bar, folded down to its handle.
   *
   * Here rather than in the bar's own state because the bar unmounts whenever
   * nothing is selected — local state would unfold it again on every new
   * selection, which is the opposite of what somebody who folded it asked for.
   */
  toolbarCollapsed: boolean;
  sidebarOpen: boolean;
  /**
   * What the sidebar's library panel is filtered to.
   *
   * Here and NOT in the URL, which is the one place the M04 rule bends. The
   * board route's URL is the board; a sidebar filter is what someone is typing
   * while hunting for an image to place, not something they send to a
   * colleague — and putting it in the URL would rewrite the board's address on
   * every keystroke.
   */
  libraryFilter: { readonly q: string; readonly collection: string | undefined };
  /**
   * How the sidebar puts an asset on the open board.
   *
   * The panel and the canvas are siblings under the shell, so the canvas
   * registers this while it is mounted and clears it when it is not — which is
   * also how the panel knows whether there is a board to place onto at all. A
   * callback, not board state: nothing about the document comes near this store.
   */
  placeAssets: ((assets: readonly DraggedAsset[]) => void) | null;
  /** Selection is small and drives chrome, so the ids (not the items) live here. */
  selectedItemIds: ReadonlySet<string>;
  /**
   * The item in crop mode, if any (ADR-0029). Ephemeral and local: never
   * persisted, never broadcast. It only ever names the sole selected item, so
   * any selection change that would leave it naming something else clears it.
   */
  cropItemId: string | null;
  setCropItemId: (id: string | null) => void;
  /**
   * Quick search on the open board (canvas/quick-search): `null` while closed.
   * `results` are occurrences in board order; `current` indexes them.
   * `focus` counts open requests, so opening it again refocuses the field.
   */
  search: {
    readonly query: string;
    readonly results: readonly SearchResult[];
    readonly current: number;
    readonly focus: number;
  } | null;
  openSearch: () => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: readonly SearchResult[]) => void;
  stepSearch: (delta: 1 | -1) => void;
  closeSearch: () => void;
  setTool: (tool: Tool) => void;
  toggleSidebar: () => void;
  setSelection: (ids: Iterable<string>) => void;
  setLibraryFilter: (filter: { q: string; collection: string | undefined }) => void;
  setPlaceAssets: (place: ((assets: readonly DraggedAsset[]) => void) | null) => void;
  setUploads: (uploads: UploadStatus) => void;
  setSync: (sync: SyncStatus) => void;
  setConnection: (connection: ConnectionState | 'idle') => void;
  setLinkViewers: (count: number) => void;
  /** True lights the wordmark at once; false dims it after AGENT_LINGER_MS, unless work resumes. */
  setAgentWorking: (working: boolean) => void;
  addUploadFailure: (failure: UploadFailure) => void;
  dismissUploadFailures: () => void;
  /** `null` is the dismiss, and also what a gesture that went as promised writes. */
  setInterchangeNotice: (notice: string | null) => void;
  setBoardNotice: (notice: string | null) => void;
  toggleToolbar: () => void;
}

/**
 * How long the wordmark stays lit after an agent's last focus expires. An agent
 * thinks between calls for longer than a focus lasts (FOCUS_MS), and a mark
 * that blinks off between every call reads as broken rather than busy.
 */
export const AGENT_LINGER_MS = 10_000;
let agentLinger: ReturnType<typeof setTimeout> | undefined;

export const useUiStore = create<UiState>((set) => ({
  tool: 'select',
  sidebarOpen: true,
  libraryFilter: { q: '', collection: undefined },
  placeAssets: null,
  selectedItemIds: new Set(),
  cropItemId: null,
  search: null,
  uploads: IDLE,
  uploadFailures: [],
  sync: SYNCED,
  connection: 'idle',
  linkViewers: 0,
  agentWorking: false,
  interchangeNotice: null,
  boardNotice: null,
  toolbarCollapsed: false,
  setTool: (tool) => set({ tool }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSelection: (ids) =>
    set((s) => {
      const selectedItemIds = new Set(ids);
      const keep =
        s.cropItemId !== null && selectedItemIds.size === 1 && selectedItemIds.has(s.cropItemId);
      return { selectedItemIds, cropItemId: keep ? s.cropItemId : null };
    }),
  setCropItemId: (cropItemId) => set({ cropItemId }),
  openSearch: () =>
    set((s) => ({
      search: s.search
        ? { ...s.search, focus: s.search.focus + 1 }
        : { query: '', results: [], current: 0, focus: 1 },
    })),
  setSearchQuery: (query) => set((s) => (s.search ? { search: { ...s.search, query } } : {})),
  // A new result list starts at its first result (canvas/quick-search).
  setSearchResults: (results) =>
    set((s) => (s.search ? { search: { ...s.search, results, current: 0 } } : {})),
  stepSearch: (delta) =>
    set((s) => {
      const n = s.search?.results.length ?? 0;
      if (!s.search || n === 0) return {};
      return { search: { ...s.search, current: (s.search.current + delta + n) % n } };
    }),
  closeSearch: () => set({ search: null }),
  setLibraryFilter: (libraryFilter) => set({ libraryFilter }),
  // Wrapped: zustand reads a bare function argument as an updater, and this
  // value IS a function.
  setPlaceAssets: (placeAssets) => set(() => ({ placeAssets })),
  setUploads: (uploads) => set({ uploads }),
  setSync: (sync) => set({ sync }),
  setConnection: (connection) => set({ connection }),
  setLinkViewers: (linkViewers) => set({ linkViewers }),
  setAgentWorking: (working) => {
    clearTimeout(agentLinger);
    if (working) set({ agentWorking: true });
    else agentLinger = setTimeout(() => set({ agentWorking: false }), AGENT_LINGER_MS);
  },
  addUploadFailure: (failure) => set((s) => ({ uploadFailures: [...s.uploadFailures, failure] })),
  dismissUploadFailures: () => set({ uploadFailures: [] }),
  setInterchangeNotice: (interchangeNotice) => set({ interchangeNotice }),
  setBoardNotice: (boardNotice) => set({ boardNotice }),
  toggleToolbar: () => set((s) => ({ toolbarCollapsed: !s.toolbarCollapsed })),
}));
