import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abs } from './load_job.mjs';

/** Resolve default screenshot output directory. */
export function resolveShotDir(job) {
  return job?.shotDir ? abs(job.shotDir) : path.join(os.tmpdir(), 'creator-publish-shots');
}

/**
 * Strip leading `#`, trim, drop empties; optionally cap length (e.g. Douyin ≤5).
 * @param {unknown} list
 * @param {{ max?: number }} [opts]
 * @returns {string[]}
 */
export function normalizeTopics(list, { max } = {}) {
  const out = (Array.isArray(list) ? list : [])
    .map((t) => String(t || '').replace(/^#/, '').trim())
    .filter(Boolean);
  return max != null ? out.slice(0, max) : out;
}

/**
 * Capture a screenshot safely without failing when the browser window is minimized.
 * @param {object} page - Ego browser page instance.
 * @param {string} filePath - Target PNG/JPG file path.
 */
export async function safeShot(page, filePath) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath });
    return true;
  } catch (e) {
    console.warn('[shot] skipped:', String(e?.message || e).slice(0, 100));
    return false;
  }
}

/**
 * Evaluate a callback across document, top-level iframes, and wujie-app shadowRoot/iframe.
 * Callback receives `(roots, arg)` where `roots` is `[{ name, root }, ...]`.
 *
 * Note: `fn` is rehydrated in the page via Function (same constraint as Puppeteer/
 * Playwright — nested functions cannot be passed as evaluate args).
 * @param {object} page - Ego browser page instance.
 * @param {(roots: Array<{name: string, root: Document|ShadowRoot}>, arg: any) => any} fn
 * @param {any} [arg]
 */
export async function evalAllRoots(page, fn, arg) {
  return page.evaluate(
    ({ src, a }) => {
      const roots = [];
      const seen = new Set();
      const push = (name, root) => {
        if (!root || seen.has(root)) return;
        seen.add(root);
        roots.push({ name, root });
      };

      push('document', document);

      const wj = document.querySelector('wujie-app');
      if (wj?.shadowRoot) {
        push('wujie-shadow', wj.shadowRoot);
        const wjIfr = wj.shadowRoot.querySelector('iframe');
        push('wujie-iframe', wjIfr?.contentDocument || wjIfr?.contentWindow?.document);
      }

      for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
        push('top-iframe', ifr?.contentDocument || ifr?.contentWindow?.document);
      }

      const runner = new Function(`return (${src})`)();
      return runner(roots, a);
    },
    { src: fn.toString(), a: arg },
  );
}
