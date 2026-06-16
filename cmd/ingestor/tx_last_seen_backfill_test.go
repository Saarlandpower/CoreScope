// Tests for the chunked tx_last_seen backfill (issue #1724).
//
// These tests pin the contract the operator-scale fix MUST honor:
//
//  - The loop actually yields the writer between batches (concurrent
//    reader gets through in bounded latency — NOT just "chunks happen",
//    which a single-tx fake could satisfy).
//  - With seedN=12000 + batchSize=5000 the progress callback fires
//    multiple times (≥3 including terminal) — proves chunking happened.
//  - ctx cancellation mid-loop returns context.Canceled, partial rows
//    are committed (visible in the DB), no panic.
//  - Concurrent INSERT of new last_seen=0 rows during the loop does
//    NOT cause infinite iteration (maxID snapshot bounds the scan).
//  - Errors from inner queries (RowsAffected via driver poisoning) and
//    parameter validation propagate — migration does not silently mark done.
//  - Orphan transmissions (no matching observations) do NOT trap the
//    loop in an infinite n=0/n=0 ping-pong: the EXISTS filter skips them.

package main

import (
	"context"
	"database/sql"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

// seedTransmissions inserts n transmissions each with one observation,
// last_seen=0. Returns when done. Uses the store's raw db.
func seedTransmissions(t *testing.T, s *Store, n int) {
	t.Helper()
	// Wait for the boot-time async migrations to release the single writer
	// connection before we start a big seed — they're harmless on the empty
	// store but they race for SetMaxOpenConns(1).
	s.WaitForAsyncMigrations()
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatalf("seed begin: %v", err)
	}
	for i := 0; i < n; i++ {
		res, err := tx.Exec(`
			INSERT INTO transmissions (raw_hex, hash, first_seen, route_type, payload_type, payload_version, decoded_json, last_seen)
			VALUES (?, ?, datetime('now'), 2, 2, 0, '{}', 0)
		`, "deadbeef", randHex(i))
		if err != nil {
			t.Fatalf("seed tx %d: %v", i, err)
		}
		id, _ := res.LastInsertId()
		// Observer row + observation referencing this tx, with a stable timestamp.
		ts := int64(1_700_000_000 + i)
		if _, err := tx.Exec(`
			INSERT INTO observations (transmission_id, observer_idx, timestamp, snr, rssi, score, path_json)
			VALUES (?, NULL, ?, 0, 0, 0, '[]')
		`, id, ts); err != nil {
			t.Fatalf("seed obs %d: %v", i, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("seed commit: %v", err)
	}
}

func randHex(i int) string {
	return fmt.Sprintf("%016x", uint64(i)*0x9E3779B97F4A7C15+1)
}

// TestChunkedBackfill_YieldsToReaderBetweenBatches asserts that a concurrent
// reader gets through in bounded latency while the backfill is running. A
// fake single-transaction implementation would NOT satisfy this — the
// reader would queue behind sqlite_busy_timeout for the full duration.
func TestChunkedBackfill_YieldsToReaderBetweenBatches(t *testing.T) {
	s := newTestStore(t)
	seedTransmissions(t, s, 12_000)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Background backfill (modest yield delay so the test is bounded).
	backfillDone := make(chan error, 1)
	go func() {
		_, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 2000, 50*time.Millisecond, nil)
		backfillDone <- err
	}()

	// Give the backfill a moment to actually start its first chunk.
	time.Sleep(20 * time.Millisecond)

	// Concurrent reader: must succeed in bounded time. A single-tx
	// implementation that holds the writer for the full duration would
	// either time out or take seconds to acquire the lock.
	readDeadline := time.Now().Add(2 * time.Second)
	var readLatency time.Duration
	readStart := time.Now()
	var rowCount int64
	for time.Now().Before(readDeadline) {
		queryStart := time.Now()
		row := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM transmissions`)
		var c int64
		if err := row.Scan(&c); err != nil {
			t.Fatalf("reader scan: %v", err)
		}
		readLatency = time.Since(queryStart)
		rowCount = c
		if readLatency < 500*time.Millisecond {
			// Got a fast read while backfill running → good signal.
			break
		}
	}
	t.Logf("reader latency: %v, count=%d, total wall=%v", readLatency, rowCount, time.Since(readStart))
	if readLatency > 500*time.Millisecond {
		t.Errorf("reader latency=%v exceeded bound — backfill is not yielding the writer", readLatency)
	}

	// Backfill should complete.
	select {
	case err := <-backfillDone:
		if err != nil {
			t.Fatalf("backfill error: %v", err)
		}
	case <-time.After(25 * time.Second):
		t.Fatalf("backfill did not complete")
	}

	// Verify all rows got populated.
	var remaining int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM transmissions WHERE last_seen = 0`).Scan(&remaining); err != nil {
		t.Fatalf("post-check: %v", err)
	}
	if remaining != 0 {
		t.Errorf("remaining last_seen=0 rows: %d, want 0", remaining)
	}
}

// TestChunkedBackfill_MinBatchCount asserts the progress callback fires
// at least 3 times for seedN=12000 / batchSize=5000 (≥2 in-flight chunks
// + 1 terminal). A single-tx fake would fire 1 or 2 times only.
func TestChunkedBackfill_MinBatchCount(t *testing.T) {
	s := newTestStore(t)
	seedTransmissions(t, s, 12_000)

	var callbacks int64
	progress := func(processed, total int64) {
		atomic.AddInt64(&callbacks, 1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	processed, total, err := chunkedTxLastSeenBackfill(ctx, s.db, 5000, 5*time.Millisecond, progress)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if total != 12_000 {
		t.Errorf("total=%d, want 12000", total)
	}
	if processed != 12_000 {
		t.Errorf("processed=%d, want 12000", processed)
	}
	got := atomic.LoadInt64(&callbacks)
	if got < 3 {
		t.Errorf("progress callbacks=%d, want >=3 (proves real chunking)", got)
	}
}

// TestChunkedBackfill_CtxCancelMidLoop cancels ctx between batches and asserts
// the function returns context.Canceled, partial rows are committed (visible
// in DB), and no panic occurs.
func TestChunkedBackfill_CtxCancelMidLoop(t *testing.T) {
	s := newTestStore(t)
	seedTransmissions(t, s, 10_000)

	ctx, cancel := context.WithCancel(context.Background())

	// Cancel shortly after the first batch starts.
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()

	_, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 1000, 80*time.Millisecond, nil)
	if err == nil {
		t.Fatalf("expected context error, got nil")
	}
	if err != context.Canceled && ctx.Err() != context.Canceled {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	var done int64
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM transmissions WHERE last_seen != 0`).Scan(&done); err != nil {
		t.Fatalf("post-check: %v", err)
	}
	if done == 0 {
		t.Errorf("expected partial commits (>0), got 0 — backfill is not committing per chunk")
	}
	if done >= 10_000 {
		t.Errorf("cancel did not take effect, all %d rows committed", done)
	}
}

// TestChunkedBackfill_ConcurrentInsertTerminates inserts new last_seen=0
// rows during the loop. The maxID snapshot must bound the scan so the loop
// terminates.
func TestChunkedBackfill_ConcurrentInsertTerminates(t *testing.T) {
	s := newTestStore(t)
	seedTransmissions(t, s, 3000)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Concurrent inserter: keeps adding new last_seen=0 rows in tight loop.
	stopInserts := make(chan struct{})
	insertsDone := make(chan struct{})
	go func() {
		defer close(insertsDone)
		i := 100_000
		for {
			select {
			case <-stopInserts:
				return
			default:
			}
			_, err := s.db.Exec(`
				INSERT INTO transmissions (raw_hex, hash, first_seen, route_type, payload_type, payload_version, decoded_json, last_seen)
				VALUES ('aa', ?, datetime('now'), 2, 2, 0, '{}', 0)
			`, randHex(i))
			if err != nil {
				return
			}
			id, _ := func() (int64, error) {
				var lid int64
				err := s.db.QueryRow(`SELECT last_insert_rowid()`).Scan(&lid)
				return lid, err
			}()
			_, _ = s.db.Exec(`
				INSERT INTO observations (transmission_id, observer_idx, timestamp, snr, rssi, score, path_json)
				VALUES (?, NULL, ?, 0, 0, 0, '[]')
			`, id, int64(1_700_000_000+i))
			i++
			time.Sleep(time.Millisecond)
		}
	}()

	_, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 500, 5*time.Millisecond, nil)
	close(stopInserts)
	<-insertsDone

	if err != nil {
		t.Fatalf("backfill should terminate, got err=%v", err)
	}
}

// TestChunkedBackfill_ParamValidation: batchSize<=0 must reject (no <0 sentinel).
func TestChunkedBackfill_ParamValidation(t *testing.T) {
	s := newTestStore(t)
	s.WaitForAsyncMigrations()
	ctx := context.Background()
	if _, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 0, 100*time.Millisecond, nil); err == nil {
		t.Errorf("batchSize=0 must error")
	}
	if _, _, err := chunkedTxLastSeenBackfill(ctx, s.db, -1, 100*time.Millisecond, nil); err == nil {
		t.Errorf("batchSize=-1 must error")
	}
	if _, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 100, -1, nil); err == nil {
		t.Errorf("negative yieldDelay must error")
	}
}

// TestChunkedBackfill_OrphanTxTerminates: transmission row with no matching
// observation must NOT trap the loop. Using EXISTS in the WHERE clause skips
// the row; the chunk returns n=0 after eligible rows are exhausted; loop ends.
func TestChunkedBackfill_OrphanTxTerminates(t *testing.T) {
	s := newTestStore(t)
	s.WaitForAsyncMigrations()
	// One orphan tx (no observation row at all)
	if _, err := s.db.Exec(`
		INSERT INTO transmissions (raw_hex, hash, first_seen, route_type, payload_type, payload_version, decoded_json, last_seen)
		VALUES ('00', 'orphan', datetime('now'), 2, 2, 0, '{}', 0)
	`); err != nil {
		t.Fatalf("seed orphan: %v", err)
	}
	// Plus one normal tx so total>0.
	seedTransmissions(t, s, 5)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	processed, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 10, 5*time.Millisecond, nil)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	// Only the 5 non-orphan rows should be touched; orphan retains last_seen=0.
	if processed != 5 {
		t.Errorf("processed=%d, want 5 (orphan must be skipped)", processed)
	}
	var orphanLs int64
	_ = s.db.QueryRow(`SELECT last_seen FROM transmissions WHERE hash = 'orphan'`).Scan(&orphanLs)
	if orphanLs != 0 {
		t.Errorf("orphan tx last_seen=%d, want 0 (no observation to source MAX from)", orphanLs)
	}
}

// TestChunkedBackfill_ErrorPropagation_BadDB: a closed DB must surface as
// an error — migration must NOT silently report success.
func TestChunkedBackfill_ErrorPropagation_BadDB(t *testing.T) {
	s := newTestStore(t)
	s.WaitForAsyncMigrations()
	// Open a second handle to the same path then close it — using a fresh
	// closed *sql.DB gives a deterministic ExecContext failure.
	bad, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	bad.Close()
	ctx := context.Background()
	if _, _, err := chunkedTxLastSeenBackfill(ctx, bad, 100, 0, nil); err == nil {
		t.Errorf("closed DB must produce an error; got nil — migration would silently mark done")
	}
	// Sanity: live store still works (no global mutation).
	if _, _, err := chunkedTxLastSeenBackfill(ctx, s.db, 100, 0, nil); err != nil {
		t.Fatalf("sanity: live store backfill should succeed, got %v", err)
	}
}
