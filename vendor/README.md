# vendor: Reproducible Dependencies and Originals

Must ship with every clone/full release. Never substitute files from developer user directories.

- `npm/` — locally repackaged tgz of the two npm packages in use; installed offline by setup.
- `licenses/` — MIT license texts for archived packages.
- `archives/` — pre-2026-10-04 plugin/collector/install-script originals; historical reference only, not an install entry point.
- `manifest.json` — SHA-256, versions, sizes, provenance; verified by `npm run doctor`.

To update a dependency: verify source/license → replace tgz → sync package/lockfile and manifest → clean-directory offline setup → run tests. Never just swap node_modules or copy binaries built on another machine.

See `docs/dependency-inventory.md` and `THIRD_PARTY_NOTICES.md` for details.
