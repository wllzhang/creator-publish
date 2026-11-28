/**
 * X (Twitter) draft-only adapter via Ego Lite.
 * Supports text posts, up to 4 images, or a single MP4 video.
 *
 * STRICT SAFETY GATE:
 *   Never clicks X's Post/Publish button (`tweetButton` / `tweetButtonInline`).
 *   Always closes the composer and confirms "Save / 保存", then verifies at
 *   `https://x.com/compose/post/unsent/drafts`.
 *
 * job: profileId, mode ('draft' only), body?, title?, images?, video?, topics?, shotDir?, keepOpen?
 */
import fs from 'node:fs';
import path from 'node:path';
import { humanPause, humanMouseClick, humanInsertText } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import {
  resolveShotDir,
  safeShot,
  normalizeTopics,
  suppressNativeFileDialog,
} from '../lib/ego_dom.mjs';

const { job } = loadJob();
if (job.mode && job.mode !== 'draft') {
  throw new Error('X_SUBMIT_FORBIDDEN_DRAFT_ONLY');
}

const videoPath = job.video ? abs(job.video) : null;
const rawImages = Array.isArray(job.images) ? job.images : [];
const allImages = rawImages.map((p) => abs(p)).filter(Boolean);
const images = allImages.slice(0, 4);
const shotDir = resolveShotDir(job);

