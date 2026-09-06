# Repository Guidelines

## Scope & Architecture

Build Echo as a lightweight personal Markdown retrieval MCP using TypeScript and embedded SQLite, without a separate database service. Preserve heading-aware chunking behavior; legacy NoteRAG is a reference, not an inherited architecture.

BM25, vector retrieval, RRF, and subquestion queries are goals. Drivers, SDK versions, and tool contracts remain proposals; distinguish decisions, designs, and verified behavior.

## Project Structure & Context

The repository currently contains documentation only, with no source, test, or asset directories. Load references by task:

- Scope or dependency changes: `docs/project/baseline.md`.
- Retrieval, grouping, or MCP interface design: `docs/design/retrieval.md`.
- Retrieval experiments or improvement claims: `docs/evals/2026-09-05-chroma-baseline.md`.
- Documentation additions: follow `docs/README.md` and update its index for long-term documents.

Keep decisions in their owning document and experiments in dated snapshots. External vault paths are local references; verify accessibility before relying on them.

## Development & Validation

No `package.json`, application entry point, formatter, linter, or build/test scripts exist yet. During scaffolding, document executable install, development, build, and test commands with their configuration.

For documentation changes, inspect `git status --short`, review tracked edits with `git diff`, inspect new files separately, and run `git diff --check`. Verify referenced paths and report checks actually performed.

## Style & Tests

For initial TypeScript code, use two-space indentation, camelCase functions/variables, and PascalCase types; codify formatting during scaffolding. Keep documentation concise and consistent with the existing Chinese materials. Use descriptive filenames and `YYYY-MM-DD-description.md` for experiments.

Vitest is proposed, not installed; no coverage threshold exists. Use `*.test.ts`, isolated Markdown fixtures, and temporary databases when adding tests. Prioritize chunk boundaries, filtering, index updates, and evidence coverage.

Compare retrieval experiments with fixed queries, corpus, embedding configuration, and final context budgets. The 12-question Chroma baseline establishes neither whole-library quality nor Echo performance.

## Git, Reviews & Data Boundaries

Follow the initial commit's type-prefixed format: `docs: 整理 Echo 项目基线与检索设计`. Keep commits focused. PRs should state the problem, change, validation, and limitations, with relevant design or issue links.

Commit and push within current user authorization; use HTTPS for `https://github.com/HuanHuanHuanFFF/Echo.git`. Keep credentials, personal notes, and generated indexes outside commits. Editing external notes or rebuilding their indexes requires task authorization; documentation work does not grant it.
