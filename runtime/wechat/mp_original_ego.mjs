/**
 * WeChat MP Ego post-step: open newly created draft in mp.weixin.qq.com,
 * declare Original (声明原创), verify Comments enabled (开启留言), and save as draft (NEVER publish).
 *
 * Driven by CREATOR_PUBLISH_JOB JSON written by wechat_mp_draft.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadJob } from '../lib/load_job.mjs';
import { humanPause, humanMouseClick } from '../lib/pace.mjs';

const { job } = loadJob();
const profileId = job.profileId || 'Profile 2';
const title = String(job.title || '').trim();
const author = String(job.author || '').trim();
const wantOriginal = job.original !== false;
const wantComment = job.comment !== false;
const onlyFansComment = !!job.onlyFansComment;
const shotDir = job.shotDir ? path.resolve(job.shotDir) : null;
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

async function safeShot(page, name) {
  if (!shotDir) return;
  try {
    await page.screenshot({ path: path.join(shotDir, name) });
  } catch {
    /* ignore */
  }
}

async function dismissTips(page) {
  await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('.weui-desktop-dialog'));
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const txt = (d.innerText || '').replace(/\s+/g, ' ');
      if (/声明类型|文字原创|留言/.test(txt)) continue;
      const btn = Array.from(d.querySelectorAll('button')).find((b) =>
        /我知道了|知道了|关闭/.test((b.innerText || '').trim()),
      );
      if (btn) btn.click();
    }
  });
}

