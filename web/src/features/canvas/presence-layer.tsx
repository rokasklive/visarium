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
 * translated to follow a point on the board, and stay at a fixed screen size at
 * every zoom level. A participant is a letter tile drawn as device-pixel dots,
 * and dots need whole pixels — moving these into the Konva layer would scale
 * them with the camera and quietly smear the grid at every zoom but 1.
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
import { LetterTile } from '~/components/letter-tile';
import type { CanvasTheme } from './canvas-theme';
import type { RemotePresence } from './realtime';

type Participant = RemotePresence['actors'] extends ReadonlyMap<string, infer A> ? A : never;

/**
 * Who a tile is, in words: its hover text and accessible name. A person is
 * their name; an agent says so, for whom, and what it is doing.
 */
export function participantLabel(actor: Participant, verb?: string): string {
  if (actor.kind !== 'agent') return actor.displayName;
  return `${actor.displayName}, an AI agent working for ${actor.person ?? 'someone'}${verb ? ` · ${verb}` : ''}`;
}

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
           * The participant's letter tile (canvas/presence-indicators), at a
           * fixed screen size: never scaled by zoom, for the same reason the
           * old name label was not.
           */}
          <span className="ml-1 inline-block align-top">
            <LetterTile
              name={actor.displayName}
              colour={theme.presence[actor.colourIndex] ?? theme.presence[0] ?? ''}
              label={participantLabel(actor)}
              agent={actor.kind === 'agent'}
              size={18}
              testId="remote-cursor-tile"
            />
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

/**
 * The item each agent just read or changed (ADR-0031), outlined solid in the
 * agent's colour — solid, where a person's selection is dashed, so the two
 * never read as the same thing.
 */
export function agentFocusMarks(
  presence: RemotePresence,
  bounds: (id: ItemId) => Rect | undefined,
  theme: CanvasTheme,
): readonly { key: string; actorId: string; verb: string; rect: Rect; colour: string }[] {
  const marks: { key: string; actorId: string; verb: string; rect: Rect; colour: string }[] = [];
  for (const [actorId, { itemId, verb }] of presence.focus) {
    const actor = presence.actors.get(actorId);
    const colour = actor && (theme.presence[actor.colourIndex] ?? theme.presence[0]);
    const rect = bounds(itemId);
    if (colour && rect) marks.push({ key: `focus:${actorId}`, actorId, verb, rect, colour });
  }
  return marks;
}

/**
 * The label on an agent's focus outline: its tile and what it is doing, at
 * the outline's top-left corner. DOM, through the camera and never scaled, like
 * the cursor labels.
 */
export function AgentFocusLabels({
  marks,
  presence,
  camera,
  size,
}: {
  marks: readonly { key: string; actorId: string; verb: string; rect: Rect; colour: string }[];
  presence: RemotePresence;
  camera: Camera;
  size: { width: number; height: number };
}) {
  if (marks.length === 0) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {marks.flatMap((mark) => {
        const actor = presence.actors.get(mark.actorId);
        if (!actor) return [];
        const at = worldToScreen(camera, size, { x: mark.rect.minX, y: mark.rect.minY });
        return [
          <div
            key={mark.key}
            data-testid="agent-focus-label"
            className="absolute top-0 left-0 flex items-center gap-1 text-[11px]"
            style={{
              transform: `translate3d(${Math.round(at.x)}px, ${Math.round(at.y) - 26}px, 0)`,
            }}
          >
            <LetterTile
              name={actor.displayName}
              colour={mark.colour}
              label={participantLabel(actor, mark.verb)}
              agent
            />
            <span className="rounded-sm bg-surface/90 px-1 text-ink">{mark.verb}</span>
          </div>,
        ];
      })}
    </div>
  );
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
 * Each participant is a letter tile (canvas/presence-indicators): the app
 * icon's ground with their first letter in their colour, outlined for an agent.
 * The full name — and for an agent, whose it is and what it is doing — is the
 * tile's hover text and accessible name, so colour is never the only carrier
 * of meaning, and neither is the letter.
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
      className="absolute top-2 right-2 flex items-center gap-1 rounded-sm border border-line-strong bg-surface/90 p-1"
      data-testid="presence-roster"
    >
      {others.map((actor) => (
        <LetterTile
          key={actor.actorId}
          name={actor.displayName}
          colour={theme.presence[actor.colourIndex] ?? theme.presence[0] ?? ''}
          label={participantLabel(
            actor,
            actor.kind === 'agent' ? presence.focus.get(actor.actorId as string)?.verb : undefined,
          )}
          agent={actor.kind === 'agent'}
          testId={actor.kind === 'agent' ? 'presence-agent' : 'presence-actor'}
        />
      ))}
    </div>
  );
}
