import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';

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
});
