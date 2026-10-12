# releases: Exported Distributions

Run `npm run release` to generate a standalone directory `agent-log-observatory-<version>/` with a file hash manifest. Existing directories are never overwritten to prevent accidental deletion of prior deliverables.

Each export contains source code, sanitized fixtures, template config, dependency archives, and SQLite — never personal config, real logs, databases, node_modules, or runtime artifacts.

In the export directory, run `node scripts/setup.mjs` and `npm test`, then manually review privacy and licensing before packaging. Package the export directory itself, not the entire workspace. Actual output is gitignored; this README is tracked.
