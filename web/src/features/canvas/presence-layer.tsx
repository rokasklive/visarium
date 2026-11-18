/**
 * Other people, on screen.
 *
 * Split deliberately in two, and the split is the interesting part.
 *
 * **Cursors are DOM.** A cursor has no world-space extent worth culling and no
 * relationship to the active set; making it a Konva node would put presence
 * chrome under the node ceiling ADR-0015 exists to protect, for three elements
 * that a `transform` moves for free.
 *
 * That choice became load-bearing in M06 and must not be undone. The labels are
 * DOM positioned THROUGH the camera and **never scaled by zoom**: they are
 * translated to follow a point on the board, and their text stays at a fixed
 * screen size at every zoom level. A person's name is drawn in the pixel face
 * (`.wordmark`), and a pixel face needs integer sizes on the grid it was drawn
 * at — moving these into the Konva layer would scale the glyphs with the camera
 * and quietly smear that grid at every zoom but 1.
 *
 * **Remote selection is drawn by the renderer**, because it is a world-space
 * rectangle that has to survive pan, zoom and LOD exactly like the local
 * selection outline it sits beside — and reimplementing that in DOM would be
 * two implementations of one stroke.
 *
 * Neither of them ever touches the document. A preview is not an operation.
 */

import type { Camera, ItemId, Rect, Transform } from '@visarium/canvas-core';
import { worldToScreen } from '@visarium/canvas-core';
import { useEffect, useRef } from 'react';
import type { CanvasTheme } from './canvas-theme';
import type { RemotePresence } from './realtime';

/**
 * How long a cursor takes to reach where it was last reported.
 *
 * Roughly one throttle window: long enough that 20 Hz reads as motion rather
 * than as stepping, short enough that a cursor never lags visibly behind the
 * item its owner is dragging. This is the half of Q4 that makes a low send rate
 * viable, which is why the two are tuned together.
 */
const EASE_MS = 60;

