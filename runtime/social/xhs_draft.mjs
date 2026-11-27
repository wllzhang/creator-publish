/**
 * 小红书草稿（支持图文 images[] 与视频 video + cover? 双模式）。
 * job: profileId, (images[] | video, cover?), title, body?, topics?, aiGenerated?, hotspot?, activity?, autoHotspot?, shotDir?
 * 话题：点「话题」→ 键入词条 → 优先点选实时热门下拉联想生成 <a class="tiptap-topic">（未匹配则空格兜底）；默认勾选原创声明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { humanPause, humanMouseClick } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import {
  resolveShotDir,
  safeShot,
  normalizeTopics,
  deriveHotspotKeywords,
  cleanSuggestLabel,
  scoreCandidateMatch,
  parseScheduleTime,
  suppressNativeFileDialog,
} from '../lib/ego_dom.mjs';
import { declareXhsAiGenerated } from '../lib/ai_declare.mjs';

const { job } = loadJob();
const videoPath = job.video ? abs(job.video) : null;
const coverPath = job.cover ? abs(job.cover) : null;
const images = (job.images || []).map((p) => abs(p)).filter(Boolean);
const isVideoMode = Boolean(videoPath);
const aiGenerated = job.aiGenerated === true;
const rawTitle = String(job.title || '').trim();
const desc = job.body || '';
const topicsList = normalizeTopics(job.topics);
const autoHotspot = job.autoHotspot !== false;
const hotspotKeywords = deriveHotspotKeywords(job);
const shotDir = resolveShotDir(job);
const schedule = parseScheduleTime(job.scheduleTime);

let descHtml = '';
if (!desc) {
  descHtml = '<p></p>';
} else if (desc.includes('<')) {
  descHtml = desc;
} else {
  descHtml = desc
    .split(/\r?\n\r?\n/)
    .map((block) => `<p>${block.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

if (!isVideoMode && !images.length) throw new Error('job 需要 images[] 或 video（绝对路径）');
if (isVideoMode && !fs.existsSync(videoPath.replace(/\//g, path.sep))) {
  throw new Error(`视频文件不存在: ${videoPath}`);
}
if (!rawTitle) throw new Error('job 需要 title');

const task = await taskSpace('cp-xhs-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

function truncateWeightedTitle(text, limit = 20) {
  const chars = Array.from(String(text || '').trim());
  const weightOf = (ch) => (ch.codePointAt(0) <= 0x7f ? 0.5 : 1);
  let total = chars.reduce((s, c) => s + weightOf(c), 0);
  if (total <= limit) return chars.join('');
  // First try stripping spaces around punctuation / ASCII runs
  const compact = chars.join('').replace(/\s*([｜|：:·—-])\s*/g, '$1').replace(/\s+/g, '');
  const compactChars = Array.from(compact);
  total = compactChars.reduce((s, c) => s + weightOf(c), 0);
  if (total <= limit) return compact;
  let acc = 0;
  let out = '';
  for (const ch of compactChars) {
    const w = weightOf(ch);
    if (acc + w > limit) break;
    acc += w;
    out += ch;
  }
  return out;
}

async function dismissPopups() {
  for (let i = 0; i < 4; i++) {
    const dismissed = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, span, div')).find((el) => {
        if (el.closest('.main-cover-editor-modal, .cover-modal')) return false;
        const dlg = el.closest('.d-modal, [role="dialog"]');
        if (dlg && /原创声明须知|笔记完成原创声明/.test(dlg.innerText || '')) return false;
        const r = el.getBoundingClientRect();
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return r.width > 0 && r.height > 0 && el.childElementCount <= 1 && /^(我知道了|知道了)$/.test(t);
      });
      if (btn) {
        btn.click();
        return (btn.innerText || '').trim();
      }
      return null;
    });
    if (!dismissed) break;
    console.log('[xhs] 已关闭引导弹窗:', dismissed);
    await humanPause(500, 800);
  }
}

