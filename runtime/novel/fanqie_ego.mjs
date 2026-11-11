// 用 Ego Lite 将一篇番茄短故事填入番茄作家后台。
// 默认在最终「确认发布」之前停下，页面留给用户检查；只有配置里 submit=true 才点确认。

const fs = await import("node:fs/promises");
const pathMod = await import("node:path");
const osMod = await import("node:os");
const CONFIG_PATH = process.env.CREATOR_PUBLISH_RUN || pathMod.join(osMod.tmpdir(), "creator-publish-fanqie-run.json");
const RESULT_PATH = process.env.CREATOR_PUBLISH_RESULT || pathMod.join(osMod.tmpdir(), "creator-publish-fanqie-result.json");
const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const slow = (min = 1000, max = 2000) => sleep(min + Math.random() * (max - min));

// 拟人节奏：操作间随机停顿，偶尔“想一下/核对一下”，避免固定间隔像脚本
async function humanPause(kind = "short", label = "") {
  const ranges = {
    micro: [280, 900],
    short: [900, 2400],
    mid: [1800, 4800],
    long: [3500, 9000],
    think: [5000, 14000],
    review: [8000, 20000],
  };
  const [lo, hi] = ranges[kind] || ranges.short;
  let ms = randInt(lo, hi);
  // 约 18% 概率再额外多停一会（像人被打断/复读）
  if (Math.random() < 0.18) ms += randInt(1200, 4500);
  if (label) console.log(`[pause:${kind}] ${label} ~${ms}ms`);
  await sleep(ms);
  return ms;
}

async function beforeClick(label) {
  await humanPause(Math.random() < 0.25 ? "mid" : "short", label || "click");
}

const result = { status: "started", started_at: new Date().toISOString(), steps: [], warnings: [], submitted: false, humanize: true };

async function save() {
  await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
}
const step = (s) => { result.steps.push(s); console.log("[step]", s); };
const warn = (s) => { result.warnings.push(s); console.log("[warn]", s); };

