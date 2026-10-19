/**
 * Ready-to-use Playwright Headless Assertion Recipes (assertion-recipes.mjs)
 *
 * Contains the 4 high-frequency deterministic browser checks:
 * 1. assertFullWidthLayout: Checks if a view fills its work container horizontally
 * 2. assertNotOccluded: Uses document.elementFromPoint(x,y) to verify dropdowns/modals aren't covered by fixed columns
 * 3. dispatchMiddleClickClose: Synthesizes native middle-mouse button events to test tab closing
 * 4. scanRoutesForWhiteScreen: Concurrently visits routes and detects ChunkLoadError / empty root container
 */

/**
 * 1. Verify that a page content container stretches full-width inside its layout wrapper
 */
export async function assertFullWidthLayout(page, parentSelector, childSelector, maxAllowedGapPx = 32) {
  const metrics = await page.evaluate(
    ({ pSel, cSel }) => {
      const parent = document.querySelector(pSel);
      const child = document.querySelector(cSel);
      if (!parent || !child) return null;
      const pRect = parent.getBoundingClientRect();
      const cRect = child.getBoundingClientRect();
      const cStyle = window.getComputedStyle(child);
      return {
        parentWidth: pRect.width,
        childWidth: cRect.width,
        leftGap: cRect.left - pRect.left,
        rightGap: pRect.right - cRect.right,
        maxWidth: cStyle.maxWidth,
        margin: cStyle.margin,
      };
    },
    { pSel: parentSelector, cSel: childSelector }
  );

  if (!metrics) throw new Error(`Missing container: ${parentSelector} or ${childSelector}`);
  if (metrics.leftGap > maxAllowedGapPx || metrics.rightGap > maxAllowedGapPx) {
    throw new Error(
      `Layout width regression: leftGap=${metrics.leftGap}px, rightGap=${metrics.rightGap}px, maxWidth=${metrics.maxWidth}`
    );
  }
  return metrics;
}

/**
 * 2. Verify that a popup/dropdown is genuinely topmost at its screen coordinates (not hidden behind sticky table columns)
 */
export async function assertNotOccluded(page, selector) {
  const check = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const topEl = document.elementFromPoint(cx, cy);
    const isTop = !!topEl && (topEl === el || el.contains(topEl));
    return {
      found: true,
      isTop,
      topTag: topEl?.tagName,
      topClass: topEl?.className,
      targetZIndex: window.getComputedStyle(el).zIndex,
    };
  }, selector);

  if (!check.found) throw new Error(`Element ${selector} not found in DOM`);
  if (!check.isTop) {
    throw new Error(
      `Element ${selector} (z-index: ${check.targetZIndex}) is occluded at center by <${check.topTag} class="${check.topClass}">`
    );
  }
  return check;
}

/**
 * 3. Dispatch native middle-mouse click (button: 1) on a tab element and verify tab count decreases
 */
export async function dispatchMiddleClickClose(page, tabSelector, indexToClose = 1) {
  return await page.evaluate(
    ({ sel, idx }) => {
      const beforeTabs = document.querySelectorAll(sel);
      const target = beforeTabs[idx];
      if (!target) return { error: `Tab at index ${idx} not found` };

      const eventInit = { button: 1, which: 2, bubbles: true, cancelable: true, view: window };
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('auxclick', eventInit));

      const afterTabs = document.querySelectorAll(sel);
      return {
        beforeCount: beforeTabs.length,
        afterCount: afterTabs.length,
        closedSuccessfully: afterTabs.length === beforeTabs.length - 1,
      };
    },
    { sel: tabSelector, idx: indexToClose }
  );
}

/**
 * 4. Batch scan a list of SPA routes for white-screen / missing chunk errors
 */
export async function scanRoutesForWhiteScreen(browserContext, baseUrl, routes, contentSelector = '.app-main, .saas-work-content') {
  const results = [];
  const page = await browserContext.newPage();

  for (const route of routes) {
    const errors = [];
    const onErr = (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    };
    page.on('console', onErr);

    const url = `${baseUrl}${route}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch((e) => errors.push(e.message));
    await page.waitForTimeout(500);

    const domState = await page.evaluate((sel) => {
      const container = document.querySelector(sel);
      return {
        hasContainer: !!container,
        childCount: container ? container.children.length : 0,
        textLength: container ? container.innerText.trim().length : 0,
      };
    }, contentSelector);

    page.off('console', onErr);
    results.push({
      route,
      ok: domState.hasContainer && domState.childCount > 0 && errors.length === 0,
      ...domState,
      errors,
    });
  }

  await page.close();
  return results;
}
