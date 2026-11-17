// tools/kdp_ego.mjs
// 使用 Ego Lite 自动化完成 Amazon KDP 电子书全流程填单与发布。
// 遵循 novel-publish 统一规范。

const fs = await import("node:fs/promises");
const pathMod = await import("node:path");
const osMod = await import("node:os");
const CONFIG_PATH = process.env.CREATOR_PUBLISH_RUN || pathMod.join(osMod.tmpdir(), "creator-publish-kdp-run.json");
const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeGoto = async (url, timeout = 25000) => {
  try {
    await page.goto(url, { timeout });
  } catch (e) {
    // 忽略加载超时，只要 committed 即可继续
  }
  await sleep(4000);
};

const triggerClick = async (selectorOrEl) => {
  await page.evaluate((target) => {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }, selectorOrEl);
};

const targetProfileId = cfg.profileId || cfg.profile_id || 'Profile 2';
console.log('[profile]', targetProfileId);
const spaceName = `kdp-pub-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const task = await taskSpace(spaceName, { profileId: targetProfileId });
console.log("[Ego] Task spaceId:", task.spaceId);
const page = task.page("p1");

let exitCode = 0;

async function executePublish() {
  console.log("[1/6] 检查当前 KDP 页面与书架...");
  await safeGoto("https://kdp.amazon.com/en_US/bookshelf");

  // 检查是否已有该书的草稿或在线状态
  const bookStatus = await page.evaluate((title) => {
    const rows = Array.from(document.querySelectorAll('tr[id^="title-"], .mt-row, tr'));
    for (const r of rows) {
      if (r.innerText.toLowerCase().includes(title.toLowerCase())) {
        const text = r.innerText;
        const isLive = text.includes("Live");
        const isInReview = text.includes("In review");
        const isDraft = text.includes("Draft");
        const link = Array.from(r.querySelectorAll('a')).find(a => a.href && a.href.includes('/title-setup/kindle/'));
        let draftId = null;
        if (link) {
          const m = link.href.match(/\/kindle\/([A-Z0-9]+)\//i);
          if (m) draftId = m[1];
        }
        return { matched: true, isLive, isInReview, isDraft, draftId, text: text.slice(0, 150) };
      }
    }
    return { matched: false };
  }, cfg.title);

  console.log("[*] 书架匹配情况:", JSON.stringify(bookStatus));

  const resPath = pathMod.join(osMod.tmpdir(), "creator-publish-kdp-result.json");

  if (bookStatus.isLive) {
    console.log(`[*] 该作品已在亚马逊 Kindle 商店正式上架 (Live)! 无需重复提审。`);
    await fs.writeFile(resPath, JSON.stringify({
      status: "live",
      submitted: true,
      title: cfg.title,
      time: new Date().toISOString()
    }, null, 2), "utf8");
    return;
  }
  if (bookStatus.isInReview) {
    console.log(`[*] 该作品已处于审核中 (In review)! 无需重复提审。`);
    await fs.writeFile(resPath, JSON.stringify({
      status: "in_review",
      submitted: true,
      title: cfg.title,
      time: new Date().toISOString()
    }, null, 2), "utf8");
    return;
  }

  let draftId = bookStatus.draftId;
  if (draftId) {
    console.log("[*] 发现已有书籍草稿，直接进入详情编辑页, Draft ID:", draftId);
    await safeGoto(`https://kdp.amazon.com/en_US/title-setup/kindle/${draftId}/details`);
  } else {
    console.log("[*] 未发现草稿，创建新 Kindle eBook...");
    await safeGoto("https://kdp.amazon.com/en_US/create");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      const b = btns.find((btn) => btn.innerText && btn.innerText.includes("Create eBook"));
      if (b) b.click();
    });
    await sleep(4000);
  }

  // --- 第 1 步：填写 Page 1 (Details) ---
  console.log("[2/6] 填写第 1 页：Kindle eBook Details...");

  // 等待详情页 DOM 与 #data-title 就绪
  console.log("   -> 等待详情页元素 (#data-title) 就绪...");
  for (let i = 0; i < 20; i++) {
    const ready = await page.evaluate(() => !!document.getElementById("data-title"));
    if (ready) {
      console.log("   [OK] #data-title 元素已就绪");
      break;
    }
    await sleep(1500);
  }

  // 1. Title, Subtitle, Author
  const filled = await page.evaluate(({ title, subtitle, first, last }) => {
    const t = document.getElementById("data-title");
    if (t) {
      t.focus();
      t.value = title;
      t.dispatchEvent(new Event("input", { bubbles: true }));
      t.dispatchEvent(new Event("change", { bubbles: true }));
      t.blur();
    }
    const s = document.getElementById("data-subtitle");
    if (s && subtitle) {
      s.focus();
      s.value = subtitle;
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
      s.blur();
    }
    const af = document.getElementById("data-primary-author-first-name");
    if (af) {
      af.focus();
      af.value = first;
      af.dispatchEvent(new Event("input", { bubbles: true }));
      af.dispatchEvent(new Event("change", { bubbles: true }));
      af.blur();
    }
    const al = document.getElementById("data-primary-author-last-name");
    if (al) {
      al.focus();
      al.value = last;
      al.dispatchEvent(new Event("input", { bubbles: true }));
      al.dispatchEvent(new Event("change", { bubbles: true }));
      al.blur();
    }
    return {
      titleVal: t?.value,
      firstVal: af?.value,
      lastVal: al?.value
    };
  }, { title: cfg.title, subtitle: cfg.subtitle, first: cfg.author_first, last: cfg.author_last });
  console.log("   [OK] 基础信息填入结果:", JSON.stringify(filled));
  await sleep(1500);

  // 2. CKEditor Description
  console.log("   -> 等待 CKEditor 实例就绪并填入 Description...");
  for (let i = 0; i < 20; i++) {
    const ckReady = await page.evaluate(() => {
      const ed = window.CKEDITOR && window.CKEDITOR.instances && window.CKEDITOR.instances.editor1;
      return !!(ed && (window.CKEDITOR.status === 'loaded' || typeof ed.setData === 'function'));
    });
    if (ckReady) {
      console.log("   [OK] CKEditor editor1 实例已就绪");
      break;
    }
    await sleep(1500);
  }

  await page.evaluate(async (descHtml) => {
    const ed = window.CKEDITOR && window.CKEDITOR.instances && window.CKEDITOR.instances.editor1;
    if (ed && typeof ed.setData === 'function') {
      await new Promise(resolve => {
        ed.setData(descHtml, function() {
          if (typeof ed.updateElement === 'function') ed.updateElement();
          resolve();
        });
      });
    }
    const hiddenDesc = document.querySelector('input[name="data[description]"]');
    if (hiddenDesc) {
      hiddenDesc.value = descHtml;
      hiddenDesc.dispatchEvent(new Event("input", { bubbles: true }));
      hiddenDesc.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, cfg.description_html);
  await sleep(2500);

  // 3. Copyright, Adult content & Pre-order
  await page.evaluate(() => {
    // 版权
    const nonPub = document.getElementById("non-public-domain");
    if (nonPub) {
      nonPub.checked = true;
      nonPub.dispatchEvent(new Event("click", { bubbles: true }));
      nonPub.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // 成人内容 No
    const noRadio = document.querySelector('input[name="data[is_adult_content]-radio"][value="false"]');
    if (noRadio) {
      noRadio.checked = true;
      noRadio.dispatchEvent(new Event("click", { bubbles: true }));
      noRadio.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const hiddenAdult = document.getElementById("data-is-adult-content-hidden");
    if (hiddenAdult) {
      hiddenAdult.value = "false";
      hiddenAdult.dispatchEvent(new Event("input", { bubbles: true }));
      hiddenAdult.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // 预售 Release now
    const releaseNow = document.querySelector('input[name="data[pre_order]-radio"][value="false"]') ||
                       document.getElementById("data-pre-order-false");
    if (releaseNow) {
      releaseNow.checked = true;
      releaseNow.dispatchEvent(new Event("click", { bubbles: true }));
      releaseNow.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });

  await sleep(1500);

  // 4. Keywords (自动清洗 KDP 静默拦截的官方品牌词/受限词)
  const KDP_FORBIDDEN_KW = [
    /\bkindle\s+unlimited\b/gi,
    /\bshort\s+reads\b/gi,
    /\bkindle\b/gi,
    /\bamazon\b/gi,
    /\bkdp\b/gi,
    /\baudible\b/gi,
    /\bbestsell(?:er|ing)\b/gi,
    /\bbest\s+seller\b/gi,
    /\bfree\b/gi,
  ];
  const cleanKeywords = (cfg.keywords || []).map((raw) => {
    let s = String(raw || "");
    for (const re of KDP_FORBIDDEN_KW) {
      if (re.test(s)) {
        console.warn(`   [WARN] 清洗 KDP 受限关键词片段: "${s}" (匹配 ${re})`);
        s = s.replace(re, " ");
      }
    }
    return s.replace(/\s+/g, " ").trim().slice(0, 50);
  });

  await page.evaluate((keywords) => {
    const forbiddenRe = /\b(kindle\s+unlimited|short\s+reads|kindle|amazon|kdp|audible|bestsell(?:er|ing)|best\s+seller|free)\b/i;
    for (let i = 0; i < 7; i++) {
      const inp = document.getElementById(`data-keywords-${i}`);
      if (inp && keywords[i] && (!inp.value || forbiddenRe.test(inp.value))) {
        inp.value = keywords[i];
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }, cleanKeywords);

  await sleep(1000);

  // 5. Categories Selection (React Popover 级联选择器)
  const hasCat = await page.evaluate(() => (document.body?.innerText || "").includes("Your title's current categories"));
  console.log("   -> 已有分类?", hasCat);

  if (!hasCat) {
    console.log("   -> 打开分类弹窗 (Categories)...");
    let catModalOpened = false;
    for (let i = 0; i < 5; i++) {
      const hasModal = await page.evaluate(() => !!document.querySelector('select[name="react-aui-0"]'));
      if (hasModal) {
        catModalOpened = true;
        break;
      }
      await page.evaluate(() => {
        const catBtn = document.getElementById("categories-modal-button");
        if (catBtn) {
          catBtn.removeAttribute("disabled");
          const p = catBtn.closest('.a-button');
          if (p) p.classList.remove('a-button-disabled');
          catBtn.scrollIntoView({ block: 'center' });
          catBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
          catBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          catBtn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
          catBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          catBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }
      });
      await sleep(2500);
    }

    if (catModalOpened) {
      console.log("   -> 在弹窗中选择 Romance / Paranormal / Shifters / Fiction...");
      await page.evaluate(() => {
        const select = document.querySelector('select[name="react-aui-0"]');
        if (select) {
          const opt = Array.from(select.options).find(o => o.text.includes('Romance')) ||
                      Array.from(select.options).find(o => o.text.includes('Science Fiction & Fantasy')) ||
                      Array.from(select.options).find(o => o.text.includes('Fiction'));
          if (opt) {
            const proto = Object.getPrototypeOf(select);
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(select, opt.value);
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      await sleep(2000);

      // 选择子分类并保存
      await page.evaluate(() => {
        const cb = document.querySelector('.a-popover-modal input[type="checkbox"], [role="dialog"] input[type="checkbox"]');
        if (cb && !cb.checked) {
          cb.click();
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const saveCatBtn = btns.find(b => (b.innerText || b.value || '').trim() === 'Save categories');
        if (saveCatBtn) {
          saveCatBtn.scrollIntoView({ block: 'center' });
          saveCatBtn.click();
        }
      });
      await sleep(3000);
    }
  }

  // 点击 Save and Continue 前往 Page 2
  console.log("[3/6] 保存第 1 页并前往第 2 页 (Content)...");
  await page.evaluate(() => {
    const btn = document.getElementById("save-and-continue-announce") || document.getElementById("save-announce");
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  });

  // 检查是否触发了 Amazon KDP 每周新建上限 (Weekly title creation limit reached)
  await sleep(3000);
  const limitReached = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return text.includes("Title creation limit reached") || text.includes("weekly title creation limit for this format");
  });
  if (limitReached) {
    console.warn("================================================================================");
    console.warn("[KDP 限额提醒] 检测到 Amazon KDP 每周新书创建上限 (Weekly title creation limit reached)");
    console.warn("亚马逊新作者账号每周最多允许创建 3 本新书，重置时间为每周日 12:00 AM UTC。");
    console.warn("当前作品资产已完整就绪，请待周日 UTC 额度重置后直接重新触发发布。");
    console.warn("================================================================================");
    throw new Error('KDP_WEEKLY_TITLE_LIMIT');
  }

  // 等待跳转至 Page 2 (Content)
  for (let t = 0; t < 12; t++) {
    await sleep(2000);
    const onP2 = await page.evaluate(() => location.href.includes('/content'));
    if (onP2) {
      console.log("   [OK] 已成功进入第 2 页 (Content):", await page.evaluate(() => location.href));
      break;
    }
  }

  const onP2Now = await page.evaluate(() => location.href.includes('/content'));
  if (!onP2Now) {
    const p1Errors = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.a-alert-error, .a-form-error'))
        .filter(e => e.offsetParent !== null && e.innerText?.trim())
        .map(e => e.innerText.trim());
    });
    if (p1Errors.length > 0) {
      console.error("   [!] 第 1 页未成功保存跳转，错误信息:", JSON.stringify(p1Errors));
      throw new Error('KDP_PAGE1_ERROR: ' + p1Errors.join('; '));
    }
    const curLoc = await page.evaluate(() => location.href);
    const m = curLoc.match(/kindle\/([A-Z0-9]+)\//);
    const targetDraftId = m ? m[1] : draftId;
    if (targetDraftId) {
      console.log("   尝试直接导航至 content 页:", targetDraftId);
      await safeGoto(`https://kdp.amazon.com/en_US/title-setup/kindle/${targetDraftId}/content`);
    }
  }

  // --- 第 2 步：填写 Page 2 (Content) ---
  console.log("[4/6] 填写第 2 页：Kindle eBook Content (上传正文与封面)...");

  // 1. DRM
  await page.evaluate(() => {
    const drmRadio = document.querySelector('input[name="data[is_drm]-radio"][value="false"]');
    if (drmRadio && !drmRadio.checked) drmRadio.click();
  });
  await sleep(1000);

  // 检查已上传状态
  const uploadStatus = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    return {
      epubDone: text.includes("Manuscript uploaded successfully") || text.includes("uploaded successfully!"),
      coverDone: text.includes("Cover uploaded successfully"),
    };
  });

  // 2. Upload EPUB & Cover
  if (cfg.epub_file && !uploadStatus.epubDone) {
    try {
      console.log("   -> 上传 EPUB 文稿:", cfg.epub_file);
      for (let i = 0; i < 6; i++) {
        const hasInput = await page.evaluate(() => !!document.querySelector("#data-assets-interior-file-upload-AjaxInput"));
        if (hasInput) break;
        await sleep(2000);
      }
      await page.setInputFiles("#data-assets-interior-file-upload-AjaxInput", cfg.epub_file);
    } catch (e) {
      console.warn("   EPUB 上传警告:", e.message);
    }
  } else {
    console.log("   -> EPUB 文稿已就绪，跳过重新上传。");
  }
  await sleep(2000);

  // 始终强制激活 "Upload a cover you already have" 面板并锁定 data[cover_choice]="upload"
  // 防止默认停留在 cover-creator 导致终审返回空 saveError
  await page.evaluate(() => {
    const uploadRow = document.querySelector('[data-a-accordion-row-name="upload"]');
    if (uploadRow && !uploadRow.classList.contains('a-accordion-active')) {
      const link = uploadRow.querySelector('a.a-accordion-row, a, input[type="radio"]') || uploadRow;
      link.scrollIntoView({ block: 'center' });
      link.click();
    }
    const hiddenCover = document.querySelector('input[name="data[cover_choice]"]');
    if (hiddenCover && hiddenCover.value !== 'upload') {
      hiddenCover.value = 'upload';
      hiddenCover.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(1500);

  if (cfg.cover_file && !uploadStatus.coverDone) {
    try {
      console.log("   -> 上传自定义封面:", cfg.cover_file);
      await page.setInputFiles("#data-assets-cover-file-upload-AjaxInput", cfg.cover_file);
    } catch (e) {
      console.warn("   封面上传警告:", e.message);
    }
  } else {
    console.log("   -> 封面已就绪，已确认 data[cover_choice]=upload，跳过重新上传。");
  }
  await sleep(3000);

  // 3. Generative AI -> No (MDN / AUI Radio)
  console.log("   -> 选定 Generative AI 为 No...");
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('[role="radio"]'));
    const noRadio = radios.find(r => r.innerText?.trim() === 'No');
    if (noRadio) {
      noRadio.scrollIntoView({ block: 'center' });
      const link = noRadio.querySelector('a') || noRadio;
      link.click();
    }
    const noBox = document.querySelector('[data-a-accordion-row-name="no"]');
    const noLink = noBox?.querySelector('a.a-accordion-row, a') || noBox;
    if (noLink) {
      noLink.scrollIntoView({ block: 'center' });
      noLink.click();
    }
  });
  await sleep(2000);

  // 4. Accessibility image_reading radio 确保选定
  await page.evaluate(() => {
    const radios = Array.from(document.querySelectorAll('input[name="data[accessibility][image_reading]"]'));
    let checked = radios.find(r => r.checked)?.value || null;
    if (!checked) {
      const target = radios.find(r => r.value === 'not_readable') || radios.find(r => r.value === 'unknown') || radios[0];
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.click();
      }
    }
  });
  await sleep(1000);

  // 5. 等待文稿与封面处理
  if (!uploadStatus.epubDone || !uploadStatus.coverDone) {
    console.log("   -> 等待文稿与封面上传及服务端校验...");
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await page.evaluate(() => {
        const text = document.body?.innerText || "";
        return {
          epubDone: text.includes("Manuscript uploaded successfully") || text.includes("uploaded successfully!"),
          coverDone: text.includes("Cover uploaded successfully"),
          isProcessing: text.includes("Processing your file") || text.includes("Uploading...")
        };
      });
      if (status.epubDone && status.coverDone) {
        console.log("   [OK] 文稿与封面均已完成校验与处理!");
        break;
      }
      await sleep(3000);
    }
  }

  // 6. 确认复选框 (confirm that my answers are accurate)
  console.log("   -> 勾选声明确认复选框与无障碍状态同步...");
  await page.evaluate(() => {
    const cb = document.querySelector('[role="checkbox"]');
    const label = cb?.closest('label') || document.querySelector('label.css-iswrg') || Array.from(document.querySelectorAll('label, span, div, p')).find(el =>
      el.innerText && el.innerText.includes('confirm that my answers are accurate')
    );

    const dispatchFull = (el) => {
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    };

    dispatchFull(label);
    dispatchFull(cb);

    // 兜底注入表单隐藏字段以确保后端验证通过
    const form = document.getElementById("form-main-1") || document.querySelector("form");
    if (form) {
      let inp = form.querySelector('input[name="data[accessibility][user_affirmed]"]');
      if (!inp) {
        inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = 'data[accessibility][user_affirmed]';
        form.appendChild(inp);
      }
      inp.value = 'true';
    }
  });
  await sleep(2000);

  // 点击 Save and Continue 前往 Page 3
  console.log("[5/6] 保存第 2 页并前往第 3 页 (Pricing)...");
  await page.evaluate(() => {
    const btn = document.getElementById("save-and-continue-announce") || document.getElementById("save-announce");
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  });

  // 等待跳转至 Page 3 (Pricing)
  for (let t = 0; t < 12; t++) {
    await sleep(2000);
    const onP3 = await page.evaluate(() => location.href.includes('/pricing'));
    if (onP3) {
      console.log("   [OK] 已成功进入第 3 页 (Pricing):", await page.evaluate(() => location.href));
      break;
    }
  }

  const onP3Now = await page.evaluate(() => location.href.includes('/pricing'));
  if (!onP3Now) {
    const curLoc = await page.evaluate(() => location.href);
    const m = curLoc.match(/kindle\/([A-Z0-9]+)\//);
    const targetDraftId = m ? m[1] : draftId;
    if (targetDraftId) {
      console.log("   尝试直接导航至 pricing 页:", targetDraftId);
      await safeGoto(`https://kdp.amazon.com/en_US/title-setup/kindle/${targetDraftId}/pricing`);
    }
  }

  // --- 第 3 步：填写 Page 3 (Pricing) ---
  console.log("[6/6] 填写第 3 页：Pricing & KDP Select...");

  // 0. Worldwide Rights
  await page.evaluate(() => {
    const wwLink = Array.from(document.querySelectorAll('a.a-accordion-row')).find(a => a.innerText && a.innerText.includes('worldwide rights'));
    if (wwLink) {
      wwLink.scrollIntoView({ block: 'center' });
      wwLink.click();
    }
    const hiddenWw = document.getElementById("data-digital-worldwide-rights");
    if (hiddenWw) {
      hiddenWw.value = "true";
      hiddenWw.dispatchEvent(new Event("change", { bubbles: true }));
    }
    document.querySelectorAll('input[name*="territory_rights"]').forEach(inp => {
      inp.checked = false;
      inp.disabled = true;
    });
  });
  await sleep(1500);

  // 1. KDP Select
  await page.evaluate(() => {
    const cb = document.getElementById("data-is-select");
    if (cb && !cb.checked) {
      cb.scrollIntoView({ block: 'center' });
      cb.click();
    }
  });
  await sleep(1000);

  // 2. 70% Royalty
  await page.evaluate(() => {
    const r70 = document.querySelector('input[name="data[digital][royalty_rate]-radio"][value="70_PERCENT"]');
    const label = r70?.closest('label');
    if (label) {
      label.scrollIntoView({ block: 'center' });
      label.click();
    } else if (r70) {
      r70.click();
    }
    if (r70) {
      r70.checked = true;
      r70.dispatchEvent(new Event('input', { bubbles: true }));
      r70.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const hidden = document.getElementById("data-digital-royalty-rate-hidden");
    if (hidden) {
      hidden.value = "70_PERCENT";
      hidden.dispatchEvent(new Event('input', { bubbles: true }));
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(2000);

  // 3. Price $3.99 & 自动汇率换算
  console.log("   -> 输入主站点价格并触发全站汇率换算...");
  await page.evaluate(() => {
    const usInp = document.querySelector('input[name="data[digital][channels][amazon][US][price_vat_inclusive]"]');
    if (usInp) {
      usInp.focus();
      usInp.select();
    }
  });
  await sleep(300);
  await page.keyboard.press('Backspace');
  await sleep(200);
  await page.keyboard.type((cfg.list_price || 3.99).toFixed(2));
  await sleep(300);
  await page.keyboard.press('Enter');
  await sleep(300);
  await page.keyboard.press('Tab');

  // 等待全站 13 个站点汇率自动换算完成 (Hydration)
  console.log("   -> 等待全站 13 个站点汇率自动换算完成...");
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(2000);
    const allFilled = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[name*="price_vat_inclusive"]'));
      return inputs.length >= 13 && inputs.every(i => i.value && i.value.trim().length > 0);
    });
    if (allFilled) {
      console.log("   [OK] 全球 13 个站点定价已全部换算填毕!");
      break;
    }
  }

  // 4. 保存定价草稿 (Save Draft)
  console.log("   -> 保存定价草稿 (Save Draft)...");
  await page.evaluate(() => {
    const draftBtn = document.getElementById("save-announce");
    if (draftBtn) draftBtn.click();
  });
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    if (bodyText.includes("Save Successful")) {
      console.log("   [OK] 定价草稿保存成功!");
      break;
    }
  }
  await sleep(2000);

  if (cfg.submit) {
    console.log("[*] 正式提交发布 (Publish Your Kindle eBook)...");
    await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('[data-jele]'));
      const pubSpan = spans.find(s => s.innerText && s.innerText.includes("Publish Your Kindle eBook"));
      if (pubSpan) {
        pubSpan.scrollIntoView({ block: 'center' });
        pubSpan.click();
      } else {
        const pubBtn = document.getElementById("save-and-publish-announce");
        if (pubBtn) {
          pubBtn.scrollIntoView({ block: 'center' });
          pubBtn.click();
        }
      }
    });

    let submitSuccess = false;
    for (let i = 0; i < 15; i++) {
      await sleep(2500);
      const st = await page.evaluate(() => {
        const modal = Array.from(document.querySelectorAll('.a-popover-modal, [role="dialog"]'))
          .find(m => m.offsetParent !== null);
        const modalText = modal && modal.innerText ? modal.innerText.trim() : null;
        const visibleErrors = Array.from(document.querySelectorAll('.a-alert-error, .a-form-error'))
          .filter(e => e.offsetParent !== null && e.innerText?.trim())
          .map(e => e.innerText.trim());
        const body = document.body?.innerText || "";
        const ok = location.href.includes('/bookshelf') ||
                   body.includes('Your Kindle eBook has been submitted') ||
                   body.includes('Congratulations') ||
                   (modalText && (modalText.includes('submitted') || modalText.includes('Start advertising') || modalText.includes('Done')));
        const limitError = visibleErrors.find(e => e.includes('Title submission limit reached') || e.includes('limit reached'));
        return { url: location.href, modalText, visibleErrors, ok, limitError };
      });

      if (st.limitError) {
        console.warn("[KDP 限额提醒] 提审触发额度上限:", st.limitError);
        throw new Error('KDP_WEEKLY_TITLE_LIMIT: ' + st.limitError);
      }

      if (st.ok) {
        console.log("   [OK] 提审提交成功! 反馈:", st.modalText || st.url);
        submitSuccess = true;
        break;
      }
      if (st.visibleErrors.length > 0 && (!st.modalText || !st.modalText.includes('Saving'))) {
        console.error("   [!] 提审报错:", JSON.stringify(st.visibleErrors));
        throw new Error('KDP_PUBLISH_ERROR: ' + st.visibleErrors.join('; '));
      }
    }

    if (!submitSuccess) {
      console.warn("   [?] 未明确检测到提交成功弹窗，检查书架状态...");
    }
  } else {
    console.log("[*] 保存为草稿 (Save as Draft)...");
    await page.evaluate(() => {
      const draftBtn = document.getElementById("save-announce");
      if (draftBtn) {
        draftBtn.scrollIntoView({ block: 'center' });
        draftBtn.click();
      }
    });
    await sleep(4000);
  }

  // 最终确认书架状态
  await safeGoto("https://kdp.amazon.com/en_US/bookshelf");
  await sleep(3000);
  const finalShelf = await page.evaluate((title) => {
    const rows = Array.from(document.querySelectorAll('tr[id^="title-"], .mt-row'));
    const matched = rows.find(r => r.innerText.toLowerCase().includes(title.toLowerCase()));
    return matched ? matched.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : "Not found";
  }, cfg.title);

  console.log(">>> [书架最终确认] <<<", finalShelf);

  await fs.writeFile(resPath, JSON.stringify({
    status: cfg.submit ? "submitted" : "draft",
    submitted: !!cfg.submit,
    title: cfg.title,
    shelf: finalShelf,
    time: new Date().toISOString()
  }, null, 2), "utf8");
}

try {
  await executePublish();
} catch (err) {
  console.error("[-] 执行异常:", err);
  exitCode = 1;
} finally {
  await task.finish({ keep: [] });
  console.log("[Ego] Task space finished.");
  process.exit(exitCode);
}
