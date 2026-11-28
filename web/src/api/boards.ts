import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type components, type paths } from '@visarium/api-client';
import {
  asCanvasId,
  asGroupId,
  asItemId,
  asLinkId,
  CanvasDocument,
  type CanvasGroup,
  type CanvasItem,
  type Centerpiece,
  contentFrom,
  DEFAULT_APPEARANCE,
  FULL_CROP,
  LINK_TYPES,
  type Link,
} from '@visarium/canvas-core';

export interface BoardSummary {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly updatedAt: string;
}

const boardsKey = ['boards'] as const;

export function useBoards(enabled = true) {
  return useQuery({
    queryKey: boardsKey,
    enabled,
    queryFn: async (): Promise<BoardSummary[]> => {
      const { data, response } = await api.GET('/api/boards');
      if (!data) throw new Error(`could not list boards: ${response.status}`);
      // The schema marks every field optional, though the server always sends
      // them. Asserted once here rather than at each use.
      return data.flatMap((board) =>
        board.id && board.title && board.updatedAt
          ? [
              {
                id: board.id,
                title: board.title,
                revision: board.revision ?? 0,
                updatedAt: board.updatedAt,
              },
            ]
          : [],
      );
    },
  });
}

/** Every board mutation invalidates the same list, because there is only one. */
function useBoardMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardsKey }),
  });
}

export function useCreateBoard() {
  return useBoardMutation(async (title: string) => {
    const { data, response } = await api.POST('/api/boards', { body: { title } });
    if (!data?.id) throw new Error(`could not create the board: ${response.status}`);
    return data.id;
  });
}

/**
 * A board's arrangement, as a new board.
 *
 * A reference board is a starting point people copy. The copy is a new board at
 * revision 0 with its own item and group ids — sharing one would mean a client
 * holding that id writes to both.
 */
export function useDuplicateBoard() {
  return useBoardMutation(async (id: string) => {
    const { data, response } = await api.POST('/api/boards/{id}/duplicate', {
      params: { path: { id } },
    });
    if (!data?.id) throw new Error(`could not duplicate the board: ${response.status}`);
    return data.id;
  });
}

export function useRenameBoard() {
  return useBoardMutation(async ({ id, title }: { id: string; title: string }) => {
    const { response } = await api.PATCH('/api/boards/{id}', {
      params: { path: { id } },
      body: { title },
    });
    if (!response.ok) throw new Error(`could not rename the board: ${response.status}`);
  });
}

export function useDeleteBoard() {
  return useBoardMutation(async (id: string) => {
    const { response } = await api.DELETE('/api/boards/{id}', { params: { path: { id } } });
    if (!response.ok) throw new Error(`could not delete the board: ${response.status}`);
  });
}

/**
 * A board, loaded.
 *
 * The document is built here rather than in the component because
 * `loadSnapshot` bulk-loads the spatial index in one pass, and doing that once
 * per board is the entire reason it exists as a single call rather than a loop
 * of inserts.
 *
 * `retry: false` and no refetch on focus: a snapshot is not a poll. Once the
 * board is in a document, that document is the live state — refetching would
 * throw away local work that has not been acknowledged yet.
 */
export function useBoardDocument(boardId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['board-snapshot', boardId],
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<CanvasDocument> => {
      const doc = new CanvasDocument(asCanvasId(boardId));
      await loadSnapshotInto(doc, boardId);
      return doc;
    },
  });
}

/**
 * Replace a document's contents with a fresh snapshot.
 *
 * The load path and the recovery path are the same request on purpose
 * (ADR-0011): when a client notices it has missed committed operations, it does
 * not ask for them — there is no operation log to ask — it refetches and starts
 * agreeing with everyone again.
 *
 * Applied to a LIVE document, so `loadSnapshot` rebuilds the spatial index in
 * one bulk pass rather than by insertion. Anything still queued for persistence
 * is unaffected: the queue holds operation bodies, not document state, and they
 * are posted after this and land on top.
 */
/**
 * Tell the server where a diagram's named elements are drawn, for the item's
 * current revision (agents/placement). Best effort: a stale or repeated report
 * is the server's to ignore, and a lost one only means placement aims at the
 * whole diagram.
 */