if (videoPath && !fs.existsSync(videoPath.replace(/\//g, path.sep))) {
  throw new Error(`X_VIDEO_NOT_FOUND: ${videoPath}`);
}
if (!videoPath && allImages.length > 4) {
  console.warn(`[x] X single post supports up to 4 images; using first 4 of ${allImages.length}`);
}
if (!videoPath && images.length) {
  for (const img of images) {
    if (!fs.existsSync(img.replace(/\//g, path.sep))) {
      throw new Error(`X_IMAGE_NOT_FOUND: ${img}`);
    }
  }
}
if (videoPath && images.length) {
  console.warn('[x] both video and images provided; prioritizing videoPath');
}

function xWeightedLength(str) {
  let total = 0;
  for (const ch of String(str || '')) {
    total += ch.codePointAt(0) <= 0x024f ? 1 : 2;
  }
  return total;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPostText(jobObj) {
  const title = String(jobObj.title || '').trim();
  const body = String(jobObj.body || '').trim();
  let text = '';
  if (title && body) {
    text = body.includes(title) ? body : `${title}\n\n${body}`;
  } else {
    text = body || title;
  }

  const topics = normalizeTopics(jobObj.topics);
  const softLimit = xWeightedLength(text) <= 280 ? 280 : 25000;

  for (const topic of topics) {
    const cleanTag = String(topic || '').replace(/^#+/, '').replace(/\s+/g, '');
    if (!cleanTag) continue;
    const tagRe = new RegExp(`(^|\\s)#${escapeRegex(cleanTag)}(?=$|\\s|[.,!?;:，。！？；：])`, 'i');
    if (tagRe.test(text)) continue;

    const sep = text ? (/\s$/.test(text) ? '' : ' ') : '';
    const candidate = `${text}${sep}#${cleanTag}`;
    if (xWeightedLength(candidate) <= softLimit) {
      text = candidate;
    } else {
      console.warn(`[x] skipping hashtag #${cleanTag} to respect X character limit (${softLimit})`);
    }
  }
  return text.trim();
}

const postText = buildPostText(job);
if (!postText && !videoPath && !images.length) {
  throw new Error('X_EMPTY_POST: require non-empty text (body/title), video, or images');
}

async function detectAuthOrChallenge(page) {
  return page.evaluate(() => {
    const url = location.href || '';
    if (/\/(i\/flow\/login|login|i\/flow\/signup|account\/access|account\/begin_password_reset)/i.test(url)) {
      return { blocked: true, reason: `login_redirect:${url}` };
    }
    const hasComposer = Boolean(
      document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"], [data-testid="tweetTextarea_0"]'),
    );
    const hasLoginEl = Boolean(
      document.querySelector(
        '[data-testid="loginButton"], input[autocomplete="username"], input[name="password"], [data-testid="ocfEnterTextTextInput"]',
      ),
    );
    if (hasLoginEl && !hasComposer) {
      return { blocked: true, reason: `login_form:${url}` };
    }
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
    if (
      !hasComposer &&
      /(Verify you are human|Are you a robot|Suspicious login|Enter your phone number or username|Sign in to X|登录 X)/i.test(
        bodyText,
      )
    ) {
      return { blocked: true, reason: `auth_or_challenge:${url}` };
    }
    return { blocked: false, url };
  });
}

async function assertAuthenticated(page) {
  const auth = await detectAuthOrChallenge(page);
  if (auth.blocked) {
    console.log('NEED_LOGIN_X', auth.reason);
    throw new Error('NEED_LOGIN_X');
  }
}

async function waitForComposerTextbox(page, timeoutMs = 25_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await assertAuthenticated(page);
    const box = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const candidates = [
        dlg?.querySelector('[data-testid="tweetTextarea_0"]'),
        dlg?.querySelector('div[role="textbox"]'),
        document.querySelector('[data-testid="tweetTextarea_0"]'),
        document.querySelector('div[role="textbox"]'),
      ].filter(Boolean);
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 20 && r.height > 15) {
          return {
            inDialog: Boolean(dlg && dlg.contains(el)),
            x: r.left + Math.min(80, r.width / 2),
            y: r.top + r.height / 2,
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        }
      }
      return null;
    });
    if (box) return box;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('X_COMPOSER_TEXTBOX_NOT_FOUND');
}

async function focusAndInsertPostText(page, box, text) {
  if (!text) return;
  await humanMouseClick(page, box.x, box.y, { radius: 4, tag: 'x' });
  await humanPause(250, 500, '聚焦发帖框', 'x');

  await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const el =
      dlg?.querySelector('[data-testid="tweetTextarea_0"]') ||
      dlg?.querySelector('div[role="textbox"]') ||
      document.querySelector('[data-testid="tweetTextarea_0"]') ||
      document.querySelector('div[role="textbox"]');
    if (el && document.activeElement !== el && !el.contains(document.activeElement)) {
      el.focus();
    }
  });

  await humanInsertText(page, text, { tag: 'x' });
  await humanPause(500, 950, '正文输入完成', 'x');

  // Dismiss any open hashtag/mention typeahead popover cleanly without closing composer.
  const hasTypeahead = await page.evaluate(() =>
    Boolean(document.querySelector('[data-testid="typeaheadDropdownWrapped"], [role="dialog"] [role="listbox"]')),
  );
  if (hasTypeahead) {
    await page.keyboard.press('Escape');
    await humanPause(250, 450);
  }

  const typed = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    const el =
      dlg?.querySelector('[data-testid="tweetTextarea_0"]') ||
      dlg?.querySelector('div[role="textbox"]') ||
      document.querySelector('[data-testid="tweetTextarea_0"]');
    return (el?.innerText || '').trim();
  });

  if (!typed) {
    console.warn('[x] Draft.js textbox still empty after insertText; retrying focus + insertText');
    await humanMouseClick(page, box.x, box.y, { radius: 2, tag: 'x' });
    await humanPause(200, 400);
    await page.keyboard.insertText(text);
    await humanPause(500, 900);
  }
}

async function tagComposerFileInput(page) {
  for (let i = 0; i < 15; i++) {
    const info = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const inp =
        dlg?.querySelector('input[data-testid="fileInput"]') ||
        dlg?.querySelector('input[type="file"]') ||
        document.querySelector('input[data-testid="fileInput"]') ||
        document.querySelector('input[type="file"]');
      if (!inp) return null;
      inp.id = 'cp_x_file_input';
      return {
        inDialog: Boolean(dlg && dlg.contains(inp)),
        accept: inp.getAttribute('accept') || '',
        multiple: Boolean(inp.multiple),
      };
    });
    if (info) return info;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('X_FILE_INPUT_NOT_FOUND');
}

