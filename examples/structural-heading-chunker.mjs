import { defaultChunker } from '../dist/chunker.js';
export default {
  id: 'example-structural-heading',
  version: '1-' + defaultChunker.version,
  async chunk(input) {
    const ranges = await defaultChunker.chunk(input);
    const lines = new Map(input.lines.map((line) => [line.number, line.text]));
    return ranges.filter((range, index) => {
      const next = ranges[index + 1];
      const parent =
        next &&
        next.headingPath.length > range.headingPath.length &&
        range.headingPath.every(
          (heading, i) => next.headingPath[i] === heading,
        );
      let headingOnly = true;
      for (let n = range.startLine; n <= range.endLine; n++) {
        const text = lines.get(n) ?? '';
        if (text.trim() && !/^ {0,3}#{1,6}[ \t]+/.test(text))
          headingOnly = false;
      }
      return !(parent && headingOnly);
    });
  },
};
