import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentIsWorking, EMPTY_PRESENCE } from '~/features/canvas/realtime';
import { AGENT_LINGER_MS, useUiStore } from './ui-store';

describe('ui store', () => {
  beforeEach(() => {
    useUiStore.setState({
      tool: 'select',
      sidebarOpen: true,
      selectedItemIds: new Set(),
      cropItemId: null,
    });
  });

  it('switches tools', () => {
    useUiStore.getState().setTool('pan');
    expect(useUiStore.getState().tool).toBe('pan');
  });

  it('toggles the sidebar', () => {
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it('replaces the selection rather than merging it', () => {
    useUiStore.getState().setSelection(['a', 'b']);
    useUiStore.getState().setSelection(['c']);
    expect(useUiStore.getState().selectedItemIds).toEqual(new Set(['c']));
  });

  it('keeps crop mode only while its item is the whole selection', () => {
    const { setSelection, setCropItemId } = useUiStore.getState();
    setSelection(['a']);
    setCropItemId('a');
    setSelection(['a']);
    expect(useUiStore.getState().cropItemId).toBe('a');
    setSelection(['a', 'b']);
    expect(useUiStore.getState().cropItemId).toBeNull();
    setSelection(['a']);
    setCropItemId('a');
    setSelection([]);
    expect(useUiStore.getState().cropItemId).toBeNull();
  });

  it('lights at once for a working agent and dims only after the linger', () => {
    vi.useFakeTimers();
    try {
      const { setAgentWorking } = useUiStore.getState();
      setAgentWorking(true);
      expect(useUiStore.getState().agentWorking).toBe(true);
      setAgentWorking(false);
      vi.advanceTimersByTime(AGENT_LINGER_MS - 1);
      expect(useUiStore.getState().agentWorking).toBe(true);
      setAgentWorking(true); // work resumed: the pending dim is cancelled
      vi.advanceTimersByTime(AGENT_LINGER_MS);
      expect(useUiStore.getState().agentWorking).toBe(true);
      setAgentWorking(false);
      vi.advanceTimersByTime(AGENT_LINGER_MS);
      expect(useUiStore.getState().agentWorking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts only an agent's focus as work", () => {
    const actor = (kind: 'agent' | 'person') =>
      ({ actorId: 'a1', displayName: 'Claude', colourIndex: 0, kind }) as never;
    const focus = new Map([['a1', { itemId: 'i' as never, verb: 'reading' }]]);
    expect(agentIsWorking(EMPTY_PRESENCE)).toBe(false);
    expect(
      agentIsWorking({ ...EMPTY_PRESENCE, actors: new Map([['a1', actor('agent')]]), focus }),
    ).toBe(true);
    expect(
      agentIsWorking({ ...EMPTY_PRESENCE, actors: new Map([['a1', actor('person')]]), focus }),
    ).toBe(false);
  });
});
