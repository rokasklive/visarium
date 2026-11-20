import { useMemo } from 'react';
import { GLYPHS } from './letter-glyphs';
import { ROW_FILLS, useDevicePixelRatio } from './wordmark';

/**
 * The letter a participant is shown by (canvas/presence-indicators): the first
 * character of their name, folded to its base letter ("Šarūnas" → S) and
 * uppercased; `?` when the face cannot draw it. The server picks colours by
 * the same rule, held to it by `presence-letters.json`.
 */
export function letterOf(name: string): string {
  const first = [...name.trim()][0];
  const base = first?.normalize('NFD')[0]?.toUpperCase()[0];
  return base && base in GLYPHS && base !== '?' ? base : '?';
}

/** The letter's dots in device pixels, centred in a `size`-device-pixel tile. */
export function tileLayout(letter: string, size: number, dpr: number): string {
  return tileRows(letter, size, dpr).join('');
}

/** The same dots, one path per inked row, so each row can take its own colour. */
export function tileRows(letter: string, size: number, dpr: number): string[] {
  const rows = GLYPHS[letter] ?? GLYPHS['?'] ?? [];
  // About 1.75 CSS px a dot pitch, whole device pixels, never under 2 so a
  // dot and its gap are both at least a pixel.
  const pitch = Math.max(2, Math.round(1.75 * dpr));
  const dot = Math.ceil(pitch / 2);
  const units = Math.max(...rows.map((r) => r.length));
  const width = Math.floor(((units - 1) * pitch) / 2) + dot;
  const height = (rows.length - 1) * pitch + dot;
  const left = Math.floor((size - width) / 2);
  const top = Math.floor((size - height) / 2);
  return rows.map((row, r) =>
    [...row]
      .flatMap((cell, k) =>
        cell === '#'
          ? [`M${left + Math.floor((k * pitch) / 2)} ${top + r * pitch}h${dot}v${dot}h-${dot}z`]
          : [],
      )
      .join(''),
  );
}

/**
 * One participant, the way the app icon is drawn: the dark ground with a
 * dot-matrix letter, here in the participant's colour. An agent's letter is
 * the icon's own, row by row in the wordmark's colours, and its tile is
 * outlined in the agent's colour so two agents are still told apart. The full name is the tile's accessible name
 * and its hover text, so the letter never has to carry more than recognition.
 *
 * Drawn as dots, not set as text: the face set at this size paints nothing at
 * all (a 0.045em dot is half a pixel, and smoothing is off), which is what
 * left the old name pills blank.
 */
export function LetterTile({
  name,
  colour,
  label,
  agent = false,
  size = 20,
  testId,
}: {
  /** The participant's display name: the letter comes from it. */
  name: string;
  colour: string;
  /** Hover text and accessible name; defaults to the name. */
  label?: string;
  agent?: boolean;
  /** Edge length in CSS pixels. */
  size?: number;
  testId?: string;
}) {
  const dpr = useDevicePixelRatio();
  const letter = letterOf(name);
  const device = Math.round(size * dpr);
  const rows = useMemo(() => tileRows(letter, device, dpr), [letter, device, dpr]);
  const radius = Math.round(4 * dpr);
  const stroke = Math.max(1, Math.round(dpr));
  return (
    <svg
      role="img"
      aria-label={label ?? name}
      width={size}
      height={size}
      viewBox={`0 0 ${device} ${device}`}
      shapeRendering="crispEdges"
      className="block shrink-0"
      data-testid={testId}
      data-letter={letter}
    >
      <title>{label ?? name}</title>
      <rect
        x={agent ? stroke / 2 : 0}
        y={agent ? stroke / 2 : 0}
        width={agent ? device - stroke : device}
        height={agent ? device - stroke : device}
        rx={radius}
        className="fill-surface"
        {...(agent ? { stroke: colour, strokeWidth: stroke } : {})}
      />
      {agent ? (
        rows.map((d, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row's place is its identity.
          <path key={r} d={d} fill={ROW_FILLS[r] ?? ROW_FILLS[ROW_FILLS.length - 1]} data-row={r} />
        ))
      ) : (
        <path d={rows.join('')} fill={colour} />
      )}
    </svg>
  );
}
