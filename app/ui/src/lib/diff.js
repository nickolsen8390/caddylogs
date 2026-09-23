// Line diff for reviewing a Caddyfile change before it is applied.
// Caddyfiles are small, so a plain LCS table (after trimming the common head
// and tail) is fast enough and gives the minimal, most readable result.

const MAX_CELLS = 4_000_000;

/**
 * @returns {{type:'same'|'add'|'del', text:string, a:number|null, b:number|null}[]}
 *          a / b are 1-based line numbers in the old / new text.
 */
export function diffLines(oldText, newText) {
  const a = split(oldText);
  const b = split(newText);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const out = [];
  for (let k = 0; k < head; k++) out.push({ type: 'same', text: a[k], a: k + 1, b: k + 1 });

  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;

  if (n * m > MAX_CELLS) {
    A.forEach((t, k) => out.push({ type: 'del', text: t, a: head + k + 1, b: null }));
    B.forEach((t, k) => out.push({ type: 'add', text: t, a: null, b: head + k + 1 }));
  } else {
    // lcs[i][j] = LCS length of A[i..] and B[j..], stored flat.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = A[i] === B[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        out.push({ type: 'same', text: A[i], a: head + i + 1, b: head + j + 1 });
        i++; j++;
      } else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
        out.push({ type: 'add', text: B[j], a: null, b: head + j + 1 });
        j++;
      } else {
        out.push({ type: 'del', text: A[i], a: head + i + 1, b: null });
        i++;
      }
    }
  }

  for (let k = tail; k > 0; k--) {
    out.push({ type: 'same', text: a[a.length - k], a: a.length - k + 1, b: b.length - k + 1 });
  }
  return out;
}

/** Collapse unchanged runs to `context` lines around each change. */
export function hunks(lines, context = 3) {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, k) => {
    if (l.type === 'same') return;
    for (let x = Math.max(0, k - context); x <= Math.min(lines.length - 1, k + context); x++) keep[x] = true;
  });
  const out = [];
  let skipped = 0;
  lines.forEach((l, k) => {
    if (keep[k]) {
      if (skipped) out.push({ type: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else {
      skipped++;
    }
  });
  if (skipped) out.push({ type: 'skip', count: skipped });
  return out;
}

export function diffStats(lines) {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.type === 'add') add++;
    else if (l.type === 'del') del++;
  }
  return { add, del };
}

function split(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (!t) return [];
  const parts = t.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}
