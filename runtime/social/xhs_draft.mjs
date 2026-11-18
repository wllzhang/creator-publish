/**
 * 小红书草稿。job: profileId, images[], title, body?, topics?, hotspot?, activity?, autoHotspot?, shotDir?
 * 话题：点「话题」→ 键入词条 → 优先点选实时热门下拉联想生成 <a class="tiptap-topic">（未匹配则空格兜底）；默认勾选原创声明。
 */
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
} from '../lib/ego_dom.mjs';

const { job } = loadJob();
const images = (job.images || []).map((p) => abs(p)).filter(Boolean);
const title = (job.title || '').slice(0, 20);
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

if (!images.length) throw new Error('job 需要 images[]（绝对路径列表）');
if (!title) throw new Error('job 需要 title');

const task = await taskSpace('cp-xhs-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

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
  await humanPause(5000, 9000, '发布页加载', 'xhs');

  const cur = await page.url();
  console.log('[xhs] URL:', cur);
  if (cur.includes('login') || cur.includes('passport')) {
    console.log('NEED_LOGIN_XHS');
    throw new Error('NEED_LOGIN_XHS');
  }

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

  await humanPause(2000, 4000, '填标题前', 'xhs');
  await page.evaluate((tText) => {
    const titleInp = document.querySelector('input[placeholder*="填写标题"]');
    if (titleInp) {
      titleInp.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(titleInp, tText);
      else titleInp.value = tText;
      titleInp.dispatchEvent(new Event('input', { bubbles: true }));
      titleInp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, title);
  await humanPause(3000, 5500, '标题后', 'xhs');

  await humanPause(2000, 4000, '填正文前', 'xhs');
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
  await task.finish({ keep: [] });
}
