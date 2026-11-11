/**
 * 抖音入草稿（停发布前）。先 node write_job.mjs，再在 ego 中跑本脚本。
 * job: profileId, video, title, topics[]
 */
import { humanPause } from '../lib/pace.mjs';
import { loadJob, abs } from '../lib/load_job.mjs';

const { job } = loadJob();
const videoPath = abs(job.video);
const title = job.title;
const topics = Array.isArray(job.topics) ? job.topics : [];
if (!videoPath || !title) throw new Error('job 需要 video + title');

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
  while (waited < 90000) {
    const url = await page.url();
    if (url.includes('/content/publish')) {
      console.log('publish page:', url);
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
    waited += 1500;
  }
  await humanPause(4000, 7000, '上传处理', 'dy');

  await page.fill('input[placeholder*="填写作品标题"]', title);
  await humanPause(800, 1800, '标题后', 'dy');

  await page.click('.zone-container.editor-kit-container');
  await humanPause(200, 500);
  await page.keyboard.press('Control+a');
  await humanPause(150, 400);
  await page.keyboard.press('Backspace');
  await humanPause(600, 1200);

  // Topics stay on one line: "#a #b #c" with spaces only (no Enter / no linebreak).
  for (let i = 0; i < topics.length; i++) {
    const t = String(topics[i] || '').replace(/^#/, '').trim();
    if (!t) continue;
    console.log(`topic #${t}`);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('*')).find(
        (el) => el.children.length === 0 && el.innerText?.trim() === '#添加话题',
      );
      if (btn) btn.click();
    });
    await humanPause(400, 900, '话题输入前', 'dy');
    await page.keyboard.type(t);
    await humanPause(1200, 2200, '话题建议', 'dy');
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
      await humanPause(150, 400);
      await page.keyboard.type(`#${t}`);
    }
    if (i < topics.length - 1) {
      await page.keyboard.type(' ');
    }
    await humanPause(500, 1100, '话题空格间隔', 'dy');
  }

  console.log('DOUYIN_STAGED_STOP_BEFORE_PUBLISH');
  console.log('spaceId', task.spaceId);
} finally {
  await task.finish({ keep: [] });
}
