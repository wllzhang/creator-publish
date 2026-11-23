/**
 * 视频号：支持 document / iframe / wujie-app shadowRoot 多根挂载。
 * 上传视频 → 填短标题与视频描述 → 用「#话题」+ 优先选热词下拉推荐/敲空格生成蓝色话题标签 + 按需关联推荐话题/活动 → 点「保存草稿」（不点发表）。
 * job: profileId, video, title（短标题）, body（可选）, topics（可选）, hotspot?, activity?, autoHotspot?, shotDir?
 */
import path from 'node:path';
import { humanPause, humanMouseClick, humanInsertText } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';
import {
  resolveShotDir,
  safeShot,
  evalAllRoots,
  normalizeTopics,
  deriveHotspotKeywords,
  cleanSuggestLabel,
  scoreCandidateMatch,
  parseScheduleTime,
  suppressNativeFileDialog,
} from '../lib/ego_dom.mjs';

function toChannelsShortTitle(raw) {
  const s = String(raw || '')
    .replace(/[，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(s);
  if (chars.length <= 16) return s;
  return chars.slice(0, 16).join('').replace(/[，。；：、,\s]+$/, '');
}

const { job } = loadJob();
const videoPath = abs(job.video);
const shortTitle = toChannelsShortTitle(job.title);
const topics = normalizeTopics(job.topics);
const postContent =
  job.body === ''
    ? ''
    : job.body != null
      ? String(job.body).trim()
      : topics.length
        ? ''
        : String(job.title || '').trim();
const autoHotspot = job.autoHotspot !== false;
const hotspotKeywords = deriveHotspotKeywords(job);
const shotDir = resolveShotDir(job);
const schedule = parseScheduleTime(job.scheduleTime);

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

async function waitUploadDone(timeoutMs = Number(process.env.WEIXIN_CHANNELS_UPLOAD_TIMEOUT_MS || 480000)) {
  const start = Date.now();
  let ticks = 0;
  let lastReady = false;
  while (Date.now() - start < timeoutMs) {
    const st = await evalAllRoots(page, (roots) => {
      for (const { name, root } of roots) {
        const text = (root.body?.innerText || root.textContent || '').replace(/\s+/g, ' ');
        const videos = root.querySelectorAll('video').length;
        const hasEditor = !!root.querySelector('.input-editor, [contenteditable="true"]');
        const uploading = /上传中|正在上传|处理中|转码中|生成中|裁剪中|校验中|\d+\s*%/.test(text);
        const ready = (videos > 0 || /删除视频|更换视频|编辑封面|删除/.test(text)) && hasEditor;
        if (ready) return { root: name, videos, uploading, ready, snippet: text.slice(0, 120) };
      }
      return { videos: 0, uploading: false, ready: false, snippet: '' };
    });
    if (ticks % 5 === 0 || st.ready !== lastReady || st.uploading) {
      console.log('upload wait', st);
    }
    lastReady = !!st.ready;
    if (st.ready && !st.uploading && ticks >= 4) return st;
    ticks++;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('WEIXIN_CHANNELS_UPLOAD_TIMEOUT');
}

try {
  await page.goto('https://channels.weixin.qq.com/platform/post/create', { waitUntil: 'load' }).catch(() => {});
  await suppressNativeFileDialog(page);
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

    // Prefer live topic suggestion item if popover appears; otherwise Space converts `#word ` to <span class="hl topic">.
    if (topics.length) {
      if (postContent) {
        await page.keyboard.press('Enter');
        await humanPause(200, 400);
      }
      for (const kw of topics) {
        const beforeSpanCount = await evalAllRoots(page, (roots) => {
          for (const { root } of roots) {
            const ed = root.querySelector(
              '.post-desc-box [contenteditable="true"], .input-editor, [contenteditable="true"]',
            );
            if (ed) return ed.querySelectorAll('span.hl.topic, span[data-type="topic"]').length;
          }
          return 0;
        });

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
        await humanPause(280, 480);
        // Humanized key rhythm so topic conversion is not machine-uniform.
        await page.keyboard.type(kw, { delay: 35 + Math.floor(Math.random() * 55) });
        await humanPause(550, 900);

        const suggestItems = await evalAllRoots(page, (roots) => {
          const out = [];
          const sels = [
            '[class*="topic-suggest"] [class*="item"]',
            '[class*="suggest"] [class*="item"]',
            '[class*="mention"] [class*="item"]',
            '[class*="topic"] ul li',
            '[class*="popover"] li',
            '[role="option"]',
          ];
          for (const { name, root } of roots) {
            const seen = new Set();
            for (const sel of sels) {
              for (const el of Array.from(root.querySelectorAll(sel))) {
                if (seen.has(el) || el.closest('[contenteditable="true"]')) continue;
                seen.add(el);
                const r = el.getBoundingClientRect();
                const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                if (r.width <= 20 || r.height <= 14 || r.height > 72 || !t || t === '#话题') continue;
                out.push({ root: name, text: t, idx: out.length });
              }
            }
          }
          return out.slice(0, 15);
        });

        let pickedSuggest = false;
        if (suggestItems.length) {
          const ranked = suggestItems
            .map((it) => ({
              ...it,
              score: scoreCandidateMatch(cleanSuggestLabel(it.text), [kw, ...hotspotKeywords]),
            }))
            .filter((it) => it.score >= 350)
            .sort((a, b) => b.score - a.score);
          const pick = ranked[0];
          if (pick) {
            pickedSuggest = await evalAllRoots(
              page,
              (roots, targetText) => {
                const sels = [
                  '[class*="topic-suggest"] [class*="item"]',
                  '[class*="suggest"] [class*="item"]',
                  '[class*="mention"] [class*="item"]',
                  '[class*="topic"] ul li',
                  '[class*="popover"] li',
                  '[role="option"]',
                ];
                for (const { root } of roots) {
                  for (const sel of sels) {
                    for (const el of Array.from(root.querySelectorAll(sel))) {
                      if (el.closest('[contenteditable="true"]')) continue;
                      const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
                      if (t === targetText && el.getBoundingClientRect().width > 0) {
                        el.click();
                        return true;
                      }
                    }
                  }
                }
                return false;
              },
              pick.text,
            );
            if (pickedSuggest) {
              console.log('WXCH_TOPIC_SUGGEST_PICKED:', pick.text);
              await humanPause(250, 450);
            }
          }
        }

        const afterSpanCount = await evalAllRoots(page, (roots) => {
          for (const { root } of roots) {
            const ed = root.querySelector(
              '.post-desc-box [contenteditable="true"], .input-editor, [contenteditable="true"]',
            );
            if (ed) return ed.querySelectorAll('span.hl.topic, span[data-type="topic"]').length;
          }
          return 0;
        });

        if (!pickedSuggest || afterSpanCount <= beforeSpanCount) {
          await page.keyboard.type(' ');
        }
        await humanPause(350, 650);
      }

      let topicSpans = await evalAllRoots(page, (roots) => {
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

      if (autoHotspot && topicSpans < 5) {
        const recTopics = await evalAllRoots(page, (roots) => {
          const out = [];
          for (const { root } of roots) {
            const ed = root.querySelector('.post-desc-box [contenteditable="true"], .input-editor');
            const box = ed?.closest('.post-desc-box') || ed?.parentElement?.parentElement;
            if (!box) continue;
            for (const el of Array.from(box.querySelectorAll('span, div, button, a'))) {
              if (el.closest('[contenteditable="true"]') || el.childElementCount > 1) continue;
              const t = (el.innerText || '').trim();
              const r = el.getBoundingClientRect();
              if (r.width > 0 && /^#[^\s]{2,16}$/.test(t) && t !== '#话题') {
                out.push(t);
              }
            }
          }
          return [...new Set(out)].slice(0, 12);
        });
        const rankedRec = recTopics
          .filter((t) => !topics.includes(t.replace(/^#/, '')))
          .map((t) => ({ text: t, score: scoreCandidateMatch(t, hotspotKeywords, { includeGeneralHints: true }) }))
          .filter((x) => x.score >= 100)
          .sort((a, b) => b.score - a.score)
          .slice(0, Math.min(2, 5 - topicSpans));
        for (const rItem of rankedRec) {
          const clickedRec = await evalAllRoots(
            page,
            (roots, textTarget) => {
              for (const { root } of roots) {
                for (const el of Array.from(root.querySelectorAll('span, div, button, a'))) {
                  if (el.closest('[contenteditable="true"]')) continue;
                  if ((el.innerText || '').trim() === textTarget && el.getBoundingClientRect().width > 0) {
                    el.click();
                    return true;
                  }
                }
              }
              return false;
            },
            rItem.text,
          );
          if (clickedRec) {
            console.log('WXCH_RECOMMEND_TOPIC_ADDED:', rItem.text);
            await humanPause(300, 500);
          }
        }
      }
    }
  } else {
    console.warn('[wxch] description editor not found; skipping body/topics');
  }

  if (autoHotspot) {
    try {
      const activityCandidates = await evalAllRoots(page, (roots) => {
        for (const { root } of roots) {
          const lbl = Array.from(root.querySelectorAll('div, span, label')).find((el) => {
            const t = (el.innerText || '').replace(/\s+/g, '').trim();
            return /^(?:参加活动|参与活动|活动)$/.test(t) && el.childElementCount <= 1 && el.getBoundingClientRect().width > 0;
          });
          if (!lbl) continue;
          let box = lbl.parentElement;
          for (let d = 0; d < 2 && box; d++) {
            const items = Array.from(box.querySelectorAll('div, span, button, li')).filter((el) => {
              if (el === lbl || el.childElementCount > 2) return false;
              if (el.closest('[contenteditable="true"], .post-desc-box')) return false;
              const r = el.getBoundingClientRect();
              const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
              return (
                r.width > 24 &&
                r.height > 16 &&
                r.height < 52 &&
                t &&
                !/活动|选择|请选择|不参加|不参与/.test(t)
              );
            });
            if (items.length) {
              return items.slice(0, 12).map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim());
            }
            box = box.parentElement;
          }
        }
        return [];
      });
      const bestAct = activityCandidates
        .map((t) => ({ text: t, score: scoreCandidateMatch(t, hotspotKeywords, { includeGeneralHints: true }) }))
        .filter((x) => x.score >= 100)
        .sort((a, b) => b.score - a.score)[0];
      if (bestAct) {
        await evalAllRoots(
          page,
          (roots, target) => {
            for (const { root } of roots) {
              const hit = Array.from(root.querySelectorAll('div, span, button, li')).find(
                (el) => (el.innerText || '').replace(/\s+/g, ' ').trim() === target && el.getBoundingClientRect().width > 0,
              );
              if (hit) {
                hit.click();
                return true;
              }
            }
            return false;
          },
          bestAct.text,
        );
        console.log('WXCH_ACTIVITY_ASSOCIATED:', bestAct.text);
      }
    } catch (e) {
      console.warn('[wxch] activity probe note:', String(e?.message || e).slice(0, 100));
    }
  }
  await humanPause(1200, 2200, '正文话题后', 'wxch');

  // 位置设置：默认不添加位置（清除平台根据 IP 自动匹配的所在地，如「洛阳市」）
  try {
    const locState = await evalAllRoots(page, (roots) => {
      for (const { root } of roots) {
        const posDisplay = root.querySelector('.post-position-wrap .position-display');
        const locNameEl = root.querySelector('.post-position-wrap .location-name');
        const currentLoc = locNameEl ? (locNameEl.innerText || '').trim() : '';
        if (posDisplay && currentLoc && currentLoc !== '不显示位置') {
          posDisplay.click();
          return { ok: true, currentLoc };
        }
      }
      return { ok: false };
    });
    if (locState?.ok) {
      await humanPause(600, 1000);
      const optClicked = await evalAllRoots(page, (roots) => {
        for (const { root } of roots) {
          const target = Array.from(root.querySelectorAll('.option-item')).find((el) => {
            const t = (el.innerText || '').trim();
            return t === '不显示位置' || t.includes('不显示位置');
          });
          if (target) {
            target.scrollIntoView({ block: 'center' });
            target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
            target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            target.click();
            return true;
          }
        }
        return false;
      });
      console.log(`[wxch] 清除位置（原默认: ${locState.currentLoc} -> 已切换为 不显示位置）:`, optClicked);
      await humanPause(500, 800);
    }
  } catch (e) {
    console.warn('[wxch] 位置设置 note:', String(e?.message || e).slice(0, 100));
  }

  if (schedule) {
    console.log(`[wxch] 定时发布需求: ${schedule.dateTimeStr}`);
    // 微信视频号平台限制：页面明确提示「使用定时发表将无法保存草稿。若要保存草稿，需先取消定时发表。」
    // 且开启「定时」后平台自动禁用「保存草稿」按钮。
    // 在草稿模式（mode: draft）下，严格遵守只入草稿箱安全红线，保持「不定时」以正常点击「保存草稿」，并在日志中明确记录预定时间。
    console.warn(`[wxch] 平台限制：微信视频号选择「定时发表」将无法保存草稿。按安全红线暂存草稿箱，预定发表时间为: ${schedule.dateTimeStr}`);
  }

  await safeShot(page, path.join(shotDir, 'channels_before_draft.png'), { fullPage: true });

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
      const btn = Array.from(
        root.querySelectorAll('button, [role="button"], span, .weui-desktop-dialog__close-btn, [class*="close"]'),
      ).find((el) => {
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return (
          t === '确定' ||
          t === '知道了' ||
          t === '我知道了' ||
          el.classList?.contains('weui-desktop-dialog__close-btn') ||
          el.getAttribute('aria-label') === '关闭'
        );
      });
      btn?.click();
    }
  });

  let saved = false;
  let lastErr = '';
  for (let w = 0; w < 20; w++) {
    await humanPause(600, 1000);
    const state = await evalAllRoots(
      page,
      (roots, expectTitle) => {
        const toastNodes = [];
        for (const { root } of roots) {
          for (const el of Array.from(
            root.querySelectorAll('[class*="toast"], [class*="message"], [class*="tips"], .weui-desktop-tips'),
          )) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (t && el.getBoundingClientRect().height > 0) toastNodes.push(t);
          }
        }
        const toast = toastNodes.join(' | ');
        const href = location.href || '';
        const text = roots
          .map((r) => {
            const el = r.root.body || r.root;
            return el.innerText || el.textContent || '';
          })
          .join('\n')
          .slice(0, 12000);
        const hasErr = /不成功|失败|超过\d+字|限制/.test(toast);
        const toastOk = !hasErr && /草稿.*成功|保存成功|已保存至草稿|成功保存/.test(toast);
        const leftCreate = /draftListManager|草稿箱/.test(href) || !/post\/create/.test(href);
        const titleSeen = expectTitle && text.includes(expectTitle);
        return { toast, hasErr, toastOk, leftCreate, titleSeen, href };
      },
      shortTitle,
    );
    if (state.hasErr) {
      lastErr = state.toast;
      console.warn('WEIXIN_CHANNELS_SAVE_WARNING:', state.toast);
      if (w === 3) {
        await humanPause(3000, 4500);
        await evalAllRoots(page, (roots) => {
          const compact = (el) => (el.innerText || '').replace(/\s+/g, '').trim();
          for (const { root } of roots) {
            const btn = Array.from(root.querySelectorAll('button')).find((el) => compact(el) === '保存草稿');
            btn?.click();
          }
        });
      }
      continue;
    }
    if (state.toastOk || (state.leftCreate && state.titleSeen)) {
      saved = true;
      console.log('WEIXIN_CHANNELS_DRAFT_SAVED', JSON.stringify(state));
      break;
    }
  }

  // Always verify in 视频号草稿箱列表页 if still on create page
  if (!/draftListManager/.test(await page.url())) {
    await page
      .goto('https://channels.weixin.qq.com/platform/post/draftListManager', { waitUntil: 'load' })
      .catch(() => {});
    await humanPause(2500, 3800, '核验草稿箱', 'wxch');
    const listNeedle = (postContent || (topics.length ? topics[0] : shortTitle)).replace(/\s+/g, ' ').trim().slice(0, 16);
    const inList = await evalAllRoots(
      page,
      (roots, needles) => {
        const text = roots
          .map((r) => {
            const el = r.root.body || r.root;
            return el.innerText || el.textContent || '';
          })
          .join('\n');
        return needles.some((n) => n && text.includes(n));
      },
      [shortTitle, listNeedle, ...topics.map((t) => '#' + t), '草稿箱'],
    );
    if (inList) {
      saved = true;
      console.log('WEIXIN_CHANNELS_DRAFT_VERIFIED_IN_LIST:', listNeedle || shortTitle);
    }
  }

  await safeShot(page, path.join(shotDir, 'channels_after_draft.png'));
  console.log(saved ? 'WEIXIN_CHANNELS_DRAFT_DONE' : 'WEIXIN_CHANNELS_DRAFT_UNCONFIRMED');
  console.log('spaceId', task.spaceId);
  if (!saved) {
    throw new Error(`WEIXIN_CHANNELS_DRAFT_NOT_SAVED: ${lastErr || 'not found in draftListManager'}`);
  }
} finally {
  await task.finish({ keep: job.keepOpen ? [page.label || 'p1'] : [] });
}
