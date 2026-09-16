import type { EchoConfig } from './config.js';
import { hash } from './identity.js';
const stopwords = new Set([
  '的',
  '了',
  '和',
  '与',
  '是',
  '在',
  '如何',
  '什么',
  '为什么',
  '怎么',
  '一个',
  '哪些',
  '及',
]);
export function lexicalFingerprint(config: EchoConfig['lexical']) {
  return hash(
    JSON.stringify({
      version: 'icu-word-cjk-bigram-identifiers-2',
      icu: process.versions.icu,
      config,
    }),
  );
}
export function tokenize(
  text: string,
  config: EchoConfig['lexical'],
): string[] {
  const terms: string[] = [];
  const normalized = text.normalize('NFKC');
  const add = (word: string) => {
    const term = word.toLowerCase();
    if (term && !stopwords.has(term))
      terms.push('t' + Buffer.from(term, 'utf8').toString('hex'));
  };
  const segmenter = new Intl.Segmenter(config.locale, { granularity: 'word' });
  for (const part of segmenter.segment(normalized))
    if (part.isWordLike) add(part.segment);
  for (const match of normalized.matchAll(/[A-Za-z][A-Za-z0-9_.$-]*/g)) {
    add(match[0]);
    for (const part of match[0]
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/))
      add(part);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    for (let i = 0; i + 1 < chars.length; i++) add(chars[i]! + chars[i + 1]!);
  }
  for (const word of config.dictionary)
    if (normalized.toLowerCase().includes(word.normalize('NFKC').toLowerCase()))
      add(word.normalize('NFKC'));
  return terms;
}
export function matchExpression(
  query: string,
  config: EchoConfig['lexical'],
): string | null {
  const terms = [...new Set(tokenize(query, config))].slice(0, 128);
  return terms.length ? terms.map((t) => '"' + t + '"').join(' OR ') : null;
}
