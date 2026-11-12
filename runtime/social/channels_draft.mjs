/**
 * 视频号：支持 document / iframe / wujie-app shadowRoot 多根挂载。
 * 上传视频 → 填短标题与视频描述 → 用「#话题」+ 键入词条 + 空格生成蓝色话题标签 → 点「保存草稿」（不点发表）。
 * job: profileId, video, title（短标题）, body（可选）, topics（可选）, shotDir?
 */
import path from 'node:path';
import { humanPause, humanMouseClick, humanInsertText } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import { resolveShotDir, safeShot, evalAllRoots, normalizeTopics } from '../lib/ego_dom.mjs';

const { job } = loadJob();
const videoPath = abs(job.video);
const shortTitle = job.title;
const postContent = job.body ? String(job.body).trim() : String(job.title || '').trim();
const topics = normalizeTopics(job.topics);
const shotDir = resolveShotDir(job);

if (!videoPath || !shortTitle) throw new Error('job 需要 video + title');

const task = await taskSpace('cp-channels-' + Date.now(), { profileId: job.profileId });
const page = await task.newPage();

async function tagDirectFileInput() {
  // Prefer document/iframe inputs for setInputFiles (CSS selectors do not pierce shadowRoot).
  return page.evaluate(() => {
    const docs = [document];
    for (const ifr of Array.from(document.querySelectorAll('iframe'))) {
      const doc = ifr?.contentDocument || ifr?.contentWindow?.document;
      if (doc) docs.push(doc);
    }
    for (const doc of docs) {
      const inp =
        doc.querySelector('input[type="file"][accept*="video"]') ||
        doc.querySelector('input[type="file"]');
      if (inp) {
        inp.id = 'wxch-video-upload-target';
        return { ok: true, accept: inp.accept || '' };
      }
    }
    return { ok: false, reason: 'no direct/iframe file input (likely wujie shadowRoot)' };
  });
}

