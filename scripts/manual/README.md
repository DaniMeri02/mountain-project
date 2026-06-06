# Manual scripts

Ad-hoc tools run by hand — **not** wired into `package.json` and not imported by the app.
Kept for occasional checks and recovery, not part of the normal build/dev flow.

Run from the repo root.

## DB checks (plain Node, need a populated DB + `.env`)

```bash
node scripts/manual/check-db.js         # trail counts + previously-failed bbox chunks
node scripts/manual/check-pois.js       # POI sanity counts
node scripts/manual/check-coverage.js   # coverage spot-check
```

## Overpass recovery / import (tsx)

```bash
tsx scripts/manual/recover-failed-chunks.ts
tsx scripts/manual/retry-failed-track-chunks.ts
tsx scripts/manual/retry-failed-trails.ts
tsx scripts/manual/import-tracks.ts
```

Note: `check-*.js` and the recovery scripts contain hardcoded bboxes from past import runs —
review them before relying on the values.
