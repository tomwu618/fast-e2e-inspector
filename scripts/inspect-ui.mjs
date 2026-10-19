#!/usr/bin/env node
/**
 * Fast E2E & CSS Layout Inspector CLI (inspect-ui.mjs)
 *
 * Usage:
 *   node scripts/inspect-ui.mjs \
 *     --url "http://10.8.0.72:9020/#/facility/views/elderly-manage/residence-change-form?id=91" \
 *     --parent ".saas-work-content" \
 *     --target ".el-card" \
 *     --occlude ".who-drop" \
 *     --token "YOUR_JWT_TOKEN" \
 *     --screenshot "./report.png"
 */

import { chromium } from 'playwright';

function parseArgs(argv) {
  const args = {
    url: '',
    parent: 'body',
    target: '',
    occlude: '',
    clickBeforeOcclude: '',
    token: '',
    tokenKey: 'token',
    viewport: '1920x1080',
    waitMs: 1200,
    screenshot: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key.startsWith('--')) {
      const k = key.slice(2);
      if (k in args && val !== undefined) {
        args[k] = val;
        i++;
      }
    }
  }
  return args;
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error('Usage: node inspect-ui.mjs --url <URL> [--parent <sel>] [--target <sel>] [--occlude <sel>] [--token <jwt>]');
    process.exit(1);
  }

  const [width, height] = args.viewport.split('x').map(Number);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: width || 1920, height: height || 1080 } });

  if (args.token) {
    await context.addInitScript(
      ({ key, token }) => {
        window.localStorage.setItem(key, token);
        window.sessionStorage.setItem(key, token);
      },
      { key: args.tokenKey, token: args.token }
    );
  }

  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(String(err));
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), reason: req.failure()?.errorText });
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      failedRequests.push({ url: res.url(), status: res.status() });
    }
  });

  const t0 = Date.now();
  await page.goto(args.url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(Number(args.waitMs));

  if (args.clickBeforeOcclude) {
    await page.locator(args.clickBeforeOcclude).first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const report = await page.evaluate(
    ({ parentSel, targetSel, occludeSel }) => {
      const getStackingChain = (node) => {
        const chain = [];
        let cur = node;
        while (cur && cur !== document.body) {
          const s = window.getComputedStyle(cur);
          if (
            s.zIndex !== 'auto' ||
            s.position !== 'static' ||
            s.transform !== 'none' ||
            Number(s.opacity) < 1
          ) {
            chain.push({
              tag: cur.tagName.toLowerCase(),
              className: String(cur.className || '').slice(0, 80),
              position: s.position,
              zIndex: s.zIndex,
            });
          }
          cur = cur.parentElement;
        }
        return chain;
      };

      const result = {
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        layout: null,
        occlusion: null,
      };

      // 1. Layout & Width Inspection
      if (targetSel) {
        const parent = document.querySelector(parentSel) || document.body;
        const target = document.querySelector(targetSel);
        if (!target) {
          result.layout = { error: `Target selector "${targetSel}" not found` };
        } else {
          const pRect = parent.getBoundingClientRect();
          const tRect = target.getBoundingClientRect();
          const tStyle = window.getComputedStyle(target);
          const pStyle = window.getComputedStyle(parent);
          result.layout = {
            parentSelector: parentSel,
            targetSelector: targetSel,
            parentRect: { left: Math.round(pRect.left), width: Math.round(pRect.width) },
            targetRect: { left: Math.round(tRect.left), width: Math.round(tRect.width) },
            leftGapPx: Math.round(tRect.left - pRect.left),
            rightGapPx: Math.round(pRect.right - tRect.right),
            horizontalFillRatio: Number((tRect.width / Math.max(pRect.width, 1)).toFixed(4)),
            targetComputedStyle: {
              width: tStyle.width,
              maxWidth: tStyle.maxWidth,
              margin: tStyle.margin,
              padding: tStyle.padding,
              boxSizing: tStyle.boxSizing,
            },
            parentComputedStyle: {
              display: pStyle.display,
              padding: pStyle.padding,
            },
          };
        }
      }

      // 2. Occlusion & Hit-Testing Inspection
      if (occludeSel) {
        const el = document.querySelector(occludeSel);
        if (!el) {
          result.occlusion = { error: `Occlude selector "${occludeSel}" not found` };
        } else {
          const rect = el.getBoundingClientRect();
          const points = [
            { name: 'center', x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
            { name: 'topLeft', x: rect.left + 8, y: rect.top + 8 },
            { name: 'bottomRight', x: rect.right - 8, y: rect.bottom - 8 },
          ];
          const hits = points.map((pt) => {
            const topEl = document.elementFromPoint(pt.x, pt.y);
            const isSelfOrChild = !!topEl && (topEl === el || el.contains(topEl));
            return {
              point: pt.name,
              x: Math.round(pt.x),
              y: Math.round(pt.y),
              occluded: !isSelfOrChild,
              hitTag: topEl?.tagName?.toLowerCase() || null,
              hitClass: String(topEl?.className || '').slice(0, 80),
              occluderStackingChain: !isSelfOrChild && topEl ? getStackingChain(topEl) : [],
            };
          });
          result.occlusion = {
            selector: occludeSel,
            rect: {
              left: Math.round(rect.left),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            targetStackingChain: getStackingChain(el),
            isOccluded: hits.some((h) => h.occluded),
            hits,
          };
        }
      }

      return result;
    },
    { parentSel: args.parent, targetSel: args.target, occludeSel: args.occlude }
  );

  if (args.screenshot) {
    await page.screenshot({ path: args.screenshot, fullPage: false });
  }

  await browser.close();

  const finalOutput = {
    elapsedMs: Date.now() - t0,
    ...report,
    consoleErrors,
    failedRequests,
  };

  console.log(JSON.stringify(finalOutput, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
