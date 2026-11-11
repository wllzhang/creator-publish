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
const task = await taskSpace(cfg.space_name || ("kdp-pub-" + Date.now()), { profileId: targetProfileId });
console.log("[Ego] Task spaceId:", task.spaceId);
const page = task.page("p1");

try {
  console.log("[1/6] 检查当前 KDP 页面与书架...");
  await safeGoto("https://kdp.amazon.com/en_US/bookshelf");

  // 检查是否已有该书的草稿
  const existingDraftLink = await page.evaluate((title) => {
    const rows = Array.from(document.querySelectorAll("tr, [data-row]"));
    for (const r of rows) {
      if (r.innerText.includes(title)) {
        const link = r.querySelector("a[href*='/title-setup/kindle/']");
        if (link) return link.href;
      }
    }
    return null;
  }, cfg.title);

  if (existingDraftLink) {
    console.log("[*] 发现已有书籍草稿，直接进入详情编辑页:", existingDraftLink);
    await safeGoto(existingDraftLink);
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

  // 1. Title, Subtitle, Author
  await page.evaluate(({ title, subtitle, first, last }) => {
    const t = document.getElementById("data-title");
    if (t) {
      t.value = title;
      t.dispatchEvent(new Event("input", { bubbles: true }));
      t.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const s = document.getElementById("data-subtitle");
    if (s && subtitle) {
      s.value = subtitle;
      s.dispatchEvent(new Event("input", { bubbles: true }));
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const af = document.getElementById("data-primary-author-first-name");
    if (af) {
      af.value = first;
      af.dispatchEvent(new Event("input", { bubbles: true }));
      af.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const al = document.getElementById("data-primary-author-last-name");
    if (al) {
      al.value = last;
      al.dispatchEvent(new Event("input", { bubbles: true }));
      al.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { title: cfg.title, subtitle: cfg.subtitle, first: cfg.author_first, last: cfg.author_last });

  // 2. CKEditor Description
  await page.evaluate((descHtml) => {
    if (window.CKEDITOR && window.CKEDITOR.instances && window.CKEDITOR.instances.editor1) {
      window.CKEDITOR.instances.editor1.setData(descHtml);
    }
    const hiddenDesc = document.querySelector('input[name="data[description]"]');
    if (hiddenDesc) {
      hiddenDesc.value = descHtml;
      hiddenDesc.dispatchEvent(new Event("input", { bubbles: true }));
      hiddenDesc.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, cfg.description_html);

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

  // 4. Keywords
  await page.evaluate((keywords) => {
    for (let i = 0; i < 7; i++) {
      const inp = document.getElementById(`data-keywords-${i}`);
      if (inp && keywords[i]) {
        inp.value = keywords[i];
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }, cfg.keywords);

  await sleep(1000);

  // 5. Categories Selection (React Popover 级联选择器)
  console.log("   -> 配置分类 (Categories)...");
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

  // 触发 React 级联类目选择
  console.log("   -> 在弹窗中选择 Romance / Paranormal / Shifters...");
  await page.evaluate(() => {
    const select = document.querySelector('select[name="react-aui-0"]');
    if (select) {
      const opt = Array.from(select.options).find(o => o.text.includes('Romance')) ||
                  Array.from(select.options).find(o => o.text.includes('Science Fiction & Fantasy')) ||
                  Array.from(select.options).find(o => o.text.includes('Literature & Fiction'));
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
    // 优先勾选 Action & Adventure、Alpha Male 或任意子类目 checkbox
    const cb = document.querySelector('.a-popover-modal input[type="checkbox"], [role="dialog"] input[type="checkbox"]');
    if (cb) {
      cb.click();
    }

    // 点击 Save categories 按钮
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const saveCatBtn = btns.find(b => (b.innerText || b.value || '').trim() === 'Save categories');
    if (saveCatBtn) {
      saveCatBtn.scrollIntoView({ block: 'center' });
      saveCatBtn.click();
    }
  });

  await sleep(3000);

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
    const text = document.body.innerText || "";
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

  // 检查是否成功到达 Page 2，若未跳转但已有 draftId 则直接导航
  const onPage2 = await page.evaluate(() => location.href.includes('/content'));
  if (!onPage2) {
    const currentLoc = await page.evaluate(() => location.href);
    console.warn("   [!] 尚未自动跳转至第 2 页，当前 URL:", currentLoc);
    const draftIdMatch = currentLoc.match(/kindle\/([A-Z0-9]+)\//);
    if (draftIdMatch) {
      const contentUrl = `https://kdp.amazon.com/en_US/title-setup/kindle/${draftIdMatch[1]}/content`;
      console.log("   尝试直接导航至 content 页:", contentUrl);
      await safeGoto(contentUrl);
    }
  }

  // --- 第 2 步：填写 Page 2 (Content) ---
  console.log("[4/6] 填写第 2 页：Kindle eBook Content (上传正文与封面)...");

  // 1. DRM
  await page.evaluate(() => {
    const drmRadio = document.querySelector('input[name="data[is_drm]-radio"][value="false"]');
    if (drmRadio) drmRadio.click();
  });
  await sleep(1000);

  // 2. Upload EPUB & Cover
  if (cfg.epub_file) {
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
  }
  await sleep(3000);

  if (cfg.cover_file) {
    try {
      console.log("   -> 展开封面上传区并上传封面:", cfg.cover_file);
      await page.evaluate(() => {
        const uploadAccordion = document.querySelector('[data-a-accordion-row-name="upload"]') ||
                                Array.from(document.querySelectorAll('.a-accordion-row, a, button, span, label'))
                                     .find(r => r.innerText?.includes('Upload a cover you already have'));
        if (uploadAccordion) {
          uploadAccordion.scrollIntoView({ block: 'center' });
          uploadAccordion.click();
        }
      });
      await sleep(3000);
      await page.setInputFiles("#data-assets-cover-file-upload-AjaxInput", cfg.cover_file);
    } catch (e) {
      console.warn("   封面上传警告:", e.message);
    }
  }
  await sleep(4000);

  // 3. AI Disclosure (AUI Accordion & Confirmation Checkbox)
  await page.evaluate(() => {
    const noRow = document.querySelector('[data-a-accordion-row-name="no"]');
    const noLink = noRow?.querySelector('a') || noRow;
    if (noLink) {
      noLink.scrollIntoView({ block: 'center' });
      noLink.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    const confirmCb = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).find((el) => {
      return el.closest('label, div, span')?.innerText?.includes('confirm that my answers are accurate');
    });
    if (confirmCb && confirmCb.getAttribute('aria-checked') !== 'true') {
      confirmCb.scrollIntoView({ block: 'center' });
      confirmCb.click();
    }
  });

  // 等待文稿与封面处理
  console.log("   -> 等待文稿与封面上传及服务端校验...");
  for (let attempt = 0; attempt < 18; attempt++) {
    const status = await page.evaluate(() => {
      const text = document.body.innerText;
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
    await sleep(2500);
  }

  // 再次确保 AI 确认框已勾选
  await page.evaluate(() => {
    const confirmCb = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]')).find((el) => {
      return el.closest('label, div, span')?.innerText?.includes('confirm that my answers are accurate');
    });
    if (confirmCb && confirmCb.getAttribute('aria-checked') !== 'true') {
      confirmCb.scrollIntoView({ block: 'center' });
      confirmCb.click();
    }
  });

  await sleep(2000);

  // 点击 Save and Continue 前往 Page 3
  console.log("[5/6] 保存第 2 页并前往第 3 页 (Pricing)...");
  await page.evaluate(() => {
    const btn = document.getElementById("save-and-continue-announce") || document.getElementById("save-announce");
    if (btn) {
      btn.scrollIntoView({ block: 'center' });
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  const onPage3 = await page.evaluate(() => location.href.includes('/pricing'));
  if (!onPage3) {
    const currentLoc = await page.evaluate(() => location.href);
    const draftIdMatch = currentLoc.match(/kindle\/([A-Z0-9]+)\//);
    if (draftIdMatch) {
      const pricingUrl = `https://kdp.amazon.com/en_US/title-setup/kindle/${draftIdMatch[1]}/pricing`;
      console.log("   尝试直接导航至 pricing 页:", pricingUrl);
      await safeGoto(pricingUrl);
    }
  }

  // --- 第 3 步：填写 Page 3 (Pricing) ---
  console.log("[6/6] 填写第 3 页：Pricing & KDP Select...");

  // 0. Worldwide Rights
  await page.evaluate(() => {
    const wwRadio = document.getElementById("data-digital-worldwide-rights") || document.querySelector('input[value="true"][name*="worldwide"]');
    if (wwRadio && !wwRadio.checked) {
      wwRadio.scrollIntoView({ block: 'center' });
      wwRadio.click();
      wwRadio.checked = true;
      wwRadio.dispatchEvent(new Event("input", { bubbles: true }));
      wwRadio.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(1000);

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
    if (r70) {
      r70.scrollIntoView({ block: 'center' });
      r70.click();
      r70.checked = true;
      r70.dispatchEvent(new Event("input", { bubbles: true }));
      r70.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await sleep(1500);

  // 3. Price $3.99
  await page.evaluate((price) => {
    const pInput = document.getElementById("data-pricing-plan-us-price-input") || 
                   document.querySelector('input[name*="[price]"]');
    if (pInput) {
      pInput.scrollIntoView({ block: 'center' });
      pInput.focus();
      pInput.value = price.toFixed(2);
      pInput.dispatchEvent(new Event("input", { bubbles: true }));
      pInput.dispatchEvent(new Event("change", { bubbles: true }));
      pInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      pInput.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      pInput.blur();
    }
  }, cfg.list_price || 3.99);

  await sleep(3000);

  if (cfg.submit) {
    console.log("[*] 正式提交发布 (Publish Your Kindle eBook)...");
    await page.evaluate(() => {
      const pubBtn = document.getElementById("save-and-publish-announce");
      if (pubBtn) {
        pubBtn.scrollIntoView({ block: 'center' });
        pubBtn.click();
      }
    });
  } else {
    console.log("[*] 保存为草稿 (Save as Draft)...");
    await page.evaluate(() => {
      const draftBtn = document.getElementById("save-announce");
      if (draftBtn) {
        draftBtn.scrollIntoView({ block: 'center' });
        draftBtn.click();
      }
    });
  }

  await sleep(6000);

  const finalReport = await page.evaluate(() => {
    const alerts = Array.from(document.querySelectorAll('.a-alert-content, .a-box-inner')).map(e => e.innerText?.trim()).filter(Boolean);
    return {
      url: location.href,
      alerts: alerts.slice(0, 5)
    };
  });

  console.log(">>> 发布流水线执行完成! 页面反馈: <<<", JSON.stringify(finalReport, null, 2));

} catch (err) {
  console.error("[-] 执行异常:", err);
} finally {
  await task.finish({ keep: [] });
  console.log("[Ego] Task space finished.");
}
