import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const digest = (x) => createHash('sha256').update(x).digest('hex');
export async function* jsonLines(file) {
  let pending = '',
    line = 0;
  const parse = (value) => {
    line++;
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('Invalid JSONL record ' + file + ':' + line);
    }
  };
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const value = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (value.trim()) yield parse(value);
    }
  }
  if (pending.trim()) yield parse(pending);
}
export const normalizeEvidence = (text) => text.replace(/\s+/gu, ' ').trim();
export function qasperMarkdown(paper, sourceId) {
  const lines = [
    '---',
    'echo_id: ' + sourceId,
    '---',
    '# ' + paper.title.replace(/\s+/g, ' '),
    '',
  ];
  const paragraphs = [];
  const append = (text) => {
    const body = text.replace(/\r\n?|\n/g, '\n');
    const start = lines.length + 1;
    lines.push(...body.split('\n'));
    const end = lines.length;
    paragraphs.push({
      id: paragraphs.length,
      text: body,
      start_line: start,
      end_line: end,
    });
    lines.push('');
  };
  if (paper.abstract?.trim()) {
    lines.push('## Abstract', '');
    append(paper.abstract);
  }
  for (const section of paper.full_text) {
    lines.push(
      '## ' + (section.section_name || 'Untitled').replace(/\s+/g, ' '),
      '',
    );
    for (const text of section.paragraphs) if (text.trim()) append(text);
  }
  return { markdown: lines.join('\n'), paragraphs };
}
export function qasperLabels(question, paragraphs) {
  const lookup = new Map();
  for (const p of paragraphs) {
    const key = normalizeEvidence(p.text);
    const ids = lookup.get(key) ?? [];
    ids.push(p.id);
    lookup.set(key, ids);
  }
  const annotations = question.answers.map(
    ({ annotation_id, answer }, index) => {
      const mapped = answer.evidence.map((text) => ({
        text,
        paragraph_ids: lookup.get(normalizeEvidence(text)) ?? [],
        visual: text.startsWith('FLOAT SELECTED'),
      }));
      return {
        id: annotation_id ?? String(index),
        unanswerable: answer.unanswerable,
        evidence: mapped,
        valid:
          !answer.unanswerable &&
          mapped.length > 0 &&
          mapped.every((e) => !e.visual && e.paragraph_ids.length > 0),
      };
    },
  );
  const valid = annotations.filter((a) => a.valid);
  return {
    annotations,
    eligible: valid.length > 0,
    category: valid.length
      ? 'text_evidence'
      : annotations.every((a) => a.unanswerable)
        ? 'unanswerable'
        : 'unsupported_evidence',
    annotation_disagreement:
      annotations.some((a) => a.unanswerable) &&
      annotations.some((a) => !a.unanswerable),
  };
}
export async function preparePublic(root, runtimeDir) {
  const prepared = path.join(root, 'prepared');
  await fs.mkdir(prepared); // Refuse replacing an existing preparation.
  const notes = path.join(prepared, 'notes');
  await fs.mkdir(notes);
  const runtime = await import(
    pathToFileURL(path.join(runtimeDir, 'chunker.js')).href
  );
  const structure = (
    await import(
      new URL(
        '../examples/profiles/chunkers/markdown-structure-v1.mjs',
        import.meta.url,
      )
    )
  ).default;
  const outputs = {},
    handles = {};
  for (const name of [
    'qasper-docs',
    'qasper-queries',
    'heading-chunks',
    'structure-chunks',
  ]) {
    handles[name] = await fs.open(path.join(prepared, name + '.jsonl'), 'wx');
    outputs[name] = { rows: 0, chars: 0 };
  }
  const emit = async (name, data) => {
    await handles[name].write(JSON.stringify(data) + '\n');
    outputs[name].rows++;
    if (data.input) outputs[name].chars += data.input.length;
  };
  const sourceIds = JSON.parse(
    await fs.readFile(
      new URL('./fixtures/qasper-v0.3-source-ids.json', import.meta.url),
      'utf8',
    ),
  );
  const categories = {},
    disagreements = { questions: 0 };
  let rawQ = 0;
  for await (const paper of jsonLines(
    path.join(root, 'data/qasper-dev.jsonl'),
  )) {
    const sourceId = sourceIds[paper.id];
    assert.ok(sourceId, 'Paper missing from frozen UUID map');
    const { markdown, paragraphs } = qasperMarkdown(paper, sourceId);
    const filename = paper.id.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.md';
    const file = path.join(notes, filename);
    await fs.writeFile(file, markdown);
    await emit('qasper-docs', {
      id: paper.id,
      source_id: sourceId,
      file,
      relative_path: filename,
      sha256: digest(markdown),
      paragraphs,
    });
    for (const q of paper.qas) {
      const label = qasperLabels(q, paragraphs);
      rawQ++;
      categories[label.category] = (categories[label.category] ?? 0) + 1;
      if (label.annotation_disagreement) disagreements.questions++;
      await emit('qasper-queries', {
        id: q.question_id,
        text: q.question,
        paper_id: paper.id,
        source_id: sourceId,
        ...label,
      });
    }
    const lines = markdown
      .split('\n')
      .map((text, i) => ({ number: i + 1, text }))
      .slice(3);
    for (const [name, chunker] of [
      ['heading', runtime.defaultChunker],
      ['structure', structure],
    ]) {
      const chunks = await runtime.runChunker(chunker, {
        sourceId,
        path: file,
        lines,
        options: { max_chars: 1000 },
      });
      for (const c of chunks)
        await emit(name + '-chunks', {
          source_id: sourceId,
          paper_id: paper.id,
          file,
          relative_path: filename,
          ...c,
          input: [path.basename(file, '.md'), ...c.headingPath, c.text].join(
            '\n',
          ),
        });
    }
  }
  for (const h of Object.values(handles)) await h.close();
  assert.equal(rawQ, 1005);
  assert.equal(outputs['qasper-docs'].rows, 281);
  for (const [name, stats] of Object.entries(outputs))
    stats.sha256 = digest(
      await fs.readFile(path.join(prepared, name + '.jsonl')),
    );
  const audit = {
    version: 1,
    qasper: { questions: rawQ, categories, disagreements, outputs },
    download_manifest_sha256: digest(
      await fs.readFile(path.join(root, 'download-manifest.json')),
    ),
    conversion_manifest_sha256: digest(
      await fs.readFile(path.join(root, 'conversion-manifest.json')),
    ),
  };
  await fs.writeFile(
    path.join(prepared, 'audit.json'),
    JSON.stringify(audit, null, 2) + '\n',
  );
  return audit;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  console.log(
    JSON.stringify(
      await preparePublic(
        path.resolve(process.argv[2]),
        path.resolve(process.argv[3]),
      ),
      null,
      2,
    ),
  );
}

export async function lastRowsById(file) {
  const rows = new Map();
  for await (const row of jsonLines(file)) {
    const id = row._id ?? row.id;
    assert.equal(typeof id, 'string');
    rows.set(id, row);
  }
  return rows;
}
