/**
 * "Add MCP app…" (canvas/app-sources; openspec canvas-apps-live design §10).
 *
 * A person names an MCP server (a URL, or on the desktop a local command,
 * with an optional token), the board connects to it and lists the tools that
 * have a view, and picking one pins that view and makes the app. The token
 * goes to the server once and never comes back.
 */

import type { CanvasItemContent } from '@visarium/canvas-core';
import { useEffect, useState } from 'react';
import { type McpTool, mcpConnect, mcpConnections, mcpPin } from '~/api/boards';

export function AddMcpApp({
  boardId,
  onCreate,
  onClose,
}: {
  boardId: string;
  onCreate: (content: CanvasItemContent) => void;
  onClose: () => void;
}) {
  const [local, setLocal] = useState(false);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conn, setConn] = useState<{ id: string; tools: McpTool[] } | null>(null);
  const [onServer, setOnServer] = useState(true);

  useEffect(() => {
    void mcpConnections(boardId).then((c) => setLocal(c.local));
  }, [boardId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isUrl = /^https?:\/\//i.test(address.trim());

  const connect = async () => {
    setBusy(true);
    setError('');
    try {
      const to = isUrl
        ? { url: address.trim(), ...(token.trim() ? { token: token.trim() } : {}) }
        : { command: address.trim() };
      setConn(await mcpConnect(boardId, to));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const make = async (tool: McpTool) => {
    if (!conn || !tool.resourceUri) return;
    setBusy(true);
    setError('');
    try {
      const sha256 = await mcpPin(boardId, conn.id, tool.resourceUri);
      onCreate({
        kind: 'app',
        title: tool.title || tool.name,
        html: '',
        mcp: {
          connection: conn.id,
          resourceUri: tool.resourceUri,
          sha256,
          ...(onServer ? { tool: tool.name } : {}),
        },
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const withView = conn?.tools.filter((t) => t.resourceUri) ?? [];

  return (
    <div
      role="dialog"
      aria-label="Add MCP app"
      data-testid="mcp-add"
      className="absolute top-12 left-1/2 z-20 flex w-[420px] -translate-x-1/2 flex-col gap-2 rounded border border-line-strong bg-surface p-3 text-[13px] text-ink"
    >
      <h2 className="text-[12px] text-ink-dim uppercase tracking-[0.025em]">Add MCP app</h2>
      {conn ? (
        <>
          <p className="text-ink-dim">
            {withView.length
              ? 'Pick a tool: its view becomes the app.'
              : 'This server offers no tool with a view.'}
          </p>
          <ul className="flex flex-col gap-1" data-testid="mcp-tools">
            {withView.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void make(t)}
                  className="w-full rounded-[4px] border border-line-strong px-2 py-1 text-left enabled:hover:bg-surface-raised"
                >
                  <span className="block text-ink">{t.title || t.name}</span>
                  {t.description ? (
                    <span className="block text-[12px] text-ink-dim">{t.description}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-ink-dim">
            <input
              type="checkbox"
              checked={onServer}
              onChange={(e) => setOnServer(e.target.checked)}
            />
            Run the tool on the server when its inputs change
          </label>
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <input
            aria-label={local ? 'Server URL or local command' : 'Server URL'}
            placeholder={local ? 'https://… or a command, e.g. npx my-server' : 'https://…'}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="rounded-[4px] border border-line-strong bg-surface-raised px-2 py-1"
          />
          {isUrl ? (
            <input
              aria-label="Token (optional)"
              placeholder="Authorization header value, if it needs one"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="rounded-[4px] border border-line-strong bg-surface-raised px-2 py-1"
            />
          ) : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-2 text-ink-dim hover:text-ink">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !address.trim() || (!isUrl && !local)}
              className="rounded-[4px] border border-line-strong px-2 text-ink-dim enabled:hover:bg-surface-raised enabled:hover:text-ink"
            >
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
