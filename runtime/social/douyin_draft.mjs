/**
 * 抖音入草稿（填表 + 自动选热词话题/关联热点/官方活动 + 点「暂存离开」停在发布前）。
 * 先 node write_job.mjs，再在 ego 中跑本脚本。
 * job: profileId, video, title, topics[]（最多取前 5 个）, body?, hotspot?, activity?, autoHotspot?, shotDir?
 */
import path from 'node:path';
import { humanPause, humanMouseClick, humanClickSelector, humanInsertText } from '../lib/pace.mjs';
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

const { job } = loadJob();
const videoPath = abs(job.video);
const title = job.title;
const rawTopics = Array.isArray(job.topics) ? job.topics : [];
const topics = normalizeTopics(rawTopics, { max: 5 });
const bodyText = job.body ? String(job.body).trim() : '';
const autoHotspot = job.autoHotspot !== false;
const hotspotKeywords = deriveHotspotKeywords(job);
const shotDir = resolveShotDir(job);
const schedule = parseScheduleTime(job.scheduleTime);

if (!videoPath || !title) throw new Error('job 需要 video + title');
if (rawTopics.length > 5) {
  console.warn(`[dy] 抖音单条最多支持 5 个 #话题，已截断前 5 个: ${topics.join(', ')}`);
}

async function pickDouyinTopicSuggestion(page, keyword) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await humanPause(320, 480);
    const candidates = await page.evaluate(() => {
      const sels = [
        '.mention-suggest-item-container-TVOZMl > div',
        '[class*="mention-suggest-item"]',
        '[class*="mention-suggest"] [role="option"]',
        'div[class*="suggest-list"] > div',
      ];
      const seen = new Set();
      const rows = [];
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width <= 10 || r.height <= 10 || r.width > 520 || r.height > 72) continue;
          const text = (el.innerText || '').trim();
          if (!text) continue;
          rows.push({ idx: rows.length, text, x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }
      }
      // Fallback: generic suggest container leaf rows
      if (!rows.length) {
        for (const el of Array.from(document.querySelectorAll('div[class*="suggest"] div, div[class*="mention"] div'))) {
          if (el.childElementCount > 4) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 40 || r.height <= 16 || r.width > 520 || r.height > 64) continue;
          const text = (el.innerText || '').trim();
          if (!text || !text.startsWith('#')) continue;
          rows.push({ idx: rows.length, text, x: r.left + r.width / 2, y: r.top + r.height / 2 });
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
      // Allow live trending variants sharing >=2 chars with keyword (e.g. 加满少花26 -> 油价下调少花26)
      if (score === 0) {
        const kwLower = keyword.toLowerCase();
        const cLower = clean.toLowerCase();
        if (cLower.includes(kwLower.slice(0, Math.min(4, kwLower.length))) && kwLower.length >= 2) {
          score = 220;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = { ...item, clean, score };
      }
    }

    if (best) {
      await humanMouseClick(page, best.x, best.y, { radius: 3, tag: 'dy' });
      return best;
    }
  }
  return null;
}