async function uploadVideoAndWait(fileAbs) {
  const tabInfo = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div, span, button')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.childElementCount <= 1;
    });
    const vidTab = els.find((el) => (el.innerText || '').trim() === '上传视频');
    if (vidTab) {
      vidTab.click();
      return { found: true };
    }
    return { found: false };
  });
  console.log('[xhs] 视频Tab:', JSON.stringify(tabInfo));
  await humanPause(1500, 2500, '确认视频Tab', 'xhs');

  let inputFound = false;
  for (let i = 0; i < 20; i++) {
    inputFound = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input.upload-input, input[type="file"]'));
      const vidInp = inputs.find((inp) => /(video|mp4|mov)/i.test(inp.accept || '')) || inputs[0];
      if (!vidInp) return false;
      vidInp.id = 'my_video_uploader_xhs';
      return true;
    });
    if (inputFound) break;
    await humanPause(600, 1000);
  }
  if (!inputFound) throw new Error('XHS_VIDEO_INPUT_NOT_FOUND');

  await humanPause(1000, 1800, '选视频前', 'xhs');
  await page.setInputFiles('#my_video_uploader_xhs', fileAbs);
  console.log('[xhs] 已注入视频文件，等待上传完成...');

  const timeoutMs = Number(process.env.XHS_UPLOAD_TIMEOUT_MS || 360_000);
  const startMs = Date.now();
  let settledTicks = 0;
  let tick = 0;
  let formReady = false;
  while (Date.now() - startMs < timeoutMs) {
    const st = await page.evaluate(() => {
      const titleInp = document.querySelector('input[placeholder*="填写标题"]');
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      const uploading = /正在上传|上传中|转码中|解析中|视频处理中/.test(body);
      return { hasTitle: !!titleInp, uploading };
    });
    if (tick % 4 === 0 || (st.hasTitle && !st.uploading)) {
      console.log('[xhs] upload wait', Math.round((Date.now() - startMs) / 1000) + 's', JSON.stringify(st));
    }
    if (st.hasTitle && !st.uploading) {
      settledTicks++;
      if (settledTicks >= 2) {
        formReady = true;
        break;
      }
    } else {
      settledTicks = 0;
    }
    tick++;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!formReady) throw new Error('XHS_VIDEO_UPLOAD_TIMEOUT');
  await humanPause(2000, 3500, '视频表单就绪', 'xhs');
  await dismissPopups();
}

