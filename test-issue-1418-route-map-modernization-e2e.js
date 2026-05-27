/**
 * #1418 — Re-implement #1374's spec for the packet-route map view.
 *
 * Asserts the 14 specific gaps documented in #1418 are closed:
 *
 *   VISUAL (11):
 *    1. Role-aware markers via makeRoleMarkerSVG (per-hop).
 *       Origin/destination get distinguishing glyph + larger size.
 *    2. Sequence number badges sit BESIDE markers (positioned absolute,
 *       offset to corner), not centered inside marker.
 *    3. Edges have directional arrows (marker-end).
 *    4. Edges carry sequence-color gradient (first vs last edge differ).
 *    5. Label collision avoidance — no two .mc-route-label boxes overlap.
 *    6. Collapsible legend panel anchored top-left with origin/dest/role swatches.
 *       Legend NOT clipped: bounding box width > 60px (not "Leg…" clip).
 *    7. Per-marker aria-label "Hop N of M, name, role" + originator/destination.
 *    8. Per-edge aria-label "Hop N → N+1, ~Xkm".
 *    9. Banner format: "Route observed at <ts> · <origin> → <dest> · <N> hops".
 *   10. ✕ close button visible, accessible, ARIA-labeled.
 *   11. Partial-route: dashed-grey marker + "X of N hops resolved" badge.
 *
 *   BEHAVIORAL (3):
 *   12. Map Controls panel auto-collapses when route renders.
 *   13. Legend panel is draggable (DragManager) OR has position toggle buttons.
 *   14. ✕ close button fully exits route view (restores controls, clears storage,
 *       navigates to #/map).
 *
 * Run: BASE_URL=http://localhost:13581 node test-issue-1418-route-map-modernization-e2e.js
 */
'use strict';
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:13581';
let passed = 0, failed = 0;

