import {
  asAssetId,
  asCanvasId,
  asItemId,
  CanvasDocument,
  CanvasHistory,
  type CanvasOperationBody,
  type GroupId,
  type ItemId,
  newGroupId,
} from '@visarium/canvas-core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  duplicateSelection,
  labelBodies,
  opacityBodies,
  SelectionToolbar,
  soleGroupId,
} from './selection-toolbar';

/**
 * The acts the bar performs, as operations.
 *
 * The bar's own pixels are the e2e walkthrough's business. What belongs here is
 * what each press turns into: one batch, one undo entry, and every field the
 * copy has to carry.
 */

const canvas = asCanvasId('board-acts');

function board(count: number, kind: 'image' | 'placeholder' = 'image') {
  const doc = new CanvasDocument(canvas);
  const ids: ItemId[] = [];
  for (let i = 0; i < count; i++) {
    const itemId = asItemId(`i-${i}`);
    ids.push(itemId);
    doc.apply({
      type: 'item.create',
      itemId,
      transform: { x: i * 200, y: 0, width: 100, height: 80, rotation: 0.3 },
      z: i,
      content:
        kind === 'image'
          ? {
              kind: 'image',
              asset: { assetId: asAssetId(`a-${i}`), intrinsicWidth: 100, intrinsicHeight: 80 },
            }
          : { kind: 'placeholder', intrinsicWidth: 100, intrinsicHeight: 80 },
    });
  }
  return { doc, ids, selection: new Set(ids) };
}

/** One press is one batch through history, which is exactly what the bar does. */
const commit = (history: CanvasHistory, bodies: CanvasOperationBody[]) => history.apply(...bodies);

describe('opacity', () => {
  it('is one operation per item, carrying the whole appearance', () => {
    const { doc, ids, selection } = board(3);
    doc.apply({
      type: 'item.appearance',
      itemId: ids[0] as ItemId,
      appearance: { opacity: 1, flipX: true, flipY: false },
    });

    const bodies = opacityBodies(doc, selection, 0.4);

    expect(bodies).toHaveLength(3);
    // The flip that was already set travels with it, because the body is
    // absolute state rather than a difference.
    expect(bodies[0]).toEqual({
      type: 'item.appearance',
      itemId: ids[0],
      appearance: { opacity: 0.4, flipX: true, flipY: false },
    });
  });

  it('is one undo entry however many items it touched', () => {
    const { doc, selection } = board(50);
    const history = new CanvasHistory(doc);

    commit(history, opacityBodies(doc, selection, 0.4));
    expect(history.undo()).toBe(true);

    for (const item of doc.items()) expect(item.appearance.opacity).toBe(1);
    expect(history.canUndo).toBe(false);
  });
});

describe('labelling', () => {
  it('groups an ungrouped selection and names it in one act', () => {
    const { doc, selection } = board(3);
    const history = new CanvasHistory(doc);

    const bodies = labelBodies(doc, selection, 'corner');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.type).toBe('group.create');
    commit(history, bodies);

    expect(doc.groupCount).toBe(1);
    expect([...doc.groups()][0]?.label).toBe('corner');
    history.undo();
    expect(doc.groupCount).toBe(0);
  });

  // The decision that makes the group/label slot deterministic: it is never
  // disabled, because a group of one is a real group.
  it('permits a group of one', () => {
    const { doc, ids } = board(1);
    const history = new CanvasHistory(doc);

    commit(history, labelBodies(doc, new Set(ids), 'the one'));

    const group = [...doc.groups()][0];
    expect(group?.memberIds).toEqual(ids);
    expect(group?.label).toBe('the one');
  });

  it('renames a selection that is already a group, keeping its id and members', () => {
    const { doc, ids, selection } = board(2);
    const history = new CanvasHistory(doc);
    const groupId = newGroupId();
    doc.apply({ type: 'group.create', groupId, memberIds: ids, label: 'first' });

    const bodies = labelBodies(doc, selection, 'second');
    expect(bodies).toEqual([{ type: 'group.label', groupId, label: 'second' }]);
    commit(history, bodies);

    expect(doc.group(groupId)?.label).toBe('second');
    expect(doc.group(groupId)?.memberIds).toEqual(ids);
    history.undo();
    expect(doc.group(groupId)?.label).toBe('first');
  });
});

