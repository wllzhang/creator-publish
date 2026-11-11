/**
 * 视频号：iframe 内上传视频 → 填短标题/描述 → 点「保存草稿」（不点发表）。
 * job: profileId, video, title（短标题）, body（可选）
 */
import path from 'node:path';
import os from 'node:os';
import { humanPause } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';

const { job } = loadJob();
const videoPath = abs(job.video);
const shortTitle = job.title;
const postContent = job.body || job.title || '';
if (!videoPath || !shortTitle) throw new Error('job 需要 video + title');

const shotDir = job.shotDir ? abs(job.shotDir) : path.join(os.tmpdir(), 'creator-publish-shots');
const task = await taskSpace('cp-channels-' + Date.now(), { profileId: job.profileId });
const page = await task.newPage();

async function tagIframeVideoInput() {
  return page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
    if (!doc) return { ok: false, reason: 'no iframe doc' };
    const inp =
      doc.querySelector('input[type="file"][accept*="video"]') ||
      doc.querySelector('input[type="file"]');
    if (!inp) return { ok: false, reason: 'no file input in iframe' };
    inp.id = 'wxch-video-upload-target';
    return { ok: true, accept: inp.accept || '' };
  });
}

async function uploadVideo(fileAbs) {
  const tagged = await tagIframeVideoInput();
  console.log('iframe file input:', JSON.stringify(tagged));
  if (tagged.ok) {
    try {
      await page.setInputFiles('#wxch-video-upload-target', fileAbs);
      return 'setInputFiles#id';
    } catch (e) {
      console.warn('setInputFiles#id failed:', String(e.message || e).slice(0, 120));
    }
  }
  // Fallback: click upload card → file chooser
  const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
  await page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
    const card = Array.from(doc.querySelectorAll('div, section, label')).find((el) =>
      /支持上传|不超过20GB|点击上传|添加视频/.test(el.innerText || ''),
    );
    (card || doc.querySelector('input[type="file"]')?.parentElement)?.click();
  });
  const chooser = await chooserPromise;
  await chooser.setFiles(fileAbs);
  return 'fileChooser';
}

async function waitUploadDone(timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
      const text = (doc.body?.innerText || '').replace(/\s+/g, ' ');
      const videos = doc.querySelectorAll('video').length;
      const uploading = /上传中|处理中|转码中|\d+\s*%/.test(text);
      const ready = videos > 0 || /删除视频|更换视频|编辑封面|封面/.test(text);
      return { videos, uploading, ready, snippet: text.slice(0, 120) };
    });
    console.log('upload wait', st);
    if (st.ready && !st.uploading) return st;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('WEIXIN_CHANNELS_UPLOAD_TIMEOUT');
}

