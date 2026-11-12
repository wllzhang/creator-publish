/**
 * 抖音入草稿（填表 + 点「暂存离开」停在发布前）。先 node write_job.mjs，再在 ego 中跑本脚本。
 * job: profileId, video, title, topics[]（最多取前 5 个，避免超出抖音话题上限导致粘连）, body?, shotDir?
 */
import path from 'node:path';
import { humanPause, humanClickSelector, humanInsertText } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import { resolveShotDir, safeShot, normalizeTopics } from '../lib/ego_dom.mjs';

const { job } = loadJob();
const videoPath = abs(job.video);
const title = job.title;
const rawTopics = Array.isArray(job.topics) ? job.topics : [];
const topics = normalizeTopics(rawTopics, { max: 5 });
const bodyText = job.body ? String(job.body).trim() : '';
const shotDir = resolveShotDir(job);

if (!videoPath || !title) throw new Error('job 需要 video + title');
if (rawTopics.length > 5) {
  console.warn(`[dy] 抖音单条最多支持 5 个 #话题，已截断前 5 个: ${topics.join(', ')}`);
}

const task = await taskSpace('cp-douyin-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

try {
  console.log('Navigating Douyin upload...');
  await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'load' });
  await humanPause(2500, 4500, '上传页加载', 'dy');

  const curUrl = await page.url();
  console.log('Douyin URL:', curUrl);
  if (curUrl.includes('login') || curUrl.includes('passport')) {
    console.log('NEED_LOGIN_DOUYIN');
    console.log(await page.snapshot());
    throw new Error('NEED_LOGIN_DOUYIN');
  }

  await humanPause(1200, 2800, '选视频前', 'dy');
  await page.setInputFiles('input[type="file"]', videoPath);

  let waited = 0;
  while (waited < 120000) {
    const url = await page.url();
    if (url.includes('/content/publish') || url.includes('/content/post/video')) {
      console.log('publish page:', url);
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    waited += 1500;
  }

  // Wait for upload completion & title input ready
  let formReady = false;
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const uploading =
        (/上传中|正在上传/.test(body) || /上传\s*\d+\s*%/.test(body)) && !body.includes('重新上传');
      const hasTitle = !!document.querySelector('input[placeholder*="填写作品标题"]');
      return { uploading, hasTitle };
    });
    if (st.hasTitle && !st.uploading) {
      formReady = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!formReady) console.warn('[dy] title input / upload settle not confirmed; continuing');
  await humanPause(3000, 5000, '上传处理', 'dy');

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
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('*')).find(
        (el) => el.children.length === 0 && el.innerText?.trim() === '#添加话题',
      );
      if (btn) btn.click();
    });
    await humanPause(400, 800, '话题输入前', 'dy');
    await page.keyboard.insertText(t);
    await humanPause(1200, 2000, '话题建议', 'dy');
    const clicked = await page.evaluate((kw) => {
      const items = Array.from(
        document.querySelectorAll(
          '.mention-suggest-item-container-TVOZMl > div, .mention-suggest-item-container-TVOZMl *, div[class*="suggest"] *',
        ),
      );
      const match = items.find((el) => {
        const text = (el.innerText || '').trim().replace(/\s+/g, ' ');
        return text === `#${kw}` || text.startsWith(`#${kw} `) || text.startsWith(`#${kw}`);
      });
      if (match) {
        match.click();
        return true;
      }
      return false;
    }, t);
    // Never Enter here — Enter often inserts a newline between tags.
    if (!clicked) {
      await page.keyboard.press('Escape');
      await humanPause(150, 350);
      await page.keyboard.insertText(`#${t}`);
    }
    if (i < topics.length - 1) {
      await page.keyboard.type(' ');
    }
    await humanPause(500, 1000, '话题空格间隔', 'dy');
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await humanPause(1200, 2200, '点暂存离开前', 'dy');
  await safeShot(page, path.join(shotDir, 'douyin_before_draft.png'));

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
  await task.finish({ keep: [] });
}