async function uploadVideoCover(coverFile) {
  await dismissPopups();

  let inputReady = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const thumbBox = await page.evaluate(() => {
      const el = document.querySelector('.default--ai-cover-layout, .cover-edit-stack');
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    if (!thumbBox) {
      console.warn('[xhs] 未找到封面缩略图容器');
      return false;
    }
    await page.mouse.move(thumbBox.x, thumbBox.y);
    await humanPause(650, 950);

    const entryBox = await page.evaluate(() => {
      const el = document.querySelector('.cover-edit-entry');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    });
    const clickTarget = entryBox || thumbBox;
    await humanMouseClick(page, clickTarget.x, clickTarget.y, { radius: 2, tag: 'xhs' });

    for (let k = 0; k < 12; k++) {
      await new Promise((r) => setTimeout(r, 500));
      inputReady = await page.evaluate(() => !!document.querySelector('input[aria-label="上传封面图片"]'));
      if (inputReady) break;
    }
    if (inputReady) break;
    await dismissPopups();
  }

  if (!inputReady) {
    console.warn('[xhs] 封面弹窗上传 input 未出现');
    await safeShot(page, path.join(shotDir, 'xhs_cover_debug.png'));
    return false;
  }

  await page.setInputFiles('input[aria-label="上传封面图片"]', coverFile);
  console.log('[xhs] 已注入封面图，等待上传与完成按钮解锁...');

  let enabled = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const st = await page.evaluate(() => {
      const m = document.querySelector('.main-cover-editor-modal, .cover-modal');
      const btn = m && Array.from(m.querySelectorAll('button')).find((b) => (b.innerText || '').replace(/\s+/g, '').trim() === '完成');
      return btn ? { disabled: !!btn.disabled || (btn.className || '').includes('disabled') || btn.getAttribute('aria-disabled') === 'true' } : { disabled: true };
    });
    if (st.disabled === false) {
      enabled = true;
      break;
    }
  }
  if (!enabled) {
    console.warn('[xhs] 封面完成按钮解锁超时');
    await safeShot(page, path.join(shotDir, 'xhs_cover_debug.png'));
    await page.keyboard.press('Escape');
    return false;
  }

  await humanPause(1500, 2100, '封面预览稳定', 'xhs');

  const clickModalDone = async () => {
    const rect = await page.evaluate(() => {
      const m = document.querySelector('.main-cover-editor-modal, .cover-modal');
      const btn = m && Array.from(m.querySelectorAll('button')).find((b) => (b.innerText || '').replace(/\s+/g, '').trim() === '完成');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!btn.disabled } : null;
    });
    if (rect && !rect.disabled) {
      await humanMouseClick(page, rect.x, rect.y, { radius: 2, tag: 'xhs' });
      return true;
    }
    return false;
  };

  await clickModalDone();
  let closed = false;
  for (let sec = 0; sec < 15; sec++) {
    await new Promise((r) => setTimeout(r, 1000));
    const open = await page.evaluate(() => {
      const m = document.querySelector('.main-cover-editor-modal');
      return !!(m && m.getBoundingClientRect().width > 100);
    });
    if (!open) {
      closed = true;
      break;
    }
    if (sec === 4) {
      await clickModalDone();
    }
  }

  if (closed) {
    console.log('XHS_VIDEO_COVER_SET');
    await humanPause(800, 1400, '封面确认后', 'xhs');
    return true;
  }
  console.warn('[xhs] 封面弹窗未能自动关闭，跳过封面避免阻断草稿保存');
  await safeShot(page, path.join(shotDir, 'xhs_cover_debug.png'));
  await page.keyboard.press('Escape');
  await humanPause(600, 1000);
  return false;
}

async function fillTitle(textToWrite) {
  const writeVal = async (val) =>
    page.evaluate((tText) => {
      const titleInp = document.querySelector('input[placeholder*="填写标题"]');
      if (!titleInp) return { ok: false };
      titleInp.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(titleInp, tText);
      else titleInp.value = tText;
      titleInp.dispatchEvent(new Event('input', { bubbles: true }));
      titleInp.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: titleInp.value, maxLength: titleInp.maxLength };
    }, val);

  const res = await writeVal(textToWrite);
  await humanPause(500, 900);
  const counterInfo = await page.evaluate(() => {
    const inp = document.querySelector('input[placeholder*="填写标题"]');
    const box = inp?.closest('[class*="title"], [class*="input"], div')?.parentElement;
    const m = (box?.innerText || '').match(/(\d+)\s*\/\s*(\d+)/);
    return {
      value: inp?.value || '',
      over: m ? Number(m[1]) > Number(m[2]) : false,
      limit: m ? Number(m[2]) : 20,
      counter: m ? m[0] : null,
    };
  });
  if (counterInfo.over || (res.value && res.value !== textToWrite)) {
    const safeTitle = truncateWeightedTitle(textToWrite, counterInfo.limit || 20);
    if (safeTitle && safeTitle !== counterInfo.value) {
      await writeVal(safeTitle);
      console.log(`[xhs] 标题长度超出上限(${counterInfo.counter || 'maxLength'})，已智能调整为: ${safeTitle}`);
    }
  }
}

async function focusEditorEnd() {
  await page.evaluate(() => {
    const editor = document.querySelector('.tiptap.ProseMirror');
    if (!editor) return false;
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  });
}

