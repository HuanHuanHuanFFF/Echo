const PYTHON_WHITESPACE_CLASS =
  '[ \\t\\n\\v\\f\\r\\u001c-\\u001f\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';

function isPythonWhitespaceAt(text, index) {
  const value = text.codePointAt(index);
  return (
    (value >= 0x09 && value <= 0x0d) ||
    (value >= 0x1c && value <= 0x20) ||
    value === 0x85 ||
    value === 0xa0 ||
    value === 0x1680 ||
    (value >= 0x2000 && value <= 0x200a) ||
    value === 0x2028 ||
    value === 0x2029 ||
    value === 0x202f ||
    value === 0x205f ||
    value === 0x3000
  );
}

const nativeRawEntriesCache = new WeakMap();

function getNativeRawEntries(source) {
  const cached = nativeRawEntriesCache.get(source);
  if (cached?.sourceText === source.text) return cached.entries;
  const entries = extractNativeRawEntries(source.text);
  nativeRawEntriesCache.set(source, { sourceText: source.text, entries });
  return entries;
}

function startsWithNativeHeading(text) {
  const heading = text.match(/^#+/u);
  return heading !== null && isPythonWhitespaceAt(text, heading[0].length);
}

function codePointLength(text) {
  return [...text].length;
}

function pythonTrimRange(text) {
  let start = 0;
  let end = text.length;
  while (start < end && isPythonWhitespaceAt(text, start))
    start += text.codePointAt(start) > 0xffff ? 2 : 1;
  while (end > start) {
    let previous = end - 1;
    const last = text.charCodeAt(previous);
    if (last >= 0xdc00 && last <= 0xdfff) previous--;
    if (!isPythonWhitespaceAt(text, previous)) break;
    end = previous;
  }
  return [start, end];
}

function pythonTokenCount(text) {
  let count = 0;
  let inToken = false;
  for (let index = 0; index < text.length;) {
    const whitespace = isPythonWhitespaceAt(text, index);
    if (!whitespace && !inToken) count++;
    inToken = !whitespace;
    index += text.codePointAt(index) > 0xffff ? 2 : 1;
  }
  return count;
}

function mappedSlice(value, start, end) {
  return {
    text: value.text.slice(start, end),
    origins: value.origins.slice(start, end),
  };
}

function mappedConcat(...values) {
  return {
    text: values.map((value) => value.text).join(''),
    origins: values.flatMap((value) => value.origins),
  };
}

function unmapped(text) {
  return { text, origins: Array(text.length).fill(-1) };
}

function splitMapped(value, expression) {
  const sections = [];
  let cursor = 0;
  for (const match of value.text.matchAll(expression)) {
    sections.push(mappedSlice(value, cursor, match.index));
    const delimiter = match[1];
    sections.push(
      mappedSlice(value, match.index, match.index + delimiter.length),
    );
    cursor = match.index + delimiter.length;
  }
  sections.push(mappedSlice(value, cursor, value.text.length));
  return sections;
}

function stripNulls(value) {
  const text = [];
  const origins = [];
  for (let index = 0; index < value.text.length; index++) {
    if (value.text[index] === '\0') continue;
    text.push(value.text[index]);
    origins.push(value.origins[index]);
  }
  return { text: text.join(''), origins };
}

function splitMappedLiteral(value, separator) {
  const pieces = [];
  let cursor = 0;
  for (;;) {
    const index = value.text.indexOf(separator, cursor);
    if (index < 0) {
      pieces.push(mappedSlice(value, cursor, value.text.length));
      break;
    }
    pieces.push(mappedSlice(value, cursor, index));
    cursor = index + separator.length;
  }
  return mappedConcat(
    ...pieces
      .slice(1)
      .flatMap((piece, index) =>
        index === 0 ? [piece] : [unmapped('\n'), piece],
      ),
  );
}

function buildAncestry(ancestry) {
  const headings = [...ancestry.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, heading]) => heading);
  return mappedConcat(
    ...headings.flatMap((heading, index) =>
      index === 0 ? [heading] : [unmapped('\n'), heading],
    ),
  );
}

