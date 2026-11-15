/**
 * B站存草稿（清理残留标签 + 填标签 + 自动选推荐标签/参与话题活动）。
 * job: profileId, video, title, topics[], cover?, hotspot?, activity?, autoHotspot?, shotDir?
 */
import fs from 'fs';
import path from 'path';
import { humanPause, humanMouseClick } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import {
  resolveShotDir,
  safeShot,
  normalizeTopics,
  deriveHotspotKeywords,
  scoreCandidateMatch,
} from '../lib/ego_dom.mjs';

const { job } = loadJob();
const videoPath = abs(job.video);
const coverPath = job.cover ? abs(job.cover) : null;
const title = job.title;
const autoHotspot = job.autoHotspot !== false;
const allTags = normalizeTopics(job.topics);
// Leave 2 slots when autoHotspot is on so B站 live 推荐标签 can fill in.
const tags = autoHotspot && allTags.length > 8 ? allTags.slice(0, 8) : allTags.slice(0, 10);
const hotspotKeywords = deriveHotspotKeywords(job);
const shotDir = resolveShotDir(job);
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
    const row = recLbl?.parentElement || document;
    const pills = Array.from(row.querySelectorAll('div, span, button')).filter((el) => {
      if (el === recLbl || el.childElementCount > 1) return false;
      if (el.closest('.label-item-v2-container, [class*="activity"], [class*="topic"]')) return false;
      const r = el.getBoundingClientRect();
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const cls = String(el.className || '');
      if (r.width <= 16 || r.height <= 16 || r.height > 44) return false;
      if (/active|checked|selected|disabled/.test(cls)) return false;
      return t && t.length <= 16 && !/^推荐标签/.test(t);
    });
    return {
      existing,
      remain,
      pills: pills.slice(0, 20).map((p) => {
        const r = p.getBoundingClientRect();
        return { text: (p.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }),
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
  const limit = Math.min(info.remain, 3);
  for (const pill of ranked) {
    if (picked.length >= limit) break;
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
        const inp = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).find((el) => {
          const r = el.getBoundingClientRect();
          const ph = el.getAttribute('placeholder') || '';
          return (
            r.width > 80 &&
            r.height > 16 &&
            ph !== '请输入稿件标题' &&
            ph !== '按回车键Enter创建标签' &&
            (/话题|搜索|查找/.test(ph) || el.closest('.bcc-dialog, [class*="modal"], [class*="topic"], [class*="popover"]'))
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

  // 3) Fallback: click best-scoring visible 参与话题 (活动) pill
  if (!selectedViaSearch && initial.pills.length) {
    const rankedVisible = initial.pills
      .map((p, idx) => ({
        ...p,
        idx,
        score: scoreCandidateMatch(p.text, hotspotKeywords, { includeGeneralHints: true }),
      }))
      .sort((a, b) => b.score - a.score || a.idx - b.idx);
    const pick = rankedVisible[0];
    if (pick) {
      await humanMouseClick(page, pick.x, pick.y, { radius: 3, tag: 'bili' });
      console.log('BILIBILI_ACTIVITY_TOPIC_ASSOCIATED:', pick.text);
      await humanPause(400, 700);
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

  for (let i = 0; i < 30; i++) {
    const ok = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(
        (inp) => (inp.accept || '').includes('.mp4') || (inp.accept || '').includes('video'),
      );
      if (inputs[0]) {
        inputs[0].id = 'bili-video-upload-target';
        return true;
      }
      return false;
    });
    if (ok) break;
    await humanPause(800, 1200);
  }

  await humanPause(1200, 2200, '选视频前', 'bili');
  await page.setInputFiles('#bili-video-upload-target', videoPath);

  let waited = 0;
  while (waited < 180000) {
    const st = await page.evaluate(() => {
      const titleInp = document.querySelector('input[placeholder="请输入稿件标题"]');
      const body = document.body?.innerText || '';
      const uploading = /上传中|转码中|处理中/.test(body);
      return { hasForm: !!titleInp, uploading };
    });
    console.log('upload wait', waited, st);
    if (st.hasForm && !st.uploading) break;
    await humanPause(1500, 2200);
    waited += 2000;
  }
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

  await clearExistingTags(page);

  for (const tag of tags) {
    await page.evaluate((t) => {
      const inp = document.querySelector('input[placeholder="按回车键Enter创建标签"]');
      if (!inp) return;
      inp.focus();
      inp.value = t;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, tag);
    await humanPause(250, 500);
    await page.keyboard.press('Enter');
    await humanPause(500, 900, `标签 ${tag}`, 'bili');
  }

  if (coverPath && fs.existsSync(coverPath.replace(/\//g, path.sep))) {
    try {
      await page.evaluate(() => {
        const coverTab = Array.from(document.querySelectorAll('*')).find(
          (el) => el.children.length === 0 && /更改封面|封面设置|上传封面/.test(el.innerText || ''),
        );
        coverTab?.click();
      });
      await humanPause(1200, 2200);
      const coverInputReady = await page.evaluate(() => {
        const dialog = document.querySelector('.bcc-dialog, [class*="cover"]');
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((inp) =>
          (inp.accept || '').includes('image'),
        );
        const inp = dialog?.querySelector('input[type="file"]') || inputs[0];
        if (!inp) return false;
        inp.id = 'bili-cover-upload-target';
        return true;
      });
      if (coverInputReady) {
        await page.setInputFiles('#bili-cover-upload-target', coverPath);
        await humanPause(3000, 5000, '封面上传', 'bili');
        await page.evaluate(() => {
          const dialog = document.querySelector('.bcc-dialog');
          const primary = dialog?.querySelector('button.bcc-button--primary');
          if (primary) primary.click();
        });
        await humanPause(1500, 2500, '封面确认', 'bili');
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
    try {
      await associateBilibiliActivityTopic(page);
    } catch (e) {
      console.warn('[bili] 参与话题 note:', String(e?.message || e).slice(0, 120));
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
