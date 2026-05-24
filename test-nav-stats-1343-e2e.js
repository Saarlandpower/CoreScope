#!/usr/bin/env node
/* Issue #1343 — nav-stats hide-band must match JS overflow assumption.
 *
 * applyNavPriority in public/app.js assumes that at viewport <=1100px
 * the CSS hides .nav-stats so the 5 high-priority links + "More ▾"
 * actually fit on screen. If the hide band is narrower than 1100px,
 * the high-priority links silently clip out of view in the gap.
 *
 * Cases:
 *   - 800x800 on /#/observers   → high-priority links visible, nav-stats hidden
 *   - 960x800 on /#/observers   → high-priority links visible, nav-stats hidden
 *   - 1080x800 on /#/observers  → high-priority links visible, nav-stats hidden
 *   - 1200x800 on /#/observers  → high-priority links visible, nav-stats RE-APPEARS
 *
 * A link is "visible" iff: clientWidth > 0 AND its bounding rect is
 * fully inside the viewport horizontally (left>=0, right<=innerWidth).
 */
'use strict';

const assert = require('assert');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:13581';
const HIGH_PRIORITY_HREFS = ['#/home', '#/packets', '#/map', '#/live', '#/nodes'];

const CASES = [
  { w: 800,  h: 800, navStatsHidden: true,  label: '800px — narrow desktop' },
  { w: 960,  h: 800, navStatsHidden: true,  label: '960px — operator-reported' },
  { w: 1080, h: 800, navStatsHidden: true,  label: '1080px — narrow desktop' },
  { w: 1200, h: 800, navStatsHidden: false, label: '1200px — wide desktop' },
];

async function main() {
  let browser;
  let failures = 0;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    for (const c of CASES) {
      const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/#/observers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      // Wait for nav to be rendered (top-nav appears as part of SPA shell)
      await page.waitForSelector('.top-nav .nav-links', { timeout: 10000 });
      // Allow nav-priority pass + font ready callback to settle
      await page.waitForTimeout(400);

      const result = await page.evaluate((hrefs) => {
        const navStats = document.querySelector('.nav-stats');
        const navStatsW = navStats ? navStats.clientWidth : 0;
        const innerW = window.innerWidth;
        const links = hrefs.map((href) => {
          const a = document.querySelector(`.nav-links a[href="${href}"]`);
          if (!a) return { href, present: false, w: 0, left: null, right: null };
          const r = a.getBoundingClientRect();
          return {
            href,
            present: true,
            w: a.clientWidth,
            left: r.left,
            right: r.right,
            inView: r.left >= 0 && r.right <= innerW && a.clientWidth > 0,
          };
        });
        return { navStatsW, innerW, links };
      }, HIGH_PRIORITY_HREFS);

      const navStatsOk = c.navStatsHidden
        ? result.navStatsW === 0
        : result.navStatsW > 0;
      const allLinksVisible = result.links.every((l) => l.present && l.inView);

      const status = navStatsOk && allLinksVisible ? 'PASS' : 'FAIL';
      if (status === 'FAIL') failures++;
      console.log(`[${status}] ${c.label} — innerW=${result.innerW} navStatsW=${result.navStatsW}`);
      for (const l of result.links) {
        console.log(`        ${l.href}: w=${l.w} left=${l.left} right=${l.right} inView=${l.inView}`);
      }
      // Hard assertion so CI failure carries an explicit error trace
      try {
        assert.strictEqual(navStatsOk, true,
          `${c.label}: expected nav-stats ${c.navStatsHidden ? 'hidden (clientWidth=0)' : 'visible (clientWidth>0)'}, got clientWidth=${result.navStatsW}`);
        assert.strictEqual(allLinksVisible, true,
          `${c.label}: expected all 5 high-priority links visible in viewport, got ${result.links.filter(l => !l.inView).map(l => l.href).join(',')} clipped`);
      } catch (err) {
        console.error(`        ASSERT: ${err.message}`);
      }
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close();
  }
  // Final assertion — fail the process loudly with a stack
  assert.strictEqual(failures, 0, `${failures} viewport case(s) failed`);
  console.log('\nAll viewport cases passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
