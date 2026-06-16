// Package main: chunked tx_last_seen_v1 backfill (issue #1724).
//
// Stub for the RED test commit — returns zero counts and nil error so the
// test compiles + runs to assertions (which then fail, proving the gate).
// The GREEN commit replaces this body with the real chunked implementation.

package main

import (
	"context"
	"database/sql"
	"time"
)

type txBackfillProgressFn func(processed, total int64)

func chunkedTxLastSeenBackfill(
	ctx context.Context,
	db *sql.DB,
	batchSize int,
	yieldDelay time.Duration,
	progress txBackfillProgressFn,
) (processed int64, total int64, err error) {
	// Intentional no-op stub: real implementation lands in the GREEN commit.
	_ = ctx
	_ = db
	_ = batchSize
	_ = yieldDelay
	_ = progress
	return 0, 0, nil
}