async function topUpRecommendedTopics(page, maxTotal = 5) {
  const existing = await page.evaluate(() => {
    const ed = document.querySelector('.zone-container.editor-kit-container');
    const txt = (ed?.innerText || '').replace(/\u00a0/g, ' ');
    const tags = txt.match(/#[^\s#]+/g) || [];
    return { count: tags.length, tags: tags.map((t) => t.replace(/^#/, '')) };
  });
  if (existing.count >= maxTotal) return;

  const chips = await page.evaluate(() => {
    const ed = document.querySelector('.zone-container.editor-kit-container');
    const box = ed?.closest('[class*="desc"], [class*="editor"]')?.parentElement || document;
    const nodes = Array.from(box.querySelectorAll('span, div, button, a')).filter((el) => {
      if (el.childElementCount > 1 || el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
      const t = (el.innerText || '').trim();
      return /^#[^\s]{2,16}$/.test(t) && t !== '#添加话题';
    });
    return nodes.slice(0, 20).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: (el.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
  });

  const existingSet = new Set(existing.tags.map((t) => t.toLowerCase()));
  const ranked = chips
    .filter((c) => !existingSet.has(c.text.replace(/^#/, '').toLowerCase()))
    .map((c) => ({ ...c, score: scoreCandidateMatch(c.text, hotspotKeywords, { includeGeneralHints: true }) }))
    .filter((c) => c.score >= 100)
    .sort((a, b) => b.score - a.score);

  let added = 0;
  for (const chip of ranked) {
    if (existing.count + added >= maxTotal) break;
    await humanMouseClick(page, chip.x, chip.y, { radius: 2, tag: 'dy' });
    added++;
    console.log('[dy] DOUYIN_RECOMMEND_TOPIC_ADDED:', chip.text);
    await humanPause(300, 600);
  }
}

async function associateDouyinHotspotAndActivity(page) {
  // Expand「扩展信息」only if hotspot field is not yet visible
  const hasHotspotVisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).some(
      (el) => el.childElementCount === 0 && /关联热点/.test((el.innerText || '').trim()) && el.offsetWidth > 0,
    ),
  );
  if (!hasHotspotVisible) {
    const expanded = await page.evaluate(() => {
      const header = Array.from(document.querySelectorAll('div, span, button')).find((el) => {
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return (t === '扩展信息' || t === '展开扩展信息' || t === '展开更多') && el.offsetWidth > 0;
      });
      if (header) {
        header.scrollIntoView({ block: 'center' });
        header.click();
        return true;
      }
      return false;
    });
    if (expanded) await humanPause(600, 1000, '展开扩展信息', 'dy');
  }

  // Log available hotspot / activity controls for diagnostics
  const formProbe = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('div, span, label, p'))
      .filter((el) => el.childElementCount <= 1 && el.offsetWidth > 0)
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => /热点|活动|合集|扩展/.test(t) && t.length <= 32);
    return [...new Set(labels)].slice(0, 15);
  });
  console.log('[dy] hotspot/activity form labels:', JSON.stringify(formProbe));

  // 1) 关联热点 / 申请关联热点（严格锁定单行容器 < 95px，优先定位「点击输入热点词」）
  let hotspotAssociated = false;
  const hotspotTrigger = await page.evaluate(() => {
    const lbl = Array.from(document.querySelectorAll('div, span, label')).find((el) => {
      const t = (el.innerText || '').replace(/\s+/g, '').trim();
      return (/^(?:申请)?关联热点/.test(t) || t === '热点') && el.childElementCount <= 2 && el.offsetWidth > 0;
    });
    if (lbl) lbl.scrollIntoView({ block: 'center' });

    // Direct match on「点击输入热点词」placeholder/div or input[placeholder*="热点"]
    const directPh = Array.from(document.querySelectorAll('input[placeholder*="热点"], div, span')).find((el) => {
      if (el.closest('.zone-container, [contenteditable="true"]')) return false;
      if (el.matches('input[placeholder*="热点"]')) return el.offsetWidth > 40;
      const t = (el.innerText || '').replace(/\s+/g, '').trim();
      return el.childElementCount <= 1 && (t === '点击输入热点词' || t === '请输入热点词') && el.offsetWidth > 40;
    });
    if (directPh) {
      const r = directPh.getBoundingClientRect();
      return { found: true, kind: 'direct', x: r.left + r.width / 2, y: r.top + r.height / 2, text: directPh.innerText || directPh.getAttribute('placeholder') || '' };
    }

    if (!lbl) return { found: false };
    let box = lbl.parentElement;
    for (let d = 0; d < 2 && box; d++) {
      const br = box.getBoundingClientRect();
      if (br.height > 110 || box.querySelector('.zone-container')) break;
      const inp = box.querySelector('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), [role="combobox"], .semi-select');
      if (inp) {
        const ir = inp.getBoundingClientRect();
        if (ir.width > 40) {
          return { found: true, kind: 'row-control', x: ir.left + ir.width / 2, y: ir.top + ir.height / 2, text: inp.getAttribute('placeholder') || inp.innerText || '' };
        }
      }
      box = box.parentElement;
    }
    return { found: true, kind: 'label-only' };
  });

  if (hotspotTrigger.found && hotspotTrigger.x > 0) {
    console.log('[dy] hotspot trigger:', JSON.stringify(hotspotTrigger));
    for (const kw of hotspotKeywords.slice(0, 4)) {
      await humanMouseClick(page, hotspotTrigger.x, hotspotTrigger.y, { radius: 3, tag: 'dy' });
      await humanPause(450, 650);
      // If clicking revealed a focused or newly mounted input in the hotspot row / portal, type into it
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
        const inp = Array.from(document.querySelectorAll('input[placeholder*="热点"], .semi-portal input, .semi-popover input')).find(
          (el) => el.offsetWidth > 30 && !el.closest('.zone-container'),
        );
        inp?.focus();
      });
      await page.keyboard.press('Control+a');
      await humanPause(100, 200);
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(kw);
      await humanPause(1300, 1800, `热点搜索 ${kw}`, 'dy');

      const opts = await page.evaluate(() => {
        const sels = [
          '.semi-portal .semi-select-option',
          '.semi-popover .semi-select-option',
          '.semi-select-option-list > *',
          '[role="listbox"] [role="option"]',
          '[class*="select-option"]',
          '[class*="hotspot"] [class*="item"]',
        ];
        const out = [];
        const seen = new Set();
        for (const sel of sels) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (seen.has(el) || el.closest('.zone-container, [contenteditable="true"]')) continue;
            seen.add(el);
            const r = el.getBoundingClientRect();
            if (r.width <= 30 || r.height <= 16) continue;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!t || /暂无|无匹配|加载中|没有找到|未找到|点击输入热点词|请输入热点词/.test(t)) continue;
            out.push({ text: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
        }
        return out.slice(0, 15);
      });
      console.log(`[dy] hotspot options for "${kw}":`, JSON.stringify(opts.map((o) => o.text.slice(0, 40))));

      if (opts.length) {
        const ranked = opts
          .map((o) => ({ ...o, score: scoreCandidateMatch(o.text, hotspotKeywords, { includeGeneralHints: true }) }))
          .sort((a, b) => b.score - a.score);
        const pick = ranked[0];
        if (pick && (pick.score > 0 || opts.length <= 10)) {
          await humanMouseClick(page, pick.x, pick.y, { radius: 3, tag: 'dy' });
          console.log('DOUYIN_HOTSPOT_ASSOCIATED:', pick.text);
          hotspotAssociated = true;
          await humanPause(400, 700);
          break;
        }
      }
    }
    await page.keyboard.press('Escape');
    await humanPause(200, 400);
  }
  if (!hotspotAssociated) {
    console.log('[dy] no hotspot dropdown match available on current form (continuing draft save)');
  }

  // 2) 官方活动（严格限定在官方活动单行容器内，彻底排除 .zone-container 话题胶囊）
  const activityMatch = await page.evaluate(() => {
    const lbl = Array.from(document.querySelectorAll('div, span, label')).find((el) => {
      const t = (el.innerText || '').replace(/\s+/g, '').trim();
      return /^官方活动/.test(t) && el.childElementCount <= 2 && el.offsetWidth > 0;
    });
    if (!lbl) return null;
    let box = lbl.parentElement;
    for (let d = 0; d < 2 && box; d++) {
      const br = box.getBoundingClientRect();
      if (br.height > 120 || box.querySelector('.zone-container')) break;
      const pills = Array.from(box.querySelectorAll('div, span, button')).filter((el) => {
        if (el === lbl || el.childElementCount > 2 || el.closest('.zone-container, [contenteditable="true"]')) return false;
        const r = el.getBoundingClientRect();
        const t = (el.innerText || '').trim();
        return r.width > 30 && r.height > 16 && r.height < 56 && t && !/^官方活动|活动详情|参与活动可|更多|\+\d+$/.test(t);
      });
      if (pills.length) {
        return pills.slice(0, 12).map((p) => {
          const r = p.getBoundingClientRect();
          return { text: (p.innerText || '').replace(/\s+/g, ' ').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
      }
      box = box.parentElement;
    }
    return null;
  });

  if (Array.isArray(activityMatch) && activityMatch.length) {
    console.log('[dy] official activity candidates:', JSON.stringify(activityMatch.map((a) => a.text.slice(0, 36))));
    const bestAct = activityMatch
      .map((a) => ({ ...a, score: scoreCandidateMatch(a.text, hotspotKeywords, { includeGeneralHints: true }) }))
      .filter((a) => a.score >= 100)
      .sort((a, b) => b.score - a.score)[0];
    if (bestAct) {
      await humanMouseClick(page, bestAct.x, bestAct.y, { radius: 2, tag: 'dy' });
      console.log('DOUYIN_ACTIVITY_ASSOCIATED:', bestAct.text);
      await humanPause(400, 700);
    }
  }
}

async function dismissResumeBanner(page) {
  const dismissedBanner = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    if (!/上次未发布的视频/.test(body)) return false;
    const giveUp = Array.from(document.querySelectorAll('span, a, button, div')).find(
      (el) => el.childElementCount === 0 && (el.innerText || '').replace(/\s+/g, '').trim() === '放弃' && el.offsetWidth > 0,
    );
    if (giveUp) {
      giveUp.click();
      return true;
    }
    return false;
  });
  if (dismissedBanner) {
    console.log('[dy] 检测到上次暂存草稿横幅，已点击「放弃」开始新上传');
    await humanPause(800, 1300);
    await page.evaluate(() => {
      const ok = Array.from(document.querySelectorAll('[role="dialog"] button, [class*="modal"] button, button')).find(
        (b) => /^(确定|确认|放弃)$/.test((b.innerText || '').replace(/\s+/g, '').trim()) && b.offsetWidth > 0,
      );
      ok?.click();
    });
    await humanPause(800, 1300);
  }
}

async function uploadDouyinVideoWithRetry(page, filePath) {
  const maxAttempts = Number(process.env.DOUYIN_UPLOAD_RETRIES || 3);
  const uploadTimeoutMs = Number(process.env.DOUYIN_UPLOAD_TIMEOUT_MS || 600_000);

  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.warn(`[dy] 上传重试第 ${attempt}/${maxAttempts} 次（上次原因: ${lastReason}）...`);
      await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'load' }).catch(() => {});
      await suppressNativeFileDialog(page);
      await humanPause(2500, 4200, '重试上传页加载', 'dy');
    }

    await dismissResumeBanner(page);

    // Wait for a mounted video file input before setInputFiles
    let inputReady = false;
    for (let i = 0; i < 20; i++) {
      inputReady = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
        const vid = inputs.find((inp) => /video|\.mp4/i.test(inp.accept || '')) || inputs[0];
        if (!vid) return false;
        vid.id = 'dy-video-upload-target';
        return true;
      });
      if (inputReady) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!inputReady) {
      lastReason = 'file input not found on upload page';
      continue;
    }

    await humanPause(1000, 2200, '选视频前', 'dy');
    await page.setInputFiles('#dy-video-upload-target', filePath);

    // Wait for transition to publish/post page or upload start (max 45s)
    let enteredPost = false;
    for (let w = 0; w < 30; w++) {
      const st = await page.evaluate(() => {
        const url = location.href;
        const body = document.body?.innerText || '';
        const onPost = url.includes('/content/publish') || url.includes('/content/post/video');
        const hasTitle = !!document.querySelector('input[placeholder*="填写作品标题"]');
        const failed = /上传失败|上传异常|网络错误|格式不支持|文件损坏/.test(body);
        return { url, onPost, hasTitle, failed };
      });
      if (st.failed) {
        lastReason = 'upload failed immediately after file selection';
        break;
      }
      if (st.onPost || st.hasTitle) {
        console.log('publish page:', st.url);
        enteredPost = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!enteredPost) {
      if (lastReason === 'unknown') lastReason = 'did not enter publish page after setInputFiles';
      continue;
    }

    // Wait for TRUE 100% upload completion & title input ready
    const startMs = Date.now();
    let ticks = 0;
    let settledTicks = 0;
    let uploadSucceeded = false;
    let uploadFailed = false;

    while (Date.now() - startMs < uploadTimeoutMs) {
      const st = await page.evaluate(() => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const hasTitle = !!document.querySelector('input[placeholder*="填写作品标题"]');
        const failed = /上传失败|上传异常|上传中断|网络异常|网络错误|转码失败/.test(body);
        const pctMatch = body.match(/(?:已上传|上传中|正在上传)[^\d%]{0,8}(\d{1,3})\s*%/) || body.match(/\b(\d{1,2})\s*%/);
        const pct = pctMatch ? Number(pctMatch[1]) : null;
        const hasCancel = /取消上传/.test(body);
        const uploading =
          !failed &&
          (hasCancel ||
            /上传中|正在上传|上传过程中|等待上传|校验中|转码中|视频处理中/.test(body) ||
            (pct !== null && pct < 100));
        const doneSignal =
          /上传成功|重新上传|更换视频/.test(body) ||
          Array.from(document.querySelectorAll('video')).some((v) => v.readyState >= 1 || !!(v.currentSrc || v.src));
        return { hasTitle, failed, uploading, pct, doneSignal };
      });

      if (st.failed) {
        console.warn('[dy] 检测到视频上传失败状态:', JSON.stringify(st));
        lastReason = 'douyin reported upload failure';
        uploadFailed = true;
        break;
      }

      if (ticks % 5 === 0 || st.uploading) {
        console.log('[dy] upload wait', Math.round((Date.now() - startMs) / 1000) + 's', JSON.stringify(st));
      }

      if (st.hasTitle && !st.uploading) {
        settledTicks++;
        if (st.doneSignal || settledTicks >= 3) {
          uploadSucceeded = true;
          break;
        }
      } else {
        settledTicks = 0;
      }

      ticks++;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (uploadSucceeded) {
      console.log('[dy] DOUYIN_UPLOAD_COMPLETE');
      return;
    }
    if (!uploadFailed) {
      lastReason = `upload timeout after ${Math.round(uploadTimeoutMs / 1000)}s`;
    }
  }

  throw new Error(`DOUYIN_UPLOAD_FAILED: ${lastReason}`);
}

