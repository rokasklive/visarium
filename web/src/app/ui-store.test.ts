import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';

describe('ui store', () => {
  beforeEach(() => {
    useUiStore.setState({ tool: 'select', sidebarOpen: true, selectedItemIds: new Set() });
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
});
