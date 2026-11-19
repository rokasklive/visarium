import { describe, expect, it } from 'vitest';
import { credit } from './use-editing';

describe('who last changed a task', () => {
  const me = { id: 'me', displayName: 'Rokas' };
  const names = (id: string) => ({ ada: 'Ada' })[id];

  it('names an agent as an agent, and the person it acted for', () => {
    expect(credit({ by: 'ada', byAgent: 'Claude Code on laptop' }, me, names)).toBe(
      'Claude Code on laptop (agent) for Ada',
    );
    expect(credit({ by: 'me', byAgent: 'Claude Code' }, me, names)).toBe(
      'Claude Code (agent) for Rokas',
    );
  });

  it('names a person plainly', () => {
    expect(credit({ by: 'ada' }, me, names)).toBe('Ada');
    expect(credit({ by: 'me' }, me, names)).toBe('Rokas');
    expect(credit({ by: 'gone' }, me, names)).toBe('Someone');
  });
});
