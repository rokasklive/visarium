import { expect, type Page, test } from '@playwright/test';
import { signedIn } from './session';

/**
 * Collaboration, from the browser's side.
 *
 * The socket is replaced with one the test drives, for the same reason the
 * persistence spec stubs the API: what has no unit-test equivalent here is the
 * BROWSER half — that a frame arriving on a socket really puts another person's
 * cursor on screen, really makes an item appear on the board, and really tells
 * the person when the connection is gone.
 *
 * The server half — three real clients, real locks, a killed socket — is
 * `ThreeClientsIT` and `CanvasSocketIT`, which run against real PostgreSQL and
 * real WebSockets. Racing three browsers to prove a server property would fail
 * for reasons that have nothing to do with the property.
 */

const BOARD = '01a01640-6b72-7d60-968b-88be186f32db';
const ASSET_ID = '01a01640-6b72-7d60-968b-88be186f32dc';
const ADA = '01a01640-6b72-7d60-968b-88be186f3300';

function snapshotItem(id: string, x: number, z: number) {
  return {
    id,
    transform: { x, y: 0, width: 300, height: 225, rotation: 0 },
    z,
    content: {
      kind: 'image',
      asset: { assetId: ASSET_ID, intrinsicWidth: 1600, intrinsicHeight: 1200 },
    },
  };
}

/**
 * A socket the test drives, installed before any application code runs.
 *
 * `window.__socket.deliver(frame)` pushes a frame at the client exactly as the
 * server would; `__socket.close()` is the network going away. Everything the
 * client sends is recorded so a test can assert what it said.
 */
async function stubSocket(page: Page) {
  await page.addInitScript(() => {
    interface Stub {
      sent: unknown[];
      deliver(frame: unknown): void;
      close(): void;
      opened: boolean;
      connections: number;
    }
    const control: Stub = {
      sent: [],
      deliver: () => {},
      close: () => {},
      opened: false,
      connections: 0,
    };
    (window as unknown as { __socket: Stub }).__socket = control;

    const RealWebSocket = window.WebSocket;

    class StubSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(public url: string) {
        super();
        control.connections += 1;
        queueMicrotask(() => {
          control.opened = true;
          control.deliver = (frame: unknown) => this.onmessage?.({ data: JSON.stringify(frame) });
          control.close = () => {
            this.readyState = 3;
            this.onclose?.();
          };
          this.onopen?.();
        });
      }

      send(payload: string) {
        control.sent.push(JSON.parse(payload));
      }

      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }

    /*
     * Only the canvas socket is stubbed.
     *
     * Vite's dev server opens its own WebSocket for HMR, and replacing the
     * global outright hijacks that one instead — the app's socket is then the
     * second connection, `deliver` is wired to the wrong peer, and the page
     * quietly fails to hot-reload. Everything that is not /ws/canvas/ goes to
     * the real implementation.
     */
    const Proxied = new Proxy(RealWebSocket, {
      construct(target, args: [string, ...unknown[]]) {
        if (typeof args[0] === 'string' && args[0].includes('/ws/canvas/')) {
          return new StubSocket(args[0]) as unknown as WebSocket;
        }
        return Reflect.construct(target, args) as WebSocket;
      },
    });
    (window as unknown as { WebSocket: unknown }).WebSocket = Proxied;
  });
}

async function stubBoard(page: Page, items: ReturnType<typeof snapshotItem>[], revision = 1) {
  let served = 0;
  await page.route(`**/api/boards/${BOARD}/snapshot`, async (route) => {
    served += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ revision, items, groups: [] }),
    });
  });
  await page.route(`**/api/boards/${BOARD}/operations`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"revision":9}' }),
  );
  await page.route('**/api/assets/*/derivatives/*', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/assets/*/content', (route) => route.fulfill({ status: 404 }));
  return { snapshotsServed: () => served };
}

/**
 * Wait until the application has actually opened the socket.
 *
 * Delivering before it does is a silent no-op — the stub has nothing to deliver
 * through yet — and the test then fails somewhere much later, looking like a
 * presence bug rather than a race in its own harness.
 */
async function socketOpen(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __socket: { opened: boolean } }).__socket.opened,
    undefined,
    { timeout: 10_000 },
  );
}

/** Complete the handshake the way the server does. */
async function welcome(page: Page, revision = 1) {
  await socketOpen(page);
  await page.evaluate(
    ([rev, ada]) => {
      const socket = (window as unknown as { __socket: { deliver(f: unknown): void } }).__socket;
      socket.deliver({
        t: 'welcome',
        actorId: '01a01640-6b72-7d60-968b-88be186f3399',
        revision: rev,
        actors: [{ actorId: ada, displayName: 'Ada', colourIndex: 1 }],
      });
    },
    [revision, ADA] as const,
  );
}

async function itemCount(page: Page) {
  const text = (await page.getByTestId('canvas-stats').textContent()) ?? '';
  return Number(/([\d,]+) items/.exec(text)?.[1]?.replaceAll(',', '') ?? Number.NaN);
}

