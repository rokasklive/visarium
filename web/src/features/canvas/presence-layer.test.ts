import { asItemId, type Camera, type ItemId, type Rect } from '@visarium/canvas-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CanvasTheme } from './canvas-theme';
import {
  agentFocusMarks,
  PresenceRoster,
  previewFor,
  RemoteCursors,
  remoteSelectionMarks,
} from './presence-layer';
import { EMPTY_PRESENCE, type RemotePresence } from './realtime';

/**
 * The two pure functions behind presence rendering.
 *
 * Drawing is Konva's and the DOM's job; deciding WHAT to draw, and in whose
 * colour, is arithmetic — and it is where the rule that colour comes from a
 * token rather than from the wire actually gets enforced.
 */

const theme = {
  presence: ['red-token', 'green-token', 'violet-token'],
} as unknown as CanvasTheme;

const rect = (x: number): Rect => ({ minX: x, minY: 0, maxX: x + 10, maxY: 10 });

function presenceWith(overrides: Partial<RemotePresence>): RemotePresence {
  return { ...EMPTY_PRESENCE, ...overrides };
}

describe('remoteSelectionMarks', () => {
  const ada = crypto.randomUUID();
  const item = asItemId(crypto.randomUUID());

  it('marks each selected item in its actor colour', () => {
    const presence = presenceWith({
      actors: new Map([[ada, { actorId: ada, displayName: 'Ada', colourIndex: 1 } as never]]),
      selections: new Map([[ada, [item]]]),
    });

    const marks = remoteSelectionMarks(presence, () => rect(0), theme);

    expect(marks).toHaveLength(1);
    expect(marks[0]?.colour).toBe('green-token');
  });

  it('skips an actor it has no presence record for', () => {
    // A selection can arrive a frame before the presence that explains it.
    // Drawing it in a default colour would attribute someone's work to nobody.
    const presence = presenceWith({ selections: new Map([[ada, [item]]]) });

    expect(remoteSelectionMarks(presence, () => rect(0), theme)).toHaveLength(0);
  });

  it('skips an item that is not on this client yet', () => {
    const presence = presenceWith({
      actors: new Map([[ada, { actorId: ada, displayName: 'Ada', colourIndex: 0 } as never]]),
      selections: new Map([[ada, [item]]]),
    });

    expect(remoteSelectionMarks(presence, () => undefined, theme)).toHaveLength(0);
  });

  it('keys marks per actor and item, so two actors on one item both show', () => {
    const grace = crypto.randomUUID();
    const presence = presenceWith({
      actors: new Map([
        [ada, { actorId: ada, displayName: 'Ada', colourIndex: 0 } as never],
        [grace, { actorId: grace, displayName: 'Grace', colourIndex: 2 } as never],
      ]),
      selections: new Map([
        [ada, [item]],
        [grace, [item]],
      ]),
    });

    const marks = remoteSelectionMarks(presence, () => rect(0), theme);

    expect(marks).toHaveLength(2);
    expect(new Set(marks.map((m) => m.key)).size).toBe(2);
    expect(marks.map((m) => m.colour)).toEqual(['red-token', 'violet-token']);
  });
});

describe('previewFor', () => {
  const item = asItemId(crypto.randomUUID());

  it('returns the in-flight transform when one is being previewed', () => {
    const presence = presenceWith({
      previews: new Map([
        [
          item,
          {
            actorId: crypto.randomUUID(),
            transform: { x: 5, y: 6, width: 1, height: 1, rotation: 0 },
          },
        ],
      ]),
    });

    expect(previewFor(presence, item)?.x).toBe(5);
  });

  it('returns nothing for an item nobody is manipulating', () => {
    expect(previewFor(EMPTY_PRESENCE, item)).toBeUndefined();
  });

  it('is what makes a remote selection outline follow a remote drag', () => {
    // The outline is drawn around the preview when there is one, so a watched
    // drag keeps its outline attached instead of leaving it at the old position
    // until the commit lands.
    const ada = crypto.randomUUID();
    const presence = presenceWith({
      actors: new Map([[ada, { actorId: ada, displayName: 'Ada', colourIndex: 0 } as never]]),
      selections: new Map([[ada, [item]]]),
      previews: new Map([
        [item, { actorId: ada, transform: { x: 500, y: 0, width: 10, height: 10, rotation: 0 } }],
      ]),
    });

    const marks = remoteSelectionMarks(
      presence,
      (id: ItemId) => {
        const preview = previewFor(presence, id);
        return preview ? rect(preview.x) : rect(0);
      },
      theme,
    );

    expect(marks[0]?.rect.minX).toBe(500);
  });
});