describe('soleGroupId', () => {
  it('is undefined when the selection is only part of a group', () => {
    const { doc, ids } = board(3);
    doc.apply({ type: 'group.create', groupId: newGroupId(), memberIds: ids });
    expect(soleGroupId(doc, ids.slice(0, 2))).toBeUndefined();
  });

  it('is undefined when the selection spans two groups', () => {
    const { doc, ids } = board(2);
    doc.apply({ type: 'group.create', groupId: newGroupId(), memberIds: [ids[0] as ItemId] });
    doc.apply({ type: 'group.create', groupId: newGroupId(), memberIds: [ids[1] as ItemId] });
    expect(soleGroupId(doc, ids)).toBeUndefined();
  });
});

describe('duplicating', () => {
  it('copies size, rotation and appearance, offset and above everything', () => {
    const { doc, ids, selection } = board(5);
    const history = new CanvasHistory(doc);
    doc.apply({
      type: 'item.appearance',
      itemId: ids[0] as ItemId,
      appearance: { opacity: 0.3, flipX: true, flipY: false },
    });
    const source = doc.item(ids[0] as ItemId);

    const { bodies, itemIds } = duplicateSelection(doc, selection);
    commit(history, bodies);

    expect(itemIds).toHaveLength(5);
    const copy = doc.item(itemIds[0] as ItemId);
    expect(copy?.appearance).toEqual(source?.appearance);
    expect(copy?.transform.rotation).toBe(source?.transform.rotation);
    expect(copy?.transform.width).toBe(source?.transform.width);
    expect(copy?.transform.x).toBe((source?.transform.x as number) + 24);
    // Above everything currently on the board, so a copy is never hidden under
    // what it was copied from.
    for (const id of ids) expect(copy?.z).toBeGreaterThan(doc.item(id)?.z as number);

    expect(history.undo()).toBe(true);
    expect(doc.itemCount).toBe(5);
  });

  it('gives the copies of a group a new group carrying the same label', () => {
    const { doc, ids, selection } = board(3);
    const history = new CanvasHistory(doc);
    const groupId = newGroupId();
    doc.apply({ type: 'group.create', groupId, memberIds: ids, label: 'corner' });

    const { bodies, itemIds } = duplicateSelection(doc, selection);
    commit(history, bodies);

    const copied = doc.item(itemIds[0] as ItemId)?.groupId as GroupId;
    expect(copied).not.toBe(groupId);
    expect(doc.group(copied)?.label).toBe('corner');
    expect(doc.group(copied)?.memberIds).toEqual(itemIds);
  });

  /*
   * A placeholder has no asset id, and only the ORIGINAL's upload will ever
   * produce an `item.content` for the ORIGINAL's id — so a copy of one would be
   * deferred by BoardSync forever. The tool stays present and copies what can be
   * copied rather than creating something the server can never hold.
   */
  it('skips a still-uploading item and copies the rest', () => {
    const { doc, ids } = board(2, 'image');
    const uploading = asItemId('pending');
    doc.apply({
      type: 'item.create',
      itemId: uploading,
      transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
      z: 99,
      content: { kind: 'placeholder', intrinsicWidth: 10, intrinsicHeight: 10 },
    });

    const { bodies, itemIds } = duplicateSelection(doc, new Set([...ids, uploading]));

    expect(itemIds).toHaveLength(2);
    for (const body of bodies) {
      if (body.type === 'item.create') expect(body.content.kind).toBe('image');
    }
  });

  it('produces nothing at all when there is nothing it can copy', () => {
    const { doc, selection } = board(2, 'placeholder');
    expect(duplicateSelection(doc, selection).bodies).toEqual([]);
  });
});

/**
 * The order of the slots, which a spec enumerates and muscle memory depends on.
 *
 * Rendered rather than asserted about, because "take out sits after duplicate
 * and before the divider that isolates delete" is a claim about markup and
 * nothing else. What the control DOES is `writeAssetTransfer`, `copySelection`
 * and `dragNotice`, each tested where it lives; what a real drag carries is the
 * e2e walkthrough's business, since a synthetic `dragstart` would test the stub.
 */
