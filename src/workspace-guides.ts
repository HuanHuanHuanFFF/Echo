import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { retrievalOverridesSchema, retrievalSchema } from './config.js';

export async function workspaceGuides(): Promise<Record<string, string>> {
  const root = new URL(
    import.meta.url.endsWith('.ts')
      ? '../templates/workspace/'
      : './templates/workspace/',
    import.meta.url,
  );
  const properties = z.toJSONSchema(retrievalOverridesSchema).properties!;
  const rows = Object.entries(retrievalSchema.parse({})).map(
    ([name, value]) => {
      const schema = properties[name]!;
      if (typeof schema !== 'object')
        throw new Error(
          'Retrieval field must have an explicit schema: ' + name,
        );
      const range = schema.enum
        ? schema.enum.join(' / ')
        : [
            schema.type,
            schema.minimum === undefined ? '' : '≥ ' + schema.minimum,
            schema.exclusiveMinimum === undefined
              ? ''
              : '> ' + schema.exclusiveMinimum,
            schema.maximum === undefined ? '' : '≤ ' + schema.maximum,
          ]
            .filter(Boolean)
            .join('; ');
      return (
        '| ' +
        [name, JSON.stringify(value), range, schema.description].join(' | ') +
        ' |'
      );
    },
  );
  const files: Record<string, string> = {};
  for (const path of [
    'config/README.md',
    'config/embedding/README.md',
    'config/retrieval/README.md',
    'chunkers/README.md',
    'tokenizers/README.md',
  ]) {
    files[path] = (await readFile(new URL(path, root), 'utf8')).replace(
      '<!-- RETRIEVAL_PARAMETERS -->',
      [
        '| 参数 | 内置默认 | 类型与范围 | 含义 |',
        '| --- | --- | --- | --- |',
        ...rows,
      ].join('\n'),
    );
  }
  return files;
}
