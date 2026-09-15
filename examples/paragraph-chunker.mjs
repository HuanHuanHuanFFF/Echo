// Trusted local extension: replace the default algorithm with paragraph ranges.
export default {
  id: 'example-paragraphs',
  version: '1',
  chunk({ lines }) {
    const ranges = [];
    let start;
    for (const line of lines) {
      if (line.text.trim()) start ??= line.number;
      else if (start !== undefined) {
        ranges.push({
          startLine: start,
          endLine: line.number - 1,
          headingPath: [],
        });
        start = undefined;
      }
    }
    if (start !== undefined)
      ranges.push({
        startLine: start,
        endLine: lines.at(-1).number,
        headingPath: [],
      });
    return ranges;
  },
};