async function clickTopicButton() {
  const box = await page.evaluate(() => {
    const btn =
      document.querySelector('button.contentBtn.topic-btn, button.topic-btn') ||
      Array.from(document.querySelectorAll('button')).find((b) =>
        (b.innerText || '').replace(/\u00a0/g, ' ').trim() === '话题',
      );
    if (!btn) return null;
    btn.scrollIntoView({ block: 'center' });
    const r = btn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!box) {
    // Fallback: type '#' into the focused editor.
    await page.keyboard.type('#');
    return false;
  }
  await humanMouseClick(page, box.x, box.y, { radius: 3, tag: 'xhs' });
  return true;
}

async function waitTopicSuggestion(keyword, { tries = 15 } = {}) {
  for (let i = 0; i < tries; i++) {
    await humanPause(200, 360);
    const candidates = await page.evaluate(() => {
      const sels = ['.tippy-content .item', '.items .item', '[class*="topic-list"] [class*="item"]', '.tippy-box .item'];
      const seen = new Set();
      const rows = [];
      for (const sel of sels) {
        const list = Array.from(document.querySelectorAll(sel));
        for (let idx = 0; idx < list.length; idx++) {
          const el = list[idx];
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width <= 10 || r.height <= 10) continue;
          const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
          if (!text || /^创建新话题|^新建话题/.test(text)) continue;
          rows.push({
            sel,
            domIdx: idx,
            text,
            isSelected: el.classList.contains('is-selected'),
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          });
        }
      }
      return rows.slice(0, 20);
    });
    if (!candidates.length) continue;

    let best = null;
    let bestScore = 0;
    for (const item of candidates) {
      const clean = cleanSuggestLabel(item.text);
      if (!clean) continue;
      let score = scoreCandidateMatch(clean, [keyword]);
      if (score === 0) {
        const kwLower = keyword.toLowerCase();
        const cLower = clean.toLowerCase();
        if (kwLower.length >= 2 && cLower.includes(kwLower.slice(0, Math.min(4, kwLower.length)))) {
          score = 220;
        }
      }
      if (item.isSelected && score > 0) score += 20;
      if (score > bestScore) {
        bestScore = score;
        best = { ...item, clean, score };
      }
    }
    if (best) return best;
  }
  return null;
}

async function countTiptapTopics() {
  return page.evaluate(() => document.querySelectorAll('.tiptap.ProseMirror a.tiptap-topic').length);
}