/**
 * A person's name, drawn on someone else's screen.
 *
 * The name is set in the pixel identity face, which needs INTEGER sizes on the
 * grid it was drawn at — so the label must be a fixed screen size at every zoom
 * level. That holds because the labels are DOM positioned through the camera and
 * never scaled by it (see the file header). These tests are what would fail if
 * somebody moved them into the Konva layer or tied their size to the camera.
 */
describe('the cursor label', () => {
  const ada = crypto.randomUUID();

  function labelAt(zoom: number): string {
    const camera: Camera = { x: 0, y: 0, zoom };
    const presence = presenceWith({
      actors: new Map([[ada, { actorId: ada, displayName: 'Ada', colourIndex: 1 } as never]]),
      cursors: new Map([[ada, { x: 120, y: 80 }]]),
    });
    return renderToStaticMarkup(
      createElement(RemoteCursors, {
        presence,
        camera,
        size: { width: 800, height: 600 },
        theme,
      }),
    );
  }

  it('holds its screen size and pixel grid from zoom 0.5 to 4', () => {
    // Byte-identical markup across an eightfold zoom range: nothing about the
    // label — not its font size, not a transform, not a scale — is a function of
    // the camera. Only its POSITION is, and that is applied imperatively on rAF.
    expect(labelAt(0.5)).toBe(labelAt(4));
    expect(labelAt(0.5)).not.toContain('scale(');
  });

  it('labels the cursor with the letter tile, never the pixel face set as text', () => {
    // The old label set the name in the dot face at 11px, where a 0.045em dot is
    // half a pixel and, with smoothing off, is not painted: the pill came out
    // blank (design.md, task 4.1). The tile draws its letter as dots instead.
    const markup = labelAt(1);

    expect(markup).toContain('data-testid="remote-cursor-tile"');
    expect(markup).toContain('data-letter="A"');
    expect(markup).toContain('aria-label="Ada"');
    expect(markup).not.toContain('wordmark');
  });

  it("draws the letter in the person's colour", () => {
    expect(labelAt(1)).toContain('fill="green-token"');
  });

  it('draws no circle, because the system permits one radius and no circles', () => {
    expect(labelAt(1)).not.toContain('rounded-full');
  });
});

describe('an agent on the board', () => {
  const agent = crypto.randomUUID();
  const item = asItemId(crypto.randomUUID());
  const presence = presenceWith({
    actors: new Map([
      [
        agent,
        {
          actorId: agent,
          displayName: 'Claude Code',
          colourIndex: 2,
          kind: 'agent',
          person: 'Ada',
        },
      ],
    ]) as unknown as RemotePresence['actors'],
    focus: new Map([[agent, { itemId: item, verb: 'editing' }]]),
  });

  it('outlines what it is working on in its own colour', () => {
    expect(agentFocusMarks(presence, (id) => (id === item ? rect(0) : undefined), theme)).toEqual([
      {
        key: `focus:${agent}`,
        actorId: agent,
        verb: 'editing',
        rect: rect(0),
        colour: 'violet-token',
      },
    ]);
  });

  it('is named in the roster as an agent, for its person, with what it is doing', () => {
    const html = renderToStaticMarkup(
      createElement(PresenceRoster, { presence, selfActorId: undefined, theme }),
    );
    expect(html).toContain('data-testid="presence-agent"');
    expect(html).toContain('data-letter="C"');
    expect(html).toContain('aria-label="Claude Code, an AI agent working for Ada · editing"');
    expect(html).toContain('stroke="violet-token"');
    expect(html).not.toContain('wordmark');
  });
});
