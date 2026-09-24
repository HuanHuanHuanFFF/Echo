import { mapReturnedText } from './product-evidence.mjs';

// Mirror the pinned Dify default cleaner while retaining only the original
// character positions actually present after cleaning.
function cleanWithOrigins(text) {
  let value = '';
  const origins = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (
      (char === '|' && (text[i - 1] === '<' || text[i + 1] === '>')) ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe]/u.test(char)
    )
      continue;
    value += char;
    origins.push(i);
  }
  return { text: value, origins };
}

function spaceFallbackOffsets(text, maxChars = 1024) {
  const allowed = new Set();
  const separators = ['\n\n', '。', '. ', ' ', ''];
  function visit(start, end, choices) {
    const value = text.slice(start, end);
    const index = choices.findIndex(
      (separator) => !separator || value.includes(separator),
    );
    const separator = choices[index];
    if (!separator) return;
    if (separator === ' ') {
      for (let i = start; i < end; i++) if (text[i] === ' ') allowed.add(i);
      return;
    }
    let cursor = start;
    for (const piece of value.split(separator)) {
      if ([...piece].length >= maxChars && index + 1 < choices.length)
        visit(cursor, cursor + piece.length, choices.slice(index + 1));
      cursor += piece.length + separator.length;
    }
  }
  let cursor = 0;
  for (const piece of text.split('\n\n')) {
    if ([...piece].length > maxChars)
      visit(cursor, cursor + piece.length, separators);
    cursor += piece.length + 2;
  }
  return allowed;
}

function contiguousSpans(positions) {
  const spans = [];
  for (const position of positions) {
    const last = spans.at(-1);
    if (last && last[1] === position) last[1]++;
    else spans.push([position, position + 1]);
  }
  return spans;
}

function matchAt(source, target, start) {
  let cursor = start;
  const positions = [];
  for (let i = 0; i < target.length;) {
    // The native fallback separator re.split(r" +", text) can collapse
    // ASCII spaces. Credit exactly the returned number of source spaces.
    if (source.text[cursor] === ' ' && target[i] === ' ') {
      let left = cursor,
        right = i;
      while (source.text[cursor] === ' ') cursor++;
      while (target[i] === ' ') i++;
      if (i - right > cursor - left) return null;
      if (
        i - right !== cursor - left &&
        (i - right !== 1 || !source.spaceFallback.has(left))
      )
        return null;
      for (let n = 0; n < i - right; n++)
        positions.push(source.origins[left + n]);
    } else {
      if (source.text[cursor] !== target[i]) return null;
      positions.push(source.origins[cursor]);
      cursor++;
      i++;
    }
  }
  return { cursor, spans: contiguousSpans(positions) };
}

// Repeated content is located only after the complete ordered partition is
// proven under the pinned, explicit product transformations. Removed symbols
// and collapsed spaces are never credited as returned evidence.
export function mapDifyPartition(segments, source) {
  const ordered = [...segments].sort((a, b) => a.position - b.position);
  const fallback = () => ({
    partition_verified: false,
    mappings: segments.map((row) => ({
      id: row.id,
      mapping: mapReturnedText(row.content, source),
    })),
  });
  if (new Set(ordered.map((row) => row.position)).size !== ordered.length)
    return fallback();
  const cleaned = cleanWithOrigins(source.text);
  cleaned.spaceFallback = spaceFallbackOffsets(cleaned.text);
  let cursor = 0;
  const mappings = [];
  for (const segment of ordered) {
    const target = segment.content.trim();
    if (!target) return fallback();
    while (cursor < cleaned.text.length && /\s/u.test(cleaned.text[cursor]))
      cursor++;
    let found = matchAt(cleaned, target, cursor);
    if (!found && ['.', '。'].includes(cleaned.text[cursor])) {
      let alternative = cursor + 1;
      while (
        alternative < cleaned.text.length &&
        /\s/u.test(cleaned.text[alternative])
      )
        alternative++;
      found = matchAt(cleaned, target, alternative);
    }
    if (!found) return fallback();
    cursor = found.cursor;
    mappings.push({
      id: segment.id,
      mapping: { status: 'mapped', spans: found.spans },
    });
  }
  if (cleaned.text.slice(cursor).trim()) return fallback();
  return { partition_verified: true, mappings };
}
