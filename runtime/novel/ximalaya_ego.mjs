// 用 Ego Lite 把一集有声书上传到喜马拉雅创作者中心并填好表单。
// 默认在最终「确认发布」之前停下，页面留给用户检查；只有配置里 submit=true 才点发布。
// 不替用户登录：未登录就停下并写入结果文件。用户接管窗口时停止，不重试。
// 通常由 `node runtime/novel/ximalaya_publish.mjs` 写好配置后调用。

const fs = await import("node:fs/promises");
const pathMod = await import("node:path");
const osMod = await import("node:os");
const CONFIG_PATH = process.env.CREATOR_PUBLISH_RUN || pathMod.join(osMod.tmpdir(), "creator-publish-ximalaya-run.json");
const RESULT_PATH = process.env.CREATOR_PUBLISH_RESULT || pathMod.join(osMod.tmpdir(), "creator-publish-ximalaya-result.json");
const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slow = (min = 1200, max = 2500) => sleep(min + Math.random() * (max - min));
const result = { status: "started", started_at: new Date().toISOString(), steps: [], warnings: [], submitted: false };
async function save() {
  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
}
const step = (s) => { result.steps.push(s); console.log("[step]", s); };
const warn = (s) => { result.warnings.push(s); console.log("[warn]", s); };

// 创作者中心的 studio 页面把上传页嵌在跨域 iframe 里，所以直接进顶层上传页。
const UPLOAD = "https://www.ximalaya.com/reform-upload/page/webCenter/upload" +
  (cfg.album_id ? "?albumId=" + encodeURIComponent(cfg.album_id) : "");

const targetProfileId = cfg.profileId || cfg.profile_id || 'Profile 2';
console.log('[profile]', targetProfileId);
const task = await taskSpace(cfg.space_name, { profileId: targetProfileId });
console.log("spaceId", task.spaceId);
const page = task.page("p1");
let finished = false;

async function done(status, keep) {
  result.status = status;
  result.finished_at = new Date().toISOString();
  await save();
  finished = true;
  await task.finish({ keep: keep || [] });
}

