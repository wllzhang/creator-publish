/**
 * B站存草稿。job: profileId, video, title, topics[], cover?, shotDir?
 */
import fs from 'fs';
import path from 'path';
import { humanPause } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import { resolveShotDir, safeShot, normalizeTopics } from '../lib/ego_dom.mjs';

const { job } = loadJob();
const videoPath = abs(job.video);
const coverPath = job.cover ? abs(job.cover) : null;
const title = job.title;
const tags = normalizeTopics(job.topics);
const shotDir = resolveShotDir(job);
if (!videoPath || !title) throw new Error('job 需要 video + title');

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
    await humanPause(500, 1000, `标签 ${tag}`, 'bili');
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
      }
    } catch (e) {
      console.log('cover optional fail', String(e));
    }
  }

  await safeShot(page, `${shotDir}/bili_before_draft.png`);
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
