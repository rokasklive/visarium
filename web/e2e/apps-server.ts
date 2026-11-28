import { readFileSync } from 'node:fs';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import { canvasBox } from './session';

/**
 * For specs against a real server with its app sandbox and the built bundle
 * (`just e2e-apps` starts it and sets VISARIUM_E2E_SERVER): an agent's tool
 * calls over /mcp, a person's requests, and where things are drawn.
 */

export const SERVER = process.env.VISARIUM_E2E_SERVER ?? '';

export const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/apps/${name}.html`, import.meta.url), 'utf8');

/** One tool call over /mcp, as an agent makes it. */
export async function call(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await request.post(`${SERVER}/mcp`, {
    headers: { accept: 'application/json, text/event-stream' },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { result } = (await res.json()) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  const text = result.content[0]?.text ?? '';
  expect(result.isError, `${name}: ${text}`).toBe(false);
  return text;
}

export async function xsrf(page: Page) {
  const c = (await page.context().cookies(SERVER)).find((c) => c.name === 'XSRF-TOKEN');
  if (!c) throw new Error('no XSRF cookie');
  return { 'x-xsrf-token': c.value };
}

/** An item's drawn box, in page px. */
export async function rectOf(page: Page, id: string) {
  const box = await canvasBox(page);
  const r = await page.evaluate(
    (i) =>
      (
        window as unknown as {
          Konva: {
            stages: {
              findOne(
                s: string,
              ):
                | { getClientRect(): { x: number; y: number; width: number; height: number } }
                | undefined;
            }[];
          };
        }
      ).Konva.stages[0]
        ?.findOne(`#${i}`)
        ?.getClientRect(),
    id,
  );
  if (!r) throw new Error(`${id} is not drawn`);
  return { x: box.x + r.x, y: box.y + r.y, width: r.width, height: r.height };
}

export async function centreOf(page: Page, id: string) {
  const box = await canvasBox(page);
  const r = await page.evaluate(
    (i) =>
      (
        window as unknown as {
          Konva: {
            stages: {
              findOne(
                s: string,
              ):
                | { getClientRect(): { x: number; y: number; width: number; height: number } }
                | undefined;
            }[];
          };
        }
      ).Konva.stages[0]
        ?.findOne(`#${i}`)
        ?.getClientRect(),
    id,
  );
  if (!r) throw new Error(`${id} is not drawn`);
  return { x: box.x + r.x + r.width / 2, y: box.y + r.y + r.height / 2 };
}

/** The id of the board node a click at this page point lands on. */
export async function hitAt(page: Page, at: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const stage = (
      window as unknown as {
        Konva: {
          stages: {
            container(): HTMLElement;
            getIntersection(p: { x: number; y: number }): { id(): string } | null;
          }[];
        };
      }
    ).Konva.stages[0];
    const c = stage?.container().getBoundingClientRect();
    return c ? (stage?.getIntersection({ x: x - c.x, y: y - c.y })?.id() ?? '') : '';
  }, at);
}

/** A new board, made by the signed-in person: its id. */
export async function newBoard(page: Page, title: string): Promise<string> {
  const made = await page.request.post(`${SERVER}/api/boards`, {
    headers: await xsrf(page),
    data: { title },
  });
  expect(made.ok(), await made.text()).toBe(true);
  return ((await made.json()) as { id: string }).id;
}

/** Item id by ref, from the board's snapshot. */
export async function idsOf(page: Page, board: string): Promise<(ref: string) => string> {
  const snap = (await (
    await page.request.get(`${SERVER}/api/boards/${board}/snapshot`)
  ).json()) as { items: { id: string; ref: string }[] };
  return (ref) => snap.items.find((i) => i.ref === ref)?.id ?? '';
}

/** Opens the board, fits it, and waits until these items are drawn. */
export async function showBoard(page: Page, board: string, ids: string[]) {
  await page.goto(`${SERVER}/boards/${board}`);
  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await page.getByRole('button', { name: 'Fit' }).click();
  for (const id of ids)
    await page.waitForFunction(
      (i) =>
        (
          window as unknown as { Konva: { stages: { findOne(s: string): unknown }[] } }
        ).Konva.stages[0]?.findOne(`#${i}`) !== undefined,
      id,
      { timeout: 15_000 },
    );
}

/**
 * Double-clicks an item once its own drawing is what a click there lands on.
 * For an app, on its band: its body is the app's own once it is selected.
 */
export async function dblclickItem(page: Page, id: string, band = false) {
  const point = async () => {
    const c = await centreOf(page, id);
    if (!band) return c;
    const r = await rectOf(page, id);
    return { x: c.x, y: r.y + 12 };
  };
  let at = await point();
  await expect
    .poll(async () => {
      at = await point();
      return hitAt(page, at);
    })
    .toBe(id);
  await page.mouse.dblclick(at.x, at.y);
}