function markup(kind: 'image' | 'placeholder', collapsed = false) {
  const { doc, selection } = board(2, kind);
  return renderToStaticMarkup(
    createElement(SelectionToolbar, {
      doc,
      camera: { x: 0, y: 0, zoom: 1 },
      size: { width: 1200, height: 800 },
      selection,
      commit: () => {},
      setSelection: () => {},
      onOpacityPreview: () => {},
      hidden: false,
      labelSignal: 0,
      collapsed,
      onToggleCollapsed: () => {},
    }),
  );
}

/** Every control's accessible name, in the order the bar renders them. */
function controls(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1] as string);
}

describe('the order of the tools', () => {
  it('is one fixed order, and delete is still last before the fold', () => {
    // The bar is icons now, so the accessible name IS the name — which is also
    // the only name a screen reader or a test ever had.
    expect(controls(markup('image'))).toEqual([
      'Take out',
      'Label',
      'Frame',
      'Flip H',
      'Flip V',
      'Front',
      'Back',
      'Group',
      'Duplicate',
      'Opacity',
      'Delete',
      'Hide tools',
    ]);
  });

  it('gives every icon a name, so none of them is hover-only', () => {
    const html = markup('image');

    // One accessible name per control, and no control without one.
    expect(controls(html).length).toBe((html.match(/<button/g) ?? []).length + 1);
  });

  it('keeps take out present and in place where there is no clipboard API', () => {
    // A plain-HTTP instance is not a secure context and has no Clipboard API at
    // all — precisely the deployment this product is for. The control still
    // exists and still sits in its slot; pressing it states why.
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', {});
    try {
      expect(controls(markup('image'))[0]).toBe('Take out');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is the same bar for a selection of items that are still uploading', () => {
    // Context changes what a control does, never whether it is there.
    expect(controls(markup('placeholder'))).toEqual(controls(markup('image')));
  });

  it('folds to the handle alone, which is the only way back', () => {
    expect(controls(markup('image', true))).toEqual(['Show tools']);
  });
});

describe('the frame toggle', () => {
  /**
   * The bar over a selection that is exactly one whole group, half of one, or
   * an ungrouped pile. An EMPTY selection has no bar at all — the Absent Panel
   * Rule — so it is not a case here.
   */
  function framedBar(frame: boolean, take: 'whole' | 'part' | 'loose'): string {
    const { doc, ids } = board(2);
    let selection: ReadonlySet<ItemId>;
    if (take === 'loose') {
      selection = new Set(ids);
    } else {
      const groupId = newGroupId();
      doc.apply({
        type: 'group.create',
        groupId,
        memberIds: ids,
        ...(frame ? { frame: true } : {}),
      });
      selection = take === 'whole' ? new Set(ids) : new Set([ids[0] as ItemId]);
    }
    return renderToStaticMarkup(
      createElement(SelectionToolbar, {
        doc,
        camera: { x: 0, y: 0, zoom: 1 },
        size: { width: 1200, height: 800 },
        selection,
        commit: () => {},
        setSelection: () => {},
        onOpacityPreview: () => {},
        hidden: false,
        labelSignal: 0,
        collapsed: false,
        onToggleCollapsed: () => {},
      }),
    );
  }

  it('reads pressed and offers the reverse act while framed', () => {
    const html = framedBar(true, 'whole');
    expect(html).toContain('aria-label="Unframe"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('reads unpressed for an unframed group', () => {
    const html = framedBar(false, 'whole');
    expect(html).toContain('aria-label="Frame"');
    expect(html).not.toContain('aria-pressed');
  });

  it('stays present but unable to act when the selection is not exactly one group', () => {
    // Half a group and an ungrouped pile are the same thing to the person:
    // this is not a cluster yet. The control says so before it is pressed.
    for (const take of ['part', 'loose'] as const) {
      const html = framedBar(false, take);
      expect(html).toContain('aria-label="Frame"');
      expect(html).toContain('text-ink-disabled');
      expect(html).toContain('Select exactly one whole group');
    }
  });
});