async function uploadVideoAndWait(page, fileAbs) {
  await tagComposerFileInput(page);
  await humanPause(600, 1200, '选择视频文件', 'x');
  await page.setInputFiles('#cp_x_file_input', fileAbs);
  console.log('[x] injected video file, waiting for upload & preview:', fileAbs);

  const timeoutMs = Number(process.env.X_UPLOAD_TIMEOUT_MS || 120_000);
  const start = Date.now();
  let settledTicks = 0;
  let tick = 0;

  while (Date.now() - start < timeoutMs) {
    const st = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') || document;
      const attachments = dlg.querySelector('[data-testid="attachments"]');
      const hasVideo = Boolean(attachments?.querySelector('video'));
      const hasThumb = Boolean(attachments?.querySelector('img[src], [data-testid="videoPlayer"]'));
      const hasRemoveBtn = Boolean(
        attachments?.querySelector(
          'button[aria-label*="移除"], button[aria-label*="Remove"], button[aria-label*="删除"]',
        ),
      );
      const attachProgressCount = attachments ? attachments.querySelectorAll('[role="progressbar"]').length : 0;
      const attachText = (attachments?.innerText || '').replace(/\s+/g, ' ').trim();
      const uploadingText =
        /\b\d{1,3}%|uploading|processing|transcoding|正在上传|上传中|处理中|转码中/i.test(attachText);

      const topBar = dlg.querySelector('[data-testid="progressBar-bar"]');
      const topBarParent = topBar?.closest('[role="progressbar"]');
      const topBarStyle = topBar ? getComputedStyle(topBar) : null;
      const topParentStyle = topBarParent ? getComputedStyle(topBarParent) : null;
      const topBarRect = topBar?.getBoundingClientRect();
      const valNow = Number(topBarParent?.getAttribute('aria-valuenow') ?? '0');
      const topBarActive = Boolean(
        topBarRect &&
          topBarRect.width > 4 &&
          valNow > 0 &&
          valNow < 100 &&
          topBarStyle?.display !== 'none' &&
          topBarStyle?.visibility !== 'hidden' &&
          topParentStyle?.opacity !== '0',
      );

      const toastTexts = Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"]'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const uploadError = toastTexts.find((t) =>
        /(error|failed|unable|too long|size|format|失败|无法|格式|超出|过大)/i.test(t),
      );

      const tweetBtn = dlg.querySelector('[data-testid="tweetButton"]');
      const postEnabled = Boolean(
        tweetBtn && !tweetBtn.disabled && tweetBtn.getAttribute('aria-disabled') !== 'true',
      );

      return {
        hasAttachments: Boolean(attachments),
        hasVideo,
        hasThumb,
        hasRemoveBtn,
        attachProgressCount,
        uploadingText,
        topBarActive,
        postEnabled,
        uploadError: uploadError || null,
      };
    });

    if (st.uploadError) {
      throw new Error(`X_VIDEO_UPLOAD_ERROR: ${st.uploadError}`);
    }

    if (tick % 4 === 0 || (st.hasAttachments && !st.attachProgressCount && !st.uploadingText)) {
      console.log('[x] video upload wait', Math.round((Date.now() - start) / 1000) + 's', JSON.stringify(st));
    }

    const ready =
      st.hasAttachments &&
      (st.hasVideo || (st.hasThumb && st.hasRemoveBtn)) &&
      st.attachProgressCount === 0 &&
      !st.uploadingText &&
      !st.topBarActive;

    if (ready) {
      settledTicks++;
      if (settledTicks >= 2) {
        console.log('[x] video preview ready');
        return;
      }
    } else {
      settledTicks = 0;
    }
    tick++;
    await new Promise((r) => setTimeout(r, 1500));
  }

  await safeShot(page, path.join(shotDir, 'x_video_upload_timeout.png'));
  throw new Error('X_VIDEO_UPLOAD_TIMEOUT');
}

