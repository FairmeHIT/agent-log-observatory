# runtime: Private Runtime Artifacts

**Only this file and `sqlite3.exe` ship with releases.** Everything else may contain local paths, real sessions, or collection history — never commit or publish it.

Default contents: `collectors/<agent>/attempts-YYYYMMDD.jsonl`, `logs/`, `processes/`, `tmp/`, `npm-cache/`, `private/`, plus cache `observatory.db*`, resource snapshots, proxy routes, and collector locks/diagnostics.

Missing directories are created on demand. Do not delete DB/WAL, PID, or lock files while services are running. Runtime caches are not dependency sources; originals live in `vendor/`.

For SQLite CLI version/hash/origin, see `vendor/manifest.json` and `docs/dependency-inventory.md`.
