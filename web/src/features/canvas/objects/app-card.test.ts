import {
  asItemId,
  asLinkId,
  type CanvasItem,
  DEFAULT_APPEARANCE,
  FULL_CROP,
} from '@visarium/canvas-core';
import { describe, expect, it } from 'vitest';
import { appCardHtml, appStateLabel } from './layout';
import { dataLinkFor, linkLabel, nextView, viewsOf } from './links';

const item = (kind: 'note' | 'app' | 'checklist'): CanvasItem => ({
  id: asItemId(kind),
  transform: { x: 0, y: 0, width: 300, height: 200, rotation: 0 },
  z: 1,
  content:
    kind === 'note'
      ? { kind: 'note', source: '# x' }
      : kind === 'app'
        ? { kind: 'app', title: 'Premium', html: '<p>x</p>' }
        : { kind: 'checklist', title: 'Regression', tasks: [] },
  appearance: DEFAULT_APPEARANCE,
  crop: FULL_CROP,
});

describe('the app card (canvas/apps)', () => {
  it('shows the title, its state and the latest outputs, all inert', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const root = document.createElement('div');
    root.innerHTML = appCardHtml(
      evil,
      { version: 2, outputs: { [evil]: evil, premium: 1240 }, inputRevs: {}, status: 'ok' },
      { state: 'stale', moved: [{ itemId: 'n3', was: 7, now: 9 }] },
    );
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.vo-title')?.textContent).toBe(evil);
    expect(root.querySelector('.vo-app-state')?.textContent).toBe('stale · 1 input changed');
    expect(root.querySelector('.vo-app-band')?.firstElementChild?.textContent).toBe('App');
    expect([...root.querySelectorAll('dd')].map((d) => d.textContent)).toEqual([evil, '1240']);
  });

  it('says what to do before the first run, and names an error', () => {
    const root = document.createElement('div');
    root.innerHTML = appCardHtml('Premium', undefined, { state: 'never run' });
    expect(root.textContent).toContain('Double-click to open and run it.');
    root.innerHTML = appCardHtml(
      'Premium',
      { version: 1, outputs: {}, inputRevs: {}, status: 'error', error: 'age out of range' },
      { state: 'error', error: 'age out of range' },
    );
    expect(root.querySelector('.vo-app-note')?.textContent).toBe('age out of range');
    expect(appStateLabel({ state: 'upstream error', from: ['a1'] }).cls).toBe('upstream-error');
  });
});

describe('data links (canvas/links)', () => {
  it('feed an app from anything, and let an app update a checklist', () => {
    expect(dataLinkFor(item('note'), item('app'))).toEqual({ linkType: 'feeds', view: 'text' });
    expect(dataLinkFor(item('app'), item('app'))).toEqual({ linkType: 'feeds', view: 'outputs' });
    expect(dataLinkFor(item('app'), item('checklist'))).toEqual({ linkType: 'updates' });
    expect(dataLinkFor(item('note'), item('checklist'))).toBeUndefined();
  });

  it('cycle a feeds link through its source views and say which it carries', () => {
    expect(viewsOf(item('note').content)).toEqual(['text', 'markdown', 'frontmatter', 'tables']);
    expect(nextView(item('note').content, 'frontmatter')).toBe('tables');
    expect(nextView(item('note').content, 'tables')).toBe('text');
    const l = { id: asLinkId('l'), from: { itemId: asItemId('n') }, to: { itemId: asItemId('a') } };
    expect(linkLabel({ ...l, linkType: 'feeds', view: 'tables' })).toBe('feeds · tables');
    expect(
      linkLabel({ ...l, linkType: 'feeds', view: 'frontmatter', path: 'age', name: 'age' }),
    ).toBe('feeds · frontmatter.age → age');
    expect(linkLabel({ ...l, linkType: 'describes' })).toBe('describes');
  });
});