async function uploadImagesAndWait(page, imagePaths) {
  await tagComposerFileInput(page);
  await humanPause(600, 1200, `选择图片 (${imagePaths.length})`, 'x');
  await page.setInputFiles('#cp_x_file_input', imagePaths);
  console.log('[x] injected image files:', imagePaths.length);

  const timeoutMs = Number(process.env.X_IMAGE_TIMEOUT_MS || 60_000);
  const start = Date.now();
  let settledTicks = 0;

  while (Date.now() - start < timeoutMs) {
    const elapsed = Date.now() - start;
    const st = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') || document;
      const attachments = dlg.querySelector('[data-testid="attachments"]');
      const imgs = Array.from(attachments?.querySelectorAll('img') || []);
      const loadedCount = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
      const attachProgressCount = attachments ? attachments.querySelectorAll('[role="progressbar"]').length : 0;
      const attachText = (attachments?.innerText || '').replace(/\s+/g, ' ').trim();
      const uploadingText = /\b\d{1,3}%|uploading|正在上传|上传中/i.test(attachText);
      const topBar = dlg.querySelector('[data-testid="progressBar-bar"]');
      const topBarParent = topBar?.closest('[role="progressbar"]');
      const topBarStyle = topBar ? getComputedStyle(topBar) : null;
      const topParentStyle = topBarParent ? getComputedStyle(topBarParent) : null;
      const topBarRect = topBar?.getBoundingClientRect();
      const valNow = Number(topBarParent?.getAttribute('aria-valuenow') ?? '0');
      const topBarActive = Boolean(
        topBarRect &&
          topBarRect.width > 4 &&
          valNow > 0 &&
          valNow < 100 &&
          topBarStyle?.display !== 'none' &&
          topBarStyle?.visibility !== 'hidden' &&
          topParentStyle?.opacity !== '0',
      );
      return {
        hasAttachments: Boolean(attachments),
        imgCount: imgs.length,
        loadedCount,
        attachProgressCount,
        uploadingText,
        topBarActive,
      };
    });

    const enoughLoaded = st.loadedCount >= imagePaths.length || (elapsed > 15_000 && st.loadedCount >= 1);
    if (st.hasAttachments && enoughLoaded && st.attachProgressCount === 0 && !st.uploadingText && !st.topBarActive) {
      settledTicks++;
      if (settledTicks >= 2) {
        console.log('[x] image previews ready:', JSON.stringify(st));
        return;
      }
    } else {
      settledTicks = 0;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await safeShot(page, path.join(shotDir, 'x_image_upload_timeout.png'));
  throw new Error('X_IMAGE_UPLOAD_TIMEOUT');
}

async function clickComposerClose(page) {
  const closeBox = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const composeDlg =
      dialogs.find((d) => d.querySelector('[data-testid="tweetTextarea_0"], [data-testid="tweetButton"]')) ||
      dialogs[0] ||
      document;
    const btn =
      composeDlg.querySelector('[data-testid="app-bar-close"]') ||
      composeDlg.querySelector('button[aria-label="Close"], button[aria-label="关闭"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      ? { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      : { fallback: true };
  });
  if (!closeBox) throw new Error('X_CLOSE_BUTTON_NOT_FOUND');

  if (closeBox.fallback) {
    await page.click('[role="dialog"] [data-testid="app-bar-close"]');
  } else {
    await humanMouseClick(page, closeBox.x, closeBox.y, { radius: 3, tag: 'x' });
  }

  for (let i = 0; i < 6; i++) {
    const open = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="confirmationSheetConfirm"], [data-testid="confirmationSheetDialog"]')),
    );
    if (open) return;
    await new Promise((r) => setTimeout(r, 350));
  }

  // Fallback click in case a popover consumed the first mouse click
  await page.evaluate(() => {
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) =>
      d.querySelector('[data-testid="tweetTextarea_0"], [data-testid="tweetButton"]'),
    );
    const btn =
      dlg?.querySelector('[data-testid="app-bar-close"]') ||
      document.querySelector('[data-testid="app-bar-close"], button[aria-label="Close"], button[aria-label="关闭"]');
    btn?.click();
  });
}

async function waitAndClickSaveConfirmation(page) {
  const start = Date.now();
  while (Date.now() - start < 12_000) {
    const btnBox = await page.evaluate(() => {
      const byTestId = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (byTestId) {
        const r = byTestId.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            via: 'testid',
            text: (byTestId.innerText || '').trim(),
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          };
        }
      }
      const sheet =
        document.querySelector('[data-testid="confirmationSheetDialog"]') ||
        Array.from(document.querySelectorAll('[role="dialog"]')).slice(-1)[0];
      if (!sheet) return null;
      const byText = Array.from(sheet.querySelectorAll('button, [role="button"]')).find((el) =>
        /^(Save|保存)$/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()),
      );
      if (!byText) return null;
      const r = byText.getBoundingClientRect();
      return r.width > 0 && r.height > 0
        ? {
            via: 'text',
            text: (byText.innerText || '').trim(),
            x: r.left + r.width / 2,
            y: r.top + r.height / 2,
          }
        : null;
    });

    if (btnBox) {
      await humanPause(350, 700, '确认保存草稿', 'x');
      await humanMouseClick(page, btnBox.x, btnBox.y, { radius: 3, tag: 'x' });
      console.log('[x] clicked Save draft confirmation:', JSON.stringify(btnBox));
      return;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error('X_SAVE_CONFIRM_NOT_FOUND');
}

