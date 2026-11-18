import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { abs } from './load_job.mjs';

/** Resolve default screenshot output directory. */
export function resolveShotDir(job) {
  return job?.shotDir ? abs(job.shotDir) : path.join(os.tmpdir(), 'creator-publish-shots');
}

/** Normalize hashtag / topic keywords (strip leading `#`, trim, dedup, optional cap). */
export function normalizeTopics(list, { max } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw || '').replace(/^#/, '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (max != null && out.length >= max) break;
  }
  return out;
}

const GENERIC_TOPIC_TAGS = new Set([
  '脉源归真', '万物溯源', '信息溯源', '硬核科普', '科普', '科普一下',
  '冷知识', '涨知识', '知识', '科普知识', '科技科普', '生活记录', '原创',
]);

const GENERAL_EXPLAINER_HINTS = [
  '科普', '知识', '科技', '汽车', '用车', '财经', '社会', '民生', '热点', '观察', '生活', '播客',
];

/**
 * Derive ordered search/matching keywords for platform hotspot, topic suggestion, and activity selection.
 * @param {{ title?: string, topics?: string[], hotspot?: string, activity?: string }} [job]
 * @returns {string[]}
 */
export function deriveHotspotKeywords(job = {}) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const s = String(raw || '').replace(/^#/, '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  const splitList = (v) =>
    String(v || '')
      .split(/[,，、|]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  for (const h of splitList(job?.hotspot)) push(h);
  for (const a of splitList(job?.activity)) push(a);

  const topics = normalizeTopics(job?.topics);
  for (const t of topics) {
    if (!GENERIC_TOPIC_TAGS.has(t)) push(t);
  }

  const title = String(job?.title || '').trim();
  if (title) {
    const clauses = title
      .split(/[？?！!：:，,、。\s「」『』“”"()（）]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 12);
    for (const c of clauses) push(c);
  }

  for (const t of topics) push(t);
  return out;
}

/**
 * Clean a topic / activity suggestion text by removing leading `#` and trailing heat counts.
 * @param {string} raw
 * @returns {string}
 */
export function cleanSuggestLabel(raw) {
  let s = String(raw || '').split(/\r?\n/)[0].replace(/[\u00a0]+/g, ' ').trim();
  s = s.replace(/^#\s*/, '').trim();
  // Strip trailing metrics like "12179.1亿", "35.6万次浏览", "200万热度", "活动", "HOT"
  s = s
    .replace(
      /\s+(?:\d+(?:\.\d+)?\s*[万亿kwKW]+.*|\d+\s*(?:次浏览|次播放|浏览|播放|在看|讨论|热度|参与).*|活动|HOT|热)$/i,
      '',
    )
    .trim();
  return s;
}

/**
 * Score how well a candidate label matches ordered keywords (higher is better; 0 = unrelated).
 * @param {string} candidateText
 * @param {string[]} keywords
 * @param {{ includeGeneralHints?: boolean }} [opts]
 * @returns {number}
 */
export function scoreCandidateMatch(candidateText, keywords = [], { includeGeneralHints = false } = {}) {
  const clean = cleanSuggestLabel(candidateText).toLowerCase();
  const raw = String(candidateText || '').toLowerCase();
  if (!clean) return 0;

  let best = 0;
  for (let i = 0; i < keywords.length; i++) {
    const kw = String(keywords[i] || '').replace(/^#/, '').trim().toLowerCase();
    if (!kw) continue;
    const priorityBoost = Math.max(10, 40 - i * 3);
    if (clean === kw) {
      best = Math.max(best, 1000 + priorityBoost);
    } else if (clean.startsWith(kw)) {
      best = Math.max(best, 700 + priorityBoost);
    } else if (clean.includes(kw)) {
      best = Math.max(best, 500 + priorityBoost);
    } else if (kw.includes(clean) && clean.length >= 2) {
      best = Math.max(best, 350 + priorityBoost);
    }
  }

  if (best === 0 && includeGeneralHints) {
    for (let i = 0; i < GENERAL_EXPLAINER_HINTS.length; i++) {
      const hint = GENERAL_EXPLAINER_HINTS[i];
      if (clean.includes(hint) || raw.includes(hint)) {
        best = Math.max(best, 120 - i * 4);
      }
    }
  }
  return best;
}

/**
 * Capture a screenshot safely without failing when the browser window is minimized.
 * @param {object} page - Ego browser page instance.
 * @param {string} filePath - Target PNG/JPG file path.
 */
export async function safeShot(page, filePath, opts = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, ...opts });
    return true;
  } catch (e) {
    if (opts?.fullPage) {
      try {
        await page.screenshot({ path: filePath });
        return true;
      } catch (_) {
        /* fallback failed */
      }
    }
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

/**
 * Parse colloquial, ISO, or standard date-time string into structured schedule info.
 * Supports:
 *   - "2026-11-17 11:30"
 *   - "2026-11-17T11:30:00"
 *   - "2026/11/17 11:30"
 *   - "17日早上11.30", "17日11:30", "11月17日 11:30", "11-17 11:30"
 * @param {string} raw
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, dateStr: string, timeStr: string, dateTimeStr: string, timestamp: number } | null}
 */
export function parseScheduleTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  let year, month, day, hour, minute;
  const now = new Date();

  // Pattern 1: standard YYYY-MM-DD HH:mm(:ss)? or YYYY/MM/DD or with T
  const mFull = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2})[:.](\d{1,2})(?::(\d{1,2}))?$/);
  if (mFull) {
    year = Number(mFull[1]);
    month = Number(mFull[2]);
    day = Number(mFull[3]);
    hour = Number(mFull[4]);
    minute = Number(mFull[5]);
  } else {
    // Pattern 2: Chinese or short format: e.g. "17日早上11.30", "11月17日 11:30", "11-17 11:30"
    const mChinese = s.match(
      /(?:(\d{4})[年/-])?(?:(\d{1,2})[月/-])?(\d{1,2})[日号]?[ \t]*(?:(早上|上午|下午|晚上|中午))?[ \t]*(\d{1,2})[:.点时](\d{1,2})/,
    );
    if (mChinese) {
      year = mChinese[1] ? Number(mChinese[1]) : now.getFullYear();
      month = mChinese[2] ? Number(mChinese[2]) : now.getMonth() + 1;
      day = Number(mChinese[3]);
      let h = Number(mChinese[5]);
      const ampm = mChinese[4];
      if ((ampm === '下午' || ampm === '晚上') && h < 12) h += 12;
      if (ampm === '中午' && h < 11) h += 12;
      hour = h;
      minute = Number(mChinese[6]);
    } else {
      const d = new Date(s);
      if (!isNaN(d.getTime())) {
        year = d.getFullYear();
        month = d.getMonth() + 1;
        day = d.getDate();
        hour = d.getHours();
        minute = d.getMinutes();
      } else {
        throw new Error(`无法解析定时发布时间: "${raw}"`);
      }
    }
  }

  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${year}-${pad(month)}-${pad(day)}`;
  const timeStr = `${pad(hour)}:${pad(minute)}`;
  const dateTimeStr = `${dateStr} ${timeStr}`;
  const timestamp = new Date(year, month - 1, day, hour, minute).getTime();

  return {
    year,
    month,
    day,
    hour,
    minute,
    dateStr,
    timeStr,
    dateTimeStr,
    timestamp,
  };
}

/**
 * Prevent Chromium from popping up a native OS file-chooser dialog on top of all Ego spaces
 * if any page click triggers `<input type="file">.click()`. CDP `DOM.setFileInputFiles`
 * (`page.setInputFiles`) continues to work silently with zero native OS window.
 */
export async function suppressNativeFileDialog(page) {
  if (typeof page?.cdp !== 'function') return false;
  try {
    await page.cdp('Page.setInterceptFileChooserDialog', { enabled: true });
    return true;
  } catch {
    return false;
  }
}