function maxHeadingLevel(text) {
  let maximum = 0;
  for (const match of text.matchAll(/(?:^|\n)(#+)/gu))
    maximum = Math.max(maximum, match[1].length);
  return maximum;
}

// Mirrors MarkdownToEntries.process_single_markdown_file from Khoj 1.42.10.
// Origins follow copied characters through recursive splits; generated ancestry
// separators have no source credit.
function extractNativeRawEntries(sourceText, maxTokens = 256) {
  const entries = [];
  const initial = {
    text: sourceText,
    origins: Array.from({ length: sourceText.length }, (_, index) => index),
  };

  const recurse = (markdown, ancestry) => {
    const ancestryText = buildAncestry(ancestry);
    const withAncestry = mappedConcat(ancestryText, markdown);
    const childLevel = ancestry.size + 1;
    const childPattern = new RegExp(
      '^#{' + childLevel + ',}' + PYTHON_WHITESPACE_CLASS,
      'm',
    );
    if (
      pythonTokenCount(withAncestry.text) <= maxTokens ||
      !childPattern.test(markdown.text)
    ) {
      entries.push(stripNulls(withAncestry));
      return;
    }

    let sections;
    let nextLevel = ancestry.size;
    const maximum = maxHeadingLevel(markdown.text);
    while (sections === undefined || sections.length < 2) {
      nextLevel++;
      const splitter = new RegExp(
        '(\\n|^)(?=#{' + nextLevel + '} .+\\n?)',
        'gm',
      );
      sections = splitMapped(markdown, splitter);
      if (sections.length >= 2) break;
      if (nextLevel > maximum) return;
    }

    for (const section of sections) {
      const [sectionStart, sectionEnd] = pythonTrimRange(section.text);
      if (sectionStart === sectionEnd) continue;

      let lineStart = 0;
      let firstLine;
      let firstLineStart;
      for (const line of section.text.split('\n')) {
        const [trimStart, trimEnd] = pythonTrimRange(line);
        if (trimStart < trimEnd) {
          firstLine = line;
          firstLineStart = lineStart;
          break;
        }
        lineStart += line.length + 1;
      }
      if (firstLine === undefined) continue;

      const currentAncestry = new Map(ancestry);
      const prefix = '#'.repeat(nextLevel) + ' ';
      if (firstLine.startsWith(prefix)) {
        const firstLineOrigins = section.origins.slice(
          firstLineStart,
          firstLineStart + firstLine.length,
        );
        const title = firstLine.slice(nextLevel);
        const [titleStart, titleEnd] = pythonTrimRange(title);
        const normalizedTitle = title.slice(titleStart, titleEnd);
        const heading = {
          text: prefix + normalizedTitle,
          origins: [
            ...firstLineOrigins.slice(0, nextLevel + 1),
            ...firstLineOrigins.slice(
              nextLevel + titleStart,
              nextLevel + titleEnd,
            ),
          ],
        };
        currentAncestry.set(nextLevel, heading);
        recurse(splitMappedLiteral(section, firstLine), currentAncestry);
      } else {
        recurse(section, currentAncestry);
      }
    }
  };

  recurse(initial, new Map());
  return entries;
}

function sanitizeCompiled(value) {
  const text = [];
  const origins = [];
  let cursor = 0;
  while (cursor < value.text.length) {
    const wordStart = cursor;
    while (
      cursor < value.text.length &&
      !isPythonWhitespaceAt(value.text, cursor)
    )
      cursor += value.text.codePointAt(cursor) > 0xffff ? 2 : 1;
    const wordEnd = cursor;
    while (
      cursor < value.text.length &&
      isPythonWhitespaceAt(value.text, cursor)
    )
      cursor += value.text.codePointAt(cursor) > 0xffff ? 2 : 1;
    const partEnd = cursor;
    const word = value.text.slice(wordStart, wordEnd);
    if (codePointLength(word) <= 500) {
      for (let index = wordStart; index < partEnd; index++) {
        if (value.text[index] === '\0') continue;
        text.push(value.text[index]);
        origins.push(value.origins[index]);
      }
    }
  }
  return { text: text.join(''), origins };
}

function sourceSpans(origins) {
  const positions = [
    ...new Set(origins.filter((position) => position >= 0)),
  ].sort((left, right) => left - right);
  const spans = [];
  for (const position of positions) {
    const last = spans.at(-1);
    if (last && position <= last[1]) last[1] = Math.max(last[1], position + 1);
    else spans.push([position, position + 1]);
  }
  return spans;
}

// Credit only returned compiled characters traceable to a unique source origin.
export function mapKhojCompiled(text, source, native) {
  if (
    !native ||
    typeof native.entry !== 'string' ||
    typeof native.file !== 'string'
  )
    return { status: 'missing-native-metadata', spans: [] };
  if (
    native.file.replaceAll('\\', '/') !==
    source.relative_path.replaceAll('\\', '/')
  )
    return { status: 'native-file-mismatch', spans: [] };

  const raw = native.entry;
  const rawCandidates = getNativeRawEntries(source).filter(
    (candidate) => candidate.text === raw,
  );
  if (rawCandidates.length === 0)
    return { status: 'raw-unmapped-native-entry', spans: [] };
  // update_embeddings builds hash_to_current_entries with dict(zip(...));
  // duplicate compiled hashes therefore keep the last parser-order entry.
  const rawOrigins = rawCandidates.at(-1).origins;

  const prefix =
    '# ' + native.file + '\n' + (startsWithNativeHeading(raw) ? '#' : '');
  const compiled = {
    text: prefix + raw,
    origins: [...Array(prefix.length).fill(-1), ...rawOrigins],
  };
  const cleaned = sanitizeCompiled(compiled);
  const value = text.trim();
  const candidates = [{ body: value, extra: [] }];
  const heading = native.heading ?? '';
  const shortHeading = [...heading].slice(-100).join('');
  if (
    shortHeading &&
    text.startsWith(shortHeading + '\n') &&
    compiled.text.startsWith(heading)
  ) {
    const start = heading.length - shortHeading.length;
    const extra = compiled.origins.slice(start, heading.length);
    candidates.push({
      body: text.slice(shortHeading.length + 1).trim(),
      extra,
    });
  }
  for (const candidate of candidates) {
    if (!candidate.body) continue;
    const start = cleaned.text.indexOf(candidate.body);
    if (start < 0) continue;
    if (cleaned.text.indexOf(candidate.body, start + 1) >= 0)
      return { status: 'ambiguous-compiled', spans: [] };
    const spans = sourceSpans([
      ...cleaned.origins.slice(start, start + candidate.body.length),
      ...candidate.extra,
    ]);
    return { status: spans.length ? 'mapped' : 'metadata-only', spans };
  }
  return { status: 'unmapped-compiled', spans: [] };
}
