/**
 * B站存草稿（清理残留标签 + 填标签 + 自动选推荐标签/参与话题活动）。
 * job: profileId, video, title, topics[], cover?, hotspot?, activity?, autoHotspot?, shotDir?
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { humanPause, humanMouseClick } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import {
  resolveShotDir,
  safeShot,
  normalizeTopics,
  deriveHotspotKeywords,
  scoreCandidateMatch,
  parseScheduleTime,
} from '../lib/ego_dom.mjs';

function ensureCoverFile(videoFile, explicitCover) {
  if (explicitCover && fs.existsSync(explicitCover.replace(/\//g, path.sep))) {
    return explicitCover;
  }
  const outPath = path.join(os.tmpdir(), 'creator-publish-bili-frame0.jpg');
  const normVideo = videoFile.replace(/\//g, path.sep);
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-hwaccel', 'cuda', '-i', normVideo, '-frames:v', '1', '-q:v', '2', outPath],
      { stdio: 'ignore' },
    );
  } catch {
    try {
      execFileSync(
        'ffmpeg',
        ['-y', '-threads', '4', '-i', normVideo, '-frames:v', '1', '-q:v', '2', outPath],
        { stdio: 'ignore' },
      );
    } catch {
      return null;
    }
  }
  return fs.existsSync(outPath) ? outPath : null;
}

function inferBilibiliPartition(title = '', tags = []) {
  const combined = (title + ' ' + tags.join(' ')).toLowerCase();
  if (
    /汽车|车|特斯拉|比亚迪|蔚来|小鹏|理想|小米su7|召回|车机|续航|底盘|轮胎|轮毂|驾驶|驾考|机油|发动机|变速箱|新能源|电动车|混动|插混|增程|交通|车险|保费|交警/.test(
      combined,
    )
  ) {
    return '汽车';
  }
  if (
    /人工智能|\bai\b|大模型|chatgpt|claude|agent|智能体|提示词|深度学习|算力|gpu|英伟达|transformer|扩散模型/.test(
      combined,
    )
  ) {
    return '人工智能';
  }
  if (/数码|手机|芯片|半导体|显卡|cpu|电脑|平板|硬件|鸿蒙|安卓|ios|苹果|华为|小米/.test(combined)) {
    return '科技数码';
  }
  if (/科普|原理|为什么|揭秘|冷知识|物理|化学|生物|地理|历史|经济|财金|法律|常识|机制/.test(combined)) {
    return '知识';
  }
  return '知识';
}

const { job } = loadJob();
const videoPath = abs(job.video);
const coverPath = job.cover ? abs(job.cover) : null;
const title = job.title;
const autoHotspot = job.autoHotspot !== false;
const allTags = normalizeTopics(job.topics);
// Use up to 10 explicit tags directly; if < 10 and autoHotspot is on, recommended tags top up remaining slots to 10.
const tags = allTags.slice(0, 10);
const hotspotKeywords = deriveHotspotKeywords(job);
const shotDir = resolveShotDir(job);
const schedule = parseScheduleTime(job.scheduleTime);
if (!videoPath || !title) throw new Error('job 需要 video + title');

async function clearExistingTags(page) {
  for (let i = 0; i < 15; i++) {
    const removed = await page.evaluate(() => {
      const first = document.querySelector('.label-item-v2-container');
      if (!first) return false;
      const closeBtn = first.querySelector('.icon-close, [class*="close"], svg, i') || first;
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      closeBtn.click?.();
      return true;
    });
    if (!removed) break;
    await humanPause(150, 280);
  }
}

async function addBilibiliRecommendedTags(page) {
  const info = await page.evaluate(() => {
    const existing = Array.from(document.querySelectorAll('.label-item-v2-container'))
      .map((el) => (el.innerText || '').replace(/[×x]/g, '').trim())
      .filter(Boolean);
    const bodyText = document.body?.innerText || '';
    const m = bodyText.match(/还可以添加\s*(\d+)\s*个标签/);
    const remain = m ? Number(m[1]) : Math.max(0, 10 - existing.length);

    const recLbl = Array.from(document.querySelectorAll('div, span, p')).find(
      (el) => el.childElementCount === 0 && /^推荐标签[:：]?$/.test((el.innerText || '').trim()),
    );
    if (!recLbl) return { existing, remain: 0, pills: [] };
    const row = recLbl.parentElement;
    const pills = Array.from(row.querySelectorAll('div, span, button'))
      .filter((el) => {
        if (el === recLbl || el.childElementCount > 1) return false;
        if (el.closest('.label-item-v2-container, [class*="activity"], [class*="topic"]')) return false;
        const r = el.getBoundingClientRect();
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        const cls = `${el.className || ''} ${el.parentElement?.className || ''}`;
        const bg = getComputedStyle(el).backgroundColor;
        const pbg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : '';
        if (r.width <= 16 || r.height <= 16 || r.height > 44) return false;
        if (/active|checked|selected|disabled|curr/i.test(cls)) return false;
        if (
          bg === 'rgb(0, 161, 214)' ||
          bg === 'rgb(0, 174, 236)' ||
          pbg === 'rgb(0, 161, 214)' ||
          pbg === 'rgb(0, 174, 236)'
        ) {
          return false;
        }
        return t && t.length <= 16 && !/^推荐标签/.test(t);
      })
      .sort((a, b) => a.childElementCount - b.childElementCount);
    const seenText = new Set();
    const uniquePills = [];
    for (const p of pills) {
      const t = (p.innerText || '').replace(/\s+/g, ' ').trim();
      const key = t.toLowerCase();
      if (seenText.has(key)) continue;
      seenText.add(key);
      const r = p.getBoundingClientRect();
      uniquePills.push({ text: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    return {
      existing,
      remain,
      pills: uniquePills.slice(0, 20),
    };
  });

  if (!info.remain || !info.pills.length) return;

  const existingSet = new Set(info.existing.map((t) => t.toLowerCase()));
  const ranked = info.pills
    .filter((p) => !existingSet.has(p.text.toLowerCase()))
    .map((p, idx) => ({
      ...p,
      idx,
      score: scoreCandidateMatch(p.text, hotspotKeywords, { includeGeneralHints: true }),
    }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const picked = [];
  const pickedSet = new Set();
  const limit = info.remain;
  for (const pill of ranked) {
    if (picked.length >= limit) break;
    const key = pill.text.toLowerCase();
    if (pickedSet.has(key)) continue;
    pickedSet.add(key);
    await humanMouseClick(page, pill.x, pill.y, { radius: 3, tag: 'bili' });
    picked.push(pill.text);
    await humanPause(300, 550);
  }
  if (picked.length) {
    console.log('BILIBILI_RECOMMENDED_TAGS_ADDED:', picked.join(', '));
  }
}

async function readVisibleTopicPills(page) {
  return page.evaluate(() => {
    const lbl = Array.from(document.querySelectorAll('div, span, p, label')).find(
      (el) => el.childElementCount === 0 && /^参与话题[:：]?$/.test((el.innerText || '').trim()),
    );
    if (!lbl) return { found: false, pills: [], searchMore: null };
    lbl.scrollIntoView({ block: 'center' });
    let row = lbl.parentElement;
    for (let d = 0; d < 2 && row; d++) {
      const more = Array.from(row.querySelectorAll('a, span, div, button')).find(
        (el) => /搜索更多话题/.test((el.innerText || '').trim()) && el.offsetWidth > 0,
      );
      const nodes = Array.from(row.querySelectorAll('div, span, button')).filter((el) => {
        if (el === lbl || el === more) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 30 || r.height <= 18 || r.height > 48) return false;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t || /^参与话题/.test(t) || /搜索更多话题/.test(t)) return false;
        // Prefer the topic pill container itself (has child spans `#` + name + optional `活动`, OR leaf text starting with `#`)
        const cls = String(el.className || '');
        return el.childElementCount <= 4 && (/topic|tag|pill|item/.test(cls) || t.startsWith('#'));
      });
      // Deduplicate nested containers by picking smallest parent or non-overlapping centers
      const pills = [];
      const seenText = new Set();
      for (const el of nodes) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (seenText.has(t)) continue;
        // Skip wrapper divs that contain multiple `#` pills
        if ((t.match(/#/g) || []).length > 1) continue;
        seenText.add(t);
        const r = el.getBoundingClientRect();
        const cls = String(el.className || '');
        pills.push({
          text: t,
          selected: /active|checked|selected/.test(cls),
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        });
      }
      if (pills.length || more) {
        const mr = more ? more.getBoundingClientRect() : null;
        return {
          found: true,
          pills: pills.slice(0, 15),
          searchMore: mr && mr.width > 0 ? { x: mr.left + mr.width / 2, y: mr.top + mr.height / 2 } : null,
        };
      }
      row = row.parentElement;
    }
    return { found: true, pills: [], searchMore: null };
  });
}

async function associateBilibiliActivityTopic(page) {
  const initial = await readVisibleTopicPills(page);
  if (!initial.found) {
    console.log('[bili] 参与话题 section not found on form');
    return;
  }
  if (initial.pills.some((p) => p.selected)) {
    console.log('BILIBILI_ACTIVITY_TOPIC_ASSOCIATED: already selected');
    return;
  }

  // 1) Direct specific match among visible 参与话题 pills
  const directMatch = initial.pills
    .map((p, idx) => ({ ...p, idx, score: scoreCandidateMatch(p.text, hotspotKeywords) }))
    .filter((p) => p.score >= 500)
    .sort((a, b) => b.score - a.score)[0];
  if (directMatch) {
    await humanMouseClick(page, directMatch.x, directMatch.y, { radius: 3, tag: 'bili' });
    console.log('BILIBILI_ACTIVITY_TOPIC_ASSOCIATED:', directMatch.text);
    await humanPause(400, 700);
    return;
  }

  // 2) Try「搜索更多话题」modal for exact/related topic
  let selectedViaSearch = false;
  if (initial.searchMore) {
    await humanMouseClick(page, initial.searchMore.x, initial.searchMore.y, { radius: 3, tag: 'bili' });
    await humanPause(900, 1400, '打开搜索更多话题', 'bili');

    for (const kw of hotspotKeywords.slice(0, 3)) {
      const inpBox = await page.evaluate(() => {
        const inp = Array.from(
          document.querySelectorAll(
            'input:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"])',
          ),
        ).find((el) => {
          const r = el.getBoundingClientRect();
          const ph = el.getAttribute('placeholder') || '';
          return (
            r.width > 50 &&
            r.height > 14 &&
            ph !== '请输入稿件标题' &&
            ph !== '按回车键Enter创建标签' &&
            (/话题|搜索|查找/.test(ph) ||
              el.closest('.bcc-dialog, [class*="modal"], [class*="topic"], [class*="popover"], [class*="dialog"]'))
          );
        });
        if (!inp) return null;
        const r = inp.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (!inpBox) break;

      await humanMouseClick(page, inpBox.x, inpBox.y, { radius: 2, tag: 'bili' });
      await humanPause(200, 350);
      await page.keyboard.press('Control+a');
      await humanPause(100, 200);
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(kw);
      await humanPause(1100, 1600, `搜索B站话题 ${kw}`, 'bili');

      const searchItems = await page.evaluate(() => {
        const dialog = document.querySelector('.bcc-dialog, [class*="topic"][class*="dialog"], [class*="topic"][class*="modal"], [class*="popover"]');
        const scope = dialog || document;
        const nodes = Array.from(scope.querySelectorAll('li, [class*="topic-item"], [class*="search-item"], [class*="item"]')).filter((el) => {
          const r = el.getBoundingClientRect();
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          return (
            r.width > 60 &&
            r.height >= 20 &&
            r.height <= 90 &&
            t &&
            t.length <= 80 &&
            !/暂无|没有找到|搜索更多|请输入|取消|确定/.test(t)
          );
        });
        const seen = new Set();
        const out = [];
        for (const el of nodes) {
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (seen.has(t)) continue;
          seen.add(t);
          const r = el.getBoundingClientRect();
          out.push({ text: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }
        return out.slice(0, 15);
      });

      if (searchItems.length) {
        const ranked = searchItems
          .map((it) => ({ ...it, score: scoreCandidateMatch(it.text, hotspotKeywords, { includeGeneralHints: true }) }))
          .filter((it) => it.score >= 100)
          .sort((a, b) => b.score - a.score);
        if (ranked[0]) {
          await humanMouseClick(page, ranked[0].x, ranked[0].y, { radius: 3, tag: 'bili' });
          await humanPause(500, 800);
          // Click dialog primary confirm button if modal stays open
          await page.evaluate(() => {
            const dlg = document.querySelector('.bcc-dialog, [class*="topic"][class*="dialog"], [class*="modal"]');
            const ok = Array.from(dlg?.querySelectorAll('button, [role="button"]') || []).find((b) =>
              /^(确定|确认|选择|完成)$/.test((b.innerText || '').replace(/\s+/g, '').trim()),
            );
            ok?.click();
          });
          selectedViaSearch = true;
          console.log('BILIBILI_ACTIVITY_TOPIC_ASSOCIATED:', `${ranked[0].text} (search:${kw})`);
          await humanPause(500, 800);
          break;
        }
      }
    }

    if (!selectedViaSearch) {
      // Close topic search modal cleanly before falling back to visible pills
      await page.evaluate(() => {
        const closeBtn = document.querySelector('.bcc-dialog__close, [class*="topic"] [class*="close"], .bcc-dialog .icon-close');
        closeBtn?.click();
      });
      await page.keyboard.press('Escape');
      await humanPause(500, 800);
    }
  }

  // 3) Fallback: click best-scoring visible 参与话题 (活动) pill only when relevant or explicit
  if (!selectedViaSearch && initial.pills.length) {
    const explicitActivity = Boolean(job.activity && String(job.activity).trim());
    const rankedVisible = initial.pills
      .map((p, idx) => ({
        ...p,
        idx,
        score: scoreCandidateMatch(p.text, hotspotKeywords, { includeGeneralHints: true }),
      }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx);
    const pick = rankedVisible[0];
    if (pick && (pick.score >= 100 || explicitActivity)) {
      await humanMouseClick(page, pick.x, pick.y, { radius: 3, tag: 'bili' });
      console.log('BILIBILI_ACTIVITY_TOPIC_ASSOCIATED:', pick.text);
      await humanPause(400, 700);
    } else {
      console.log('[bili] 参与话题 无相关候选，跳过无关活动');
    }
  }
}

const task = await taskSpace('cp-bili-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

try {
  await page
    .goto('https://member.bilibili.com/platform/upload/video/frame', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    .catch((e) => console.warn('goto note', e.message?.slice(0, 120)));
  await humanPause(3000, 5500, '上传页加载', 'bili');

  const curUrl = await page.url();
  console.log('Bilibili URL:', curUrl);
  if (curUrl.includes('login') || curUrl.includes('passport')) {
    console.log('NEED_LOGIN_BILIBILI');
    throw new Error('NEED_LOGIN_BILIBILI');
  }

  let formReady = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      console.warn('[bili] 上传后未出现表单，刷新上传页重试一次...');
      await page.goto('https://member.bilibili.com/platform/upload/video/frame', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await humanPause(3000, 5000, '重试上传页加载', 'bili');
    }

    let inputFound = false;
    for (let i = 0; i < 30; i++) {
      inputFound = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(
          (inp) => (inp.accept || '').includes('.mp4') || (inp.accept || '').includes('video'),
        );
        if (inputs[0]) {
          inputs[0].id = 'bili-video-upload-target';
          return true;
        }
        return false;
      });
      if (inputFound) break;
      await humanPause(800, 1200);
    }
    if (!inputFound) continue;

    await humanPause(1200, 2200, '选视频前', 'bili');
    await page.setInputFiles('#bili-video-upload-target', videoPath);

    let waited = 0;
    let noFormTicks = 0;
    const uploadTimeoutMs = Number(process.env.BILIBILI_UPLOAD_TIMEOUT_MS || 480_000);
    while (waited < uploadTimeoutMs) {
      const st = await page.evaluate(() => {
        const titleInp = document.querySelector('input[placeholder="请输入稿件标题"]');
        const body = document.body?.innerText || '';
        const uploading = /上传中|转码中|处理中/.test(body);
        return { hasForm: !!titleInp, uploading };
      });
      console.log('upload wait', waited, st);
      if (st.hasForm && !st.uploading) {
        formReady = true;
        break;
      }
      if (!st.hasForm && !st.uploading) {
        noFormTicks++;
        if (noFormTicks >= 12) break;
      } else {
        noFormTicks = 0;
      }
      await humanPause(1500, 2200);
      waited += 2000;
    }
    if (formReady) break;
  }
  if (!formReady) throw new Error('BILIBILI_UPLOAD_FORM_NOT_LOADED');
  await humanPause(4000, 7000, '表单就绪', 'bili');

  await page.evaluate((t) => {
    const inp = document.querySelector('input[placeholder="请输入稿件标题"]');
    if (!inp) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(inp, t);
    else inp.value = t;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }, title);
  await humanPause(1000, 1800, '标题后', 'bili');

  await page.evaluate(() => {
    const desc = document.querySelector('.ql-editor');
    if (desc) desc.innerHTML = '';
  });

  // 分区选择（若 job 指定了 partition/category，或根据标题/标签智能推断，杜绝无干预时平台默认记忆残留的分区）
  const explicitPartition = job.partition || job.category;
  const targetPartition = explicitPartition || inferBilibiliPartition(title, allTags);
  console.log(`[bili] 目标分区: ${targetPartition} (显式指定: ${explicitPartition ? '是' : '否，智能推断'})`);

  try {
    const partRes = await page.evaluate(async (target) => {
      const vht = document.querySelector('.video-human-type');
      if (!vht) return { ok: false, reason: 'no .video-human-type' };

      const currentText = vht.querySelector('.select-controller')?.innerText.trim() || '';
      if (currentText.includes(target)) {
        return { ok: true, already: true, currentText };
      }

      const selectCtrl = vht.querySelector('.select-controller');
      if (!selectCtrl) return { ok: false, reason: 'no select-controller' };

      selectCtrl.scrollIntoView({ block: 'center' });
      selectCtrl.click();
      await new Promise((r) => setTimeout(r, 600));

      const items = Array.from(document.querySelectorAll('.video-human-type .drop-list-v2-item'));
      const hit = items.find((el) => {
        const titleAttr = (el.getAttribute('title') || '').trim();
        const text = (el.innerText || '').trim();
        return titleAttr === target || text.includes(target);
      });

      if (!hit) {
        return {
          ok: false,
          reason: 'partition item not found',
          target,
          available: items.map((i) => i.getAttribute('title') || i.innerText.trim()).slice(0, 15),
        };
      }

      hit.scrollIntoView({ block: 'center' });
      hit.click();
      await new Promise((r) => setTimeout(r, 600));

      const afterText = vht.querySelector('.select-controller')?.innerText.trim() || '';
      return { ok: true, before: currentText, after: afterText };
    }, targetPartition);

    console.log('[bili] 分区选择结果:', JSON.stringify(partRes));
    await humanPause(600, 1000, '选择分区后', 'bili');
  } catch (e) {
    console.warn('[bili] 分区选择 note:', String(e?.message || e).slice(0, 100));
  }

  await clearExistingTags(page);

  // Associate activity topic FIRST if autoHotspot is on, because Bilibili's 参与话题 occupies 1 of the 10 tag slots.
  if (autoHotspot) {
    try {
      await associateBilibiliActivityTopic(page);
    } catch (e) {
      console.warn('[bili] 参与话题 note:', String(e?.message || e).slice(0, 120));
    }
  }

  for (const tag of tags) {
    const curState = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.label-item-v2-container'))
        .map((el) => (el.innerText || '').replace(/[×x]/g, '').trim())
        .filter(Boolean);
      const inp = document.querySelector('input[placeholder="按回车键Enter创建标签"]');
      if (!inp) return { count: chips.length, chips, box: null, hasVal: false };
      inp.scrollIntoView({ block: 'center' });
      const r = inp.getBoundingClientRect();
      return {
        count: chips.length,
        chips,
        hasVal: (inp.value || '').length > 0,
        box: r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
      };
    });
    if (curState.count >= 10) break;
    if (curState.chips.some((c) => c.toLowerCase() === tag.trim().toLowerCase())) continue;

    if (curState.box) {
      await humanMouseClick(page, curState.box.x, curState.box.y, { radius: 3, tag: 'bili' });
      await humanPause(150, 260);
    } else {
      await page.evaluate(() => {
        document.querySelector('input[placeholder="按回车键Enter创建标签"]')?.focus();
      });
    }
    // IMPORTANT: Never press Backspace when tag input is empty — Bilibili deletes the previous tag chip on empty Backspace!
    if (curState.hasVal) {
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await humanPause(100, 180);
    }
    await page.keyboard.insertText(tag);
    await humanPause(250, 420);
    await page.keyboard.press('Enter');
    await humanPause(550, 850, `标签 ${tag}`, 'bili');

    const added = await page.evaluate((t) => {
      const target = t.trim().toLowerCase();
      return Array.from(document.querySelectorAll('.label-item-v2-container')).some((el) =>
        (el.innerText || '').replace(/[×x\s]/g, '').trim().toLowerCase().includes(target),
      );
    }, tag);

    if (!added) {
      await page.evaluate((t) => {
        const inp = document.querySelector('input[placeholder="按回车键Enter创建标签"]');
        if (!inp) return;
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, t);
        else inp.value = t;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }, tag);
      await humanPause(200, 320);
      await page.keyboard.press('Enter');
      await humanPause(550, 850, `标签重试 ${tag}`, 'bili');
    }
  }

  const effectiveCover = ensureCoverFile(videoPath, coverPath);
  if (effectiveCover && fs.existsSync(effectiveCover.replace(/\//g, path.sep))) {
    try {
      await page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('div, span, button, a, label'));
        const leaf = nodes.find(
          (el) =>
            el.childElementCount === 0 &&
            /^\+?\s*添加封面$|^更改封面$|^封面设置$|^上传封面$/.test(
              (el.innerText || '').replace(/\s+/g, ' ').trim(),
            ) &&
            el.getBoundingClientRect().width > 0,
        );
        const box =
          leaf ||
          document.querySelector('.cover-upload, [class*="cover-upload"], [class*="cover-select"]');
        box?.scrollIntoView({ block: 'center' });
        box?.click();
      });
      await humanPause(1200, 2200);
      const clickedUploadTab = await page.evaluate(() => {
        const modals = Array.from(
          document.querySelectorAll('.bcc-dialog, [class*="dialog"], [class*="modal"], [role="dialog"]'),
        ).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 300 && r.height > 200 && /封面制作|上传封面/.test(el.innerText || '');
        });
        const modal = modals[modals.length - 1];
        if (!modal) return false;
        const tab = Array.from(modal.querySelectorAll('div, span, button, a')).find(
          (el) =>
            el.childElementCount <= 1 &&
            /^上传封面$/.test((el.innerText || '').replace(/\s+/g, '').trim()) &&
            el.getBoundingClientRect().width > 0,
        );
        if (tab) {
          tab.click();
          return true;
        }
        return false;
      });
      if (clickedUploadTab) {
        await humanPause(600, 1000);
      }
      const coverInputReady = await page.evaluate(() => {
        const modals = Array.from(
          document.querySelectorAll('.bcc-dialog, [class*="dialog"], [class*="modal"], [role="dialog"]'),
        ).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 300 && r.height > 200 && /封面制作|上传封面/.test(el.innerText || '');
        });
        const dialog = modals[modals.length - 1];
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((inp) =>
          /(image|png|jpg|jpeg|webp)/i.test(inp.accept || ''),
        );
        const inp = dialog?.querySelector('input[type="file"]') || inputs[inputs.length - 1] || inputs[0];
        if (!inp) return false;
        inp.id = 'bili-cover-upload-target';
        return true;
      });
      if (coverInputReady) {
        await page.setInputFiles('#bili-cover-upload-target', effectiveCover);
        await humanPause(2500, 4000, '封面上传', 'bili');

        const confirmBtn = await page.evaluate(() => {
          const modals = Array.from(
            document.querySelectorAll('.bcc-dialog, [class*="dialog"], [class*="modal"], [role="dialog"]'),
          ).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 300 && r.height > 200 && /封面制作/.test(el.innerText || '');
          });
          const modal = modals[modals.length - 1] || document;
          const btns = Array.from(modal.querySelectorAll('button, [role="button"], span, div')).filter((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 20 && r.height > 16;
          });
          const okBtn =
            btns.find((b) => /^(完成|确定|确认|保存)$/.test((b.innerText || '').replace(/\s+/g, '').trim())) ||
            modal.querySelector('button.bcc-button--primary, [class*="primary"][class*="btn"]');
          if (!okBtn) return null;
          okBtn.scrollIntoView({ block: 'center' });
          const clickable = okBtn.closest('button, [role="button"]') || okBtn;
          clickable.click();
          const r = clickable.getBoundingClientRect();
          return {
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
            text: (clickable.innerText || '').replace(/\s+/g, '').trim(),
          };
        });

        await humanPause(500, 650);
        const stillOpenAfterDomClick = await page.evaluate(() =>
          Array.from(
            document.querySelectorAll('.bcc-dialog, [class*="dialog"], [class*="modal"], [role="dialog"]'),
          ).some((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 300 && r.height > 200 && /封面制作/.test(el.innerText || '');
          }),
        );
        if (stillOpenAfterDomClick && confirmBtn && confirmBtn.x > 0 && confirmBtn.y > 0) {
          await humanMouseClick(page, confirmBtn.x, confirmBtn.y, { radius: 3, tag: 'bili' });
        }
        await humanPause(1800, 2800, '封面确认', 'bili');

        const stuckOpen = await page.evaluate(() => {
          const modals = Array.from(
            document.querySelectorAll('.bcc-dialog, [class*="dialog"], [class*="modal"], [role="dialog"]'),
          ).filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 300 && r.height > 200 && /封面制作/.test(el.innerText || '');
          });
          const modal = modals[modals.length - 1];
          if (!modal) return false;
          const closeBtn = modal.querySelector('.bcc-dialog__close, [class*="close"], .icon-close');
          closeBtn?.click();
          return true;
        });
        if (stuckOpen) {
          await page.keyboard.press('Escape');
          await humanPause(550, 750);
        }
      }
    } catch (e) {
      console.log('cover optional fail', String(e));
    }
  }

  if (autoHotspot) {
    try {
      await addBilibiliRecommendedTags(page);
    } catch (e) {
      console.warn('[bili] 推荐标签 note:', String(e?.message || e).slice(0, 120));
    }
  }

  const finalTags = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.label-item-v2-container'))
      .map((el) => (el.innerText || '').replace(/[×x]/g, '').trim())
      .filter(Boolean),
  );
  console.log(`BILIBILI_FINAL_TAGS: ${finalTags.length}/10`, JSON.stringify(finalTags));

  if (schedule) {
    try {
      console.log(`[bili] 设置定时发布: ${schedule.dateTimeStr}`);
      const switchRes = await page.evaluate(() => {
        const sw = document.querySelector('.time-container .switch-container');
        if (!sw) return { ok: false, reason: 'no switch' };
        sw.scrollIntoView({ block: 'center' });
        const isActive = /\b(on|active|checked)\b/.test(sw.className) || sw.className.includes('switch-container-active');
        if (!isActive) sw.click();
        return { ok: true, wasActive: isActive };
      });
      console.log('[bili] 定时开关:', JSON.stringify(switchRes));
      await humanPause(800, 1400, '开启定时开关后', 'bili');

      const dateOpen = await page.evaluate(() => {
        const btn = document.querySelector('.date-picker-date');
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      });
      if (dateOpen) {
        await humanPause(600, 1000, '打开日期面板', 'bili');
        const dayRes = await page.evaluate((targetDay) => {
          const cells = Array.from(document.querySelectorAll('.date-picker-container .date-wrp > div, .date-picker-container .date-wrp span, .date-picker-container [class*="date-item"], .date-picker-container li'));
          const hit = cells.find(c => (c.innerText || '').trim() === String(targetDay) && !c.className.includes('disabled') && !c.className.includes('prev') && !c.className.includes('next'));
          if (hit) {
            hit.click();
            return { ok: true, text: hit.innerText.trim() };
          }
          const hit2 = Array.from(document.querySelectorAll('.date-picker-container *')).find(c => c.children.length === 0 && (c.innerText || '').trim() === String(targetDay) && !c.className.includes('disabled'));
          if (hit2) {
            hit2.click();
            return { ok: true, fallback: true, text: hit2.innerText.trim() };
          }
          return { ok: false };
        }, schedule.day);
        console.log('[bili] 选择日期结果:', JSON.stringify(dayRes));
        await humanPause(600, 1000, '选定日期后', 'bili');
      }

      const timeOpen = await page.evaluate(() => {
        const btn = document.querySelector('.date-picker-timer');
        if (!btn) return false;
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      });
      if (timeOpen) {
        await humanPause(600, 1000, '打开时间面板', 'bili');
        const timeRes = await page.evaluate((targetHour, targetMin) => {
          const cols = Array.from(document.querySelectorAll('.time-picker-panel-select-wrp, .time-picker-body-wrp ul, .time-picker-body-wrp > div'));
          const hourCol = cols[0];
          const minCol = cols[1];
          let hourHit = null;
          let minHit = null;
          if (hourCol) {
            const hours = Array.from(hourCol.querySelectorAll('li, div, span')).filter(el => (el.innerText || '').trim() === String(targetHour) || (el.innerText || '').trim() === String(targetHour).padStart(2, '0'));
            hourHit = hours[0];
            hourHit?.click();
          }
          if (minCol) {
            const mins = Array.from(minCol.querySelectorAll('li, div, span')).filter(el => (el.innerText || '').trim() === String(targetMin) || (el.innerText || '').trim() === String(targetMin).padStart(2, '0'));
            minHit = mins[0];
            minHit?.click();
          }
          return {
            hourOk: !!hourHit,
            minOk: !!minHit,
            hourText: hourHit?.innerText?.trim(),
            minText: minHit?.innerText?.trim()
          };
        }, schedule.hour, schedule.minute);
        console.log('[bili] 选择时间结果:', JSON.stringify(timeRes));
        await humanPause(600, 1000, '选定时间后', 'bili');
      }

      await page.evaluate(() => {
        const titleInp = document.querySelector('input[placeholder="请输入稿件标题"]');
        titleInp?.scrollIntoView({ block: 'center' });
        titleInp?.click();
      });
      await humanPause(500, 800, '关闭时间下拉', 'bili');
    } catch (e) {
      console.warn('[bili] 设置定时发布异常:', String(e?.message || e).slice(0, 120));
    }
  }

  await safeShot(page, `${shotDir}/bili_before_draft.png`, { fullPage: true });
  await humanPause(2500, 4500, '点存草稿前', 'bili');
  const clickedDraft = await page.evaluate(() => {
    const labels = new Set(['存草稿', '保存草稿', '保存为草稿']);
    const compact = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
    // Prefer the smallest leaf whose compact text is exactly a draft label
    // (avoid parent nodes that also contain「立即投稿」).
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"], a, span'),
    ).filter((el) => labels.has(compact(el)));
    candidates.sort((a, b) => compact(a).length - compact(b).length || a.childElementCount - b.childElementCount);
    const hit = candidates[0];
    if (!hit) {
      const sample = Array.from(document.querySelectorAll('button, [role="button"], span'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => /草稿|保存|投稿/.test(t))
        .slice(0, 10);
      return { ok: false, reason: 'no draft button', sample };
    }
    const clickable =
      labels.has(compact(hit)) && hit.matches('button, [role="button"], a')
        ? hit
        : hit.closest('button, [role="button"], a') || hit;
    // If closest button also contains 立即投稿, click the leaf instead.
    const target =
      /立即投稿/.test(compact(clickable)) && !labels.has(compact(clickable)) ? hit : clickable;
    target.scrollIntoView({ block: 'center' });
    target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    target.click();
    return { ok: true, text: compact(target).slice(0, 40) };
  });
  console.log('存草稿点击:', JSON.stringify(clickedDraft));
  await humanPause(2000, 3500);
  await page.evaluate(() => {
    const ok = Array.from(document.querySelectorAll('button, [role="button"], span')).find((b) => {
      const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
      return t === '确定' || t === '确认' || t === '知道了';
    });
    ok?.click();
  });

  let saved = false;
  for (let w = 0; w < 25; w++) {
    await humanPause(800, 1400);
    const state = await page.evaluate((expectTitle) => {
      const nodes = Array.from(
        document.querySelectorAll(
          '[class*="toast"], [class*="message"], .bcc-snackbar, .bcc-message, .bcc-notification, .success',
        ),
      );
      const toast = nodes.map((t) => t.innerText?.trim()).filter(Boolean).join(' | ');
      const href = location.href || '';
      const body = (document.body?.innerText || '').slice(0, 4000);
      const onDraftManager =
        /稿件管理|\/platform\/upload-manager|\/platform\/article|草稿/.test(href + body) &&
        (/草稿\s*\d/.test(body) || body.includes('草稿箱'));
      const titleInList = expectTitle && body.includes(expectTitle);
      return { toast, href, onDraftManager, titleInList };
    }, title);
    if (/草稿.*成功|保存成功|已保存|成功保存/.test(state.toast || '')) {
      saved = true;
      console.log('BILIBILI_DRAFT_SAVED', state.toast.slice(0, 200));
      break;
    }
    if (state.onDraftManager && state.titleInList) {
      saved = true;
      console.log('BILIBILI_DRAFT_SAVED via draft list', state.href);
      break;
    }
  }
  await safeShot(page, `${shotDir}/bili_after_draft.png`);
  console.log(saved ? 'BILIBILI_DRAFT_DONE' : 'BILIBILI_DRAFT_UNCONFIRMED_CHECK_MANAGER');
  console.log('spaceId', task.spaceId);
} finally {
  await task.finish({ keep: [] });
}
