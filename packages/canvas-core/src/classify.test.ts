import { describe, expect, it } from 'vitest';
import { classifyText } from './classify';

const kind = (text: string) => {
  const c = classifyText(text);
  return c.kind === 'diagram' ? `diagram:${c.lang}` : c.kind;
};

describe('classifyText', () => {
  it.each([
    ['flowchart LR\n  A --> B', 'diagram:mermaid'],
    ['flowchart\n  A --> B', 'diagram:mermaid'],
    ['graph TD\n  A --> B', 'diagram:mermaid'],
    ['sequenceDiagram\n  A->>B: hi', 'diagram:mermaid'],
    ['classDiagram\n  class A', 'diagram:mermaid'],
    ['stateDiagram-v2\n  [*] --> A', 'diagram:mermaid'],
    ['erDiagram\n  A ||--o{ B : has', 'diagram:mermaid'],
    ['%% a comment first\n\nflowchart LR\n  A --> B', 'diagram:mermaid'],
    ['pie title Pets\n  "Dogs" : 3', 'diagram:mermaid'],
    ['@startuml\nAlice -> Bob\n@enduml', 'diagram:plantuml'],
    ['  @startmindmap\n* root\n@endmindmap', 'diagram:plantuml'],
    ['```mermaid\nflowchart LR\n  A --> B\n```', 'diagram:mermaid'],
    ['```plantuml\n@startuml\nA -> B\n@enduml\n```', 'diagram:plantuml'],
  ])('%j is a %s', (text, expected) => {
    expect(kind(text)).toBe(expected);
  });

  it.each([
    'graph theory is fun, and flowcharts help',
    'The flowchart LR layout reads left to right.',
    'pie is tasty',
    'sequenceDiagram is the keyword you want',
    'Some prose.\n\nAnd a second paragraph.',
    '- a plain bullet\n- another',
  ])('%j stays a note', (text) => {
    expect(kind(text)).toBe('note');
  });

  it('turns task lines led by one heading into a titled checklist', () => {
    expect(classifyText('## Release\n- [ ] Tag\n- [x] Changelog\n* [ ] Announce')).toEqual({
      kind: 'checklist',
      title: 'Release',
      tasks: [
        { id: 't1', text: 'Tag', state: 'todo' },
        { id: 't2', text: 'Changelog', state: 'done' },
        { id: 't3', text: 'Announce', state: 'todo' },
      ],
    });
  });

  it('takes task lines without a heading as an untitled checklist', () => {
    const c = classifyText('- [ ] one\n\n- [ ] two');
    expect(c.kind === 'checklist' && [c.title, c.tasks.length]).toEqual(['', 2]);
  });

  it('keeps prose with task lines as a note, where its checkboxes still work', () => {
    expect(kind('We still need to:\n- [ ] Tag\n- [ ] Announce')).toBe('note');
    expect(kind('## Release\n## Second heading\n- [ ] Tag')).toBe('note');
  });

  it('keeps the note source as pasted, trimmed of surrounding blank lines', () => {
    expect(classifyText('\n\n  Hello *there*\n\n')).toEqual({
      kind: 'note',
      source: 'Hello *there*',
    });
  });
});
