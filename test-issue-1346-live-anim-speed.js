/* Tests for #1346 — per-packet animation honors VCR.speed in BOTH modes.
 *
 * Bug history: PR #922 introduced `stepMs = 33 / VCR.speed` / `DURATION_MS = 1100 / VCR.speed`
 * so slow-mo (0.25×) and fast-fwd (4×/8×) work for the per-packet animation. An interim fix
 * mode-gated that to REPLAY only, which removed the ability to slow down / speed up LIVE
 * animation. Operator wants the original #922 behavior restored: animation ALWAYS follows
 * VCR.speed regardless of LIVE/REPLAY.
 *
 * Behavior:
 *  - LIVE & REPLAY both → animation scaled by VCR.speed
 *  - Inter-packet replay delay `realGap / VCR.speed` unchanged
 *  - UI: speed button visible in BOTH modes (operator can adjust live-anim speed)
 */
'use strict';
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync('public/live.js', 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

console.log('\n=== #1346 — per-packet animation honors VCR.speed in BOTH modes ===');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, `function ${name} not found`);
  const next = src.indexOf('\n  function ', start + 1);
  return src.substring(start, next === -1 ? start + 4000 : next);
}

function evalWithVCR(expr, VCR) {
  return new Function('VCR', `return (${expr});`)(VCR);
}

// --- drawAnimatedLine.stepMs ---
const stepExpr = extractFn('drawAnimatedLine').match(/const\s+stepMs\s*=\s*([^;]+);/)[1];

test('LIVE @ speed=0.25 → stepMs = 132 (slow-mo works in LIVE too)', () => {
  const v = evalWithVCR(stepExpr, { mode: 'LIVE', speed: 0.25 });
  assert.strictEqual(v, 132, `got ${v}`);
});
test('LIVE @ speed=4 → stepMs = 8.25 (fast-anim works in LIVE too)', () => {
  const v = evalWithVCR(stepExpr, { mode: 'LIVE', speed: 4 });
  assert.strictEqual(v, 8.25, `got ${v}`);
});
test('LIVE @ speed=1 → stepMs = 33 (baseline)', () => {
  const v = evalWithVCR(stepExpr, { mode: 'LIVE', speed: 1 });
  assert.strictEqual(v, 33, `got ${v}`);
});
test('REPLAY @ speed=4 → stepMs = 8.25 (fast-forward animation)', () => {
  const v = evalWithVCR(stepExpr, { mode: 'REPLAY', speed: 4 });
  assert.strictEqual(v, 8.25, `got ${v}`);
});
test('REPLAY @ speed=0.25 → stepMs = 132 (#922 slow-mo preserved)', () => {
  const v = evalWithVCR(stepExpr, { mode: 'REPLAY', speed: 0.25 });
  assert.strictEqual(v, 132, `got ${v}`);
});
test('REPLAY @ speed=1 → stepMs = 33 (baseline)', () => {
  const v = evalWithVCR(stepExpr, { mode: 'REPLAY', speed: 1 });
  assert.strictEqual(v, 33, `got ${v}`);
});

// --- drawMatrixLine.DURATION_MS ---
const durExpr = extractFn('drawMatrixLine').match(/const\s+DURATION_MS\s*=\s*([^;]+);/)[1];

test('LIVE @ speed=4 → DURATION_MS = 275 (fast-fwd in LIVE)', () => {
  const v = evalWithVCR(durExpr, { mode: 'LIVE', speed: 4 });
  assert.strictEqual(v, 275, `got ${v}`);
});
test('LIVE @ speed=0.25 → DURATION_MS = 4400 (slow-mo in LIVE)', () => {
  const v = evalWithVCR(durExpr, { mode: 'LIVE', speed: 0.25 });
  assert.strictEqual(v, 4400, `got ${v}`);
});
test('REPLAY @ speed=4 → DURATION_MS = 275 (fast-forward)', () => {
  const v = evalWithVCR(durExpr, { mode: 'REPLAY', speed: 4 });
  assert.strictEqual(v, 275, `got ${v}`);
});
test('REPLAY @ speed=0.25 → DURATION_MS = 4400 (#922 slow-mo)', () => {
  const v = evalWithVCR(durExpr, { mode: 'REPLAY', speed: 0.25 });
  assert.strictEqual(v, 4400, `got ${v}`);
});

// --- inter-packet replay delay regression guard ---
test('Inter-packet replay delay still divides realGap by VCR.speed', () => {
  assert.ok(/delay\s*=\s*Math\.min\([^;]+?\/\s*VCR\.speed/.test(src),
    'inter-packet replay delay must still divide realGap by VCR.speed');
});

// --- UI: speed button visible in BOTH modes ---
test('updateVCRUI does NOT hide speed button in LIVE', () => {
  const start = src.indexOf('function updateVCRUI(');
  assert.ok(start !== -1, 'updateVCRUI not found');
  const end = src.indexOf('\n  function ', start + 1);
  const body = src.substring(start, end === -1 ? start + 4000 : end);
  // No branch that adds 'hidden' class to speedBtn based on LIVE mode
  assert.ok(!/speedBtn[\s\S]{0,200}VCR\.mode\s*===\s*['"]LIVE['"][\s\S]{0,200}classList\.add\(['"]hidden['"]\)/.test(body)
         && !/VCR\.mode\s*===\s*['"]LIVE['"][\s\S]{0,200}speedBtn[\s\S]{0,200}classList\.add\(['"]hidden['"]\)/.test(body),
    'speedBtn must NOT be hidden when VCR.mode === LIVE — operator needs it to adjust live-anim speed');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