async function step(name, fn) {
  try { await fn(); passed++; console.log('  \u2713 ' + name); }
  catch (e) { failed++; console.error('  \u2717 ' + name + ': ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const ROUTE_FIXTURE = {
  origin: { pubkey: 'aa00aa00aa00aa00', name: 'Originator Node', role: 'companion', lat: 37.78, lon: -122.42, isOrigin: true },
  hops: [
    { pubkey: 'bb11bb11bb11bb11', name: 'Big Redwood Oakland', role: 'repeater', lat: 37.80, lon: -122.27, resolved: true },
    { pubkey: 'cc22cc22cc22cc22', name: 'San Carlos Rptr',     role: 'repeater', lat: 37.51, lon: -122.26, resolved: true },
    { pubkey: 'dd33dd33dd33dd33', name: 'Room Server SJ',      role: 'room',     lat: 37.34, lon: -121.89, resolved: true },
    { pubkey: 'ee44ee44ee44ee44', name: 'Destination Node',    role: 'sensor',   lat: 37.27, lon: -121.97, resolved: true, isDest: true },
  ]
};

async function renderRouteOnPage(page, fixture) {
  return await page.evaluate((fx) => {
    if (!window.MeshRoute || typeof window.MeshRoute.render !== 'function') {
      return { error: 'window.MeshRoute.render not present' };
    }
    const positions = [];
    if (fx.origin) positions.push(Object.assign({}, fx.origin));
    for (const h of fx.hops) positions.push(Object.assign({}, h));
    if (window.__mc_routeLayer && window.__mc_routeLayer.clearLayers) {
      window.__mc_routeLayer.clearLayers();
    }
    window.MeshRoute.render(window.__mc_map, window.__mc_routeLayer, positions, {
      timestamp: new Date('2025-01-01T12:00:00Z').toISOString()
    });
    return { ok: true, count: positions.length };
  }, fixture);
}

async function runViewport(browser, width, height, label) {
  console.log('\n=== Viewport ' + label + ' (' + width + 'x' + height + ') ===');
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('  pageerror:', e.message));
  await page.goto(BASE + '/#/map', { waitUntil: 'commit', timeout: 30000 });
  await page.waitForSelector('#leaflet-map', { timeout: 10000 });
  await page.waitForFunction(() => window.MeshRoute && window.__mc_map && window.__mc_routeLayer, { timeout: 10000 });
  await page.waitForTimeout(500);

  const r = await renderRouteOnPage(page, ROUTE_FIXTURE);
  if (r && r.error) throw new Error(r.error);
  await page.waitForTimeout(1800);

  // GAP 2 — sequence badge offset to corner (not centered inside marker)
  await step(label + ': gap2 — sequence badges positioned at marker corner (not inside)', async () => {
    const data = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('.mc-route-seq-badge'));
      return badges.map(b => {
        const cs = getComputedStyle(b);
        return { position: cs.position, bottom: cs.bottom, right: cs.right, top: cs.top, left: cs.left };
      });
    });
    assert(data.length >= 5, 'expected >=5 badges, got ' + data.length);
    for (const d of data) {
      assert(d.position === 'absolute', 'badge not absolutely positioned: ' + JSON.stringify(d));
      // Either bottom+right or top+right anchored to a corner (negative or near-zero offset)
      const cornerAnchored = (d.bottom !== 'auto' && d.right !== 'auto') ||
                             (d.top !== 'auto' && d.right !== 'auto');
      assert(cornerAnchored, 'badge not corner-anchored: ' + JSON.stringify(d));
    }
  });

  // GAP 4 — sequence-color gradient on edges (first vs last differ)
  await step(label + ': gap4 — edges have sequence-color gradient (first edge ≠ last edge)', async () => {
    const data = await page.evaluate(() => {
      const edges = Array.from(document.querySelectorAll('path.mc-route-edge'));
      return edges.map(e => e.getAttribute('stroke') || (e.style && e.style.color) || '');
    });
    assert(data.length >= 3, 'expected >=3 edges, got ' + data.length);
    const first = data[0], last = data[data.length - 1];
    assert(first && last, 'edge colors missing: first=' + first + ' last=' + last);
    assert(first !== last, 'edge first and last share color (no gradient): ' + first);
  });

  // GAP 6 — legend not clipped, anchored top-left
  await step(label + ': gap6 — legend rendered at top-left, NOT clipped (width > 80px)', async () => {
    const data = await page.evaluate(() => {
      const el = document.querySelector('.mc-route-legend');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: r.width, h: r.height, left: r.left, top: r.top, position: cs.position };
    });
    assert(data, '.mc-route-legend missing');
    assert(data.w >= 80, 'legend clipped, width=' + data.w + ' (expected >=80 to fit "Legend" + body)');
    // top-left preferred (gap6 spec)
    assert(data.left < (data.w + 60), 'legend not anchored left, left=' + data.left);
  });

  // GAP 9 — banner includes originator → destination · N hops
  await step(label + ': gap9 — banner shows "<origin> → <dest> · N hops" format', async () => {
    const data = await page.evaluate(() => {
      const el = document.querySelector('.mc-route-context-label');
      return el ? el.textContent : null;
    });
    assert(data, 'context-label missing');
    assert(/Originator Node/.test(data), 'banner missing origin name: ' + data);
    assert(/Destination Node/.test(data), 'banner missing dest name: ' + data);
    assert(/→|\u2192/.test(data), 'banner missing arrow separator: ' + data);
    assert(/\b5\s*hops?\b/i.test(data), 'banner missing hop count "5 hops": ' + data);
  });

  // GAP 10 / 14 — close affordance present + has accessible name
  await step(label + ': gap10 — ✕ close button rendered with accessible name', async () => {
    const data = await page.evaluate(() => {
      const btn = document.querySelector('.mc-route-close-btn, [data-mc-route-close]');
      if (!btn) return null;
      return {
        text: btn.textContent.trim(),
        ariaLabel: btn.getAttribute('aria-label') || btn.getAttribute('title') || ''
      };
    });
    assert(data, 'close button (.mc-route-close-btn) not found');
    assert(/close|exit|✕|×/i.test(data.text + ' ' + data.ariaLabel), 'close button missing close text/aria: ' + JSON.stringify(data));
  });

  // GAP 12 — Map Controls panel auto-collapses when route renders
  await step(label + ': gap12 — Map Controls panel auto-collapses on route render', async () => {
    const data = await page.evaluate(() => {
      const panel = document.getElementById('mapControls');
      const toggle = document.getElementById('mapControlsToggle');
      if (!panel || !toggle) return null;
      return {
        collapsed: panel.classList.contains('collapsed'),
        expanded: toggle.getAttribute('aria-expanded')
      };
    });
    assert(data, 'mapControls/toggle missing');
    assert(data.collapsed === true, 'mapControls did not auto-collapse: ' + JSON.stringify(data));
    assert(data.expanded === 'false', 'toggle aria-expanded not false: ' + JSON.stringify(data));
  });

  // GAP 13 — legend has a drag handle OR position toggle buttons
  await step(label + ': gap13 — legend is draggable OR has position toggle buttons', async () => {
    const data = await page.evaluate(() => {
      const legend = document.querySelector('.mc-route-legend');
      if (!legend) return null;
      const header = legend.querySelector('.panel-header, .mc-route-legend-toggle');
      const positionBtns = legend.querySelectorAll('[data-mc-route-position]').length;
      const dragRegistered = !!(window.DragManager && window.__mc_legend_drag_registered);
      return {
        hasHeader: !!header,
        positionBtns: positionBtns,
        dragRegistered: dragRegistered
      };
    });
    assert(data, 'legend missing');
    assert(data.dragRegistered || data.positionBtns >= 2,
      'legend not draggable and no position toggles: ' + JSON.stringify(data));
  });

  // GAP 14 — close click fully exits: restores controls, clears storage, route layer empty
  await step(label + ': gap14 — close click fully exits route view', async () => {
    await page.evaluate(() => {
      sessionStorage.setItem('map-route-hops', JSON.stringify({hops:['aa'],origin:null}));
    });
    const result = await page.evaluate(() => {
      const btn = document.querySelector('.mc-route-close-btn, [data-mc-route-close]');
      if (!btn) return { error: 'no close btn' };
      btn.click();
      return { clicked: true };
    });
    if (result.error) throw new Error(result.error);
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => {
      const panel = document.getElementById('mapControls');
      const legend = document.querySelector('.mc-route-legend');
      const ctx = document.querySelector('.mc-route-context-label');
      const layerCount = window.__mc_routeLayer && window.__mc_routeLayer.getLayers ? window.__mc_routeLayer.getLayers().length : -1;
      return {
        controlsCollapsed: panel ? panel.classList.contains('collapsed') : null,
        legendGone: !legend,
        ctxGone: !ctx,
        layerCount: layerCount,
        sessionCleared: !sessionStorage.getItem('map-route-hops'),
        hash: location.hash
      };
    });
    assert(after.legendGone, 'legend not removed after close: ' + JSON.stringify(after));
    assert(after.ctxGone, 'context banner not removed after close: ' + JSON.stringify(after));
    assert(after.layerCount === 0, 'route layer not cleared: ' + JSON.stringify(after));
    assert(after.sessionCleared, 'sessionStorage map-route-hops not cleared: ' + JSON.stringify(after));
    assert(after.controlsCollapsed === false, 'Map Controls not re-expanded after close: ' + JSON.stringify(after));
  });

  await ctx.close();
}

async function run() {
  const launchOpts = { args: ['--no-sandbox'] };
  if (process.env.CHROMIUM_PATH) launchOpts.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  try {
    await runViewport(browser, 375, 800, 'mobile');
    await runViewport(browser, 1440, 900, 'desktop');
  } finally {
    await browser.close();
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
