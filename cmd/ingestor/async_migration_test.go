package main

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// TestRunAsyncMigration_PendingThenDone pins the contract for RunAsyncMigration:
//
//   1. After calling, the migration name MUST be queryable in the migrations
//      table with status `pending_async` IMMEDIATELY (no waiting for fn).
//   2. After fn returns, the status MUST transition to `done`.
//   3. RunAsyncMigration MUST return without blocking on fn.
//
// This is the regression test for the recurring "sync migration on large
// table blocks ingestor startup" class (#791, #1483, ...). If this test
// fails the contract is broken — do not relax it; fix the runner.
func TestRunAsyncMigration_PendingThenDone(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	started := make(chan struct{})
	release := make(chan struct{})

	const name = "test_async_migration_v1"
	if err := s.RunAsyncMigration(ctx, name, func(ctx context.Context, db *sql.DB) error {
		close(started)
		<-release
		return nil
	}); err != nil {
		t.Fatalf("RunAsyncMigration returned error: %v", err)
	}

	// Wait for the goroutine to actually start before checking status; this
	// proves RunAsyncMigration did not block on fn and that fn is running
	// concurrently.
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("async migration fn did not start within 2s — RunAsyncMigration may have blocked or never scheduled")
	}

	status, err := s.AsyncMigrationStatus(name)
	if err != nil {
		t.Fatalf("AsyncMigrationStatus while running: %v", err)
	}
	if status != "pending_async" {
		t.Fatalf("status while fn running: got %q, want %q", status, "pending_async")
	}

	close(release)

	// Poll for transition to done.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		status, err = s.AsyncMigrationStatus(name)
		if err == nil && status == "done" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("status never transitioned to done within 2s: got %q (err=%v)", status, err)
}