const task = await taskSpace('cp-douyin-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

try {
  console.log('Navigating Douyin upload...');
  await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'load' });
  await suppressNativeFileDialog(page);
  await humanPause(2500, 4500, '上传页加载', 'dy');

  const curUrl = await page.url();
  console.log('Douyin URL:', curUrl);
  if (curUrl.includes('login') || curUrl.includes('passport')) {
    console.log('NEED_LOGIN_DOUYIN');
    console.log(await page.snapshot());
    throw new Error('NEED_LOGIN_DOUYIN');
  }

  await uploadDouyinVideoWithRetry(page, videoPath);
  await humanPause(2500, 4000, '上传处理', 'dy');

  await page.fill('input[placeholder*="填写作品标题"]', title);
  await humanPause(800, 1800, '标题后', 'dy');

  await humanClickSelector(page, '.zone-container.editor-kit-container', { tag: 'dy' });
  await humanPause(200, 500);
  await page.keyboard.press('Control+a');
  await humanPause(150, 400);
  await page.keyboard.press('Backspace');
  await humanPause(500, 1000);

  if (bodyText) {
    await humanInsertText(page, bodyText, { tag: 'dy' });
    if (topics.length) await page.keyboard.press('Enter');
    await humanPause(400, 800, '正文后', 'dy');
  }

  // Topics stay on one line: "#a #b #c" with spaces only (no Enter / no linebreak; max 5).
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    console.log(`topic #${t}`);
    const clickedTopicBtn = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('*')).find(
        (el) => el.children.length === 0 && el.innerText?.trim() === '#添加话题',
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!clickedTopicBtn) await page.keyboard.type('#');
    await humanPause(350, 650, '话题输入前', 'dy');
    await page.keyboard.insertText(t);

    const matched = await pickDouyinTopicSuggestion(page, t);
    if (matched) {
      console.log(`[dy] DOUYIN_TOPIC_SUGGEST_PICKED: ${matched.text.replace(/\s+/g, ' ')}`);
      await humanPause(250, 450);
    } else {
      await page.keyboard.press('Escape');
      await humanPause(150, 350);
      const alreadyPresent = await page.evaluate((kw) => {
        const ed = document.querySelector('.zone-container.editor-kit-container');
        const txt = (ed?.innerText || '').replace(/\u00a0/g, ' ').trimEnd();
        return txt.endsWith(`#${kw}`) || txt.includes(`#${kw} `);
      }, t);
      if (!alreadyPresent) {
        await page.keyboard.insertText(`#${t}`);
      }
    }

    const endsWithSpace = await page.evaluate(() => {
      const ed = document.querySelector('.zone-container.editor-kit-container');
      const txt = (ed?.innerText || '').replace(/\u00a0/g, ' ');
      return /\s$/.test(txt);
    });
    if (!endsWithSpace && (i < topics.length - 1 || !matched)) {
      await page.keyboard.type(' ');
    }
    await humanPause(450, 850, '话题间隔', 'dy');
  }

  if (autoHotspot) {
    try {
      await topUpRecommendedTopics(page, 5);
    } catch (e) {
      console.warn('[dy] recommended topic top-up note:', String(e?.message || e).slice(0, 120));
    }
    try {
      await associateDouyinHotspotAndActivity(page);
    } catch (e) {
      console.warn('[dy] hotspot/activity note:', String(e?.message || e).slice(0, 120));
    }
  }

  if (schedule) {
    try {
      console.log(`[dy] 设置定时发布: ${schedule.dateTimeStr}`);
      const clickedRadio = await page.evaluate(() => {
        const hit = Array.from(document.querySelectorAll('label, div, span')).find((el) =>
          (el.innerText || '').trim() === '定时发布',
        );
        if (!hit) return false;
        const target = hit.closest('label, [class*="radio"]') || hit;
        target.scrollIntoView({ block: 'center' });
        target.click();
        return true;
      });
      if (clickedRadio) {
        await humanPause(600, 1000, '选择定时发布单选', 'dy');
        const setRes = await page.evaluate((targetTime) => {
          const inp = document.querySelector('input[placeholder="日期和时间"], input[placeholder*="日期"]');
          if (!inp) return { found: false };
          inp.focus();
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(inp, targetTime);
          else inp.value = targetTime;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
          inp.blur();
          return { found: true, val: inp.value };
        }, schedule.dateTimeStr);
        console.log('[dy] 定时发布设置结果:', JSON.stringify(setRes));
        await humanPause(600, 1000, '完成定时发布输入', 'dy');
      } else {
        console.warn('[dy] 未找到「定时发布」单选框');
      }
    } catch (e) {
      console.warn('[dy] 设置定时发布异常:', String(e?.message || e).slice(0, 120));
    }
  }

  // Guard: never click 暂存离开 if video upload unexpectedly failed or is still in progress
  const preSaveHealth = await page.evaluate(() => {
    const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return {
      failed: /上传失败|上传异常|上传中断|转码失败/.test(body),
      uploading: /取消上传|正在上传|上传中/.test(body),
    };
  });
  if (preSaveHealth.failed) {
    throw new Error('DOUYIN_UPLOAD_FAILED_BEFORE_STASH');
  }
  if (preSaveHealth.uploading) {
    console.warn('[dy] 暂存前检测到仍在上传，追加等待完成...');
    for (let k = 0; k < 60; k++) {
      await new Promise((r) => setTimeout(r, 2000));
      const still = await page.evaluate(() => /取消上传|正在上传|上传中/.test(document.body?.innerText || ''));
      if (!still) break;
    }
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await humanPause(1200, 2200, '点暂存离开前', 'dy');
  await safeShot(page, path.join(shotDir, 'douyin_before_draft.png'), { fullPage: true });

  // Click「暂存离开」(never「发布」) so draft persists in /content/upload resume banner.
  const draftClick = await page.evaluate(() => {
    const labels = ['暂存离开', '存草稿', '保存草稿', '保存为草稿'];
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], span, div')).filter(
      (el) => el.offsetWidth > 0 && el.offsetHeight > 0,
    );
    for (const lbl of labels) {
      const hit = nodes
        .filter((el) => (el.innerText || '').replace(/\s+/g, '').trim() === lbl)
        .sort((a, b) => a.childElementCount - b.childElementCount)[0];
      if (hit) {
        const target = hit.closest('button, [role="button"]') || hit;
        target.scrollIntoView({ block: 'center' });
        target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        target.click();
        return { ok: true, label: lbl };
      }
    }
    return { ok: false };
  });
  console.log('暂存离开点击:', JSON.stringify(draftClick));
  if (!draftClick.ok) throw new Error('DOUYIN_NO_STASH_LEAVE_BUTTON');

  await humanPause(2000, 3500, '等待暂存确认', 'dy');
  await page.evaluate(() => {
    const ok = Array.from(
      document.querySelectorAll('[class*="modal"] button, [role="dialog"] button, button'),
    ).find((b) => {
      const t = (b.innerText || '').replace(/\s+/g, '').trim();
      return (t === '确定' || t === '确认' || t === '暂存离开' || t === '保存') && b.offsetWidth > 0;
    });
    ok?.click();
  });

  // Verify redirect to /content/upload showing「你还有上次未发布的视频，是否继续编辑？」
  let draftSaved = false;
  for (let w = 0; w < 15; w++) {
    await new Promise((r) => setTimeout(r, 800));
    const st = await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return {
        url: location.href,
        hasResumeBanner: /上次未发布的视频|继续编辑/.test(body),
      };
    });
    if (st.hasResumeBanner) {
      draftSaved = true;
      break;
    }
    // Still on publish form — keep waiting; only treat upload URL without banner as soft miss after loop.
    if (!st.url.includes('/content/upload') && !st.url.includes('/content/publish')) {
      break;
    }
  }
  await safeShot(page, path.join(shotDir, 'douyin_after_draft.png'));
  console.log(draftSaved ? 'DOUYIN_DRAFT_SAVED' : 'DOUYIN_DRAFT_UNCONFIRMED_CHECK_UPLOAD_BANNER');
  // Always emitted after a successful「暂存离开」click (never「发布」).
  console.log('DOUYIN_STAGED_STOP_BEFORE_PUBLISH');
  console.log('spaceId', task.spaceId);
} finally {
  await task.finish({ keep: job.keepOpen ? [page.label || 'p1'] : [] });
}