export async function reportElements(
  boardId: string,
  itemId: string,
  revision: number,
  width: number,
  elements: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
): Promise<void> {
  const boxes: Record<string, [number, number, number, number]> = {};
  for (const [name, r] of elements) boxes[name] = [r.x, r.y, r.width, r.height];
  await api.PUT('/api/boards/{id}/items/{item}/elements', {
    params: { path: { id: boardId, item: itemId } },
    body: { revision, width, elements: boxes },
  });
}

export async function loadSnapshotInto(doc: CanvasDocument, boardId: string): Promise<void> {
  const { data, response } = await api.GET('/api/boards/{id}/snapshot', {
    params: { path: { id: boardId } },
  });
  if (!data) throw new Error(`could not load the board: ${response.status}`);
  snapshotInto(doc, data);
}

/**
 * Display names of everyone a board credits (task and link authors), by account
 * id, from the last snapshot. A hover says who finished a task without a second
 * request. Absent for share viewers, who see the work and not who did it.
 */
const people = new Map<string, string>();
export function personName(id: string | null | undefined): string | undefined {
  return id ? people.get(id) : undefined;
}

/** A snapshot body into a document: a member's, or a share viewer's (ADR-0026). */
export function snapshotInto(
  doc: CanvasDocument,
  data: components['schemas']['BoardSnapshot'],
): void {
  for (const [id, name] of Object.entries(data.people ?? {})) people.set(id, name);
  doc.loadSnapshot(
    (data.items ?? []).flatMap(toItem),
    (data.groups ?? []).flatMap(toGroup),
    data.revision ?? 0,
    (data.links ?? []).flatMap(toLink),
    data.centerpiece && /^(item|group):./.test(data.centerpiece)
      ? (data.centerpiece as Centerpiece)
      : null,
  );
}

function toLink(link: components['schemas']['Link']): Link[] {
  if (!link.id || !link.from?.itemId || !link.to?.itemId || !LINK_TYPES.includes(link.linkType))
    return [];
  return [
    {
      id: asLinkId(link.id),
      from: { itemId: asItemId(link.from.itemId), element: link.from.element ?? null },
      to: { itemId: asItemId(link.to.itemId), element: link.to.element ?? null },
      linkType: link.linkType,
      ...(link.view ? { view: link.view } : {}),
      by: link.by ?? null,
      ...(link.byAgent ? { byAgent: link.byAgent } : {}),
      ...(link.at ? { at: link.at } : {}),
    },
  ];
}

/**
 * One snapshot row becoming a `CanvasItem`.
 *
 * A row missing an id, a transform or an asset is dropped rather than faked:
 * the schema makes all three NOT NULL, so one arriving absent means the contract
 * broke, and drawing an invented item would hide that.
 */
function toItem(item: components['schemas']['Item']): CanvasItem[] {
  const t = item.transform;
  // A note, diagram or checklist has no asset; an image without one is a broken
  // contract and `contentFrom` refuses it. An unrecognised kind is kept, inert.
  // An app's latest output travels beside its content in the snapshot.
  const content = contentFrom(
    item.content?.kind === 'app' ? { ...item.content, output: item.output } : item.content,
  );
  if (!item.id || !t || !content) return [];
  return [
    {
      id: asItemId(item.id),
      transform: {
        x: t.x ?? 0,
        y: t.y ?? 0,
        width: t.width ?? 0,
        height: t.height ?? 0,
        rotation: t.rotation ?? 0,
      },
      z: item.z ?? 0,
      // The snapshot always carries one — the columns are NOT NULL DEFAULT — so
      // this fallback is for the schema marking every field optional,
      // not for a state the server can be in.
      appearance: {
        opacity: item.appearance?.opacity ?? DEFAULT_APPEARANCE.opacity,
        flipX: item.appearance?.flipX ?? DEFAULT_APPEARANCE.flipX,
        flipY: item.appearance?.flipY ?? DEFAULT_APPEARANCE.flipY,
      },
      // Absent is the whole image: the server stores a full crop as NULL.
      crop: item.crop ?? FULL_CROP,
      content,
      ...(item.revision !== undefined ? { revision: item.revision } : {}),
      ...(item.contentRev !== undefined ? { contentRev: item.contentRev } : {}),
      ...(item.groupId ? { groupId: asGroupId(item.groupId) } : {}),
      ...(item.collides ? { collides: true } : {}),
      ...(item.textScale !== undefined && item.textScale !== 1
        ? { textScale: item.textScale }
        : {}),
    },
  ];
}

