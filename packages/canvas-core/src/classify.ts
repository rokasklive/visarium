/**
 * What pasted or dropped text becomes on a board.
 *
 * Runs only after the surface has already declined the payload as an image or
 * a URL it handles. The rules are fixed and deliberately narrow (specs
 * canvas/diagrams and canvas/checklists): prose that merely mentions a diagram
 * keyword stays a note, because a wrong guess costs more than a missed one —
 * a note can always be turned into a diagram, but a paragraph swallowed into a
 * broken diagram reads as Visarium losing your text.
 */

import type { CanvasItemContent, Task } from './model';

/** First lines that open a Mermaid diagram, matched against the whole line. */
const MERMAID_FIRST_LINE = new RegExp(
  '^(' +
    [
      '(?:flowchart|graph)(?:\\s+(?:TB|TD|BT|RL|LR))?',
      'sequenceDiagram',
      'classDiagram(?:-v2)?',
      'stateDiagram(?:-v2)?',
      'erDiagram',
      'journey',
      'gantt',
      'pie(?:\\s+(?:showData|title\\s.*))?',
      'gitGraph(?:\\s*:)?',
      'mindmap',
      'timeline',
      'quadrantChart',
      'requirementDiagram',
      'C4(?:Context|Container|Component|Dynamic|Deployment)',
      '(?:sankey|xychart|block|packet|architecture)-beta',
      'kanban',
    ].join('|') +
    ')\\s*$',
);

const PLANTUML_FIRST_LINE = /^@start(?:uml|mindmap|wbs|gantt|salt|json|yaml)\b/;
const TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;
const HEADING_LINE = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^```\s*(mermaid|plantuml|puml)\s*\n([\s\S]*?)\n```\s*$/;

/** The first line that carries meaning: not blank, not a Mermaid `%%` comment. */
function firstLine(text: string): string {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('%%')) return t;
  }
  return '';
}

export function classifyText(text: string): CanvasItemContent {
  const trimmed = text.trim();
  // A fenced block copied out of Markdown is its contents.
  const fenced = FENCE.exec(trimmed);
  if (fenced) {
    const source = fenced[2] as string;
    return { kind: 'diagram', lang: fenced[1] === 'mermaid' ? 'mermaid' : 'plantuml', source };
  }

  const first = firstLine(trimmed);
  if (PLANTUML_FIRST_LINE.test(first))
    return { kind: 'diagram', lang: 'plantuml', source: trimmed };
  if (MERMAID_FIRST_LINE.test(first)) return { kind: 'diagram', lang: 'mermaid', source: trimmed };

  const checklist = asChecklist(trimmed);
  return checklist ?? { kind: 'note', source: trimmed };
}

/**
 * Task lines only, optionally led by ONE heading, which becomes the title.
 * Anything else on a line of its own (a paragraph, a plain bullet) makes the
 * whole paste a note, where Markdown checkboxes still work.
 */
function asChecklist(text: string): CanvasItemContent | undefined {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim());
  let title = '';
  const heading = lines[0] !== undefined ? HEADING_LINE.exec(lines[0]) : null;
  if (heading) {
    title = heading[1] as string;
    lines.shift();
  }
  const tasks: Task[] = [];
  for (const line of lines) {
    const m = TASK_LINE.exec(line);
    if (!m) return undefined;
    tasks.push({
      id: `t${tasks.length + 1}`,
      text: m[2] as string,
      state: m[1] === ' ' ? 'todo' : 'done',
    });
  }
  return tasks.length > 0 ? { kind: 'checklist', title, tasks } : undefined;
}