async function uploadVideo(fileAbs) {
  const tagged = await tagDirectFileInput();
  console.log('direct/iframe file input:', JSON.stringify(tagged));
  if (tagged.ok) {
    try {
      await page.setInputFiles('#wxch-video-upload-target', fileAbs);
      return 'setInputFiles#id';
    } catch (e) {
      console.warn('setInputFiles#id failed:', String(e.message || e).slice(0, 120));
    }
  }
  // Fallback: probe upload trigger across all roots (including wujie-app shadowRoot) + fileChooser
  const trigger = await evalAllRoots(page, (roots) => {
    for (const { name, root } of roots) {
      const inp = root.querySelector('input[type="file"][accept*="video"], input[type="file"]');
      if (inp) {
        const r = (inp.parentElement || inp).getBoundingClientRect();
        if (r.width > 0 || r.height > 0) {
          return { root: name, x: r.left + Math.max(20, r.width / 2), y: r.top + Math.max(20, r.height / 2) };
        }
      }
      const card = Array.from(root.querySelectorAll('div, section, label, span, button')).find(
        (el) =>
          /支持上传|不超过20GB|点击上传|上传视频|添加视频/.test(el.innerText || '') &&
          el.getBoundingClientRect().width > 40,
      );
      if (card) {
        const r = card.getBoundingClientRect();
        return { root: name, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
    return null;
  });
  if (!trigger) throw new Error('WEIXIN_CHANNELS_NO_UPLOAD_TRIGGER');
  console.log('upload trigger:', JSON.stringify(trigger));
  const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
  await humanMouseClick(page, trigger.x, trigger.y, { radius: 8, tag: 'wxch' });
  const chooser = await chooserPromise;
  await chooser.setFiles(fileAbs);
  return `fileChooser@${trigger.root}`;
}

async function waitUploadDone(timeoutMs = 180000) {
  const start = Date.now();
  let ticks = 0;
  let lastReady = false;
  while (Date.now() - start < timeoutMs) {
    const st = await evalAllRoots(page, (roots) => {
      for (const { name, root } of roots) {
        const text = (root.body?.innerText || root.textContent || '').replace(/\s+/g, ' ');
        const videos = root.querySelectorAll('video').length;
        const hasEditor = !!root.querySelector('.input-editor, [contenteditable="true"]');
        const uploading = /上传中|正在上传|处理中|转码中|\d+\s*%/.test(text);
        const ready = (videos > 0 || /删除视频|更换视频|编辑封面|删除/.test(text)) && hasEditor;
        if (ready) return { root: name, videos, uploading, ready, snippet: text.slice(0, 120) };
      }
      return { videos: 0, uploading: false, ready: false, snippet: '' };
    });
    if (ticks % 5 === 0 || st.ready !== lastReady || st.uploading) {
      console.log('upload wait', st);
    }
    lastReady = !!st.ready;
    if (st.ready && !st.uploading && ticks >= 2) return st;
    ticks++;
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

  const titleFilled = await evalAllRoots(
    page,
    (roots, t) => {
      for (const { root } of roots) {
        const input = root.querySelector(
          'input[placeholder="填写短标题有机会获得更多流量"], input[placeholder*="短标题"]',
        );
        if (input) {
          input.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, t);
          else input.value = t;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    },
    shortTitle,
  );
  if (!titleFilled) throw new Error('WEIXIN_CHANNELS_NO_SHORT_TITLE_INPUT');
  await humanPause(1000, 2000, '短标题后', 'wxch');

  // Focus description editor via DOM (works even if window is minimized)
  const focusedEditor = await evalAllRoots(page, (roots) => {
    for (const { root } of roots) {
      const editor = root.querySelector(
        '.post-desc-box [contenteditable="true"], .input-editor, [contenteditable="true"]',
      );
      if (editor) {
        editor.scrollIntoView({ block: 'center' });
        editor.focus();
        return true;
      }
    }
    return false;
  });
  if (focusedEditor) {
    await humanPause(250, 450);
    await page.keyboard.press('Control+a');
    await humanPause(150, 300);
    await page.keyboard.press('Backspace');
    await humanPause(250, 450);

    if (postContent) {
      await humanInsertText(page, postContent, { tag: 'wxch' });
      await humanPause(200, 400);
    }

    // Weixin Channels converts `#word + Space` into <span class="hl topic" data-type="topic"> (no dropdown).
    if (topics.length) {
      if (postContent) {
        await page.keyboard.press('Enter');
        await humanPause(200, 400);
      }
      for (const kw of topics) {
        const clickedTopicBtn = await evalAllRoots(page, (roots) => {
          for (const { root } of roots) {
            const btn = Array.from(root.querySelectorAll('div, button, span')).find(
              (el) => (el.innerText || '').trim() === '#话题' && el.getBoundingClientRect().width > 0,
            );
            if (btn) {
              btn.click();
              return true;
            }
          }
          return false;
        });
        if (!clickedTopicBtn) await page.keyboard.type('#');
        await humanPause(300, 500);
        // Humanized key rhythm so topic conversion is not machine-uniform.
        await page.keyboard.type(kw, { delay: 35 + Math.floor(Math.random() * 55) });
        await humanPause(250, 450);
        await page.keyboard.type(' ');
        await humanPause(350, 650);
      }
      const topicSpans = await evalAllRoots(page, (roots) => {
        for (const { root } of roots) {
          const ed = root.querySelector(
            '.post-desc-box [contenteditable="true"], .input-editor, [contenteditable="true"]',
          );
          if (ed) return ed.querySelectorAll('span.hl.topic, span[data-type="topic"]').length;
        }
        return 0;
      });
      console.log('topic spans rendered:', topicSpans, 'of', topics.length);
      if (topicSpans < topics.length) {
        console.warn('[wxch] some topics stayed as plain text; check #话题 + Space conversion');
      }
    }
  } else {
    console.warn('[wxch] description editor not found; skipping body/topics');
  }
  await humanPause(1200, 2200, '正文话题后', 'wxch');
  await safeShot(page, path.join(shotDir, 'channels_before_draft.png'));

  // Wait until the real BUTTON「保存草稿」is enabled (not weui-desktop-btn_disabled).
  let saveBtnReady = null;
  for (let i = 0; i < 40; i++) {
    saveBtnReady = await evalAllRoots(page, (roots) => {
      const compact = (el) => (el.innerText || '').replace(/\s+/g, '').trim();
      for (const { name, root } of roots) {
        const btn = Array.from(root.querySelectorAll('button')).find((el) => compact(el) === '保存草稿');
        if (btn) {
          const disabled =
            btn.disabled ||
            btn.className.includes('weui-desktop-btn_disabled') ||
            btn.getAttribute('aria-disabled') === 'true';
          return { ok: true, root: name, disabled, className: btn.className };
        }
      }
      return { ok: false, reason: 'no button' };
    });
    if (i % 4 === 0 || (saveBtnReady.ok && !saveBtnReady.disabled)) {
      console.log('saveBtn', i, JSON.stringify(saveBtnReady));
    }
    if (saveBtnReady.ok && !saveBtnReady.disabled) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!saveBtnReady?.ok || saveBtnReady.disabled) {
    throw new Error('WEIXIN_CHANNELS_SAVE_DRAFT_DISABLED');
  }

  const clicked = await evalAllRoots(page, (roots) => {
    const compact = (el) => (el.innerText || '').replace(/\s+/g, '').trim();
    for (const { name, root } of roots) {
      const btn = Array.from(root.querySelectorAll('button')).find((el) => compact(el) === '保存草稿');
      if (btn) {
        btn.scrollIntoView({ block: 'center' });
        btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.click();
        return { ok: true, root: name, className: btn.className };
      }
    }
    return { ok: false, reason: 'no button' };
  });
  console.log('保存草稿点击:', JSON.stringify(clicked));
  if (!clicked.ok) throw new Error('WEIXIN_CHANNELS_NO_SAVE_DRAFT_BUTTON');

  await humanPause(1500, 2800);
  await evalAllRoots(page, (roots) => {
    for (const { root } of roots) {
      const btn = Array.from(root.querySelectorAll('button, [role="button"], span')).find((el) => {
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return t === '确定' || t === '知道了' || t === '我知道了';
      });
      btn?.click();
    }
  });

  let saved = false;
  for (let w = 0; w < 25; w++) {
    await humanPause(500, 900);
    const state = await evalAllRoots(
      page,
      (roots, expectTitle) => {
        const chunks = roots.map((r) => r.root.body?.innerText || r.root.textContent || '');
        const text = chunks.join('\n').slice(0, 12000);
        const href = location.href || '';
        const toastOk = /草稿.*成功|保存成功|已保存|成功保存/.test(text);
        const leftCreate = /draftListManager|草稿箱/.test(href) || !/post\/create/.test(href);
        const titleSeen = expectTitle && text.includes(expectTitle);
        return {
          toastOk,
          leftCreate,
          titleSeen,
          href,
          hit: (text.match(/已保存|保存成功|草稿箱\s*\(\d+\)/) || [])[0] || '',
        };
      },
      shortTitle,
    );
    if (state.toastOk || state.hit || (state.leftCreate && state.titleSeen)) {
      saved = true;
      console.log('WEIXIN_CHANNELS_DRAFT_SAVED', JSON.stringify(state));
      break;
    }
  }

  await safeShot(page, path.join(shotDir, 'channels_after_draft.png'));
  console.log(saved ? 'WEIXIN_CHANNELS_DRAFT_DONE' : 'WEIXIN_CHANNELS_DRAFT_CLICKED_CHECK_LIST');
  console.log('spaceId', task.spaceId);
  if (!saved) {
    console.warn('draft toast/list not confirmed; verify in 视频号后台 draftListManager');
  }
} finally {
  await task.finish({ keep: [] });
}
