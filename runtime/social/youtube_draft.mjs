/**
 * YouTube Studio 入草稿（上传视频 → 填标题/简介/#标签 → 可选自定义封面 → 选择非面向儿童 → 可选展开填入Tags与AI内容声明 → 等待保存为草稿后关闭弹窗，绝不点击下一步/发布）。
 * job: profileId, video, title, body?, topics?, cover?, aiGenerated?, shotDir?, keepOpen?
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

function clampTitle(raw, maxLen = 100) {
  const s = String(raw || '').trim();
  if (s.length <= maxLen) return s;
  let cut = s.slice(0, maxLen);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

function buildDescription(body, topics) {
  const cleanBody = body ? String(body).trim() : '';
  const lowerBody = cleanBody.toLowerCase();
  const hashtags = [];
  for (const t of topics) {
    const cleanTag = String(t || '').replace(/^#/, '').replace(/\s+/g, '').trim();
    if (!cleanTag) continue;
    const hash = `#${cleanTag}`;
    if (!lowerBody.includes(hash.toLowerCase())) {
      hashtags.push(hash);
    }
  }
  const parts = [];
  if (cleanBody) parts.push(cleanBody);
  if (hashtags.length) parts.push(hashtags.join(' '));
  return parts.join('\n\n').slice(0, 5000);
}

const { job } = loadJob();
if (job.mode && job.mode !== 'draft') {
  throw new Error('YOUTUBE_SUBMIT_FORBIDDEN_DRAFT_ONLY');
}

const videoPath = abs(job.video);
const rawTitle = String(job.title || '').trim();
if (!videoPath || !rawTitle) throw new Error('job 需要 video + title');
if (!fs.existsSync(videoPath.replace(/\//g, path.sep))) {
  throw new Error(`视频文件不存在: ${videoPath}`);
}

const title = clampTitle(rawTitle, 100);
if (rawTitle.length > 100) {
  console.warn(`[yt] title truncated to <=100 chars (${title.length}/${rawTitle.length})`);
}

const topics = normalizeTopics(job.topics);
const description = buildDescription(job.body, topics);
const coverPath = job.cover ? abs(job.cover) : null;
const aiGenerated = job.aiGenerated === true;
const shotDir = resolveShotDir(job);

async function checkStudioAuthAndShell(page) {
  return page.evaluate(() => {
    const href = location.href || '';
    const origin = location.origin || 'https://studio.youtube.com';
    const host = location.hostname || '';
    const mChan = href.match(/\/channel\/(UC[\w-]+|[^/?#]+)/);
    let channelId = mChan ? mChan[1] : null;
    if (!channelId) {
      const link = document.querySelector('a[href*="/channel/"]');
      const lm = link?.getAttribute('href')?.match(/\/channel\/(UC[\w-]+|[^/?#]+)/);
      if (lm) channelId = lm[1];
    }

    const bodyText = (document.body?.innerText || '').slice(0, 2500);
    const isGoogleAuth =
      /accounts\.google\.com/i.test(host) ||
      /ServiceLogin|signin\/v2|identifier|challenge\/|accounts\/Login/i.test(href);
    const hasCaptcha = Boolean(
      document.querySelector('iframe[src*="recaptcha"], #captchaimg, [id*="captcha"], [class*="captcha"]'),
    );
    const hasStudioShell = Boolean(
      document.querySelector('ytcp-app, ytcp-header, button[aria-label="Create"], #upload-icon, #upload-button, ytcp-uploads-dialog'),
    );
    const hasSignInCta =
      !hasStudioShell &&
      /(?:Sign in|Use your Google Account|Verify it['’]s you|登录|验证您的身份)/i.test(bodyText);

    return {
      href,
      origin,
      channelId,
      needLogin: isGoogleAuth || hasCaptcha || hasSignInCta,
      hasStudioShell,
      title: document.title || '',
    };
  });
}

async function waitForStudioReady(page) {
  const deadline = Date.now() + 25_000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await checkStudioAuthAndShell(page);
    if (lastState.needLogin) {
      console.log('NEED_LOGIN_YOUTUBE');
      throw new Error('NEED_LOGIN_YOUTUBE');
    }
    if (lastState.hasStudioShell && /studio\.youtube\.com/i.test(lastState.href)) {
      return lastState;
    }
    await humanPause(700, 1100);
  }
  if (lastState?.needLogin) {
    console.log('NEED_LOGIN_YOUTUBE');
    throw new Error('NEED_LOGIN_YOUTUBE');
  }
  return lastState;
}

async function probeVideoFileInput(page) {
  return page.evaluate(() => {
    const deepAll = (root, sel) => {
      const out = [];
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n.querySelectorAll !== 'function') return;
        for (const el of n.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
        for (const el of n.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };

    const lightDirect =
      document.querySelector('ytcp-uploads-dialog input[type="file"][name="Filedata"]') ||
      document.querySelector('ytcp-uploads-dialog input[type="file"]') ||
      document.querySelector('input[type="file"][name="Filedata"]') ||
      document.querySelector('input[type="file"][accept*="video"]');
    if (lightDirect) {
      lightDirect.setAttribute('data-cp-yt-upload', 'video');
      return { found: true, lightDom: true, selector: '[data-cp-yt-upload="video"]' };
    }

    const selectBtn = deepAll(document, '#select-files-button, button[aria-label="Select files"], button[aria-label="选择文件"]').find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (selectBtn) {
      selectBtn.scrollIntoView({ block: 'center' });
      const r = selectBtn.getBoundingClientRect();
      return {
        found: true,
        lightDom: false,
        selectBtn: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      };
    }
    return { found: false };
  });
}

async function openUploadDialogAndSelectVideo(page, studioInfo) {
  let probe = await probeVideoFileInput(page);

  if (!probe.found) {
    // 1) Verified Create button -> #text-item-0 (Upload videos)
    const createBtn = await page.evaluate(() => {
      const candidates = [
        ...document.querySelectorAll('button[aria-label="Create"], button[aria-label="创建"], ytcp-button'),
      ];
      const hit = candidates.find((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const lbl = (el.getAttribute('aria-label') || '').trim();
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        return /^(Create|创建)$/i.test(lbl) || /^(Create|创建)$/i.test(txt);
      });
      if (!hit) return null;
      hit.scrollIntoView({ block: 'center' });
      const r = hit.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    if (createBtn) {
      await humanMouseClick(page, createBtn.x, createBtn.y, { radius: 4, tag: 'yt' });
      await humanPause(700, 1200, '点击Create菜单', 'yt');

      const menuItem = await page.evaluate(() => {
        const direct = document.querySelector('#text-item-0');
        const candidates = [
          ...(direct ? [direct] : []),
          ...document.querySelectorAll('tp-yt-paper-item, ytcp-text-menu tp-yt-paper-item, [role="menuitem"]'),
        ];
        const hit = candidates.find((el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          if (el.id === 'text-item-0') return true;
          return /Upload videos|上传视频/i.test(el.innerText || '');
        });
        if (!hit) return null;
        const r = hit.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });

      if (menuItem) {
        await humanMouseClick(page, menuItem.x, menuItem.y, { radius: 3, tag: 'yt' });
        await humanPause(1000, 1700, '点击Upload videos菜单项', 'yt');
      }
    }
    probe = await probeVideoFileInput(page);
  }

  if (!probe.found) {
    // 2) Direct Upload icon / button on dashboard
    const directUploadBtn = await page.evaluate(() => {
      const sels = [
        '#upload-icon',
        '#upload-button',
        'ytcp-icon-button[aria-label="Upload videos"]',
        'button[aria-label="Upload videos"]',
        'button[aria-label="上传视频"]',
      ];
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          el.scrollIntoView({ block: 'center' });
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });

    if (directUploadBtn) {
      await humanMouseClick(page, directUploadBtn.x, directUploadBtn.y, { radius: 4, tag: 'yt' });
      await humanPause(1000, 1700, '点击Upload图标按钮', 'yt');
      probe = await probeVideoFileInput(page);
    }
  }

  if (!probe.found) {
    // 3) Fallback to Studio upload deep link (?d=ud)
    const origin = studioInfo?.origin || 'https://studio.youtube.com';
    const uploadUrl = studioInfo?.channelId
      ? `${origin}/channel/${studioInfo.channelId}/videos/upload?d=ud`
      : `${origin}/?d=ud`;
    console.log('[yt] navigating to upload URL fallback:', uploadUrl);
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await suppressNativeFileDialog(page);
    await waitForStudioReady(page);
    await humanPause(1200, 2000);
  }

  for (let i = 0; i < 20; i++) {
    probe = await probeVideoFileInput(page);
    if (probe.found) break;
    await humanPause(800, 1200);
  }
  if (!probe.found) throw new Error('YOUTUBE_UPLOAD_DIALOG_NOT_OPENED');

  await humanPause(1000, 1800, '选视频前', 'yt');
  if (probe.lightDom) {
    await page.setInputFiles(probe.selector, videoPath);
  } else {
    const chooserPromise = page.waitForFileChooser({ timeout: 15000 });
    await humanMouseClick(page, probe.selectBtn.x, probe.selectBtn.y, { radius: 4, tag: 'yt' });
    const chooser = await chooserPromise;
    await chooser.setFiles(videoPath);
  }
  console.log('[yt] video file attached:', path.basename(videoPath));
}

async function waitForDetailsForm(page) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => {
      const deepAll = (root, sel) => {
        const out = [];
        const seen = new Set();
        const walk = (n) => {
          if (!n || typeof n.querySelectorAll !== 'function') return;
          for (const el of n.querySelectorAll(sel)) {
            if (!seen.has(el)) {
              seen.add(el);
              out.push(el);
            }
          }
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(root);
        return out;
      };
      const isVis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };

      const errEl = deepAll(document, 'ytcp-error-section').find(isVis);
      const errText = errEl ? (errEl.innerText || '').trim() : '';
      const titleBox = deepAll(document, '#title-textarea').find(isVis);
      const textboxes = deepAll(document, '#textbox[contenteditable="true"], ytcp-social-suggestions-textbox [contenteditable="true"]').filter(isVis);
      return {
        ready: Boolean(titleBox || textboxes.length >= 1),
        errText,
      };
    });

    if (st.errText && /invalid|unsupported|limit|failed|无法|无效|上限|失败/i.test(st.errText)) {
      throw new Error(`YOUTUBE_UPLOAD_ERROR: ${st.errText.slice(0, 180)}`);
    }
    if (st.ready) {
      await humanPause(1500, 2400, 'Details表单就绪', 'yt');
      return;
    }
    await humanPause(800, 1200);
  }
  throw new Error('YOUTUBE_DETAILS_STEP_TIMEOUT');
}

async function locateEditableBox(page, kind) {
  return page.evaluate((targetKind) => {
    const deepAll = (root, sel) => {
      const out = [];
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n.querySelectorAll !== 'function') return;
        for (const el of n.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
        for (const el of n.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };
    const isVis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };

    const containerSel = targetKind === 'title' ? '#title-textarea' : '#description-textarea';
    const container = deepAll(document, containerSel).find(isVis);
    let box = container ? deepAll(container, '#textbox, [contenteditable="true"]').find(isVis) : null;
    if (!box) {
      const dlg = document.querySelector('ytcp-uploads-dialog') || document;
      const all = deepAll(dlg, 'ytcp-social-suggestions-textbox #textbox, #textbox[contenteditable="true"]').filter(isVis);
      box = targetKind === 'title' ? all[0] : all[1];
    }
    if (!box) return null;
    box.scrollIntoView({ block: 'center', inline: 'center' });
    const r = box.getBoundingClientRect();
    const cur = (box.innerText || box.textContent || '').replace(/\u200b/g, '').trim();
    return {
      x: r.left + Math.min(r.width * 0.4, 160),
      y: r.top + Math.min(r.height * 0.5, 24),
      cur,
    };
  }, kind);
}

async function fillContentEditableField(page, kind, value, { clearFirst = true } = {}) {
  const loc = await locateEditableBox(page, kind);
  if (!loc) {
    if (kind === 'title') throw new Error('YOUTUBE_TITLE_INPUT_NOT_FOUND');
    console.warn(`[yt] ${kind} textbox not found; skipping`);
    return false;
  }

  await humanMouseClick(page, loc.x, loc.y, { radius: 4, tag: 'yt' });
  await humanPause(200, 350);

  if (clearFirst) {
    await page.keyboard.press('Control+a');
    await humanPause(120, 220);
    await page.keyboard.press('Backspace');
    await humanPause(200, 350);

    const remaining = await locateEditableBox(page, kind);
    if (remaining?.cur) {
      await page.evaluate((targetKind) => {
        const deepAll = (root, sel) => {
          const out = [];
          const walk = (n) => {
            if (!n || typeof n.querySelectorAll !== 'function') return;
            for (const el of n.querySelectorAll(sel)) out.push(el);
            for (const el of n.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
            }
          };
          walk(root);
          return out;
        };
        const c = deepAll(document, targetKind === 'title' ? '#title-textarea' : '#description-textarea')[0];
        const b = c ? deepAll(c, '#textbox, [contenteditable="true"]')[0] : null;
        if (b) {
          b.focus();
          document.execCommand('selectAll', false, null);
        }
      }, kind);
      await page.keyboard.press('Backspace');
      await humanPause(150, 280);
    }
  }

  if (value) {
    await humanInsertText(page, value, { tag: 'yt' });
    await humanPause(450, 750);
  }

  const after = await locateEditableBox(page, kind);
  if (value && (!after?.cur || (kind === 'title' && !after.cur.includes(value.slice(0, 12))))) {
    await page.evaluate(
      ({ targetKind, val }) => {
        const deepAll = (root, sel) => {
          const out = [];
          const walk = (n) => {
            if (!n || typeof n.querySelectorAll !== 'function') return;
            for (const el of n.querySelectorAll(sel)) out.push(el);
            for (const el of n.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
            }
          };
          walk(root);
          return out;
        };
        const c = deepAll(document, targetKind === 'title' ? '#title-textarea' : '#description-textarea')[0];
        const b = c ? deepAll(c, '#textbox, [contenteditable="true"]')[0] : null;
        if (!b) return;
        b.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, val);
        b.dispatchEvent(new Event('input', { bubbles: true }));
      },
      { targetKind: kind, val: value },
    );
    await humanPause(350, 600);
  }
  return true;
}

async function blurByClickingHeader(page) {
  const hdr = await page.evaluate(() => {
    const el = document.querySelector('ytcp-uploads-dialog #title, ytcp-uploads-dialog .header');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left + Math.min(80, r.width * 0.3), y: r.top + r.height / 2 };
  });
  if (hdr) {
    await humanMouseClick(page, hdr.x, hdr.y, { radius: 3, tag: 'yt' });
    await humanPause(250, 450);
  }
}

async function uploadThumbnailIfPresent(page, coverAbs) {
  if (!coverAbs) return;
  if (!fs.existsSync(coverAbs.replace(/\//g, path.sep))) {
    console.warn(`[yt] cover file missing, skipping: ${coverAbs}`);
    return;
  }

  try {
    const thumbProbe = await page.evaluate(() => {
      const deepAll = (root, sel) => {
        const out = [];
        const walk = (n) => {
          if (!n || typeof n.querySelectorAll !== 'function') return;
          for (const el of n.querySelectorAll(sel)) out.push(el);
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(root);
        return out;
      };
      const lightInp =
        document.querySelector('ytcp-thumbnail-uploader #file-loader') ||
        document.querySelector('ytcp-thumbnail-uploader input[type="file"]') ||
        document.querySelector('ytcp-video-thumbnail-editor input[type="file"]') ||
        document.querySelector('#file-loader[type="file"]') ||
        document.querySelector('ytcp-uploads-dialog input[type="file"][accept*="image"]');
      if (lightInp) {
        lightInp.scrollIntoView({ block: 'center' });
        lightInp.setAttribute('data-cp-yt-upload', 'cover');
        return { found: true, lightDom: true, selector: '[data-cp-yt-upload="cover"]' };
      }

      const uploader = deepAll(document, 'ytcp-thumbnail-uploader, ytcp-video-thumbnail-editor')[0];
      if (!uploader) return { found: false };
      uploader.scrollIntoView({ block: 'center' });
      const btn = deepAll(uploader, '#select-button, button, [role="button"]').find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !el.disabled;
      });
      if (!btn) return { found: false };
      const r = btn.getBoundingClientRect();
      return { found: true, lightDom: false, btn: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
    });

    if (!thumbProbe.found) {
      console.warn('[yt] thumbnail uploader input not found; skipping cover');
      return;
    }

    if (thumbProbe.lightDom) {
      await page.setInputFiles(thumbProbe.selector, coverAbs);
    } else {
      const chooserPromise = page.waitForFileChooser({ timeout: 6000 });
      await humanMouseClick(page, thumbProbe.btn.x, thumbProbe.btn.y, { radius: 3, tag: 'yt' });
      const chooser = await chooserPromise;
      await chooser.setFiles(coverAbs);
    }
    await humanPause(1500, 2600, '封面缩略图上传后', 'yt');
    console.log('YOUTUBE_THUMBNAIL_UPLOADED:', path.basename(coverAbs));
  } catch (e) {
    console.warn('[yt] thumbnail upload optional failed:', String(e?.message || e).slice(0, 140));
  }
}

async function selectRadioDeep(page, { exactNames, textRegex, sectionRegex, excludeRegex }) {
  const target = await page.evaluate(
    ({ names, textPat, secPat, excPat }) => {
      const deepAll = (root, sel) => {
        const out = [];
        const seen = new Set();
        const walk = (n) => {
          if (!n || typeof n.querySelectorAll !== 'function') return;
          for (const el of n.querySelectorAll(sel)) {
            if (!seen.has(el)) {
              seen.add(el);
              out.push(el);
            }
          }
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(root);
        return out;
      };
      const isVis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      };

      const tRe = textPat ? new RegExp(textPat, 'i') : null;
      const sRe = secPat ? new RegExp(secPat, 'i') : null;
      const eRe = excPat ? new RegExp(excPat, 'i') : null;

      let hit = null;
      for (const name of names) {
        hit = deepAll(document, `tp-yt-paper-radio-button[name="${name}"], [role="radio"][name="${name}"]`).find(isVis);
        if (hit) break;
      }

      if (!hit && tRe) {
        const radios = deepAll(document, 'tp-yt-paper-radio-button, [role="radio"]').filter(isVis);
        hit = radios.find((el) => {
          const n = el.getAttribute('name') || '';
          if (eRe && eRe.test(n)) return false;
          const lbl = (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          if (!tRe.test(lbl)) return false;
          if (!sRe) return true;
          const hostText = (el.closest('ytcp-video-audience-picker, ytcp-form-input-container, section, div')?.innerText || '').slice(0, 600);
          return sRe.test(hostText);
        });
      }

      if (!hit) return { found: false };
      hit.scrollIntoView({ block: 'center', inline: 'center' });
      const checked = hit.hasAttribute('checked') || hit.getAttribute('aria-checked') === 'true';
      const r = hit.getBoundingClientRect();
      return {
        found: true,
        checked,
        name: hit.getAttribute('name') || '',
        text: (hit.innerText || '').replace(/\s+/g, ' ').trim(),
        x: r.left + Math.min(24, r.width / 2),
        y: r.top + r.height / 2,
      };
    },
    {
      names: exactNames,
      textPat: textRegex?.source || null,
      secPat: sectionRegex?.source || null,
      excPat: excludeRegex?.source || null,
    },
  );

  if (!target.found) return { ok: false, reason: 'not found' };
  if (target.checked) return { ok: true, already: true, name: target.name };

  await humanMouseClick(page, target.x, target.y, { radius: 3, tag: 'yt' });
  await humanPause(450, 750);

  const verified = await page.evaluate(
    ({ names, textPat, secPat, excPat }) => {
      const deepAll = (root, sel) => {
        const out = [];
        const walk = (n) => {
          if (!n || typeof n.querySelectorAll !== 'function') return;
          for (const el of n.querySelectorAll(sel)) out.push(el);
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(root);
        return out;
      };
      const tRe = textPat ? new RegExp(textPat, 'i') : null;
      const sRe = secPat ? new RegExp(secPat, 'i') : null;
      const eRe = excPat ? new RegExp(excPat, 'i') : null;

      let hit = null;
      for (const name of names) {
        hit = deepAll(document, `tp-yt-paper-radio-button[name="${name}"], [role="radio"][name="${name}"]`)[0];
        if (hit) break;
      }
      if (!hit && tRe) {
        hit = deepAll(document, 'tp-yt-paper-radio-button, [role="radio"]').find((el) => {
          const n = el.getAttribute('name') || '';
          if (eRe && eRe.test(n)) return false;
          const lbl = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (!tRe.test(lbl)) return false;
          if (!sRe) return true;
          const hostText = (el.closest('ytcp-video-audience-picker, ytcp-form-input-container, section, div')?.innerText || '').slice(0, 600);
          return sRe.test(hostText);
        });
      }
      if (!hit) return false;
      const isChecked = hit.hasAttribute('checked') || hit.getAttribute('aria-checked') === 'true';
      if (!isChecked) {
        const rc = hit.shadowRoot?.querySelector('#radioContainer') || hit.querySelector('#radioContainer') || hit;
        rc.click();
        return hit.hasAttribute('checked') || hit.getAttribute('aria-checked') === 'true';
      }
      return true;
    },
    {
      names: exactNames,
      textPat: textRegex?.source || null,
      secPat: sectionRegex?.source || null,
      excPat: excludeRegex?.source || null,
    },
  );

  return { ok: verified, name: target.name, text: target.text };
}

async function expandShowMore(page) {
  const btn = await page.evaluate(() => {
    const deepAll = (root, sel) => {
      const out = [];
      const walk = (n) => {
        if (!n || typeof n.querySelectorAll !== 'function') return;
        for (const el of n.querySelectorAll(sel)) out.push(el);
        for (const el of n.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };
    const isVis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };

    const details = deepAll(document, 'ytcp-uploads-details')[0] || document;
    const toggle =
      deepAll(details, '#toggle-button').find((el) => isVis(el) && !/Show less|收起|顯示較少/i.test(el.innerText || '')) ||
      deepAll(details, 'ytcp-button, button').find(
        (el) => isVis(el) && /^(Show more|显示更多|展开更多|顯示更多)$/i.test((el.innerText || '').replace(/\s+/g, ' ').trim()),
      );
    if (!toggle) return null;
    toggle.scrollIntoView({ block: 'center' });
    const r = toggle.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (!btn) return false;
  await humanMouseClick(page, btn.x, btn.y, { radius: 3, tag: 'yt' });
  await humanPause(800, 1400, '展开Show more选项', 'yt');
  return true;
}

async function insertTags(page, tagList) {
  const limited = tagList.slice(0, 10);
  if (!limited.length) return;

  for (const rawTag of limited) {
    const tag = String(rawTag || '').replace(/,/g, '').trim();
    if (!tag) continue;

    const tagBox = await page.evaluate((candidate) => {
      const deepAll = (root, sel) => {
        const out = [];
        const walk = (n) => {
          if (!n || typeof n.querySelectorAll !== 'function') return;
          for (const el of n.querySelectorAll(sel)) out.push(el);
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(root);
        return out;
      };
      const isVis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const container = deepAll(document, '#tags-container')[0];
      if (!container) return { found: false };
      container.scrollIntoView({ block: 'center' });

      const chips = deepAll(container, 'ytcp-chip #text, ytcp-chip .chip-text, ytcp-chip')
        .map((c) => (c.innerText || '').replace(/[×x\n]/g, '').trim().toLowerCase())
        .filter(Boolean);
      if (chips.includes(candidate.toLowerCase())) {
        return { found: true, duplicate: true, count: chips.length };
      }

      const inp = deepAll(
        container,
        'input#text-input, input[aria-label*="Tags" i], input[placeholder*="tag" i], input[placeholder*="标签"], input[type="text"], input:not([type])',
      ).find(isVis);
      if (!inp) return { found: false };

      const r = inp.getBoundingClientRect();
      return {
        found: true,
        duplicate: false,
        x: r.left + Math.min(80, r.width / 2),
        y: r.top + r.height / 2,
      };
    }, tag);

    if (!tagBox.found) {
      console.warn('[yt] #tags-container input not found; stopping tag entry');
      break;
    }
    if (tagBox.duplicate) continue;

    await humanMouseClick(page, tagBox.x, tagBox.y, { radius: 2, tag: 'yt' });
    await humanPause(150, 280);
    await humanInsertText(page, tag, { tag: 'yt' });
    await humanPause(180, 320);
    await page.keyboard.press('Enter');
    await humanPause(350, 620, `标签 ${tag}`, 'yt');
  }

  const finalTagInfo = await page.evaluate(() => {
    const deepAll = (root, sel) => {
      const out = [];
      const walk = (n) => {
        if (!n || typeof n.querySelectorAll !== 'function') return;
        for (const el of n.querySelectorAll(sel)) out.push(el);
        for (const el of n.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };
    const c = deepAll(document, '#tags-container')[0];
    if (!c) return [];
    return deepAll(c, 'ytcp-chip')
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });
  console.log(`YOUTUBE_TAGS_SET: ${finalTagInfo.length}`, JSON.stringify(finalTagInfo));
}

async function waitForUploadAndDraftSave(page) {
  const timeoutMs = Number(process.env.YOUTUBE_UPLOAD_TIMEOUT_MS || 90_000);
  const start = Date.now();
  let lastSnapshot = {};

  while (Date.now() - start < timeoutMs) {
    const st = await page.evaluate(() => {
      const deepAll = (root, sel) => {
        const out = [];
        const walk = (n) => {
          if (!n || typeof n.querySelectorAll !== 'function') return;
          for (const el of n.querySelectorAll(sel)) out.push(el);
          for (const el of n.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(root);
        return out;
      };
      const dlg = document.querySelector('ytcp-uploads-dialog');
      if (!dlg) return { hasDialog: false };

      const headerTxt = deepAll(dlg, '.header, .header #title, [class*="saving"]')
        .filter((el) => !el.closest('#scrollable-content'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');
      const progressTxt = deepAll(
        dlg,
        'ytcp-video-upload-progress, #progress-status-text, .progress-label, .left-button-area, .footer .status-container',
      )
        .filter((el) => !el.closest('#stepper, [role="tablist"], #scrollable-content'))
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');
      const footerTxt = deepAll(dlg, '.footer, ytcp-uploads-dialog-footer')
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');
      const statusTxt = progressTxt || footerTxt;
      const errTxt = deepAll(dlg, 'ytcp-error-section, .error-message, #error-message')
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');

      const hasFatalError =
        /upload failed|uploading failed|processing abandoned|daily upload limit|invalid file|上传失败|上传出错|每日上传上限|格式无效/i.test(
          `${errTxt} | ${statusTxt}`,
        );
      const isUploading =
        /(?:uploading|正在上传|正在上傳)[^\n%]*\b([0-9]|[1-9][0-9])%|\b([0-9]|[1-9][0-9])%\s*(?:uploaded|已上传|已上傳)|\b\d+\s*(?:seconds?|minutes?|hours?|秒|分钟|分鐘)\s*(?:left|remaining|剩余|剩餘)/i.test(
          statusTxt,
        ) &&
        !/upload complete|100%\s*(?:uploaded)?|已上传\s*100%|上传完毕|上传完成|processing|正在处理|checks complete|checking|正在检查|检查完毕/i.test(
          statusTxt,
        );
      const uploadDone =
        /upload complete|100%\s*(?:uploaded)?|已上传\s*100%|上传完毕|上传完成|上傳完畢|上傳完成|processing|正在处理|處理中|处理中|\bchecks\b|checking|正在检查|检查完毕|檢查中|檢查完畢|no issues found|未发现问题/i.test(
          statusTxt,
        );
      const isSaving = /saving\.\.\.|正在保存|儲存中/i.test(headerTxt);
      const savedAsDraft = /saved as draft|draft saved|已保存为草稿|已儲存為草稿/i.test(headerTxt);

      return {
        hasDialog: true,
        hasFatalError,
        isUploading,
        uploadDone,
        isSaving,
        savedAsDraft,
        headerTxt: headerTxt.slice(0, 120),
        progressTxt: statusTxt.slice(0, 140),
      };
    });

    lastSnapshot = st;
    if (!st.hasDialog) break;
    if (st.hasFatalError) {
      throw new Error(`YOUTUBE_UPLOAD_FAILED: ${st.progressTxt || st.headerTxt}`);
    }

    const elapsed = Date.now() - start;
    console.log('[yt] upload/save wait', Math.round(elapsed / 1000) + 's', {
      isUploading: st.isUploading,
      uploadDone: st.uploadDone,
      savedAsDraft: st.savedAsDraft,
      isSaving: st.isSaving,
      progress: st.progressTxt,
    });

    // Never leave early while 0-99% upload is active.
    if (!st.isUploading && !st.isSaving && st.uploadDone && (st.savedAsDraft || elapsed >= 6000)) {
      return st;
    }
    if (!st.isUploading && !st.isSaving && st.savedAsDraft && elapsed >= 12_000) {
      return st;
    }

    await humanPause(1800, 2400);
  }

  if (lastSnapshot.isUploading) {
    throw new Error(`YOUTUBE_UPLOAD_TIMEOUT: ${lastSnapshot.progressTxt || 'still uploading at 90s'}`);
  }
  return lastSnapshot;
}

async function closeUploadDialogDraftOnly(page) {
  // HARD SAFETY GATE: Never click #next-button, #done-button, Save, Publish, or Public.
  const closeBtn = await page.evaluate(() => {
    const deepAll = (root, sel) => {
      const out = [];
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n.querySelectorAll !== 'function') return;
        for (const el of n.querySelectorAll(sel)) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
        for (const el of n.querySelectorAll('*')) {
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(root);
      return out;
    };
    const isVis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const isForbidden = (el) => {
      const id = (el.id || '').toLowerCase();
      const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      if (id === 'next-button' || id === 'done-button') return true;
      return /^(next|save|publish|public|schedule|下一步|保存|发布|公开)$/i.test(txt) ||
        /^(next|save|publish|public|schedule|下一步|保存|发布|公开)$/i.test(aria);
    };

    const dlg = document.querySelector('ytcp-uploads-dialog');
    if (!dlg) return { alreadyClosed: true };

    const sels = [
      '#close-button',
      '#ytcp-uploads-dialog-close-button',
      'button[aria-label="Close"]',
      'button[aria-label="关闭"]',
      'ytcp-icon-button[aria-label="Close"]',
    ];
    for (const sel of sels) {
      const hit = deepAll(dlg, sel).find((el) => isVis(el) && !isForbidden(el));
      if (hit) {
        hit.scrollIntoView({ block: 'center' });
        const r = hit.getBoundingClientRect();
        return {
          found: true,
          selector: sel,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
      }
    }
    return { found: false };
  });

  if (closeBtn.alreadyClosed) return true;
  if (!closeBtn.found) throw new Error('YOUTUBE_DRAFT_CLOSE_BUTTON_NOT_FOUND');

  await humanMouseClick(page, closeBtn.x, closeBtn.y, { radius: 3, tag: 'yt' });
  await humanPause(1200, 2000, '关闭上传弹窗保存草稿', 'yt');

  const stillOpen = await page.evaluate(() => {
    const dlg = document.querySelector('ytcp-uploads-dialog');
    if (!dlg) return false;
    const closeEl =
      dlg.querySelector('#close-button, #ytcp-uploads-dialog-close-button, button[aria-label="Close"]');
    if (closeEl) {
      closeEl.click();
      return true;
    }
    return Boolean(document.querySelector('ytcp-uploads-dialog'));
  });
  if (stillOpen) await humanPause(1000, 1600);

  return page.evaluate(() => !document.querySelector('ytcp-uploads-dialog'));
}

async function verifyDraftOnContentPage(page, studioInfo, expectedTitle) {
  const origin = studioInfo?.origin || 'https://studio.youtube.com';
  const contentUrl = studioInfo?.channelId
    ? `${origin}/channel/${studioInfo.channelId}/videos/upload`
    : `${origin}/videos/upload`;

  await page.goto(contentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await humanPause(2500, 4000, '等待内容列表刷新', 'yt');

  const needleFull = expectedTitle.trim();
  const needlePrefix = needleFull.slice(0, Math.min(30, needleFull.length));

  for (let i = 0; i < 8; i++) {
    const check = await page.evaluate(
      ({ full, prefix }) => {
        const deepAll = (root, sel) => {
          const out = [];
          const walk = (n) => {
            if (!n || typeof n.querySelectorAll !== 'function') return;
            for (const el of n.querySelectorAll(sel)) out.push(el);
            for (const el of n.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
            }
          };
          walk(root);
          return out;
        };

        const rows = deepAll(document, 'ytcp-video-row, [role="row"]');
        const rowTexts = rows.map((r) => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
        const matchingRow = rowTexts.find((txt) => txt.includes(full) || (prefix.length >= 8 && txt.includes(prefix)));
        const hasDraftStatus = matchingRow
          ? /\bDraft\b|草稿/i.test(matchingRow)
          : /\bDraft\b|草稿/i.test(document.body?.innerText || '');

        return {
          url: location.href,
          rowCount: rows.length,
          titleInList: Boolean(matchingRow) || (document.body?.innerText || '').includes(full),
          hasDraftStatus,
          matchedSnippet: matchingRow ? matchingRow.slice(0, 160) : '',
        };
      },
      { full: needleFull, prefix: needlePrefix },
    );

    if (check.titleInList && check.hasDraftStatus) return check;
    if (i === 7) return check;
    await humanPause(1500, 2200);
  }
  return { titleInList: false, hasDraftStatus: false };
}

const task = await taskSpace('cp-yt-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

try {
  await page
    .goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((e) => console.warn('[yt] goto note:', e.message?.slice(0, 120)));
  await suppressNativeFileDialog(page);
  await humanPause(2500, 4200, 'Studio页加载', 'yt');

  const studioInfo = await waitForStudioReady(page);
  console.log('[yt] Studio ready:', JSON.stringify({ url: studioInfo?.href, channelId: studioInfo?.channelId }));

  await openUploadDialogAndSelectVideo(page, studioInfo);
  await waitForDetailsForm(page);

  await fillContentEditableField(page, 'title', title, { clearFirst: true });
  await humanPause(700, 1200, '标题填写后', 'yt');

  if (description) {
    await fillContentEditableField(page, 'description', description, { clearFirst: true });
    await humanPause(700, 1200, '简介填写后', 'yt');
    await blurByClickingHeader(page);
  }

  await uploadThumbnailIfPresent(page, coverPath);

  const kidsRes = await selectRadioDeep(page, {
    exactNames: ['VIDEO_MADE_FOR_KIDS_NOT_MFK', 'NOT_MADE_FOR_KIDS'],
    textRegex: /No,\s*it['’]?s not made for kids|不是，内容不是面向儿童的|不，内容不是面向儿童的|不是面向儿童/i,
    sectionRegex: /Audience|Made for kids|观众|面向儿童/i,
    excludeRegex: /^VIDEO_MADE_FOR_KIDS_MFK$/i,
  });
  console.log('[yt] audience not-made-for-kids:', JSON.stringify(kidsRes));
  await humanPause(600, 1000);

  if (aiGenerated || topics.length > 0) {
    await expandShowMore(page);

    if (aiGenerated) {
      const aiRes = await selectRadioDeep(page, {
        exactNames: ['VIDEO_ALTERED_CONTENT_YES'],
        textRegex: /^(Yes|是)\b/i,
        sectionRegex: /Altered content|altered or synthetic|经过修改|更改的内容|合成/i,
        excludeRegex: /KIDS|MFK|NO/i,
      });
      if (aiRes.ok) {
        console.log('YOUTUBE_AI_DECLARED');
      } else {
        console.warn('[yt] Altered/synthetic content Yes radio not confirmed:', JSON.stringify(aiRes));
      }
      await humanPause(500, 900);
    }

    if (topics.length > 0) {
      await insertTags(page, topics);
    }
  }

  const uploadStatus = await waitForUploadAndDraftSave(page);
  await safeShot(page, `${shotDir}/yt_before_draft.png`);
  await humanPause(1200, 2200, '点关闭保存草稿前', 'yt');

  const closedCleanly = await closeUploadDialogDraftOnly(page);
  console.log('[yt] upload dialog closed (draft-only):', closedCleanly);

  await humanPause(2500, 4000, '等待草稿保存', 'yt');
  const contentCheck = await verifyDraftOnContentPage(page, studioInfo, title);
  await safeShot(page, `${shotDir}/yt_after_draft.png`);

  const confirmed = (contentCheck.titleInList && contentCheck.hasDraftStatus) || (uploadStatus?.savedAsDraft && closedCleanly);
  if (confirmed) {
    console.log(
      'YOUTUBE_DRAFT_SAVED',
      JSON.stringify({
        title,
        verifiedInList: Boolean(contentCheck.titleInList),
        hasDraftStatus: Boolean(contentCheck.hasDraftStatus),
        dialogSavedAsDraft: Boolean(uploadStatus?.savedAsDraft),
      }),
    );
  } else {
    console.warn(
      'YOUTUBE_DRAFT_UNCONFIRMED_CHECK_STUDIO',
      JSON.stringify({ contentCheck, uploadStatus, closedCleanly }),
    );
  }
  console.log('spaceId', task.spaceId);
} finally {
  await task.finish({ keep: job.keepOpen ? [page.label || 'p1'] : [] });
}