async function openAndVerifyUnsentDrafts(page, expectedText) {
  await humanPause(1500, 2500, '等待草稿落库', 'x');

  const curUrl = await page.url();
  if (!curUrl.includes('/unsent/drafts')) {
    try {
      await page.goto('https://x.com/compose/post/unsent/drafts', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
    } catch (e) {
      console.warn('[x] goto unsent drafts timeout:', e.message?.slice(0, 160));
    }
  }

  const snippet = String(expectedText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);

  let summary = null;
  let emptyTicks = 0;
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    summary = await page.evaluate((snip) => {
      const dlg = document.querySelector('[role="dialog"]');
      const root = dlg || document.body;
      const hasEmptyState = Boolean(root?.querySelector('[data-testid="emptyState"]'));
      const dialogText = (root?.innerText || '').replace(/\s+/g, ' ').trim();

      const rowEls = Array.from(
        (dlg || document).querySelectorAll('[data-testid="unsentTweet"], [role="listitem"], [role="button"], button'),
      ).filter((el) => {
        if (el.closest('[role="tablist"]')) return false;
        const tid = el.getAttribute('data-testid') || '';
        if (['app-bar-back', 'app-bar-close', 'unsentButton'].includes(tid)) return false;
        const aria = el.getAttribute('aria-label') || '';
        if (/^(Back|Close|Previous|Next|返回|关闭|上一个|下一步)$/i.test(aria)) return false;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (!t && !el.querySelector('img, video, svg')) return false;
        if (/^(Edit|Done|Delete|Select all|Deselect all|编辑|完成|删除|全选|取消全选)$/i.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 120 && r.height >= 36;
      });

      const snippetMatched = Boolean(snip && dialogText.includes(snip));
      return {
        url: location.href,
        hasDialog: Boolean(dlg),
        hasEmptyState,
        draftCount: rowEls.length,
        snippetMatched,
        preview: dialogText.slice(0, 260),
      };
    }, snippet);

    if (summary.hasDialog && !summary.hasEmptyState && (summary.draftCount > 0 || summary.snippetMatched)) {
      break;
    }
    if (summary.hasEmptyState) {
      emptyTicks++;
      if (emptyTicks >= 4) break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  return summary;
}

const task = await taskSpace('cp-x-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

try {
  try {
    await page.goto('https://x.com/compose/post', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (e) {
    console.warn('[x] goto compose timeout:', e.message?.slice(0, 160));
  }
  await suppressNativeFileDialog(page);
  await humanPause(1500, 2800, 'X发帖页加载', 'x');
  await assertAuthenticated(page);

  const box = await waitForComposerTextbox(page, 25_000);
  await focusAndInsertPostText(page, box, postText);

  if (videoPath) {
    await uploadVideoAndWait(page, videoPath);
  } else if (images.length) {
    await uploadImagesAndWait(page, images);
  }

  await humanPause(800, 1500, '保存草稿前检查', 'x');
  await safeShot(page, path.join(shotDir, 'x_before_draft.png'));

  // STRICT SAFETY GATE: NEVER click tweetButton / tweetButtonInline.
  await clickComposerClose(page);
  await waitAndClickSaveConfirmation(page);

  const draftSummary = await openAndVerifyUnsentDrafts(page, postText);
  await safeShot(page, path.join(shotDir, 'x_after_draft.png'));
  console.log('[x] unsent drafts check:', JSON.stringify(draftSummary));

  if (!draftSummary || (draftSummary.hasEmptyState && !draftSummary.snippetMatched && draftSummary.draftCount === 0)) {
    throw new Error('X_DRAFT_NOT_FOUND_IN_UNSENT_DRAFTS');
  }

  console.log('X_DRAFT_SAVED', JSON.stringify({
    draftCount: draftSummary.draftCount,
    snippetMatched: draftSummary.snippetMatched,
    url: draftSummary.url,
  }));
  console.log('spaceId', task.spaceId);
} finally {
  await task.finish({ keep: job.keepOpen ? [page.label || 'p1'] : [] });
}