const deliver = (page: Page, frame: unknown) =>
  page.evaluate(
    (f) => (window as unknown as { __socket: { deliver(x: unknown): void } }).__socket.deliver(f),
    frame,
  );

test.beforeEach(async ({ page }) => {
  await stubSocket(page);
});

// M06: the application asks who you are before it renders anything, so every
// spec that reaches a route has to answer that first.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('another person appears, with a cursor and a name', async ({ page }) => {
  await stubBoard(page, [snapshotItem('01a01640-6b72-7d60-968b-88be186f3401', 0, 1)]);
  await page.goto(`/boards/${BOARD}`);
  await welcome(page);

  await deliver(page, {
    t: 'presence',
    joined: [{ actorId: ADA, displayName: 'Ada', colourIndex: 1 }],
  });
  await deliver(page, { t: 'cursor', actorId: ADA, x: 120, y: 90 });

  await expect(page.getByTestId('presence-roster')).toContainText('Ada');
  await expect(page.getByTestId('remote-cursor')).toBeVisible();

  // And when they leave, they leave completely.
  await deliver(page, { t: 'presence', left: [ADA] });
  await expect(page.getByTestId('presence-roster')).toHaveCount(0);
  await expect(page.getByTestId('remote-cursor')).toHaveCount(0);
});

/**
 * Placement needs no broadcast of its own.
 *
 * An asset placed from the library is an `item.create` carrying image content —
 * byte for byte the frame a resolved drop produces — so the ordinary operation
 * broadcast is what carries it, and this is the test that says so. The server
 * half, two real clients over a real socket, is `ThreeClientsIT`.
 */
test('an image someone else drops or places appears without a reload', async ({ page }) => {
  await stubBoard(page, [], 0);
  await page.goto(`/boards/${BOARD}`);
  await welcome(page, 0);

  await expect(page.getByTestId('canvas-stats')).toBeVisible();
  await expect.poll(() => itemCount(page)).toBe(0);

  const newItem = '01a01640-6b72-7d60-968b-88be186f3402';
  await deliver(page, {
    t: 'op',
    fromRevision: 0,
    toRevision: 1,
    operations: [
      {
        type: 'item.create',
        itemId: newItem,
        transform: { x: 60, y: 40, width: 300, height: 225, rotation: 0 },
        z: 1,
        content: {
          kind: 'image',
          asset: { assetId: ASSET_ID, intrinsicWidth: 1600, intrinsicHeight: 1200 },
        },
      },
    ],
  });

  // Really on the board, by the same readout the persistence spec trusts —
  // the document's own count, not a DOM node that happens to exist.
  await expect.poll(() => itemCount(page)).toBe(1);
});

test('the person is told when the connection goes, and it does not read as lost work', async ({
  page,
}) => {
  await stubBoard(page, [snapshotItem('01a01640-6b72-7d60-968b-88be186f3403', 0, 1)]);
  await page.goto(`/boards/${BOARD}`);
  await welcome(page);

  await expect(page.getByTestId('presence-status')).toHaveCount(0);

  await page.evaluate(() =>
    (window as unknown as { __socket: { close(): void } }).__socket.close(),
  );

  const status = page.getByTestId('presence-status');
  await expect(status).toBeVisible();
  // The wording is the assertion. Durable writes go over REST and are unaffected,
  // so anything implying lost work would be false.
  await expect(status).toContainText('others not visible');
  await expect(status).not.toContainText('unsaved');
  await expect(status).not.toContainText('offline');
});

test('a revision gap refetches the snapshot instead of applying it', async ({ page }) => {
  const board = await stubBoard(page, [], 0);
  await page.goto(`/boards/${BOARD}`);
  await welcome(page, 0);
  const before = board.snapshotsServed();

  // Begins at 7 while the client holds 0: operations were missed, and there is
  // no log to replay them from (ADR-0011).
  await deliver(page, {
    t: 'op',
    fromRevision: 7,
    toRevision: 9,
    operations: [{ type: 'item.delete', itemId: '01a01640-6b72-7d60-968b-88be186f3404' }],
  });

  await expect.poll(() => board.snapshotsServed()).toBe(before + 1);
});

test('a malformed frame does not take the session down', async ({ page }) => {
  await stubBoard(page, [snapshotItem('01a01640-6b72-7d60-968b-88be186f3405', 0, 1)]);
  await page.goto(`/boards/${BOARD}`);
  await welcome(page);

  await page.evaluate(() => {
    const socket = (
      window as unknown as {
        __socket: { deliver(f: unknown): void };
      }
    ).__socket;
    socket.deliver({ t: 'cursor', actorId: 'not-a-uuid-but-a-string', x: Number.NaN, y: 0 });
    socket.deliver({ t: 'telepathy' });
  });

  // Still alive: a real frame after two bad ones still lands.
  await deliver(page, {
    t: 'presence',
    joined: [{ actorId: ADA, displayName: 'Ada', colourIndex: 2 }],
  });
  await expect(page.getByTestId('presence-roster')).toContainText('Ada');
  await expect(page.getByTestId('presence-status')).toHaveCount(0);
});
