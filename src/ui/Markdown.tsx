import type { ReactNode } from 'react';

/** Inline: **bold**, *italic*, `code`. Everything is rendered as text nodes (no HTML injection). */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** Minimal Markdown renderer: headings, lists, tables, paragraphs. */
export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${k++}`;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const body = inline(h[2]!, key);
      out.push(level <= 1 ? <h2 key={key}>{body}</h2> : level === 2 ? <h3 key={key}>{body}</h3> : <h4 key={key}>{body}</h4>);
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <table key={key} className="md-table">
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    const isUl = (l: string) => /^\s*[-*・]\s+/.test(l);
    const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? isOl(lines[i]!) : isUl(lines[i]!))) {
        items.push(lines[i++]!.replace(/^\s*([-*・]|\d+[.)])\s+/, ''));
      }
      const lis = items.map((t, j) => <li key={j}>{inline(t, `${key}l${j}`)}</li>);
      out.push(ordered ? <ol key={key}>{lis}</ol> : <ul key={key}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^#{1,4}\s/.test(lines[i]!) && !isUl(lines[i]!) && !isOl(lines[i]!)
      && !(lines[i]!.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!))) {
      para.push(lines[i++]!);
    }
    out.push(<p key={key}>{para.flatMap((t, j) => [...(j > 0 ? [<br key={`br${j}`} />] : []), ...inline(t, `${key}p${j}`)])}</p>);
  }
  return <div className="md">{out}</div>;
}
