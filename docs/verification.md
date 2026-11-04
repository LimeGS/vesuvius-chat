# Release verification

Verified 2026-11-04 using this release's lockfile. These badges are snapshots, not live
GitHub status or a promise that future dependency audits will remain clean.

| Application metric | Coverage |
| --- | --- |
| lines | 99.07% |
| statements | 96.35% |
| branches | 94.48% |
| functions | 97.24% |

All four metrics exceed **90%**. Scope: executable application/lib/proxy TypeScript
covered by Vitest; Python backend tests run separately and are not included in this
percentage. Dependencies, generated code and model weights are excluded.

**npm audit: 0 vulnerabilities**, including development dependencies.

Reproduce with:

```sh
npm run test:coverage -- --maxWorkers=1
npm audit --json > audit.json
npm run badges:update
npm run check:publication
```

The Quality workflow enforces the same coverage floor and audit gate. Model weights,
live Discord credentials, paid generation and NVIDIA hardware are not exercised by
these offline verification commands. Keep generated reports and credentials out of
source publication.