async function fillTopics(topics) {
  if (!topics.length) return;
  await focusEditorEnd();
  await humanPause(250, 450, '话题前聚焦', 'xhs');
  // Start topics on a new paragraph when body already has content.
  const hasBody = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap.ProseMirror');
    const text = (editor?.innerText || '').replace(/\u00a0/g, ' ').trim();
    return text.length > 0;
  });
  if (hasBody) {
    await page.keyboard.press('Enter');
    await humanPause(200, 400);
  }

  for (const kw of topics) {
    console.log(`topic #${kw}`);
    const beforeCount = await countTiptapTopics();
    await focusEditorEnd();
    await clickTopicButton();
    await humanPause(300, 550, '点话题后', 'xhs');
    await page.keyboard.type(kw, { delay: 35 + Math.floor(Math.random() * 55) });
    // Prefer clicking the live platform suggestion so XHS attaches the real trending topic ID.
    const sug = await waitTopicSuggestion(kw);
    let insertedByClick = false;
    if (sug) {
      console.log('[xhs] XHS_HOTSPOT_SUGGEST_PICKED:', sug.text);
      await humanMouseClick(page, sug.x, sug.y, { radius: 3, tag: 'xhs' });
      await humanPause(350, 550);
      if ((await countTiptapTopics()) > beforeCount) {
        insertedByClick = true;
      } else {
        await page.evaluate(({ sel, domIdx }) => {
          document.querySelectorAll(sel)[domIdx]?.click();
        }, sug);
        await humanPause(300, 500);
        if ((await countTiptapTopics()) > beforeCount) insertedByClick = true;
      }
    }
    if (!insertedByClick) {
      console.warn('[xhs] no tippy click confirmation, Space fallback:', kw);
      await page.keyboard.type(' ');
    }
    await humanPause(350, 650, '确认话题', 'xhs');
  }

  if (autoHotspot) {
    const currentCount = await countTiptapTopics();
    if (currentCount < 6) {
      const recChips = await page.evaluate(() => {
        const list = Array.from(
          document.querySelectorAll('[class*="topic-recommend"] span, [class*="recommend-topic"] span, [class*="recommend"] [class*="tag"]'),
        ).filter((el) => {
          if (el.closest('.tiptap.ProseMirror')) return false;
          const r = el.getBoundingClientRect();
          const t = (el.innerText || '').trim();
          return r.width > 16 && r.height > 14 && t && t !== '话题' && t.length <= 20;
        });
        return list.slice(0, 12).map((el) => {
          const r = el.getBoundingClientRect();
          return { text: (el.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
      });
      const existingNames = new Set(topics.map((t) => t.toLowerCase()));
      const pickedRecs = recChips
        .filter((c) => !existingNames.has(c.text.replace(/^#/, '').toLowerCase()))
        .map((c) => ({ ...c, score: scoreCandidateMatch(c.text, hotspotKeywords, { includeGeneralHints: true }) }))
        .filter((c) => c.score >= 100)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(2, 6 - currentCount));
      for (const chip of pickedRecs) {
        await humanMouseClick(page, chip.x, chip.y, { radius: 2, tag: 'xhs' });
        console.log('[xhs] XHS_RECOMMEND_TOPIC_ADDED:', chip.text);
        await humanPause(350, 550);
      }
    }
  }

  const topicNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tiptap.ProseMirror a.tiptap-topic')).map((a) => {
      try {
        return JSON.parse(a.getAttribute('data-topic') || '{}').name || '';
      } catch {
        return (a.innerText || '').replace(/\[话题\]#/g, '').replace(/^#/, '').trim();
      }
    }),
  );
  console.log('tiptap-topic:', topicNames.length, 'of', topics.length, topicNames);
  const missing = topics.filter((t) => !topicNames.includes(t));
  if (missing.length) console.warn('[xhs] missing topics after fillTopics:', missing.join(', '));
}

async function readOriginalOn() {
  return page.evaluate(() => {
    const wrap = document.querySelector('.original-wrapper');
    if (!wrap) return { found: false, on: false, modalOpen: false };
    const input = wrap.querySelector('input[type="checkbox"]');
    const sim = wrap.querySelector('.d-switch-simulator');
    const cls = (sim?.className?.toString?.() || '').split(/\s+/);
    const modalOpen = Array.from(document.querySelectorAll('.d-modal, [role="dialog"]')).some((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 120 && r.height > 80 && /原创声明须知|笔记完成原创声明/.test(d.innerText || '');
    });
    // Do not use String.includes('checked') — it matches class "unchecked".
    const switchOn = !!input?.checked || cls.includes('checked');
    return { found: true, on: switchOn && !modalOpen, switchOn, modalOpen };
  });
}

async function confirmOriginalModalIfOpen() {
  const modalState = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('.d-modal, [role="dialog"]')).filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 120 && r.height > 80 && /原创声明须知|笔记完成原创声明/.test(d.innerText || '');
    });
    const dlg = modals[modals.length - 1];
    if (!dlg) return { open: false };

    const cbSim = dlg.querySelector('.d-checkbox-simulator');
    const cbInp = dlg.querySelector('input[type="checkbox"]');
    const isChecked = () =>
      !!cbInp?.checked || (cbSim?.className?.toString?.() || '').split(/\s+/).includes('checked');

    // Click checkbox simulator ONCE (Vue updates checked state asynchronously on next tick; do NOT double-click cbInp!)
    if (!isChecked()) {
      (cbSim || cbInp)?.click();
    }
    return { open: true, clickedCheckbox: !isChecked() };
  });

  if (!modalState.open) return false;
  console.log('[xhs] 检测到「原创声明须知」确认弹窗，已点击协议勾选框:', JSON.stringify(modalState));
  await humanPause(750, 1150, '等待声明原创按钮解锁', 'xhs');

  const confirmBtn = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('.d-modal, [role="dialog"]')).filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 120 && r.height > 80 && /原创声明须知|笔记完成原创声明/.test(d.innerText || '');
    });
    const dlg = modals[modals.length - 1];
    if (!dlg) return { found: false, reason: 'modal disappeared' };

    const btn = Array.from(dlg.querySelectorAll('button')).find(
      (b) => (b.innerText || '').replace(/\s+/g, '').trim() === '声明原创',
    );
    if (!btn) return { found: false, reason: 'no 声明原创 button' };
    const r = btn.getBoundingClientRect();
    const disabled = !!btn.disabled || (btn.className || '').includes('disabled');
    if (!disabled) btn.click();
    return {
      found: true,
      disabled,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  });

  if (!confirmBtn.found) {
    console.warn('[xhs] 原创弹窗内未找到「声明原创」确认按钮:', confirmBtn.reason);
    return false;
  }
  await humanPause(700, 1200, '确认声明原创弹窗', 'xhs');

  // If modal is still open (e.g. button needed a real mouse click after unlocking), click it via mouse
  const stillOpenBtn = await page.evaluate(() => {
    const modals = Array.from(document.querySelectorAll('.d-modal, [role="dialog"]')).filter((d) => {
      const r = d.getBoundingClientRect();
      return r.width > 120 && r.height > 80 && /原创声明须知|笔记完成原创声明/.test(d.innerText || '');
    });
    const dlg = modals[modals.length - 1];
    if (!dlg) return null;
    const btn = Array.from(dlg.querySelectorAll('button')).find(
      (b) => (b.innerText || '').replace(/\s+/g, '').trim() === '声明原创' && !b.disabled,
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (stillOpenBtn) {
    await humanMouseClick(page, stillOpenBtn.x, stillOpenBtn.y, { radius: 3, tag: 'xhs' });
    await humanPause(700, 1100, '鼠标补点声明原创', 'xhs');
  }
  return true;
}

async function enableOriginalDeclaration() {
  await page.evaluate(() => {
    document.querySelector('.original-wrapper')?.scrollIntoView({ block: 'center' });
  });
  await humanPause(300, 550);

  let state = await readOriginalOn();
  if (!state.found) {
    console.warn('[xhs] 原创声明控件未找到');
    return false;
  }
  if (state.on) {
    console.log('[xhs] 原创声明已开启');
    return true;
  }

  const box = await page.evaluate(() => {
    const wrap = document.querySelector('.original-wrapper');
    const target =
      wrap?.querySelector('.d-switch-simulator') ||
      wrap?.querySelector('.d-switch') ||
      wrap?.querySelector('.d-switch-box');
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (box) {
    await humanMouseClick(page, box.x, box.y, { radius: 2, tag: 'xhs' });
  } else {
    await page.evaluate(() => {
      document.querySelector('.original-wrapper .d-switch-simulator, .original-wrapper .d-switch')?.click();
    });
  }
  await humanPause(800, 1400, '点击原创声明开关后', 'xhs');

  // Handle the mandatory「原创声明须知」confirmation modal!
  await confirmOriginalModalIfOpen();

  state = await readOriginalOn();
  if (!state.on) {
    // Fallback retry if first click missed or modal needed a second pass
    await page.evaluate(() => {
      document.querySelector('.original-wrapper .d-switch-simulator, .original-wrapper .d-switch')?.click();
    });
    await humanPause(800, 1200);
    await confirmOriginalModalIfOpen();
    state = await readOriginalOn();
  }

  console.log('[xhs] 原创声明:', state.on ? 'ON' : 'OFF', JSON.stringify(state));
  if (state.on) console.log('XHS_ORIGINAL_DECLARED');
  return state.on;
}

try {
  try {
    await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  } catch (e) {
    console.warn('[xhs] goto timeout:', e.message?.slice(0, 160));
  }
  await suppressNativeFileDialog(page);
  await humanPause(5000, 9000, '发布页加载', 'xhs');

  const cur = await page.url();
  console.log('[xhs] URL:', cur);
  if (cur.includes('login') || cur.includes('passport')) {
    console.log('NEED_LOGIN_XHS');
    throw new Error('NEED_LOGIN_XHS');
  }

  if (isVideoMode) {
    await uploadVideoAndWait(videoPath);
    if (coverPath && fs.existsSync(coverPath.replace(/\//g, path.sep))) {
      await uploadVideoCover(coverPath);
    }
  } else {
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div, span, button'));
      const imgTab = tabs.find((el) => el.innerText?.trim() === '上传图文' || el.innerText?.trim() === '图文');
      imgTab?.click();
    });
    await humanPause(2000, 4000, '切图文', 'xhs');

    console.log(`准备上传 (${images.length})`);
    await page.evaluate(() => {
      const inp = document.querySelector('input.upload-input, input[type="file"]');
      if (inp) inp.id = 'my_batch_uploader_xhs';
    });
    await humanPause(1500, 3000, '选图前', 'xhs');
    await page.setInputFiles('#my_batch_uploader_xhs', images);
    await humanPause(15000, 25000, '图片上传', 'xhs');
  }

  await humanPause(1500, 3000, '填标题前', 'xhs');
  await fillTitle(rawTitle);
  await humanPause(2500, 4500, '标题后', 'xhs');

  await humanPause(1500, 3000, '填正文前', 'xhs');
  await page.evaluate((dHtml) => {
    const editor = document.querySelector('.tiptap.ProseMirror');
    if (editor) {
      editor.focus();
      editor.innerHTML = dHtml;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, descHtml);
  await humanPause(2000, 4000, '正文后', 'xhs');

  await fillTopics(topicsList);
  await humanPause(800, 1600, '话题后', 'xhs');

  await enableOriginalDeclaration();
  await humanPause(800, 1600, '原创声明后', 'xhs');

  if (aiGenerated) {
    try {
      await declareXhsAiGenerated(page);
    } catch (e) {
      console.warn('[xhs] 内容类型声明 note:', String(e?.message || e).slice(0, 120));
    }
    await humanPause(600, 1200, 'AI声明后', 'xhs');
  }

  if (schedule) {
    try {
      console.log(`[xhs] 设置定时发布: ${schedule.dateTimeStr}`);
      const switchRes = await page.evaluate(() => {
        const card = Array.from(document.querySelectorAll('.custom-switch-card')).find((c) =>
          /定时发布/.test(c.innerText || ''),
        );
        const sw = card?.querySelector('.d-switch');
        if (!sw) return { ok: false, reason: 'no switch' };
        const checked = sw.classList.contains('d-switch-checked') || sw.querySelector('input')?.checked;
        if (!checked) sw.click();
        return { ok: true, wasChecked: checked };
      });
      console.log('[xhs] 定时发布开关:', JSON.stringify(switchRes));
      await humanPause(1000, 1600, '开启定时开关后', 'xhs');

      const scrolled = await page.evaluate(() => {
        const picker = document.querySelector('.date-picker-container');
        if (!picker) return false;
        picker.scrollIntoView({ block: 'center' });
        return true;
      });
      if (scrolled) {
        await page.click('.date-picker-container');
        await humanPause(1000, 1600, '打开日期时间弹窗', 'xhs');

        const dayRes = await page.evaluate((targetDay) => {
          const pop = document.querySelector('.post-time-date-picker-popover-class');
          if (!pop) return { ok: false, reason: 'no pop' };
          const cells = Array.from(pop.querySelectorAll('.d-datepicker-cell:not(.disabled)'));
          const hit = cells.find((c) => {
            const span = c.querySelector('.d-text.d-text-monospace') || c;
            return (span.innerText || '').trim() === String(targetDay);
          });
          if (hit) {
            hit.click();
            return { ok: true, text: hit.innerText.trim() };
          }
          return { ok: false, reason: 'day not found' };
        }, schedule.day);
        console.log('[xhs] 选择日期结果:', JSON.stringify(dayRes));
        await humanPause(800, 1400, '选定日期后', 'xhs');

        const hourRes = await page.evaluate((targetH) => {
          const pop = document.querySelector('.post-time-date-picker-popover-class');
          if (!pop) return { ok: false, reason: 'no pop' };
          const timebars = Array.from(pop.querySelectorAll('.d-timepicker-timebar'));
          const hourBar = timebars[0];
          const hit = Array.from(hourBar?.querySelectorAll('.d-timepicker-time') || []).find((el) => {
            const t = (el.innerText || '').replace(/\D/g, '');
            return t === String(targetH) || t === String(targetH).padStart(2, '0');
          });
          if (hit) {
            hit.scrollIntoView({ block: 'center' });
            hit.click();
            return { ok: true, text: hit.innerText.trim() };
          }
          return { ok: false, reason: 'hour not found' };
        }, schedule.hour);
        console.log('[xhs] 选择小时结果:', JSON.stringify(hourRes));
        await humanPause(800, 1400, '选定小时后', 'xhs');

        const minRes = await page.evaluate((targetM) => {
          const pop = document.querySelector('.post-time-date-picker-popover-class');
          if (!pop) return { ok: false, reason: 'no pop' };
          const timebars = Array.from(pop.querySelectorAll('.d-timepicker-timebar'));
          const minBar = timebars[1];
          const hit = Array.from(minBar?.querySelectorAll('.d-timepicker-time') || []).find((el) => {
            const t = (el.innerText || '').replace(/\D/g, '');
            return t === String(targetM) || t === String(targetM).padStart(2, '0');
          });
          if (hit) {
            hit.scrollIntoView({ block: 'center' });
            hit.click();
            return { ok: true, text: hit.innerText.trim() };
          }
          return { ok: false, reason: 'min not found' };
        }, schedule.minute);
        console.log('[xhs] 选择分钟结果:', JSON.stringify(minRes));
        await humanPause(800, 1400, '选定分钟后', 'xhs');

        await page.evaluate(() => {
          const titleInp = document.querySelector('input[placeholder*="填写标题"]');
          titleInp?.click();
        });
        await humanPause(600, 1000, '关闭日期弹层', 'xhs');
      }
    } catch (e) {
      console.warn('[xhs] 设置定时发布异常:', String(e?.message || e).slice(0, 120));
    }
  }

  if (isVideoMode) {
    await page.evaluate(() => {
      const topAnchor = document.querySelector('.default--ai-cover-layout, .cover-plugin-title, input[placeholder*="填写标题"]');
      if (topAnchor) topAnchor.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, 0);
    });
    await humanPause(500, 800);
    await safeShot(page, path.join(shotDir, 'xhs_before_draft_top.png'));
  }
  await page.evaluate(() => {
    const anchor = document.querySelector('[lass="declaration-wrapper"], .original-wrapper');
    anchor?.scrollIntoView({ block: 'center' });
  });
  await humanPause(400, 700);
  await safeShot(page, path.join(shotDir, 'xhs_before_draft.png'), { fullPage: true });

  await humanPause(3000, 6000, '点暂存前', 'xhs');
  const clickSave = await page.evaluate(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (el?._sr) {
      const saveBtn = Array.from(el._sr.querySelectorAll('button')).find(
        (b) => b.innerText?.trim() === '暂存离开',
      );
      if (saveBtn) {
        saveBtn.click();
        return { success: true, via: 'shadow' };
      }
    }
    const fallback = Array.from(document.querySelectorAll('button')).find(
      (b) => b.innerText?.trim() === '暂存离开',
    );
    if (fallback) {
      fallback.click();
      return { success: true, via: 'light' };
    }
    return { success: false, reason: 'no saveBtn' };
  });
  console.log('保存点击:', JSON.stringify(clickSave));

  let savedOk = false;
  for (let w = 0; w < 15; w++) {
    await new Promise((r) => setTimeout(r, 1200));
    const toasts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*="toast"], [class*="message"]'))
        .map((t) => t.innerText?.trim())
        .filter(Boolean),
    );
    if (toasts.some((t) => t.includes('保存成功'))) {
      console.log('XHS_DRAFT_SAVED', toasts.join(', '));
      savedOk = true;
      break;
    }
  }
  await humanPause(600, 1200);
  await safeShot(page, path.join(shotDir, 'xhs_after_draft.png'));
  if (!savedOk) console.warn('未检测到保存成功 toast，请人工看草稿箱');
  console.log('XHS_STAGED_DONE');
} finally {
  await task.finish({ keep: job.keepOpen ? [page.label || 'p1'] : [] });
}