export function RemoteCursors({
  presence,
  camera,
  size,
  theme,
}: {
  presence: RemotePresence;
  camera: Camera;
  size: { width: number; height: number };
  theme: CanvasTheme;
}) {
  const layer = useRef<HTMLDivElement | null>(null);
  /** Where each cursor is being drawn right now, as opposed to where it was reported. */
  const drawn = useRef(new Map<string, { x: number; y: number }>());

  /*
   * Interpolation runs on rAF against refs, not on React state.
   *
   * A cursor arriving at 20 Hz from three people would otherwise be sixty
   * re-renders a second of a component that sits over a canvas trying to hold
   * 60 fps. The elements are created by React; only their transforms are
   * animated imperatively, which is the same bargain the item drag already
   * makes.
   */
  useEffect(() => {
    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      const alpha = 1 - Math.exp(-dt / EASE_MS);

      for (const [actorId, target] of presence.cursors) {
        const current = drawn.current.get(actorId) ?? target;
        const next = {
          x: current.x + (target.x - current.x) * alpha,
          y: current.y + (target.y - current.y) * alpha,
        };
        drawn.current.set(actorId, next);

        const element = layer.current?.querySelector<HTMLElement>(`[data-actor="${actorId}"]`);
        if (!element) continue;
        // World space, so a cursor stays over the same point of the board when
        // the local camera pans or zooms — it is a place on the canvas, not a
        // place on someone's screen.
        const screen = worldToScreen(camera, size, next);
        element.style.transform = `translate3d(${screen.x}px, ${screen.y}px, 0)`;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [presence.cursors, camera, size]);

  // Forget anyone who left, so a reconnecting actor does not ease in from
  // wherever they were standing when they disappeared.
  useEffect(() => {
    for (const actorId of [...drawn.current.keys()]) {
      if (!presence.cursors.has(actorId)) drawn.current.delete(actorId);
    }
  }, [presence.cursors]);

  const cursors = [...presence.cursors.keys()].flatMap((actorId) => {
    const actor = presence.actors.get(actorId);
    return actor ? [{ actorId, actor }] : [];
  });

  if (cursors.length === 0) return null;

  return (
    <div ref={layer} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {cursors.map(({ actorId, actor }) => (
        <div
          key={actorId}
          data-actor={actorId}
          data-testid="remote-cursor"
          className="absolute top-0 left-0 will-change-transform"
        >
          <svg width="14" height="18" viewBox="0 0 14 18" fill="none" aria-hidden>
            <path
              d="M1 1L1 14L4.5 10.8L6.8 16L9.4 15L7.1 9.9L11.5 9.7Z"
              fill={theme.presence[actor.colourIndex] ?? theme.presence[0]}
              stroke={theme.surface}
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          {/*
           * A filled pill in the actor's colour with `surface`-coloured ink,
           * rather than coloured text on the ground.
           *
           * Not conservatism: the presence tokens were validated at 3:1 against
           * the canvas as INDICATORS, and a name is text, which owes 4.5:1.
           * Inverting it into a fill puts dark ink on the bright colour, which
           * clears the bar comfortably without nudging a token — asserted in
           * tokens.test.ts.
           *
           * The name is set in the identity face: the pixel face names the
           * product and a person, and nothing else.
           */}
          <span
            className="wordmark ml-2 rounded-sm px-1.5 py-0.5 text-[11px] whitespace-nowrap text-surface"
            style={{ backgroundColor: theme.presence[actor.colourIndex] ?? theme.presence[0] }}
          >
            {actor.displayName}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The rectangles another actor has selected, in world space.
 *
 * Returned as plain data rather than as elements: the caller draws them inside
 * the Konva layer that already owns interface strokes, so they get the same
 * screen-pixel treatment — a stroke divided by zoom — as the local selection.
 */
export function remoteSelectionMarks(
  presence: RemotePresence,
  bounds: (id: ItemId) => Rect | undefined,
  theme: CanvasTheme,
): readonly { key: string; rect: Rect; colour: string }[] {
  const marks: { key: string; rect: Rect; colour: string }[] = [];
  for (const [actorId, itemIds] of presence.selections) {
    const actor = presence.actors.get(actorId);
    if (!actor) continue;
    const colour = theme.presence[actor.colourIndex] ?? theme.presence[0];
    if (!colour) continue;
    for (const itemId of itemIds) {
      const rect = bounds(itemId);
      if (rect) marks.push({ key: `${actorId}:${itemId}`, rect, colour });
    }
  }
  return marks;
}

/** The transform another actor is previewing for an item, if any. */
export function previewFor(presence: RemotePresence, itemId: ItemId): Transform | undefined {
  return presence.previews.get(itemId)?.transform;
}

/**
 * Who else is here, and what this person is called.
 *
 * Sits quietly in a corner and disappears entirely when nobody else is on the
 * board — collaboration chrome that is always visible is chrome that is usually
 * lying, and a board with one person on it should look exactly like a board with
 * no collaboration at all.
 *
 * The name is now an IDENTITY rather than a label: it comes from the account the
 * socket authenticated as, so there is nothing here to edit and no field asking
 * you who you are. M05's text input and its `localStorage` entry were explicitly
 * a placeholder for this, and both are gone.
 *
 * The coloured dot went with them. It was a circle in a system that permits one
 * radius and no circles, and it repeated a colour the name now carries — "colour
 * is never the only carrier of meaning" is satisfied by the name itself.
 */
export function PresenceRoster({
  presence,
  selfActorId,
  theme,
}: {
  presence: RemotePresence;
  selfActorId: string | undefined;
  theme: CanvasTheme;
}) {
  const others = [...presence.actors.values()].filter((actor) => actor.actorId !== selfActorId);
  if (others.length === 0) return null;

  return (
    <div
      className="absolute top-2 right-2 flex items-center gap-2 rounded-sm border border-line-strong bg-surface/90 px-2 py-1 text-[11px]"
      data-testid="presence-roster"
    >
      {others.map((actor) => (
        <span
          key={actor.actorId}
          className="wordmark rounded-sm px-1.5 py-0.5 text-surface"
          style={{ backgroundColor: theme.presence[actor.colourIndex] ?? theme.presence[0] }}
          data-testid="presence-actor"
        >
          {actor.displayName}
        </span>
      ))}
    </div>
  );
}
