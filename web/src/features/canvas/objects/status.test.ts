import { describe, expect, it } from 'vitest';
import fixture from '../../../../../packages/canvas-core/fixtures/note-status.json';
import { sourceBlocks } from './blocks';
import { noteHtml } from './layout';
import { loadMarkdown } from './loaders';
import { noteStatus, statusLabel, stripFrontmatter, withStatus } from './status';

describe('note status (canvas/note-status)', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(noteStatus(c.source) ?? null).toEqual(c.expect);
  });

  it('labels kind and state, or the word as written', () => {
    expect(statusLabel({ kind: 'decision', state: 'proposed', raw: 'Proposed' })).toBe(
      'Decision · Proposed',
    );
    expect(statusLabel({ kind: 'none', state: null, raw: 'Resolved' })).toBe('Resolved');
  });

  it('strips frontmatter that closes in time, and nothing else', () => {
    expect(stripFrontmatter('---\nstatus: open\n---\n# Q\nText')).toBe('# Q\nText');
    expect(stripFrontmatter('# Q\n\n---\nText')).toBe('# Q\n\n---\nText');
  });

  it('rewrites a status line, keeping bold markers and the date', () => {
    const src = '# ADR-2\n\n**Status: Proposed** (2026-10-14)\n\nBody.';
    expect(withStatus(src, 'accepted')).toBe(
      '# ADR-2\n\n**Status: Accepted** (2026-10-14)\n\nBody.',
    );
    expect(withStatus('# A\n**Status:** Proposed', 'rejected')).toBe('# A\n**Status:** Rejected');
    expect(withStatus('# Q\n\n**Status: Open question. Not decided.**', 'answered')).toBe(
      '# Q\n\n**Status: Answered**',
    );
  });

  it('rewrites frontmatter, keeping quotes', () => {
    expect(withStatus('---\nstatus: "proposed"\n---\n# A', 'accepted')).toBe(
      '---\nstatus: "accepted"\n---\n# A',
    );
    expect(withStatus('---\nstatus: accepted\n---\n# A\nStatus: Proposed', 'superseded')).toBe(
      '---\nstatus: superseded\n---\n# A\nStatus: Proposed',
    );
    expect(withStatus('# No status', 'accepted')).toBeUndefined();
  });

  it('draws a chip above the note and no frontmatter', async () => {
    const render = noteHtml(await loadMarkdown());
    const root = document.createElement('div');
    root.innerHTML = render(
      '---\nstatus: proposed\nowner: ana\n---\nIntro\n\n# ADR-6 · Sign at enqueue\n\nWe sign later.',
    );
    const chip = root.querySelector('[data-status]');
    expect(chip?.textContent).toBe('Decision · Proposed');
    expect(root.firstElementChild).toBe(chip);
    expect(root.textContent).not.toContain('owner: ana');
    expect(root.textContent).not.toContain('status:');
    // A status line still reads as written, and a plain note has no chip.
    root.innerHTML = render('Intro\n\n# Q-2\n\nStatus: open');
    expect(root.querySelector('[data-status]')?.className).toBe('vo-chip question open');
    expect(root.textContent).toContain('Status: open');
    root.innerHTML = render('# Plain');
    expect(root.querySelector('[data-status]')).toBeNull();
  });

  it('counts no passages in frontmatter', () => {
    const blocks = sourceBlocks('---\nstatus: open\n---\n# Q-1\n\nWhy? ^why');
    expect(blocks.map((b) => [b.kind, b.name, b.first])).toEqual([
      ['heading', 'q-1', 3],
      ['paragraph', '^why', 5],
    ]);
  });
});
