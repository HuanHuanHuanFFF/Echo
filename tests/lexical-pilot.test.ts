import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { tokenize } from '../src/lexical.js';
const { createPilotTokenizer, idf, rankFromPostings } = await import(
  pathToFileURL(resolve('evals/lib/lexical-pilot.mjs')).href
);
it('preserves existing tokens and actual repeated occurrences when replacing only the word pass', () => {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const fromIcu = createPilotTokenizer((s: string) =>
    [...segmenter.segment(s)].filter((p) => p.isWordLike).map((p) => p.segment),
  );
  for (const text of [
    'timeout timeout HTTPServer',
    '如何配置向量数据库？',
    'ＡＢＣ１２３ max_output_tokens=100',
    '😀数据库 空间\r\nC++ C#',
    'a.b $x a_b x-y',
  ]) {
    expect(fromIcu(text)).toEqual(
      tokenize(text, { locale: 'zh-CN', dictionary: [] }),
    );
  }
  const word = 't' + Buffer.from('timeout').toString('hex');
  expect(
    fromIcu('timeout timeout').filter((t: string) => t === word),
  ).toHaveLength(6);
  const replaced = createPilotTokenizer(() => ['向量数据库']);
  expect(replaced('向量数据库')[0]).toBe(
    't' + Buffer.from('向量数据库').toString('hex'),
  );
});
it('reconstructs native FTS5 BM25 from postings, including common terms and empty documents', () => {
  const db = new Database(':memory:');
  try {
    db.exec(
      "CREATE VIRTUAL TABLE fts USING fts5(title,body,content=''); CREATE VIRTUAL TABLE vocab USING fts5vocab(fts,'instance')",
    );
    const meta = new Map<number, { id: string; length: number }>();
    const texts = [
      'common rare rare',
      'common other',
      'common common',
      '',
      'extra',
    ];
    const insert = db.prepare(
      'INSERT INTO fts(rowid,title,body) VALUES (?,?,?)',
    );
    texts.forEach((s, i) => {
      insert.run(i + 1, '', s);
      meta.set(i + 1, {
        id: String(i + 1),
        length: s ? s.split(' ').length : 0,
      });
    });
    const postings = db.prepare(
      "SELECT doc,count(*) tf FROM vocab WHERE term=? AND col='body' GROUP BY doc",
    );
    const terms = ['common', 'rare'];
    const manual = rankFromPostings(
      terms,
      (t: string) => postings.all(t),
      5,
      8 / 5,
      meta,
      'sqlite',
    );
    const native = db
      .prepare(
        'SELECT rowid,bm25(fts,2,1) score FROM fts WHERE fts MATCH ? ORDER BY score,rowid',
      )
      .all('"common" OR "rare"') as { rowid: number; score: number }[];
    expect(manual.map((r: { id: string }) => r.id)).toEqual(
      native.map((r) => String(r.rowid)),
    );
    manual.forEach((r: { score: number }, i: number) =>
      expect(r.score).toBeCloseTo(-native[i]!.score, 12),
    );
    expect(idf(5, 4, 'sqlite')).toBe(1e-6);
    expect(idf(5, 4, 'lucene')).toBeGreaterThan(0);
    expect(() => idf(5, 6, 'sqlite')).toThrow();
  } finally {
    db.close();
  }
});
