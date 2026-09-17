// Fixed, self-contained strategy. Change the ID when changing the policy.
export const policy = Object.freeze({
  targetChars: 1000,
  maxChars: 1500,
  shortSectionChars: 200,
  overlapChars: 80,
});
const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const list = /^( {0,3})(?:[-+*]|\d+[.)])[ \t]+/;
const quote = /^ {0,3}>/;
const indented = /^(?: {4}|\t)/;
const fenceMarker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/;
function opener(text) {
  const match = fenceMarker.exec(text);
  return match && !(match[1][0] === '\x60' && match[2].includes('\x60'))
    ? match[1]
    : undefined;
}
function closes(text, fence) {
  const match = fenceMarker.exec(text);
  return Boolean(
    match &&
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    !match[2].trim(),
  );
}
function tableDelimiter(text) {
  const cells = text.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return (
    cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell))
  );
}
export default {
  id: 'markdown-structure-v1',
  version: '1',
  chunk(input) {
    const lines = input.lines;
    if (!lines.length) return [];
    const prefix = [0];
    for (const line of lines) prefix.push(prefix.at(-1) + line.text.length + 1);
    const length = (a, b) => (b < a ? 0 : prefix[b + 1] - prefix[a] - 1);
    const blank = (i) => !lines[i].text.trim();
    const root = {
      level: 0,
      start: 0,
      end: lines.length - 1,
      path: [],
      parent: null,
      children: [],
    };
    const stack = [root],
      sections = [],
      headingLines = new Set();
    let current = { owner: root, start: 0 },
      fence;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].text;
      if (fence) {
        if (closes(text, fence)) fence = undefined;
        continue;
      }
      const opening = opener(text);
      if (opening) {
        fence = opening;
        continue;
      }
      const match = atx.exec(text);
      const underline =
        !match &&
        text.trim() &&
        !indented.test(text) &&
        !list.test(text) &&
        !quote.test(text) &&
        i + 1 < lines.length &&
        /^ {0,3}(=+|-+)[ \t]*$/.exec(lines[i + 1].text);
      if (!match && !underline) continue;
      const level = match ? match[1].length : underline[1][0] === '=' ? 1 : 2;
      const title = match
        ? (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
        : text.trim();
      current.end = i - 1;
      if (current.start <= current.end) sections.push(current);
      while (stack.at(-1).level >= level) stack.pop().end = i - 1;
      const parent = stack.at(-1);
      const owner = {
        level,
        start: i,
        end: lines.length - 1,
        path: [...parent.path, title].filter(Boolean),
        parent,
        children: [],
      };
      parent.children.push(owner);
      stack.push(owner);
      current = { owner, start: i };
      headingLines.add(i);
      if (underline) headingLines.add(++i);
    }
    current.end = lines.length - 1;
    if (current.start <= current.end) sections.push(current);
    for (const s of sections) {
      s.hasBody = false;
      for (let i = s.start; i <= s.end; i++)
        if (!blank(i) && !headingLines.has(i)) s.hasBody = true;
      s.short =
        s.hasBody &&
        !s.owner.children.length &&
        length(s.start, s.end) <= policy.shortSectionChars;
    }
    // Bind an otherwise empty ancestor heading to its following descendant.
    const folded = [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i],
        next = sections[i + 1];
      let descendant = next?.owner;
      while (descendant && descendant !== s.owner)
        descendant = descendant.parent;
      if (!s.hasBody && s.owner !== root && next && descendant === s.owner)
        next.start = s.start;
      else if (
        Array.from({ length: s.end - s.start + 1 }, (_, j) => s.start + j).some(
          (j) => !blank(j),
        )
      )
        folded.push(s);
    }
    const groups = [];
    for (const s of folded) {
      const prev = groups.at(-1);
      const parent = s.owner.parent;
      if (
        prev?.short &&
        s.short &&
        parent &&
        parent !== root &&
        prev.parent === parent &&
        prev.end + 1 === s.start &&
        length(prev.start, prev.end) < policy.targetChars &&
        length(prev.start, s.end) <= policy.maxChars
      ) {
        prev.end = s.end;
        prev.path = parent.path;
      } else
        groups.push({
          start: s.start,
          end: s.end,
          owner: s.owner,
          path: s.owner.path,
          parent,
          short: s.short,
        });
    }
    const ranges = [];
    for (const group of groups) {
      let container = group.owner;
      while (
        container.parent &&
        (container.start > group.start || container.end < group.end)
      )
        container = container.parent;
      const emit = (a, b) => {
        while (a <= b && blank(a)) a++;
        while (b >= a && blank(b)) b--;
        if (a <= b)
          ranges.push({
            startLine: lines[a].number,
            endLine: lines[b].number,
            headingPath: [...group.path],
            sectionStartLine: lines[container.start].number,
            sectionEndLine: lines[container.end].number,
          });
      };
      const isTable = (i) =>
        i < group.end &&
        lines[i].text.includes('|') &&
        tableDelimiter(lines[i + 1].text);
      const special = (i) =>
        headingLines.has(i) ||
        opener(lines[i].text) ||
        list.test(lines[i].text) ||
        quote.test(lines[i].text) ||
        indented.test(lines[i].text) ||
        isTable(i);
      const units = [];
      let pendingHeading;
      for (let i = group.start; i <= group.end;) {
        if (blank(i)) {
          i++;
          continue;
        }
        if (headingLines.has(i)) {
          pendingHeading ??= i;
          i++;
          continue;
        }
        const bodyStart = i,
          text = lines[i].text;
        let kind = 'paragraph',
          end = i;
        const opening = opener(text);
        if (opening) {
          kind = 'code';
          end = group.end;
          for (let j = i + 1; j <= group.end; j++)
            if (closes(lines[j].text, opening)) {
              end = j;
              break;
            }
        } else if (isTable(i)) {
          kind = 'table';
          end = i + 1;
          while (
            end < group.end &&
            !blank(end + 1) &&
            lines[end + 1].text.includes('|') &&
            !headingLines.has(end + 1)
          )
            end++;
        } else if (list.test(text)) {
          kind = 'list';
          const indent = list.exec(text)[1].length;
          while (end < group.end) {
            let next = end + 1;
            if (blank(next)) {
              while (next <= group.end && blank(next)) next++;
            }
            if (next > group.end || headingLines.has(next)) break;
            const t = lines[next].text;
            if (list.test(t) || (/^\s/.test(t) && t.search(/\S/) > indent))
              end = next;
            else break;
          }
        } else if (quote.test(text)) {
          kind = 'quote';
          while (end < group.end && quote.test(lines[end + 1].text)) end++;
        } else if (indented.test(text)) {
          kind = 'code';
          while (end < group.end) {
            let next = end + 1;
            while (next <= group.end && blank(next)) next++;
            if (next <= group.end && indented.test(lines[next].text))
              end = next;
            else break;
          }
        } else {
          while (end < group.end && !blank(end + 1) && !special(end + 1)) end++;
        }
        const start = pendingHeading ?? bodyStart;
        pendingHeading = undefined;
        // Very long headings must not force an otherwise fitting body unit to split.
        if (
          start < bodyStart &&
          length(start, end) > policy.maxChars &&
          length(bodyStart, end) <= policy.maxChars
        ) {
          units.push({ start, end: bodyStart - 1, kind: 'heading' });
          units.push({ start: bodyStart, end, kind });
        } else units.push({ start, end, kind });
        i = end + 1;
      }
      if (pendingHeading !== undefined)
        units.push({ start: pendingHeading, end: group.end, kind: 'heading' });
      let first = -1,
        last = -1;
      const flush = () => {
        if (first >= 0) emit(first, last);
        first = -1;
        last = -1;
      };
      for (const unit of units) {
        if (length(unit.start, unit.end) > policy.maxChars) {
          flush();
          let start = unit.start,
            previousEnd = unit.start - 1;
          while (start <= unit.end) {
            let end = start;
            while (
              end < unit.end &&
              length(start, end + 1) <= policy.targetChars
            )
              end++;
            if (end < unit.end) {
              let preferred;
              for (let j = start + 1; j <= end; j++) {
                if (
                  (blank(j) ||
                    (unit.kind === 'list' && list.test(lines[j].text))) &&
                  j - 1 > previousEnd
                )
                  preferred = j - 1;
              }
              if (preferred !== undefined) end = preferred;
            }
            if (end <= previousEnd) {
              start = previousEnd + 1;
              continue;
            }
            emit(start, end);
            previousEnd = end;
            if (end === unit.end) break;
            let next = end,
              count = 0;
            while (next > start && count < policy.overlapChars) {
              count += lines[next].text.length + 1;
              next--;
            }
            next++;
            start =
              next > start &&
              next <= end &&
              length(next, end) < policy.targetChars
                ? next
                : end + 1;
          }
        } else {
          if (
            first >= 0 &&
            (length(first, last) >= policy.targetChars ||
              length(first, unit.end) > policy.maxChars)
          )
            flush();
          if (first < 0) first = unit.start;
          last = unit.end;
        }
      }
      flush();
    }
    return ranges;
  },
};
