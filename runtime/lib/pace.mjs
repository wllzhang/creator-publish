/** 拟人随机停顿（ego 脚本共用） */
export function humanPause(minMs, maxMs, label = '', tag = 'pace') {
  const ms = Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  if (label) console.log(`[${tag}] ${label} → ${ms}ms`);
  return new Promise((r) => setTimeout(r, ms));
}

/** Small random offset around a point (pixels). */
export function jitterXY(x, y, radius = 6) {
  const ang = Math.random() * Math.PI * 2;
  const r = Math.random() * radius;
  return {
    x: Math.round(x + Math.cos(ang) * r),
    y: Math.round(y + Math.sin(ang) * r),
  };
}

/**
 * Mouse click with slight position jitter (+ optional pre-move pause).
 * Prefer this over raw `page.mouse.click` for UI actions.
 */
export async function humanMouseClick(page, x, y, { radius = 6, tag = 'pace' } = {}) {
  const p = jitterXY(x, y, radius);
  if (typeof page.mouse?.move === 'function') {
    await page.mouse.move(p.x, p.y);
    await humanPause(80, 220, '', tag);
  }
  await page.mouse.click(p.x, p.y);
}

/**
 * Click a CSS selector near its visual center with jitter.
 * Falls back to `page.click` when the element has no usable box.
 */
export async function humanClickSelector(page, selector, { radius = 5, tag = 'pace' } = {}) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!box) {
    await page.click(selector);
    return false;
  }
  await humanPause(100, 280, '', tag);
  await humanMouseClick(page, box.x, box.y, { radius, tag });
  return true;
}

/**
 * Split long text into phrase-sized chunks (punctuation / whitespace aware).
 * Short strings stay as a single chunk.
 */
export function splitHumanChunks(text, { min = 6, max = 18 } = {}) {
  const s = String(text || '');
  if (!s) return [];
  if (s.length <= min) return [s];

  const parts = s.split(/([，。！？；、,.!?;:\n\r]+|\s+)/).filter((p) => p.length);
  const chunks = [];
  let buf = '';
  const nextLimit = () => min + Math.floor(Math.random() * (max - min + 1));
  let limit = nextLimit();

  for (const part of parts) {
    if (!buf || (buf + part).length <= limit) {
      buf += part;
      if (buf.length >= limit) {
        chunks.push(buf);
        buf = '';
        limit = nextLimit();
      }
      continue;
    }
    chunks.push(buf);
    buf = part;
    limit = nextLimit();
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * Insert text in human-sized chunks with random pauses between them.
 * Uses `insertText` (IME-friendly) rather than per-key `type`.
 */
export async function humanInsertText(
  page,
  text,
  { tag = 'pace', minPause = 120, maxPause = 420, minChunk = 6, maxChunk = 18 } = {},
) {
  const chunks = splitHumanChunks(text, { min: minChunk, max: maxChunk });
  for (let i = 0; i < chunks.length; i++) {
    await page.keyboard.insertText(chunks[i]);
    if (i < chunks.length - 1) await humanPause(minPause, maxPause, '', tag);
  }
}
