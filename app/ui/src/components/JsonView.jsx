// Pretty-printer with syntax colouring for the raw log entry.
//
// Log lines are attacker-influenced data, so the output is built as React text
// nodes — never innerHTML — and every token is escaped by React itself.

const TOKEN =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function classify(token, isKey) {
  if (isKey) return 'jkey';
  if (token.startsWith('"')) return 'jstr';
  if (token === 'true' || token === 'false') return 'jbool';
  if (token === 'null') return 'jnull';
  return 'jnum';
}

export function JsonView({ value, raw }) {
  let text;
  if (value !== null && value !== undefined) {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(raw ?? '');
    }
  } else {
    text = String(raw ?? '(no raw line stored — it may have aged out of retention)');
  }

  const nodes = [];
  let last = 0;
  let match;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const isKey = Boolean(match[2]);
    nodes.push(
      <span key={`${match.index}`} className={classify(token, isKey)}>
        {token}
      </span>
    );
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));

  return <pre className="log-json">{nodes}</pre>;
}
