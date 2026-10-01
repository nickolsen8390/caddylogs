// Renders one release from CHANGELOG.md. Only what the changelog uses is
// understood — `###` headings, `-` lists with indented continuation lines,
// paragraphs, and inline `code`, **bold** and [links](…) — and everything is
// built as React elements, so nothing in the file is ever treated as HTML.

/** Split markdown into headings, lists and paragraphs. */
function blocks(md) {
  const out = [];
  let para = null;
  let list = null;
  const flush = () => {
    if (para) out.push({ type: 'p', text: para.join(' ') });
    if (list) out.push({ type: 'ul', items: list.map((i) => i.join(' ')) });
    para = null;
    list = null;
  };

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{3,6}\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      out.push({ type: 'h', text: heading[1] });
    } else if (item) {
      if (para) flush();
      list ??= [];
      list.push([item[1]]);
    } else if (list && /^\s/.test(line)) {
      list[list.length - 1].push(line.trim());
    } else {
      if (list) flush();
      para ??= [];
      para.push(line.trim());
    }
  }
  flush();
  return out;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) parts.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) parts.push(<strong key={key}>{m[2]}</strong>);
    else if (/^https?:\/\//i.test(m[4])) {
      parts.push(<a key={key} href={m[4]} target="_blank" rel="noreferrer">{m[3]}</a>);
    } else {
      // A relative link points into the repository, not this app.
      parts.push(m[3]);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export default function ReleaseNotes({ notes }) {
  const parsed = blocks(notes ?? '');
  if (!parsed.length) return <p className="faint" style={{ margin: 0 }}>No notes for this release.</p>;
  return (
    <div className="release-notes">
      {parsed.map((b, i) =>
        b.type === 'h' ? (
          <h3 key={i}>{inline(b.text)}</h3>
        ) : b.type === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}
          </ul>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        )
      )}
    </div>
  );
}