async function findDraftEditUrl(page, token, targetTitle) {
  const needleFull = targetTitle.trim();
  const needle16 = needleFull.slice(0, 16);
  const needle10 = needleFull.slice(0, 10);

  // 1) Try authenticated draft list JSON endpoint first (fast & reliable)
  const fromApi = await page.evaluate(
    async ({ tk, nFull, n16, n10 }) => {
      const endpoints = [
        `/cgi-bin/appmsg?action=list_ex&begin=0&count=10&type=77&token=${tk}&lang=zh_CN&f=json`,
        `/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=${tk}&lang=zh_CN&f=json`,
      ];
      for (const ep of endpoints) {
        try {
          const res = await fetch(ep, { credentials: 'include' });
          if (!res.ok) continue;
          const j = await res.json();
          const list = j.app_msg_list || j.item || j.draft_list || [];
          for (const it of list) {
            const multi = it.multi_item || it.content?.news_item || [it];
            for (const sub of multi) {
              const t = String(sub.title || it.title || '').trim();
              if (!t) continue;
              if (t === nFull || (n16 && t.includes(n16)) || (n10 && t.includes(n10))) {
                const appmsgid = it.appmsgid || it.app_id || sub.appmsgid || '';
                if (appmsgid) {
                  return {
                    source: ep,
                    appmsgid: String(appmsgid),
                    title: t,
                    url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=0&type=77&appmsgid=${appmsgid}&token=${tk}&lang=zh_CN`,
                  };
                }
              }
            }
          }
        } catch {
          /* try next */
        }
      }
      return null;
    },
    { tk: token, nFull: needleFull, n16: needle16, n10: needle10 },
  );
  if (fromApi?.url) return fromApi;

  // 2) Fallback: load Draft Box card list and inspect DOM links/cards
  await page
    .goto(
      `https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=${token}&lang=zh_CN`,
      { waitUntil: 'load' },
    )
    .catch(() => {});
  await humanPause(2500, 3800, '草稿箱列表加载', 'wxmp');

  const fromDom = await page.evaluate(
    ({ tk, nFull, n16, n10 }) => {
      const matchText = (txt) => {
        const s = String(txt || '').replace(/\s+/g, ' ');
        return s.includes(nFull) || (n16 && s.includes(n16)) || (n10 && s.includes(n10));
      };
      // Check window.wx.cgiData if present
      try {
        const items = window.wx?.cgiData?.item || window.cgiData?.item || [];
        for (const it of items) {
          const multi = it.multi_item || [it];
          for (const sub of multi) {
            if (matchText(sub.title || it.title)) {
              const id = it.app_id || it.appmsgid;
              if (id) {
                return {
                  source: 'cgiData',
                  appmsgid: String(id),
                  title: sub.title || it.title,
                  url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=0&type=77&appmsgid=${id}&token=${tk}&lang=zh_CN`,
                };
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
      // Check DOM cards
      const links = Array.from(document.querySelectorAll('a[href*="appmsg_edit"], a[href*="action=edit"]'));
      for (const a of links) {
        const card = a.closest('.weui-desktop-card, .appmsg, .weui-desktop-mass-appmsg, li, .js_draft_item') || a.parentElement;
        if (matchText(card?.innerText || a.innerText)) {
          const href = a.getAttribute('href') || '';
          const absUrl = href.startsWith('http') ? href : `https://mp.weixin.qq.com${href}`;
          return { source: 'dom-link', url: absUrl, title: (card?.innerText || '').slice(0, 60) };
        }
      }
      return null;
    },
    { tk: token, nFull: needleFull, n16: needle16, n10: needle10 },
  );
  return fromDom;
}

const task = await taskSpace('cp-wxmp-' + Date.now(), { profileId });
const page = task.page('p1');

try {
  await page.goto('https://mp.weixin.qq.com/', { waitUntil: 'load' }).catch(() => {});
  await humanPause(2600, 4000, '公众号后台加载', 'wxmp');

  const curUrl = await page.url();
  const tokMatch = curUrl.match(/[?&]token=(\d+)/);
  if (!tokMatch || /login/i.test(curUrl)) {
    console.log('NEED_LOGIN_WECHAT_MP', curUrl);
    throw new Error('NEED_LOGIN_WECHAT_MP');
  }
  const token = tokMatch[1];
  console.log('[wxmp] logged in, token detected');

  const draft = await findDraftEditUrl(page, token, title);
  if (!draft?.url) {
    throw new Error(`WECHAT_MP_DRAFT_NOT_FOUND_IN_LIST: ${title}`);
  }
  console.log('[wxmp] located draft:', JSON.stringify({ source: draft.source, appmsgid: draft.appmsgid || '' }));

  await page.goto(draft.url, { waitUntil: 'load' }).catch(() => {});
  await humanPause(3200, 4600, '草稿编辑页加载', 'wxmp');
  await dismissTips(page);
  await humanPause(500, 900, '关闭提示后', 'wxmp');
  await safeShot(page, 'wechat_mp_before_settings.png');

  // 1) Declare Original (声明原创)
  let originalDeclared = false;
  if (wantOriginal) {
    const alreadyOn = await page.evaluate(() => {
      const openEl = document.querySelector('#js_original_open');
      if (openEl && openEl.getBoundingClientRect().height > 0) return true;
      const box = document.querySelector('#js_original');
      const txt = (box?.innerText || '').replace(/\s+/g, ' ');
      return !!(txt && !txt.includes('未声明') && /编辑声明|已声明|文字原创/.test(txt));
    });

    if (alreadyOn) {
      console.log('WECHAT_MP_ORIGINAL_ALREADY_ON');
      originalDeclared = true;
    } else {
      const triggerBox = await page.evaluate(() => {
        const el =
          document.querySelector('#js_original .setting-group__switch.js_original_apply') ||
          document.querySelector('#js_original .js_original_apply') ||
          document.querySelector('#js_original');
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el.innerText || '').trim() };
      });
      if (!triggerBox) throw new Error('WECHAT_MP_ORIGINAL_TRIGGER_NOT_FOUND');

      await humanPause(400, 800, '准备点原创声明', 'wxmp');
      await humanMouseClick(page, triggerBox.x, triggerBox.y, { radius: 4, tag: 'wxmp' });
      await humanPause(1200, 1900, '等待原创弹窗', 'wxmp');

      const modalResult = await page.evaluate((authorVal) => {
        const dialogs = Array.from(document.querySelectorAll('.weui-desktop-dialog')).filter((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 80 && r.height > 80 && /声明类型|文字原创/.test(d.innerText || '');
        });
        const dlg = dialogs[0];
        if (!dlg) return { ok: false, reason: 'no original dialog found' };

        // Ensure 文字原创 (value="0") is selected
        const textRadio = dlg.querySelector('input.js_original_type_radio[value="0"], input[type="radio"][value="0"]');
        if (textRadio && !textRadio.checked) textRadio.click();

        // Fill author (max 8 chars) if input exists and empty
        const authorInput = dlg.querySelector('input.js_counter.js_author, input[placeholder="请输入作者"]');
        const shortAuthor = String(authorVal || '').trim().slice(0, 8);
        if (authorInput && shortAuthor && !authorInput.value.trim()) {
          authorInput.focus();
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(authorInput, shortAuthor);
          else authorInput.value = shortAuthor;
          authorInput.dispatchEvent(new Event('input', { bubbles: true }));
          authorInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Ensure original agreement checkbox is checked
        const agreeBox = Array.from(dlg.querySelectorAll('input[type="checkbox"].weui-desktop-form__checkbox')).find(
          (cb) => /协议/.test(cb.closest('label, div')?.innerText || ''),
        );
        if (agreeBox && !agreeBox.checked) agreeBox.click();

        const okBtn = Array.from(dlg.querySelectorAll('button.weui-desktop-btn_primary, button')).find(
          (b) => (b.innerText || '').trim() === '确定' && !b.disabled,
        );
        if (!okBtn) return { ok: false, reason: 'confirm button not found or disabled' };
        const r = okBtn.getBoundingClientRect();
        return {
          ok: true,
          authorUsed: authorInput?.value || '',
          agreeChecked: agreeBox ? !!agreeBox.checked : null,
          btn: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
        };
      }, author);

      if (!modalResult.ok) {
        throw new Error(`WECHAT_MP_ORIGINAL_MODAL_FAIL: ${modalResult.reason}`);
      }
      console.log('[wxmp] original modal ready:', JSON.stringify({ authorUsed: modalResult.authorUsed, agreeChecked: modalResult.agreeChecked }));
      await humanPause(500, 900, '点原创确定前', 'wxmp');
      await humanMouseClick(page, modalResult.btn.x, modalResult.btn.y, { radius: 4, tag: 'wxmp' });
      await humanPause(1400, 2200, '原创确认后', 'wxmp');

      originalDeclared = await page.evaluate(() => {
        const openEl = document.querySelector('#js_original_open');
        if (openEl && openEl.getBoundingClientRect().height > 0) return true;
        const box = document.querySelector('#js_original');
        const txt = (box?.innerText || '').replace(/\s+/g, ' ');
        return !!(txt && !txt.includes('未声明'));
      });
      if (!originalDeclared) {
        throw new Error('WECHAT_MP_ORIGINAL_NOT_CONFIRMED_AFTER_OK');
      }
      console.log('WECHAT_MP_ORIGINAL_DECLARED');
    }
  }

  // 2) Verify / Enable Comments (开启留言)
  let commentEnabled = false;
  if (wantComment) {
    const commentState = await page.evaluate(() => {
      const area = document.querySelector('#js_comment_and_fansmsg_area');
      if (!area) return { found: false, text: '' };
      area.scrollIntoView({ block: 'center' });
      const text = (area.innerText || '').replace(/\s+/g, ' ').trim();
      const disabled = /未开启|不开启|已关闭/.test(text);
      const r = area.getBoundingClientRect();
      return { found: true, text, disabled, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    console.log('[wxmp] comment area state:', JSON.stringify({ found: commentState.found, text: commentState.text, disabled: commentState.disabled }));

    if (commentState.found && !commentState.disabled) {
      commentEnabled = true;
      console.log('WECHAT_MP_COMMENT_VERIFIED_ON');
    } else if (commentState.found && commentState.disabled) {
      await humanPause(400, 800, '准备开启留言', 'wxmp');
      await humanMouseClick(page, commentState.x, commentState.y, { radius: 4, tag: 'wxmp' });
      await humanPause(1000, 1600, '等待留言设置弹窗', 'wxmp');

      const cRes = await page.evaluate((onlyFans) => {
        const dlg = Array.from(document.querySelectorAll('.weui-desktop-dialog')).find((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 80 && r.height > 80 && /留言/.test(d.innerText || '');
        });
        if (!dlg) return { ok: false, reason: 'no comment dialog' };
        const sw = dlg.querySelector('input[type="checkbox"].weui-desktop-switch__input, input[type="checkbox"]');
        if (sw && !sw.checked) sw.click();
        const radios = Array.from(dlg.querySelectorAll('label, input[type="radio"]'));
        const wantRe = onlyFans ? /关注后可留言|仅粉丝/ : /所有人可留言/;
        for (const el of radios) {
          if (wantRe.test(el.innerText || '')) {
            el.click();
            break;
          }
        }
        const okBtn = Array.from(dlg.querySelectorAll('button.weui-desktop-btn_primary, button')).find(
          (b) => (b.innerText || '').trim() === '确定' && !b.disabled,
        );
        if (!okBtn) return { ok: false, reason: 'no confirm button' };
        const r = okBtn.getBoundingClientRect();
        return { ok: true, btn: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
      }, onlyFansComment);

      if (cRes.ok) {
        await humanPause(400, 800, '确认留言设置', 'wxmp');
        await humanMouseClick(page, cRes.btn.x, cRes.btn.y, { radius: 4, tag: 'wxmp' });
        await humanPause(1000, 1600, '留言确认后', 'wxmp');
        commentEnabled = true;
        console.log('WECHAT_MP_COMMENT_ENABLED_VIA_UI');
      } else {
        console.warn('[wxmp] comment UI toggle skipped:', cRes.reason);
      }
    }
  }

  // 3) Save as Draft (保存为草稿) — NEVER click 发表/群发
  const saveBtn = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a'));
    const target = btns.find((b) => {
      const t = (b.innerText || '').trim();
      return t === '保存为草稿' && !/发表|群发/.test(t) && b.getBoundingClientRect().width > 0;
    });
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (target.innerText || '').trim() };
  });
  if (!saveBtn) throw new Error('WECHAT_MP_SAVE_DRAFT_BTN_NOT_FOUND');

  await humanPause(500, 900, '点保存为草稿前', 'wxmp');
  await humanMouseClick(page, saveBtn.x, saveBtn.y, { radius: 4, tag: 'wxmp' });
  await humanPause(2500, 3800, '等待草稿保存确认', 'wxmp');

  const afterCheck = await page.evaluate(() => {
    const toast = (document.querySelector('.weui-desktop-tips, .js_tips, .weui-desktop-toast, [class*="toast"]')?.innerText || '').trim();
    const origOpen = !!(document.querySelector('#js_original_open')?.getBoundingClientRect().height > 0);
    const origTxt = (document.querySelector('#js_original_open, #js_original')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const commentTxt = (document.querySelector('#js_comment_and_fansmsg_area')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return { toast, origOpen, origTxt, commentTxt };
  });
  await safeShot(page, 'wechat_mp_after_settings.png');
  console.log('[wxmp] after save:', JSON.stringify(afterCheck));
  console.log('WECHAT_MP_ORIGINAL_SAVED', JSON.stringify({ originalDeclared, commentEnabled }));
} finally {
  await task.finish({ keep: job.keepOpen ? [page.label || 'p1'] : [] });
}
