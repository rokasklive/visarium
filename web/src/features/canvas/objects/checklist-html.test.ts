import { describe, expect, it } from 'vitest';
import { checklistHtml } from './layout';

describe('checklistHtml', () => {
  it('keeps every value inert, the state included', () => {
    const evil = 'x"><img src=x onerror=alert(1)>';
    const root = document.createElement('div');
    root.innerHTML = checklistHtml(evil, [{ id: 't1', text: evil, state: evil }]);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('li')?.getAttribute('class')).toBe(evil);
    expect(root.querySelector('.vo-text')?.textContent).toBe(evil);
  });
});
