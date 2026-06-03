// Async migration helper — runs schema/backfill work that may take minutes on
// large prod tables WITHOUT blocking ingestor startup.
//
// MIGRATION ANNOTATION CONVENTION (read this before touching migrations):
//
//   Sync schema/data migrations (CREATE INDEX, ALTER TABLE, UPDATE ... WHERE)
//   that run inline during OpenStore() block the ingestor from accepting
//   packets until they finish. On an empty dev DB they return in milliseconds;
//   at prod scale (1.9M+ observations, 80K+ adverts) they can pin the boot
//   for minutes and trigger restart loops. This regression class has bitten us
//   repeatedly (#791 resolved_path backfill, #1483 obs_observer_ts_idx_v1).
//
//   ANY new CREATE INDEX / ALTER TABLE / data-rewrite migration MUST EITHER:
//     1. Run via Store.RunAsyncMigration(...) below (preferred for backfills
//        and any work that may touch >1K rows). The migration is recorded as
//        `pending_async` immediately, returns to the caller (boot proceeds),
//        and completes in a goroutine. Status flips to `done` (or `failed`
//        with an error message) when fn returns.
//     2. Carry the preflight annotation comment immediately above the
//        migration block, e.g.
//             // PREFLIGHT: async=true reason="<one-line justification>"
//        Use this for migrations that are genuinely cheap at any scale
//        (e.g. ALTER TABLE ADD COLUMN, CREATE INDEX on a known-bounded
//        table). The annotation is grepped by
//        ~/.openclaw/skills/pr-preflight/scripts/check-async-migrations.sh
//        — its absence on a touched migration block is a hard-fail gate.
//
//   See MIGRATIONS.md in the repo root for the full policy and examples.

package main

import (
	"context"
	"database/sql"
)

// RunAsyncMigration registers `name` as a pending async migration and
// schedules `fn` to run in a background goroutine. It returns to the caller
// immediately so the ingestor can keep booting.
//
// STUB: red-commit version. Implementation lands in the green commit; the
// failing test in async_migration_test.go pins the contract.
func (s *Store) RunAsyncMigration(ctx context.Context, name string, fn func(context.Context, *sql.DB) error) error {
	return nil
}

// AsyncMigrationStatus returns the current status of an async migration
// (one of "pending_async", "done", "failed") or sql.ErrNoRows if no such
// migration has been registered.
//
// STUB: red-commit version.
func (s *Store) AsyncMigrationStatus(name string) (string, error) {
	return "", sql.ErrNoRows
}