try {
  await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'load' }).catch(() => {});
  await humanPause(3500, 5500, '创建页加载', 'wxch');

  const curUrl = await page.url();
  console.log('Weixin Channels URL:', curUrl);
  if (curUrl.includes('login')) {
    console.log('NEED_LOGIN_WEIXIN_CHANNELS');
    throw new Error('NEED_LOGIN_WEIXIN_CHANNELS');
  }

  await humanPause(1000, 2200, '选视频前', 'wxch');
  const how = await uploadVideo(videoPath);
  console.log('upload via', how);
  await waitUploadDone();
  await humanPause(2000, 4000, '上传完成后', 'wxch');

  await page.evaluate((t) => {
    const iframe = document.querySelector('iframe');
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
    const input = doc.querySelector(
      'input[placeholder="填写短标题有机会获得更多流量"], input[placeholder*="短标题"]',
    );
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, t);
      else input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, shortTitle);
  await humanPause(1000, 2000);

  await page.evaluate((text) => {
    const iframe = document.querySelector('iframe');
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
    const editor = doc.querySelector('.post-desc-box [contenteditable="true"], [contenteditable="true"]');
    if (editor) {
      editor.focus();
      editor.innerText = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, postContent);
  await humanPause(1200, 2200, '正文后', 'wxch');

  // Wait until the real BUTTON「保存草稿」is enabled (not weui-desktop-btn_disabled).
  let saveBtnReady = null;
  for (let i = 0; i < 40; i++) {
    saveBtnReady = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
      const compact = (el) => (el.innerText || '').replace(/\s+/g, '').trim();
      const btn = Array.from(doc.querySelectorAll('button')).find((el) => compact(el) === '保存草稿');
      if (!btn) return { ok: false, reason: 'no button' };
      const disabled =
        btn.disabled ||
        btn.className.includes('weui-desktop-btn_disabled') ||
        btn.getAttribute('aria-disabled') === 'true';
      return { ok: true, disabled, className: btn.className };
    });
    console.log('saveBtn', i, JSON.stringify(saveBtnReady));
    if (saveBtnReady.ok && !saveBtnReady.disabled) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!saveBtnReady?.ok || saveBtnReady.disabled) {
    throw new Error('WEIXIN_CHANNELS_SAVE_DRAFT_DISABLED');
  }

  const clicked = await page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
    const compact = (el) => (el.innerText || '').replace(/\s+/g, '').trim();
    const btn = Array.from(doc.querySelectorAll('button')).find((el) => compact(el) === '保存草稿');
    if (!btn) return { ok: false, reason: 'no button' };
    btn.scrollIntoView({ block: 'center' });
    btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    btn.click();
    return { ok: true, className: btn.className };
  });
  console.log('保存草稿点击:', JSON.stringify(clicked));
  if (!clicked.ok) throw new Error('WEIXIN_CHANNELS_NO_SAVE_DRAFT_BUTTON');

  await humanPause(1500, 2800);
  await page.evaluate(() => {
    const roots = [];
    const iframe = document.querySelector('iframe');
    if (iframe?.contentDocument) roots.push(iframe.contentDocument);
    roots.push(document);
    for (const root of roots) {
      const btn = Array.from(root.querySelectorAll('button, [role="button"], span')).find((el) => {
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return t === '确定' || t === '知道了' || t === '我知道了';
      });
      btn?.click();
    }
  });

  let saved = false;
  for (let w = 0; w < 25; w++) {
    await humanPause(600, 1200);
    const state = await page.evaluate((expectTitle) => {
      const iframe = document.querySelector('iframe');
      const doc = iframe?.contentDocument || iframe?.contentWindow?.document || document;
      const text = ((document.body?.innerText || '') + '\n' + (doc.body?.innerText || '')).slice(0, 8000);
      const href = location.href || '';
      const toastOk = /草稿.*成功|保存成功|已保存|成功保存/.test(text);
      const leftCreate = /draftListManager|草稿箱/.test(href) || !/post\/create/.test(href);
      const titleSeen = expectTitle && text.includes(expectTitle);
      return { toastOk, leftCreate, titleSeen, href, hit: (text.match(/已保存|保存成功|草稿箱\s*\(\d+\)/) || [])[0] || '' };
    }, shortTitle);
    if (state.toastOk || state.hit || (state.leftCreate && state.titleSeen)) {
      saved = true;
      console.log('WEIXIN_CHANNELS_DRAFT_SAVED', JSON.stringify(state));
      break;
    }
  }

  try {
    await page.screenshot({ path: path.join(shotDir, 'channels_after_draft.png') });
  } catch (e) {
    console.warn('screenshot failed', String(e.message || e).slice(0, 80));
  }

  console.log(saved ? 'WEIXIN_CHANNELS_DRAFT_DONE' : 'WEIXIN_CHANNELS_DRAFT_CLICKED_CHECK_LIST');
  console.log('spaceId', task.spaceId);
  if (!saved) {
    // Still require upload succeeded; draft click happened. Soft-fail for toast detection.
    console.warn('draft toast/list not confirmed; verify in 视频号后台');
  }
} finally {
  await task.finish({ keep: [] });
}