function toGroup(group: components['schemas']['Group']): CanvasGroup[] {
  if (!group.id) return [];
  return [
    {
      id: asGroupId(group.id),
      memberIds: (group.memberIds ?? []).map(asItemId),
      ...(group.label ? { label: group.label } : {}),
      // Absent on a snapshot from before the flag existed, which means
      // unframed — the backwards-compatible default everywhere.
      ...(group.frame ? { frame: true } : {}),
      ...(group.collides ? { collides: true } : {}),
    },
  ];
}

/**
 * Where to load an app's view from (canvas/apps): a URL on the sandbox origin
 * with a short-lived token. Null when this server has none (apps run in the
 * desktop app) or the app is gone.
 */
export async function mountApp(
  boardId: string,
  itemId: string,
  look?: { theme: 'light' | 'dark'; tokens: Record<string, string> },
): Promise<{ url: string; origin: string } | null> {
  const { data, response } = await api.POST('/api/boards/{id}/items/{item}/mount', {
    params: { path: { id: boardId, item: itemId } },
    ...(look ? { body: look } : {}),
  });
  if (response.status === 404) return null;
  if (!data) throw new Error(`could not open the app: ${response.status}`);
  return data;
}

/** One view of an item (canvas/item-views), as the server derives it now. */
/** What an app reads and where its outputs go, resolved by the server (canvas/apps). */
export type AppInventory =
  paths['/api/boards/{id}/items/{item}/inputs']['get']['responses'][200]['content']['application/json'];

export async function appInventory(boardId: string, itemId: string): Promise<AppInventory | null> {
  const { data } = await api.GET('/api/boards/{id}/items/{item}/inputs', {
    params: { path: { id: boardId, item: itemId } },
  });
  return data ?? null;
}

/** What an app reads now, name → value: what its view receives. */
/** A tool an MCP server offers, as the add menu lists it (canvas/app-sources). */
export type McpTool = components['schemas']['McpTool'];

/** The board's MCP connections, and whether local commands are allowed (the desktop). */
export async function mcpConnections(boardId: string) {
  const { data } = await api.GET('/api/boards/{id}/mcp', { params: { path: { id: boardId } } });
  return data ?? { local: false, connections: [] };
}

/** Why the server said no, in its words. */
function refusal(error: unknown, status: number): Error {
  const detail = (error as { detail?: string } | undefined)?.detail;
  return new Error(detail ?? `the server said ${status}`);
}

/** Adds a connection once its server answers; returns it with the tools it offers. */
export async function mcpConnect(
  boardId: string,
  to: { url?: string; command?: string; token?: string },
) {
  const { data, error, response } = await api.POST('/api/boards/{id}/mcp', {
    params: { path: { id: boardId } },
    body: to,
  });
  if (!data) throw refusal(error, response.status);
  return data;
}

export async function mcpTools(boardId: string, conn: string): Promise<McpTool[]> {
  const { data, error, response } = await api.GET('/api/boards/{id}/mcp/{conn}/tools', {
    params: { path: { id: boardId, conn } },
  });
  if (!data) throw refusal(error, response.status);
  return data.tools;
}

/** Fetches and pins a tool's ui:// view; the app made from it names this hash. */
export async function mcpPin(boardId: string, conn: string, uri: string): Promise<string> {
  const { data, error, response } = await api.POST('/api/boards/{id}/mcp/{conn}/resource', {
    params: { path: { id: boardId, conn } },
    body: { uri },
  });
  if (!data) throw refusal(error, response.status);
  return data.sha256;
}

/** An MCP app's view asks its own server: a tools/call or a resources/read. */
export async function appMcp(
  boardId: string,
  itemId: string,
  method: 'tools/call' | 'resources/read',
  params: unknown,
): Promise<Record<string, unknown>> {
  const { data, error, response } = await api.POST('/api/boards/{id}/items/{item}/mcp', {
    params: { path: { id: boardId, item: itemId } },
    body: { method, params },
  });
  if (!data) throw refusal(error, response.status);
  return data;
}

export async function appInputs(boardId: string, itemId: string): Promise<Record<string, unknown>> {
  return (await appInventory(boardId, itemId))?.values ?? {};
}