try {
  // 尽量把 Ego 窗口从最小化恢复（最小化时无法截图）；失败不影响流程
  try {
    const w = await task.cdp("Browser.getWindowForTarget", { targetId: page.targetId });
    await task.cdp("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "normal" } });
  } catch (e) { /* ignore */ }
  await page.goto(UPLOAD);
  await page.waitForLoadState();
  await sleep(3500);
  const state = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 300) }));
  if (/passport\.ximalaya\.com|\/login/.test(state.url)) {
    result.detail = state;
    step("未登录：已跳转到登录页");
    await done("not_logged_in", []);
    console.log("NOT_LOGGED_IN: 请先在 Ego 里登录喜马拉雅创作者中心，再重新运行。");
    process.exitCode = 4;
  } else {
    step("已登录，进入上传页 " + state.url);

    // 1. 上传音频：WebUploader 的隐藏 input[name=file]；先直接设文件，失败再走文件选择器。
    await page.waitForSelector('input[type="file"]', { state: "attached", timeout: 30000 });
    try {
      await page.setInputFiles('input[type="file"][name="file"]', [cfg.mp3]);
    } catch (e) {
      warn("直接 setInputFiles 失败，改走文件选择器：" + String(e.message || e).slice(0, 120));
      const chooserPromise = page.waitForFileChooser({ timeout: 10000 });
      await page.click("css=.webuploader-pick");
      const chooser = await chooserPromise;
      await chooser.setFiles(cfg.mp3);
    }
    step("已选择音频 " + cfg.mp3);
    await slow();

    // 2. 等上传完成（大文件，默认最多等 25 分钟）
    await page.waitForFunction(() => /上传成功/.test(document.body.innerText), undefined, {
      timeout: (cfg.upload_timeout_s || 1500) * 1000,
    });
    step("音频上传成功");

    // 3. 标题：上传后会按文件名自动填，这里统一覆盖
    try {
      await page.evaluate(() => {
        const input = document.querySelector('input[placeholder*="声音标题"]');
        if (input) input.scrollIntoView({ block: "center" });
      });
      await slow(500, 1000);
      await page.fill('input[placeholder*="声音标题"]', cfg.title);
    } catch (e) {
      const ok = await page.evaluate((title) => {
        const input = document.querySelector('input[placeholder*="声音标题"]');
        if (input) {
          input.value = title;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }, cfg.title);
      if (!ok) throw e;
    }
    step("已填标题 " + cfg.title);
    await slow();

    // 4. 是否 AI 合成：如实选「是」
    if (cfg.ai !== false) {
      const aiOk = await page.evaluate(() => {
        const el = document.querySelector('#isAiTrack input[value="true"]');
        if (!el) return false;
        (el.closest("label") || el).click();
        return true;
      });
      if (aiOk) step("已选 AI 合成=是"); else warn("没找到 #isAiTrack 单选，需人工确认 AI 合成选项");
    }

    // 5. 简介：KindEditor 会按自己的内部状态回写隐藏 textarea，直接改 iframe/textarea 会被冲掉；
    //    必须走 KindEditor 实例 API（html + sync）。没有 API 时才退回直接写 DOM。
    const introOk = await page.evaluate((intro) => {
      const esc = (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]);
      const html = intro.split(/\n+/).map((s) => "<p>" + s.replace(/[&<>]/g, esc) + "</p>").join("");
      const K = window.KindEditor || window.K;
      const inst = K && K.instances && K.instances[0];
      if (inst) { inst.html(html); inst.sync(); return "api"; }
      const ta = document.querySelector('textarea[name="soundRichIntro"]') || document.querySelector('textarea[name="richIntro"]');
      const ifr = document.querySelector("iframe.ke-edit-iframe");
      let ok = false;
      if (ifr && ifr.contentDocument && ifr.contentDocument.body) { ifr.contentDocument.body.innerHTML = html; ok = true; }
      if (ta) { ta.value = html; ta.dispatchEvent(new Event("input", { bubbles: true })); ta.dispatchEvent(new Event("change", { bubbles: true })); ok = true; }
      return ok ? "dom" : "";
    }, cfg.intro);
    if (introOk) step("已填简介（" + introOk + "）"); else warn("没找到简介编辑器，需人工填写");
    await slow();

    // 6. 标签（选择器未在 Ego 里验证过，失败只告警）
    if (cfg.tags && cfg.tags.length) {
      try {
        const sel = 'input[placeholder*="标签"]';
        await page.waitForSelector(sel, { state: "visible", timeout: 5000 });
        for (const tag of cfg.tags) {
          await page.fill(sel, tag);
          await page.press(sel, "Enter");
          await slow(600, 1200);
        }
        step("已填标签 " + cfg.tags.join(","));
      } catch (e) {
        warn("标签输入框没找到或填写失败，需人工补标签：" + cfg.tags.join(","));
      }
    }

    // 7. 单集封面（可选；专辑共用封面时不传）
    if (cfg.cover) {
      try {
        // 编辑页实测：封面 input 的 accept=".png, .jpg, .jpeg, .bmp"（不含 "image"），两种都试
        let coverSet = false;
        for (const sel of ['input[type="file"][accept*=".jpg"]', 'input[type="file"][accept*="image"]']) {
          try { await page.setInputFiles(sel, [cfg.cover]); coverSet = true; break; } catch (e) { /* 试下一个 */ }
        }
        if (!coverSet) throw new Error("no cover input");
        step("已选封面 " + cfg.cover);
        await slow();
      } catch (e) {
        warn("没找到封面上传控件，需人工上传封面：" + cfg.cover);
      }
    }

    // 8. 字幕 .lrc：隐藏的 input[accept=".lrc"] 载入后，字幕文本会进 .gen-lrc-box 的 textarea，
    //    必须再点「确认提交」（aria-label=确认提交字幕）才生效，页面提示「字幕格式合格」。
    //    该按钮在页面很靠下，page.click 会被页面顶部的辅助 textarea 挡住而超时，
    //    所以先 scrollIntoView，再用原生 click；page.click 只作首选尝试。
    if (cfg.lrc) {
      try {
        let loaded = false;
        try { await page.setInputFiles('input[accept=".lrc"]', [cfg.lrc]); loaded = true; } catch (e) { /* 走 textarea */ }
        if (!loaded) {
          const lrcText = await fs.readFile(cfg.lrc, "utf8");
          await page.fill("css=.gen-lrc-box textarea", lrcText);
        }
        await page.waitForSelector('css=button[aria-label="确认提交字幕"]', { state: "attached", timeout: 15000 });
        await slow();
        let clicked = "";
        try {
          const ok = await page.evaluate(() => {
            const b = document.querySelector('button[aria-label="确认提交字幕"]');
            if (b) { b.scrollIntoView({ block: "center" }); b.click(); return true; }
            return false;
          });
          if (ok) clicked = "native";
        } catch (e) { /* ignore */ }
        if (!clicked) {
          try {
            await page.click('css=button[aria-label="确认提交字幕"]', { force: true, timeout: 3000 });
            clicked = "click";
          } catch (e) { /* ignore */ }
        }
        let okTip = false;
        try {
          await page.waitForFunction(() => /字幕格式合格|字幕.{0,6}成功/.test(document.body.innerText), undefined, { timeout: 8000 });
          okTip = true;
        } catch (e) { /* 提示可能一闪而过，以下面的文本长度为准 */ }
        const lrcLen = await page.evaluate(() => (document.querySelector(".gen-lrc-box textarea")?.value || "").length);
        result.lrc_len = lrcLen;
        if (lrcLen > 0) step("已上传字幕并确认（" + clicked + (okTip ? "，页面提示字幕格式合格" : "") + "，" + lrcLen + " 字符）");
        else warn("字幕确认后文本框为空，需人工检查字幕");
        await slow();
      } catch (e) {
        warn("字幕上传/确认失败，需人工处理：" + String(e.message || e).slice(0, 120));
      }
    }

    // 9. 知识产权承诺：只读检查，不替用户勾选
    const ip = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
      return { total: boxes.length, checked: boxes.filter((b) => b.checked).length };
    });
    result.ip_checkboxes = ip;
    if (ip.total && ip.checked < ip.total) warn("知识产权承诺未勾选（" + ip.checked + "/" + ip.total + "），脚本不替用户勾选，如平台拦截提交请人工处理");

    // 10. 回读 + 截图（截图失败不影响流程，例如窗口被最小化）
    result.readback = await page.evaluate(() => {
      const K = window.KindEditor || window.K;
      const inst = K && K.instances && K.instances[0];
      const ta = document.querySelector('textarea[name="soundRichIntro"]') || document.querySelector('textarea[name="richIntro"]');
      return {
        title: document.querySelector('input[placeholder*="声音标题"]')?.value || "",
        intro_len: Math.max(inst ? inst.text().length : 0, ta ? ta.value.length : 0),
        ai_true_checked: !!document.querySelector('#isAiTrack input[value="true"]:checked'),
        lrc_len: (document.querySelector(".gen-lrc-box textarea")?.value || "").length,
      };
    });
    try {
      const shot = pathMod.join(osMod.tmpdir(), "creator-publish-ximalaya-form.png");
      await page.screenshot({ path: shot });
      result.screenshot = shot;
    } catch (e) {
      warn("截图失败（不影响发布）：" + String(e.message || e).slice(0, 80));
    }

    if (cfg.submit) {
      if (!(result.readback.intro_len > 0)) throw new Error("简介回读为空，拒绝提交");
      let clicked = false;
      try {
        clicked = await page.evaluate(() => {
          const b = [...document.querySelectorAll("button")].find((x) => /确认发布/.test(x.innerText) && x.className.includes("confirm-publish"));
          if (b) { b.scrollIntoView({ block: "center" }); b.click(); return true; }
          return false;
        });
      } catch (e) { /* ignore */ }
      if (!clicked) {
        try {
          await page.click('css=button.ant-btn-primary:has-text("确认发布")', { force: true, timeout: 5000 });
        } catch (e) {
          warn("点击确认发布异常：" + String(e.message || e).slice(0, 80));
        }
      }
      step("已点击确认发布");
      await sleep(6000);
      result.submitted = true;
      result.after_submit = await page.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 300) }));
      await done("submitted", []);
    } else {
      step("已停在「确认发布」之前；页面留给用户检查后手动点击（或用 --submit 重跑）");
      await done("ready_for_review", ["p1"]);
    }
  }
} catch (e) {
  result.error = String(e && e.message || e);
  console.log("[error]", result.error);
  if (/control|inactive|unassigned|taken over/i.test(result.error) && !finished) {
    // 用户接管了窗口：停止，不重试，不再操作页面。
    result.status = "stopped_user_control";
    await save();
    console.log("STOP: 用户已接管窗口或空间失效，脚本停止，不重试。");
    process.exitCode = 5;
  } else if (!finished) {
    try { await done("failed", ["p1"]); } catch (e2) { result.status = "failed"; await save(); }
    process.exitCode = 1;
  }
}
await save();
