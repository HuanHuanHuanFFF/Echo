# Repository Guidelines

## Scope & Architecture

Build Echo as a lightweight personal Markdown retrieval MCP using TypeScript and embedded SQLite, without a separate database service. Preserve heading-aware chunking behavior; legacy NoteRAG is a reference, not an inherited architecture.

BM25, API vector retrieval, RRF, and subquestion queries are implemented. Use source, lockfile, phase records, and fresh checks to distinguish verified behavior from historical proposals and unmeasured retrieval quality.

## Project Structure & Context

Implementation lives in src/, isolated regressions in tests/, runnable examples in examples/, and fixed evaluation data in evals/. Load references by task:

- Scope or dependency changes: `docs/project/baseline.md`.
- Development phases and acceptance: `docs/project/2026-09-15-development-plan.md`; follow applicable newer revisions.
- Configuration or chunking contracts: `docs/design/configuration.md`; retrieval/MCP behavior and evidence: `docs/development/phase-03-hybrid-retrieval.md` and `docs/development/phase-04-agent-mcp.md`.
- Retrieval experiments or improvement claims: `docs/development/phase-05-evaluation-delivery.md` and dated reports under docs/evals/; the Chroma snapshot is historical context.
- Documentation additions: follow `docs/README.md` and update its index for long-term documents.

Follow the latest explicit user requirements. When a newer applicable plan or decision revises an older plan, or the two conflict in a way that blocks execution, follow the newer document for that scope. Record its date, status, superseded scope, and links to prior documents; retain older documents without wholesale rewrites. A newer research note or unconfirmed proposal alone does not override confirmed requirements.

Keep decisions in their owning document and experiments in dated snapshots. External vault paths are local references; verify accessibility before relying on them.

## Development & Validation

For each development phase, maintain a concise record under `docs/` before marking it complete: what was implemented, module responsibilities, scope boundaries and remaining gaps, plus verification results with relevant code or test links. Organize by phase and topic; link to existing decisions rather than repeating them or keeping a chronological work log.

Use package.json as the executable command source. npm run check runs formatting, type checking, isolated tests, and build; CI runs the same checks on Windows and Linux. Keep model-key evaluation separate from ordinary CI.

For documentation changes, inspect `git status --short`, review tracked edits with `git diff`, inspect new files separately, and run `git diff --check`. Verify referenced paths and report checks actually performed.

## Style & Tests

Use the configured two-space formatting, camelCase functions/variables, and PascalCase types. Keep documentation concise and consistent with the existing Chinese materials. Use descriptive filenames and `YYYY-MM-DD-description.md` for experiments.

Vitest is installed; no coverage threshold exists. Test discovery is limited to tests/**/*.test.ts; references/ remains read-only research material. Use `*.test.ts`, isolated Markdown fixtures, and temporary databases when adding tests. Prioritize chunk boundaries, filtering, index updates, and evidence coverage.

Compare retrieval experiments with fixed queries, corpus, embedding configuration, and final context budgets. The 12-question Chroma baseline establishes neither whole-library quality nor Echo performance.

## Git, Reviews & Data Boundaries

Follow the initial commit's type-prefixed format: `docs: 整理 Echo 项目基线与检索设计`. Keep commits focused. PRs should state the problem, change, validation, and limitations, with relevant design or issue links.

For each development phase, create a new `codex/` branch from the preceding phase's integrated state, normally updated `main` after its PR is merged. Commit each small, coherent increment after relevant checks pass. Complete phase documentation and validation, push via HTTPS to `https://github.com/HuanHuanHuanFFF/Echo.git`, verify the remote commit, and open a PR targeting `main`. Commit, push, and PR creation follow this standing authorization; merging requires user authorization. Later user restrictions take precedence. Keep credentials, personal notes, and generated indexes outside commits. Editing external notes or rebuilding their indexes requires task authorization; documentation work does not grant it.
