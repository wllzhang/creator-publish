// Ego Lite adapter for Gmail compose (draft by default; sends only when cfg.submit === true).

import { humanPause } from '../lib/pace.mjs';

const fs = await import('node:fs/promises');
const pathMod = await import('node:path');
const osMod = await import('node:os');

const CONFIG_PATH =
  process.env.CREATOR_PUBLISH_RUN || pathMod.join(osMod.tmpdir(), 'creator-publish-gmail-run.json');
const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
const RESULT_PATH =
  cfg.result_file ||
  process.env.CREATOR_PUBLISH_RESULT ||
  pathMod.join(osMod.tmpdir(), 'creator-publish-gmail-result.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const accountIndex = Number.isInteger(cfg.account_index) ? cfg.account_index : 0;
const toRecipients = Array.isArray(cfg.to) ? cfg.to : [String(cfg.to || '')].filter(Boolean);
const attachments = Array.isArray(cfg.attachments) ? cfg.attachments.filter(Boolean) : [];
const targetProfileId = cfg.profileId || cfg.profile_id || 'Profile 2';

const result = {
  platform: 'gmail',
  mode: cfg.submit ? 'submit' : 'draft',
  status: 'started',
  submitted: false,
  account_index: accountIndex,
  to: toRecipients,
  subject: cfg.subject,
  attachments,
  attachments_verified: attachments.length === 0,
  steps: [],
  warnings: [],
  started_at: new Date().toISOString(),
};

async function saveResult() {
  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
}

const step = (msg) => {
  result.steps.push(msg);
  console.log('[gmail]', msg);
};

console.log('[profile]', targetProfileId);
const spaceName = cfg.space_name || `gmail-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const task = await taskSpace(spaceName, { profileId: targetProfileId });
console.log('[gmail] spaceId:', task.spaceId);
const page = task.page('p1');

let exitCode = 0;

try {
  const composeUrl =
    `https://mail.google.com/mail/u/${accountIndex}/?fs=1` +
    `&to=${encodeURIComponent(toRecipients.join(','))}` +
    `&su=${encodeURIComponent(cfg.subject || '')}` +
    `&tf=cm`;

  step(`Opening Gmail compose (u/${accountIndex})`);
  try {
    await page.goto(composeUrl, { timeout: 25_000 });
  } catch {
    // Allow slow Gmail background XHRs as long as navigation committed
  }
  await humanPause(3500, 5200, 'wait compose load', 'gmail');

  const authState = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').slice(0, 400),
  }));

  if (/accounts\.google\.com|\/ServiceLogin|\/signin/i.test(authState.url)) {
    result.status = 'not_logged_in';
    result.detail = authState;
    result.finished_at = new Date().toISOString();
    await saveResult();
    console.error(`NOT_LOGGED_IN: Please sign into Gmail (u/${accountIndex}) in Ego profile "${targetProfileId}".`);
    exitCode = 4;
  } else {
    // Poll up to 25s for Gmail's message body textbox to mount
    let composeReady = false;
    for (let i = 0; i < 25; i++) {
      composeReady = await page.evaluate(() => {
        return Boolean(
          document.querySelector(
            'div[aria-label="Message Body"], div[aria-label="邮件正文"], div[role="textbox"][g_editable="true"], div[role="textbox"][contenteditable="true"]',
          ),
        );
      });
      if (composeReady) break;
      await sleep(1000);
    }
    if (!composeReady) {
      throw new Error(`Gmail compose editor did not mount at ${authState.url}`);
    }
    step('Compose editor mounted');

    // Verify/ensure subject input matches cfg.subject
    await page.evaluate((expectedSubject) => {
      const subInp = document.querySelector('input[name="subjectbox"]');
      if (subInp && subInp.value !== expectedSubject) {
        subInp.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(subInp, expectedSubject);
        else subInp.value = expectedSubject;
        subInp.dispatchEvent(new Event('input', { bubbles: true }));
        subInp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, cfg.subject || '');
    await humanPause(400, 900, 'subject verified', 'gmail');

    // Inject message body safely
    const bodyInjected = await page.evaluate((text) => {
      const divBody = document.querySelector(
        'div[aria-label="Message Body"], div[aria-label="邮件正文"], div[role="textbox"][g_editable="true"], div[role="textbox"][contenteditable="true"]',
      );
      if (!divBody) return { ok: false, len: 0 };
      divBody.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      divBody.dispatchEvent(new Event('input', { bubbles: true }));
      divBody.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, len: (divBody.innerText || '').trim().length };
    }, String(cfg.body || ''));

    if (!bodyInjected.ok) {
      throw new Error('Failed to locate Gmail Message Body editor for text injection');
    }
    step(`Body injected (${bodyInjected.len} chars)`);
    await humanPause(1200, 2200, 'after body injection', 'gmail');

    // Upload attachments and strictly verify each upload completes
    if (attachments.length > 0) {
      for (const attPath of attachments) {
        const fileName = pathMod.basename(attPath);
        step(`Uploading attachment: ${fileName}`);

        const hasFiledataInput = await page.evaluate(() => {
          return Boolean(document.querySelector('input[type="file"][name="Filedata"]'));
        });
        const inputSel = hasFiledataInput ? 'input[type="file"][name="Filedata"]' : 'input[type="file"]';
        const anyFileInput = await page.evaluate((sel) => Boolean(document.querySelector(sel)), inputSel);
        if (!anyFileInput) {
          throw new Error(`Gmail attachment file input (${inputSel}) not found in DOM`);
        }

        await page.setInputFiles(inputSel, attPath);
        // Allow Gmail time to mount progress bar / attachment row
        await sleep(1500);

        let uploadedOk = false;
        let lastProbe = null;
        for (let poll = 0; poll < 60; poll++) {
          lastProbe = await page.evaluate((targetName) => {
            const isVisible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              return el.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
            };

            // Check for upload error dialogs
            const dialogs = Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"]')).filter(isVisible);
            for (const d of dialogs) {
              const dt = (d.innerText || '').trim();
              if (/upload error|exceeds the|virus|blocked|上传错误|超过|无法上传/i.test(dt)) {
                return { error: dt.slice(0, 240) };
              }
            }

            // Check if any progress bar is still active
            const activeBars = Array.from(document.querySelectorAll('[role="progressbar"]')).filter(isVisible);
            const hasActiveProgress = activeBars.length > 0;

            // Verify attachment filename chip exists OUTSIDE the message body editor and subject input
            const isInsideEditor = (el) =>
              Boolean(
                el.closest(
                  'div[aria-label="Message Body"], div[aria-label="邮件正文"], div[role="textbox"][g_editable="true"], div[role="textbox"][contenteditable="true"]',
                ),
              ) || el.getAttribute('name') === 'subjectbox';

            const candidates = Array.from(
              document.querySelectorAll(
                '.dL, .vI, a[href], div[aria-label], span[aria-label], div[data-tooltip], span',
              ),
            );
            let hasChip = false;
            for (const el of candidates) {
              if (isInsideEditor(el)) continue;
              const aria = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-tooltip') || ''}`;
              const txt = (el.childElementCount <= 3 ? el.innerText || '' : '').trim();
              if (aria.includes(targetName) || txt.includes(targetName)) {
                if (isVisible(el) || el.closest('.dL')) {
                  hasChip = true;
                  break;
                }
              }
            }

            const hiddenAttachCount = document.querySelectorAll('input[name="attach"]').length;
            return {
              error: null,
              hasActiveProgress,
              hasChip,
              hiddenAttachCount,
            };
          }, fileName);

          if (lastProbe.error) {
            throw new Error(`Gmail rejected attachment "${fileName}": ${lastProbe.error}`);
          }
          if (lastProbe.hasChip && !lastProbe.hasActiveProgress) {
            uploadedOk = true;
            break;
          }
          await sleep(1000);
        }

        if (!uploadedOk) {
          throw new Error(
            `Attachment upload did not complete or verify for "${fileName}": ${JSON.stringify(lastProbe)}`,
          );
        }
        step(`Attachment verified: ${fileName}`);
        await humanPause(700, 1400, 'between attachments', 'gmail');
      }
      result.attachments_verified = true;
    }

    if (!cfg.submit) {
      // Draft mode (default): wait >= 3s for Gmail draft auto-save and DO NOT click Send
      step('Waiting for Gmail draft auto-save (draft mode)...');
      await sleep(3200);
      const draftState = await page.evaluate(() => {
        const txt = document.body?.innerText || '';
        return {
          draftSavedHint: /\bSaved\b|Draft saved|已保存/i.test(txt),
          url: location.href,
        };
      });
      result.status = 'draft';
      result.submitted = false;
      result.draft_saved = draftState.draftSavedHint;
      result.finished_at = new Date().toISOString();
      step('Draft ready in Gmail (Send NOT clicked)');
      await saveResult();
    } else {
      // Submit mode: click Send and poll up to 15s for "Message sent" / "Sent" toast
      await humanPause(900, 1800, 'before Send click', 'gmail');
      step('Clicking Send...');
      const clickInfo = await page.evaluate(() => {
        const isVisible = (el) => el && el.offsetParent !== null && window.getComputedStyle(el).display !== 'none';
        const btns = Array.from(document.querySelectorAll('div[role="button"], button')).filter(isVisible);
        const sendBtn = btns.find((b) => {
          const label = (
            b.innerText?.trim() ||
            b.getAttribute('aria-label') ||
            b.getAttribute('data-tooltip') ||
            ''
          ).trim();
          const isSend =
            label === 'Send' ||
            label.startsWith('Send ') ||
            label === '发送' ||
            label.startsWith('发送 ');
          const isSchedule = /schedule|定时/i.test(label);
          return isSend && !isSchedule;
        });
        if (sendBtn) {
          sendBtn.click();
          return { clicked: true, via: 'button', label: sendBtn.getAttribute('aria-label') || sendBtn.innerText?.trim() };
        }
        return { clicked: false };
      });

      if (!clickInfo.clicked) {
        step('Explicit Send button not matched; pressing Control+Enter');
        await page.keyboard.press('Control+Enter');
      } else {
        step(`Clicked Send (${clickInfo.label || 'button'})`);
      }

      let sentConfirmed = false;
      for (let i = 0; i < 15; i++) {
        await sleep(1000);
        const check = await page.evaluate(() => {
          const alerts = Array.from(
            document.querySelectorAll('[role="alert"], .vh, .bAq, [aria-live="assertive"], [aria-live="polite"]'),
          )
            .map((el) => (el.innerText || '').trim())
            .filter(Boolean)
            .join(' | ');
          const bodyText = document.body?.innerText || '';
          const toastHit = /Message sent|Your message has been sent|\bSent\b|邮件已发送|已发送/i.test(alerts);
          const bodyHit = /Message sent|Your message has been sent|邮件已发送/i.test(bodyText);
          return {
            confirmed: Boolean(toastHit || bodyHit),
            alerts: alerts.slice(0, 200),
          };
        });
        if (check.confirmed) {
          sentConfirmed = true;
          result.toast = check.alerts;
          break;
        }
      }

      result.status = sentConfirmed ? 'submitted' : 'submit_unconfirmed';
      result.submitted = sentConfirmed;
      result.finished_at = new Date().toISOString();
      exitCode = sentConfirmed ? 0 : 1;
      step(sentConfirmed ? 'Email send confirmed via Gmail toast' : 'Email send toast NOT confirmed within 15s');
      await saveResult();
    }
  }
} catch (err) {
  result.status = 'failed';
  result.submitted = false;
  result.error = String((err && err.message) || err);
  result.finished_at = new Date().toISOString();
  console.error('[gmail:error]', result.error);
  exitCode = 1;
  try {
    await saveResult();
  } catch { /* ignore */ }
} finally {
  await task.finish({ keep: [] });
  process.exit(exitCode);
}
