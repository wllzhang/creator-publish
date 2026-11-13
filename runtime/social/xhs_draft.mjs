/**
 * 小红书草稿。job: profileId, images[], title, body?, topics?
 */
import { humanPause } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';

const { job } = loadJob();
const images = (job.images || []).map((p) => abs(p)).filter(Boolean);
const title = (job.title || '').slice(0, 20);
let desc = job.body || '';
const rawTopics = Array.isArray(job.topics) ? job.topics : [];
const topicsList = rawTopics
  .map((t) => String(t).trim().replace(/^#/, ''))
  .filter(Boolean);

const topicTagsText = topicsList.map((t) => `#${t}`).join(' ');
if (topicTagsText) {
  if (desc) {
    desc = `${desc}\n\n${topicTagsText}`;
  } else {
    desc = topicTagsText;
  }
}

let descHtml = '';
if (!desc) {
  descHtml = '<p></p>';
} else if (desc.includes('<')) {
  descHtml = desc;
} else {
  descHtml = desc
    .split(/\r?\n\r?\n/)
    .map((block) => `<p>${block.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

if (!images.length) throw new Error('job 需要 images[]（绝对路径列表）');
if (!title) throw new Error('job 需要 title');

const task = await taskSpace('cp-xhs-' + Date.now(), { profileId: job.profileId });
const page = task.page('p1');

try {
  try {
    await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
  } catch (e) {
    console.warn('[xhs] goto timeout:', e.message?.slice(0, 160));
  }
  await humanPause(5000, 9000, '发布页加载', 'xhs');

  const cur = await page.url();
  console.log('[xhs] URL:', cur);
  if (cur.includes('login') || cur.includes('passport')) {
    console.log('NEED_LOGIN_XHS');
    throw new Error('NEED_LOGIN_XHS');
  }

  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('div, span, button'));
    const imgTab = tabs.find((el) => el.innerText?.trim() === '上传图文' || el.innerText?.trim() === '图文');
    imgTab?.click();
  });
  await humanPause(2000, 4000, '切图文', 'xhs');

  console.log(`准备上传 (${images.length})`);
  await page.evaluate(() => {
    const inp = document.querySelector('input.upload-input, input[type="file"]');
    if (inp) inp.id = 'my_batch_uploader_xhs';
  });
  await humanPause(1500, 3000, '选图前', 'xhs');
  await page.setInputFiles('#my_batch_uploader_xhs', images);
  await humanPause(15000, 25000, '图片上传', 'xhs');

  await humanPause(2000, 4000, '填标题前', 'xhs');
  await page.evaluate((tText) => {
    const titleInp = document.querySelector('input[placeholder*="填写标题"]');
    if (titleInp) {
      titleInp.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(titleInp, tText);
      else titleInp.value = tText;
      titleInp.dispatchEvent(new Event('input', { bubbles: true }));
      titleInp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, title);
  await humanPause(3000, 5500, '标题后', 'xhs');

  await humanPause(2000, 4000, '填正文前', 'xhs');
  await page.evaluate((dHtml) => {
    const editor = document.querySelector('.tiptap.ProseMirror');
    if (editor) {
      editor.focus();
      editor.innerHTML = dHtml;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, descHtml);
  await humanPause(5000, 9000, '正文后', 'xhs');

  await humanPause(3000, 6000, '点暂存前', 'xhs');
  const clickSave = await page.evaluate(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el || !el._sr) return { success: false, reason: 'no el or _sr' };
    const saveBtn = Array.from(el._sr.querySelectorAll('button')).find(
      (b) => b.innerText?.trim() === '暂存离开',
    );
    if (!saveBtn) return { success: false, reason: 'no saveBtn' };
    saveBtn.click();
    return { success: true };
  });
  console.log('保存点击:', JSON.stringify(clickSave));

  let savedOk = false;
  for (let w = 0; w < 15; w++) {
    await new Promise((r) => setTimeout(r, 1200));
    const toasts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[class*="toast"], [class*="message"]'))
        .map((t) => t.innerText?.trim())
        .filter(Boolean),
    );
    if (toasts.some((t) => t.includes('保存成功'))) {
      console.log('XHS_DRAFT_SAVED', toasts.join(', '));
      savedOk = true;
      break;
    }
  }
  if (!savedOk) console.warn('未检测到保存成功 toast，请人工看草稿箱');
  console.log('XHS_STAGED_DONE');
} finally {
  await task.finish({ keep: [] });
}