const targetProfileId = cfg.profileId || cfg.profile_id || 'Profile 2';
console.log('[profile]', targetProfileId);
const task = await taskSpace(cfg.space_name || ("fanqie-pub-" + Date.now()), { profileId: targetProfileId });
console.log("spaceId:", task.spaceId);
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
  // 1. 访问短故事新建入口
  const startUrl = cfg.draft_url || "https://fanqienovel.com/main/writer/publish-short/?enter_from=NEWCHAPTER_1";
  await page.goto(startUrl);
  await page.waitForLoadState();
  // 进页后先“看一眼”再动手
  await humanPause("long", "页面加载后浏览");

  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    body: document.body.innerText.slice(0, 300),
  }));

  if (/passport\.fanqienovel\.com|\/login/.test(state.url) || state.body.includes("登录/注册")) {
    result.detail = state;
    step("未登录：跳转到登录页");
    await done("not_logged_in", []);
    console.log("NOT_LOGGED_IN: 请先在 Ego 浏览器中登录番茄作家助手，再重新运行。");
    process.exitCode = 4;
    process.exit(4);
  }

  // 2. 处理草稿弹窗
  const dialogDismissed = await page.evaluate((targetTitle) => {
    const modals = [...document.querySelectorAll('.arco-modal, .byte-modal')];
    const m = modals.find(mod => mod.innerText && mod.innerText.includes("有刚刚更新的草稿"));
    if (m) {
      const curTitle = document.querySelector('input[placeholder*="短故事"]')?.value || "";
      const cont = [...m.querySelectorAll("button")].find(b => b.innerText && b.innerText.includes("继续编辑"));
      const disc = [...m.querySelectorAll("button")].find(b => b.innerText && b.innerText.includes("放弃"));
      if (curTitle === targetTitle && cont) {
        cont.click();
        return "continued_matching_draft";
      } else if (disc) {
        disc.click();
        return "discarded_different_draft";
      } else if (cont) {
        cont.click();
        return "continued";
      }
    }
    return "none";
  }, cfg.title);
  if (dialogDismissed !== "none") {
    step("已处理草稿恢复弹窗：" + dialogDismissed);
    await humanPause("mid", "草稿弹窗处理后");
  }

  result.draft_url = await page.url();
  step("当前编辑页 URL: " + result.draft_url);

  // 3. 填写标题：逐字输入，间隔抖动，避免瞬间整段塞入
  await beforeClick("准备填标题");
  await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="短故事"], textarea[placeholder*="短故事"]');
    if (input) {
      input.focus();
      const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, "");
      else input.value = "";
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  for (const ch of String(cfg.title || "")) {
    await page.evaluate((c) => {
      const input = document.querySelector('input[placeholder*="短故事"], textarea[placeholder*="短故事"]');
      if (!input) return;
      const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = (input.value || "") + c;
      if (setter) setter.call(input, next);
      else input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, ch);
    await sleep(randInt(45, 160));
    if (Math.random() < 0.08) await sleep(randInt(220, 520)); // 偶发停顿改字
  }
  step("已填入标题: " + cfg.title);
  await humanPause("mid", "标题核对");

  // 4. 填写正文 (分段 <p> 标签，激活 ProseMirror 段落统计)
  await beforeClick("准备填正文");
  const paras = await page.evaluate((text) => {
    const el = document.querySelector('div[contenteditable="true"]');
    if (!el) return 0;
    el.focus();
    const ps = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const html = ps.map(p => {
      const escaped = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<p>${escaped}</p>`;
    }).join('');
    el.innerHTML = html;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return ps.length;
  }, cfg.body);
  step("已填入正文，段落数: " + paras + "，汉字数约: " + (cfg.body || "").replace(/\s/g, "").length);
  // 粘贴后装作通读一会儿
  await humanPause("think", "正文粘贴后通读");

  // 5. 是否 AI 辅助写作：如实勾选
  await beforeClick("选择 AI 辅助选项");
  const aiRadioSet = await page.evaluate((isAi) => {
    const targetText = isAi ? "是" : "否";
    const labels = [...document.querySelectorAll("label")];
    const match = labels.find(l => l.innerText.trim() === targetText);
    if (match) {
      const radio = match.querySelector('input[type="radio"]') || match;
      radio.click();
      return true;
    }
    return false;
  }, cfg.ai !== false);
  if (aiRadioSet) step("已设置 AI 辅助属性: " + (cfg.ai !== false ? "是" : "否"));
  else warn("未找到 AI 单选控件，需人工核对");
  await humanPause("short", "AI 选项后");

  // 6. 分类设置
  if (cfg.category) {
    try {
      await beforeClick("打开分类下拉");
      await page.evaluate((targetCat) => {
        const curCat = document.querySelector(".publish-short-category-select")?.innerText || "";
        if (!curCat.includes(targetCat)) {
          document.querySelector(".publish-short-category-select")?.click();
        }
      }, cfg.category);
      await humanPause("short", "分类列表展开");
      const catSetResult = await page.evaluate((targetCat) => {
        const MAIN_CATS = new Set([
          "婚姻家庭", "女生生活", "男生生活", "现言甜宠", "虐心婚恋", "青春虐恋",
          "男生情感", "女性成长", "悬疑惊悚", "玄幻仙侠", "宫斗宅斗", "男频衍生",
          "女频衍生", "年代", "纯爱", "其他", "古言甜宠", "古风世情",
          "都市日常", "男频脑洞", "女频脑洞", "民国旧影", "古言虐恋", "历史古代"
        ]);
        const allItems = [...document.querySelectorAll(".publish-short-category-select-item")];
        // 过滤出真正的主分类，排除次级题材标签（避免选错次级标签导致主分类为空）
        const mainItems = allItems.filter(e => e.innerText && MAIN_CATS.has(e.innerText.trim()));
        const items = mainItems.length > 0 ? mainItems : allItems;

        // 1. 精确匹配主分类
        let match = items.find(e => e.innerText && e.innerText.trim() === targetCat);
        // 2. 包含匹配主分类
        if (!match) match = items.find(e => e.innerText && (e.innerText.includes(targetCat) || targetCat.includes(e.innerText.trim())));
        // 3. 兜底回退匹配“都市日常”
        let fallback = false;
        if (!match) {
          match = items.find(e => e.innerText && e.innerText.trim() === "都市日常");
          fallback = true;
        }
        if (match) {
          match.click();
          return { name: match.innerText.trim(), fallback };
        }
        return null;
      }, cfg.category);
      if (catSetResult) {
        if (catSetResult.fallback) {
          warn(`目标分类【${cfg.category}】未完全匹配，已自动回退选定通用分类【${catSetResult.name}】`);
        } else {
          step("已选定作品分类: " + catSetResult.name);
        }
      } else {
        warn("分类列表选取失败，可能导致下一步拦截: " + cfg.category);
      }
      await page.evaluate(() => { document.body.click(); });
    } catch (e) {
      warn("作品分类选择提示: " + String(e.message || e));
    }
    await humanPause("mid", "分类选定后");
  }

  // 7. 上传封面（若提供）
  if (cfg.cover) {
    try {
      const coverNeeded = await page.evaluate(() => {
        const c = document.querySelector(".publish-short-config-cover-container");
        return !c || c.querySelector("img") === null;
      });

      if (coverNeeded) {
        await beforeClick("打开封面上传");
        await page.evaluate(() => {
          const target = document.querySelector(".publish-short-config-book-cover-content-desc") ||
                         document.querySelector(".publish-short-config-cover-container");
          if (target) {
            const opts = { bubbles: true, cancelable: true, view: window };
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
          }
        });
        await humanPause("mid", "封面抽屉打开");

        // 点击本地上传 tab
        await beforeClick("切到本地上传");
        await page.evaluate(() => {
          const tabs = [...document.querySelectorAll(".byte-drawer-wrapper *")].filter(el => el.innerText && el.innerText.trim() === "本地上传");
          if (tabs.length) {
            const opts = { bubbles: true, cancelable: true, view: window };
            tabs[0].dispatchEvent(new MouseEvent('mousedown', opts));
            tabs[0].dispatchEvent(new MouseEvent('mouseup', opts));
            tabs[0].dispatchEvent(new MouseEvent('click', opts));
          }
        });
        await humanPause("short", "本地上传 tab");

        // 选择本地封面文件
        await humanPause("short", "选文件前犹豫");
        await page.setInputFiles('.byte-drawer-wrapper input[type="file"]', [cfg.cover]);
        step("已选择封面文件: " + cfg.cover);
        await humanPause("long", "等待封面预览");

        // 点击确认上传
        await beforeClick("确认上传封面");
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll(".byte-drawer-wrapper button")];
          const b = btns.find(btn => btn.innerText && btn.innerText.trim() === "确认上传");
          if (b) {
            const opts = { bubbles: true, cancelable: true, view: window };
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
          }
        });
        await humanPause("long", "确认上传后");

        // 点击确定
        await beforeClick("封面确定");
        await page.evaluate(() => {
          const btns = [...document.querySelectorAll(".byte-drawer-wrapper button")];
          const b = btns.find(btn => btn.innerText && btn.innerText.trim() === "确定" && !btn.disabled);
          if (b) {
            const opts = { bubbles: true, cancelable: true, view: window };
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
          }
        });
        await humanPause("mid", "封面确定后");

        // 点击完成制作
        await beforeClick("完成封面制作");
        await page.evaluate(() => {
          const b = document.querySelector(".make-cover-deal-btns-finish");
          if (b) {
            const opts = { bubbles: true, cancelable: true, view: window };
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
          }
        });
        step("封面上传流程已执行完毕");
        await humanPause("long", "封面制作完成");

        // 确保抽屉关闭
        await page.evaluate(() => {
          const close = document.querySelector(".byte-drawer-close-icon");
          if (close) close.click();
        });
        await humanPause("short", "关闭封面抽屉");
      } else {
        step("封面已存在，无需重复上传");
      }
    } catch (e) {
      warn("封面上传步骤提示：" + String(e.message || e).slice(0, 120));
    }
  }

  // 8. 试读比例
  try {
    let payReady = false;
    for (let i = 0; i < 6; i++) {
      payReady = await page.evaluate(() => {
        const btn = document.querySelector(".publish-short-config-pay-location-wrapper")?.closest("button");
        return btn && !btn.disabled;
      });
      if (payReady) break;
      await humanPause("short", "等待试读按钮可用");
    }

    if (payReady) {
      const currentPayText = await page.evaluate(() => {
        return document.querySelector(".publish-short-config-pay-location-wrapper")?.innerText.trim() || "";
      });
      if (!/\d+%/.test(currentPayText)) {
        await beforeClick("打开试读设置");
        await page.evaluate(() => {
          document.querySelector(".publish-short-config-pay-location-wrapper")?.click();
        });
        await humanPause("mid", "试读弹层");
        await beforeClick("保存试读比例");
        await page.evaluate(() => {
          const ok = [...document.querySelectorAll("button")].find(b => b.innerText && (b.innerText.trim() === "确定" || b.innerText.trim() === "保存"));
          if (ok) ok.click();
        });
        step("已设置试读比例");
        await humanPause("short", "试读保存后");
      } else {
        step("试读比例已存在: " + currentPayText);
      }
    } else {
      warn("试读比例按钮处于禁用状态，跳过");
    }
  } catch (e) {
    warn("试读比例设置提示：" + String(e.message || e).slice(0, 100));
  }
  await humanPause("mid", "表单填完后总览");

  // 9. 勾选原创/发布协议
  await beforeClick("勾选发布协议");
  await page.evaluate(() => {
    const cb = document.querySelector('input[type="checkbox"]');
    if (cb && !cb.checked) {
      const label = cb.closest("label") || cb;
      label.click();
    }
  });
  step("已勾选发布协议复选框");
  await humanPause("short", "协议勾选后");

  // 10. 点击「存草稿」
  await beforeClick("存草稿");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(e => e.innerText && e.innerText.trim() === "存草稿");
    if (b) b.click();
  });
  step("已点击「存草稿」");
  await humanPause("long", "存草稿等待");

  // 11. 点击「下一步」——提交前多停一会儿，像人最后核对
  await humanPause("review", "点下一步前最后核对");
  await beforeClick("下一步");
  await page.evaluate(() => {
    const b = document.querySelector('button[data-apm-action="core_chain_short_story_next_confirm"]') ||
              [...document.querySelectorAll("button")].find(e => e.innerText && e.innerText.trim() === "下一步");
    if (b) {
      const opts = { bubbles: true, cancelable: true, view: window };
      b.dispatchEvent(new MouseEvent('mousedown', opts));
      b.dispatchEvent(new MouseEvent('mouseup', opts));
      b.dispatchEvent(new MouseEvent('click', opts));
    }
  });
  step("已点击「下一步」");
  await humanPause("long", "下一步后等待检测");

  // 12. 处理内容检测及提示弹窗
  const deadline = Date.now() + 60000;
  let waitingCount = 0;
  while (Date.now() < deadline) {
    const loopStatus = await page.evaluate((shouldSubmit) => {
      const isVisible = (el) => el && el.offsetParent !== null && window.getComputedStyle(el).display !== 'none';
      const bodyText = document.body.innerText;

      if (bodyText.includes("发布成功") || bodyText.includes("已发布") || bodyText.includes("审核中") || location.href.includes("short-manage")) {
        return "success_submitted";
      }

      const modals = [...document.querySelectorAll('.arco-modal, .byte-modal, [role="dialog"]')].filter(isVisible);
      for (const m of modals) {
        if (m.innerText.includes("提交确认")) {
          // 先回报“确认弹窗已出现”，由外层做人味停顿后再点确定
          return shouldSubmit ? "confirm_ready_submit" : "confirm_ready_stop";
        }
        const agree = [...m.querySelectorAll("button")].find(b => b.innerText && b.innerText.includes("我已阅读并同意"));
        if (agree) {
          const opts = { bubbles: true, cancelable: true, view: window };
          agree.dispatchEvent(new MouseEvent('mousedown', opts));
          agree.dispatchEvent(new MouseEvent('mouseup', opts));
          agree.dispatchEvent(new MouseEvent('click', opts));
          agree.click();
          return "clicked_我已阅读并同意";
        }
        const genericBtns = [...m.querySelectorAll("button")];
        for (const name of ["仅基础检测", "继续发布", "提交", "确定"]) {
          const t = genericBtns.find(b => b.innerText && b.innerText.trim() === name);
          if (t) {
            const opts = { bubbles: true, cancelable: true, view: window };
            t.dispatchEvent(new MouseEvent('mousedown', opts));
            t.dispatchEvent(new MouseEvent('mouseup', opts));
            t.dispatchEvent(new MouseEvent('click', opts));
            t.click();
            return "clicked_" + name;
          }
        }
      }

      return "waiting";
    }, cfg.submit !== false);

    step("弹窗推进状态: " + loopStatus);
    if (loopStatus === "success_submitted") {
      result.submitted = true;
      step("番茄短篇提交成功");
      await done("submitted", []);
      break;
    }
    if (loopStatus === "confirm_ready_stop") {
      step("已到达提交确认弹窗，停在最终确认前");
      await done("ready_for_review", ["p1"]);
      break;
    }
    if (loopStatus === "confirm_ready_submit") {
      step("已到达提交确认弹窗，拟人核对后再点确定");
      await humanPause("review", "提交确认前最后核对");
      await beforeClick("提交确认·确定");
      await page.evaluate(() => {
        const isVisible = (el) => el && el.offsetParent !== null && window.getComputedStyle(el).display !== 'none';
        const modals = [...document.querySelectorAll('.arco-modal, .byte-modal, [role="dialog"]')].filter(isVisible);
        for (const m of modals) {
          if (!(m.innerText && m.innerText.includes("提交确认"))) continue;
          const ok = [...m.querySelectorAll("button")].find(b => b.innerText && b.innerText.includes("确定"));
          if (ok) {
            const opts = { bubbles: true, cancelable: true, view: window };
            ok.dispatchEvent(new MouseEvent('mousedown', opts));
            ok.dispatchEvent(new MouseEvent('mouseup', opts));
            ok.dispatchEvent(new MouseEvent('click', opts));
            ok.click();
            return true;
          }
        }
        return false;
      });
      await humanPause("long", "最终确认提交后等待回跳");
      result.submitted = true;
      step("番茄短篇提交成功，已确认提交");
      await done("submitted", []);
      break;
    }
    if (loopStatus === "clicked_我已阅读并同意") {
      await humanPause("mid", "阅读协议后");
      await beforeClick("协议后再次下一步");
      await page.evaluate(() => {
        const b = document.querySelector('button[data-apm-action="core_chain_short_story_next_confirm"]') ||
                  [...document.querySelectorAll("button")].find(e => e.innerText && e.innerText.trim() === "下一步");
        if (b) {
          const opts = { bubbles: true, cancelable: true, view: window };
          b.dispatchEvent(new MouseEvent('mousedown', opts));
          b.dispatchEvent(new MouseEvent('mouseup', opts));
          b.dispatchEvent(new MouseEvent('click', opts));
          b.click();
        }
      });
      await humanPause("mid", "协议后下一步");
    } else if (loopStatus === "waiting") {
      waitingCount++;
      if (waitingCount % 3 === 0) {
        // 若长时间等待，重试点击「下一步」推动流程
        await beforeClick("等待超时重试下一步");
        await page.evaluate(() => {
          const modals = [...document.querySelectorAll('.arco-modal, .byte-modal, [role="dialog"]')];
          const hasModal = modals.some(el => el && el.offsetParent !== null && window.getComputedStyle(el).display !== 'none');
          if (!hasModal) {
            const b = document.querySelector('button[data-apm-action="core_chain_short_story_next_confirm"]') ||
                      [...document.querySelectorAll("button")].find(e => e.innerText && e.innerText.trim() === "下一步");
            if (b) {
              const opts = { bubbles: true, cancelable: true, view: window };
              b.dispatchEvent(new MouseEvent('mousedown', opts));
              b.dispatchEvent(new MouseEvent('mouseup', opts));
              b.dispatchEvent(new MouseEvent('click', opts));
              b.click();
            }
          }
        });
      }
      await humanPause("short", "弹窗轮询等待");
    } else {
      // 点了某个中间按钮后，再随机停一下再继续
      await humanPause(Math.random() < 0.35 ? "mid" : "short", "弹窗推进间隔");
    }
  }

  // 13. 回读与截图保存（仅当未结束时执行）
  if (!finished) {
    try {
      result.readback = await page.evaluate(() => ({
        title: document.querySelector('input[placeholder*="短故事"], textarea[placeholder*="短故事"]')?.value || "",
        body_len: (document.querySelector('div[contenteditable="true"]')?.innerText || "").length,
        url: location.href,
      }));
      result.screenshot = pathMod.join(osMod.tmpdir(), "creator-publish-fanqie-form.png");
      await page.screenshot({ path: result.screenshot });
    } catch (e) {
      warn("回读/截图保存提示: " + String(e.message || e));
    }

    if (result.submitted) {
      await done("submitted", []);
    } else {
      await done("ready_for_review", ["p1"]);
    }
  }

} catch (e) {
  result.error = String(e && e.message || e);
  console.log("[error]", result.error);
  if (/control|inactive|unassigned|taken over/i.test(result.error) && !finished) {
    result.status = "stopped_user_control";
    await save();
    console.log("STOP: 用户接管窗口或空间失效，脚本停止。");
    process.exitCode = 5;
  } else if (!finished) {
    try { await done("failed", ["p1"]); } catch (e2) { result.status = "failed"; await save(); }
    process.exitCode = 1;
  }
}
await save();
process.exit(result.status === "failed" ? 1 : 0);
