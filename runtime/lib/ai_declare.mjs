import { humanPause, humanMouseClick } from './pace.mjs';
import { evalAllRoots } from './ego_dom.mjs';

/**
 * 抖音：在「自主声明」行选择「内容由AI生成」并点击弹窗确定。
 */
export async function declareDouyinAiGenerated(page) {
  const hasDeclRow = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div, span, label')).some(
      (el) => el.childElementCount <= 1 && /^自主声明$/.test((el.innerText || '').trim()) && el.offsetWidth > 0,
    ),
  );
  if (!hasDeclRow) {
    const expanded = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('div, span, button')).find((el) => {
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return el.childElementCount <= 1 && el.offsetWidth > 0 && /^(扩展信息|展开扩展信息|展开更多)$/.test(t);
      });
      if (btn) {
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      }
      return false;
    });
    if (expanded) await humanPause(600, 1000, '展开扩展信息', 'dy');
  }

  const trigger = await page.evaluate(() => {
    const lbl = Array.from(document.querySelectorAll('div, span, label')).find(
      (el) => el.childElementCount <= 1 && /^自主声明$/.test((el.innerText || '').trim()) && el.offsetWidth > 0,
    );
    const section = lbl?.closest('section') || lbl?.parentElement?.parentElement;
    const box =
      section?.querySelector('[class*="selectBox"], [class*="selectText"], .semi-select, [role="combobox"], button') ||
      Array.from(document.querySelectorAll('div, span, button')).find((el) => {
        const t = (el.innerText || '').replace(/\s+/g, '').trim();
        return el.offsetWidth > 0 && /^(请选择自主声明|添加声明|选择声明|请添加声明|内容由AI生成)$/.test(t);
      });
    if (!box) return { found: false };
    box.scrollIntoView({ block: 'center' });
    const txt = (section?.innerText || box.innerText || '').replace(/\s+/g, ' ').trim();
    const r = box.getBoundingClientRect();
    return {
      found: true,
      already: /内容由AI生成/.test(txt),
      text: txt,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  });

  if (!trigger.found) {
    console.warn('[dy] 自主声明控件未找到');
    return { ok: false, reason: 'trigger not found' };
  }
  if (trigger.already) {
    console.log('DOUYIN_AI_DECLARED');
    return { ok: true, already: true, text: trigger.text };
  }

  await humanMouseClick(page, trigger.x, trigger.y, { radius: 3, tag: 'dy' });

  let modalReady = false;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 400));
    modalReady = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.semi-modal, [role="dialog"]')).some((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 120 && r.height > 80 && /对作品内容添加声明|请选择声明类型|内容由AI生成/.test(m.innerText || '');
      }),
    );
    if (modalReady) break;
  }
  if (!modalReady) {
    console.warn('[dy] 自主声明弹窗未打开');
    return { ok: false, reason: 'modal not opened' };
  }

  const radioPicked = await page.evaluate(() => {
    const modal = Array.from(document.querySelectorAll('.semi-modal, [role="dialog"]')).find((m) =>
      /对作品内容添加声明|请选择声明类型|内容由AI生成/.test(m.innerText || ''),
    );
    if (!modal) return null;
    const lbl = Array.from(modal.querySelectorAll('label.semi-radio, label, [role="radio"]')).find((el) =>
      /内容由AI生成/.test(el.innerText || ''),
    );
    if (!lbl) return null;
    lbl.scrollIntoView({ block: 'center' });
    lbl.click();
    const r = lbl.getBoundingClientRect();
    return { text: (lbl.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!radioPicked) {
    console.warn('[dy] 未找到「内容由AI生成」单选项');
    return { ok: false, reason: 'radio not found' };
  }
  await humanPause(600, 1000, '点选内容由AI生成后', 'dy');

  let okInfo = null;
  for (let i = 0; i < 8; i++) {
    okInfo = await page.evaluate(() => {
      const modal = Array.from(document.querySelectorAll('.semi-modal, [role="dialog"]')).find((m) =>
        /对作品内容添加声明|请选择声明类型|内容由AI生成/.test(m.innerText || ''),
      );
      if (!modal) return { open: false };
      const btn = Array.from(modal.querySelectorAll('button')).find(
        (b) => (b.innerText || '').replace(/\s+/g, '').trim() === '确定',
      );
      if (!btn) return { open: true, found: false };
      const disabled = !!btn.disabled || (btn.className || '').includes('disabled');
      const r = btn.getBoundingClientRect();
      if (!disabled) btn.click();
      return { open: true, found: true, disabled, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!okInfo.open || (okInfo.found && !okInfo.disabled)) break;
    await new Promise((r) => setTimeout(r, 300));
  }

  await humanPause(600, 1000);
  const stillOpenBtn = await page.evaluate(() => {
    const modal = Array.from(document.querySelectorAll('.semi-modal, [role="dialog"]')).find((m) =>
      /对作品内容添加声明|请选择声明类型|内容由AI生成/.test(m.innerText || ''),
    );
    if (!modal) return null;
    const btn = Array.from(modal.querySelectorAll('button')).find(
      (b) => (b.innerText || '').replace(/\s+/g, '').trim() === '确定' && !b.disabled,
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (stillOpenBtn) {
    await humanMouseClick(page, stillOpenBtn.x, stillOpenBtn.y, { radius: 2, tag: 'dy' });
    await humanPause(800, 1200);
  }

  const after = await page.evaluate(() => {
    const lbl = Array.from(document.querySelectorAll('div, span, label')).find(
      (el) => el.childElementCount <= 1 && /^自主声明$/.test((el.innerText || '').trim()) && el.offsetWidth > 0,
    );
    const section = lbl?.closest('section') || lbl?.parentElement?.parentElement;
    return (section?.innerText || '').replace(/\s+/g, ' ').trim();
  });
  const ok = /内容由AI生成/.test(after);
  if (ok) {
    console.log('DOUYIN_AI_DECLARED', after);
    return { ok: true, text: after };
  }
  console.warn('[dy] 自主声明回显未确认:', after);
  return { ok: false, text: after };
}

/**
 * 小红书：在「内容设置 → 添加内容类型声明」中选择「笔记含AI合成内容」。
 */
export async function declareXhsAiGenerated(page) {
  const findSelect = () =>
    page.evaluate(() => {
      const el =
        document.querySelector('[lass="declaration-wrapper"] .d-select, .declaration-wrapper .d-select') ||
        Array.from(document.querySelectorAll('.d-select')).find((d) =>
          /添加内容类型声明|内容类型声明|笔记含AI合成内容|虚构演绎/.test(d.innerText || ''),
        );
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const r = el.getBoundingClientRect();
      return {
        text,
        already: /笔记含AI合成内容|AI合成|AI生成/.test(text),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      };
    });

  let sel = await findSelect();
  if (!sel) {
    // Expand 内容设置 if collapsed
    await page.evaluate(() => {
      const header = Array.from(document.querySelectorAll('div, span, button')).find(
        (el) => el.childElementCount <= 1 && /^内容设置$/.test((el.innerText || '').trim()) && el.getBoundingClientRect().width > 0,
      );
      const expand = header?.parentElement?.querySelector('[class*="expand"], [class*="toggle"], span, div');
      if (expand && /展开/.test(expand.innerText || '')) expand.click();
    });
    await humanPause(500, 800);
    sel = await findSelect();
  }

  if (!sel) {
    console.warn('[xhs] 未找到「添加内容类型声明」下拉框');
    return { ok: false, reason: 'select not found' };
  }
  if (sel.already) {
    console.log('XHS_AI_DECLARED', sel.text);
    return { ok: true, already: true, text: sel.text };
  }

  await humanMouseClick(page, sel.x, sel.y, { radius: 3, tag: 'xhs' });
  await humanPause(800, 1300, '展开内容类型声明', 'xhs');

  const optBox = await page.evaluate(() => {
    const scope =
      document.querySelector('.declaration-drop-down') ||
      Array.from(document.querySelectorAll('.d-popover, .d-dropdown, .d-select-dropdown')).find(
        (el) => el.getBoundingClientRect().height > 20 && /笔记含AI合成内容/.test(el.innerText || ''),
      );
    if (!scope) return null;
    const candidates = Array.from(scope.querySelectorAll('.d-option-content, .d-option, .d-grid-item, li, div')).filter(
      (el) => el.getBoundingClientRect().width > 20 && /笔记含AI合成内容|AI合成|AI生成/.test((el.innerText || '').trim()),
    );
    candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const hit = candidates[0];
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { text: (hit.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (!optBox) {
    console.warn('[xhs] 未找到「笔记含AI合成内容」选项');
    await page.keyboard.press('Escape');
    return { ok: false, reason: 'option not found' };
  }

  await humanMouseClick(page, optBox.x, optBox.y, { radius: 3, tag: 'xhs' });
  await humanPause(700, 1100, '选中AI合成声明后', 'xhs');

  let after = await findSelect();
  if (!after?.already) {
    await page.evaluate(() => {
      const scope = document.querySelector('.declaration-drop-down');
      const hit = Array.from(scope?.querySelectorAll('.d-option-content, .d-option, .d-grid-item') || []).find((el) =>
        /笔记含AI合成内容|AI合成|AI生成/.test((el.innerText || '').trim()),
      );
      hit?.click();
    });
    await humanPause(700, 1000);
    after = await findSelect();
  }

  if (after?.already) {
    console.log('XHS_AI_DECLARED', after.text);
    return { ok: true, text: after.text };
  }
  console.warn('[xhs] AI合成声明回显未确认:', after?.text);
  return { ok: false, text: after?.text || '' };
}

/**
 * 微信视频号：在「视频标注」中选择「含AI生成内容」（支持 document / iframe / wujie-app shadowRoot）。
 */
export async function declareChannelsAiGenerated(page) {
  const trigger = await evalAllRoots(page, (roots) => {
    for (const { name, root } of roots) {
      const row =
        root.querySelector('.post-with-mark-tag') ||
        Array.from(root.querySelectorAll('.form-item')).find((el) => /视频标注/.test(el.innerText || ''));
      const disp = row?.querySelector('.select-display');
      if (disp) {
        disp.scrollIntoView({ block: 'center' });
        const text = (disp.innerText || '').replace(/\s+/g, ' ').trim();
        const r = disp.getBoundingClientRect();
        if (!/含AI生成内容/.test(text)) disp.click();
        return {
          found: true,
          root: name,
          already: /含AI生成内容/.test(text),
          text,
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
      }
    }
    return { found: false };
  });

  if (!trigger?.found) {
    console.warn('[wxch] 未找到「视频标注」下拉框');
    return { ok: false, reason: 'trigger not found' };
  }
  if (trigger.already) {
    console.log('WXCH_AI_DECLARED', trigger.text);
    return { ok: true, already: true, text: trigger.text };
  }

  await humanPause(700, 1100, '展开视频标注', 'wxch');

  // Ensure dropdown actually opened; fallback to mouse click if needed
  const isOpen = await evalAllRoots(page, (roots) => {
    for (const { root } of roots) {
      const opts = root.querySelector('.post-with-mark-tag .mark-tag-options, .mark-tag-options');
      if (opts && opts.getBoundingClientRect().height > 10) return true;
    }
    return false;
  });
  if (!isOpen && trigger.x > 0) {
    await humanMouseClick(page, trigger.x, trigger.y, { radius: 2, tag: 'wxch' });
    await humanPause(700, 1100);
  }

  const picked = await evalAllRoots(page, (roots) => {
    for (const { root } of roots) {
      const opts = Array.from(root.querySelectorAll('.post-with-mark-tag .mark-tag-option, .mark-tag-options .mark-tag-option'));
      const hit = opts.find((el) => {
        const main = el.querySelector('.option-main') || el;
        return (main.innerText || '').replace(/\s+/g, '').trim() === '含AI生成内容';
      });
      if (hit) {
        hit.scrollIntoView({ block: 'center' });
        hit.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        hit.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
        hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        hit.click();
        return { ok: true, text: (hit.innerText || '').trim() };
      }
    }
    return { ok: false };
  });

  if (!picked?.ok) {
    console.warn('[wxch] 未找到「含AI生成内容」视频标注项');
    return { ok: false, reason: 'option not found' };
  }
  await humanPause(600, 1000, '选择视频标注后', 'wxch');

  const afterText = await evalAllRoots(page, (roots) => {
    for (const { root } of roots) {
      const disp = root.querySelector('.post-with-mark-tag .select-display');
      if (disp) return (disp.innerText || '').replace(/\s+/g, ' ').trim();
    }
    return '';
  });
  const ok = /含AI生成内容/.test(afterText);
  if (ok) {
    console.log('WXCH_AI_DECLARED', afterText);
    return { ok: true, text: afterText };
  }
  console.warn('[wxch] 视频标注回显未确认:', afterText);
  return { ok: false, text: afterText };
}

/**
 * B站：在「* 创作声明」中选择「含AI生成内容」。
 */
export async function declareBilibiliAiGenerated(page) {
  const trigger = await page.evaluate(() => {
    const container =
      document.querySelector('.creation-statement-container') ||
      Array.from(document.querySelectorAll('.form-item')).find((el) =>
        /^创作声明$/.test((el.querySelector('h3.section-title-content-main')?.innerText || '').trim()),
      );
    const select = container?.querySelector('.bcc-select');
    if (!select) return { found: false };
    const input = select.querySelector('.bcc-select-input-inner');
    const wrap = select.querySelector('.bcc-select-input-wrap') || select;
    const current = (input?.value || select.innerText || '').replace(/\s+/g, ' ').trim();
    wrap.scrollIntoView({ block: 'center' });
    const r = wrap.getBoundingClientRect();
    if (!/含AI生成内容/.test(current)) wrap.click();
    return {
      found: true,
      already: /含AI生成内容/.test(current),
      text: current,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    };
  });

  if (!trigger.found) {
    console.warn('[bili] 未找到「创作声明」选择框');
    return { ok: false, reason: 'select not found' };
  }
  if (trigger.already) {
    console.log('BILIBILI_AI_DECLARED', trigger.text);
    return { ok: true, already: true, text: trigger.text };
  }

  await humanPause(600, 1000, '展开创作声明', 'bili');

  const listVisible = await page.evaluate(() => {
    const list = document.querySelector('.creation-statement-container .bcc-select-list-wrap, .creation-statement-container .bcc-select-option-list');
    return !!(list && list.getBoundingClientRect().height > 10);
  });
  if (!listVisible && trigger.x > 0) {
    await humanMouseClick(page, trigger.x, trigger.y, { radius: 2, tag: 'bili' });
    await humanPause(600, 1000);
  }

  const optInfo = await page.evaluate(() => {
    const list = document.querySelector('.creation-statement-container .bcc-select-option-list') || document;
    const hit = Array.from(list.querySelectorAll('li.bcc-option, .bcc-option')).find(
      (el) => (el.innerText || '').replace(/\s+/g, '').trim() === '含AI生成内容',
    );
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center' });
    const r = hit.getBoundingClientRect();
    hit.click();
    return { text: (hit.innerText || '').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });

  if (!optInfo) {
    console.warn('[bili] 未找到「含AI生成内容」创作声明项');
    return { ok: false, reason: 'option not found' };
  }
  await humanPause(600, 1000, '选择创作声明后', 'bili');

  let after = await page.evaluate(() => {
    const inp = document.querySelector('.creation-statement-container .bcc-select-input-inner');
    return (inp?.value || '').trim();
  });
  if (!/含AI生成内容/.test(after) && optInfo.x > 0) {
    await humanMouseClick(page, optInfo.x, optInfo.y, { radius: 2, tag: 'bili' });
    await humanPause(600, 1000);
    after = await page.evaluate(() => {
      const inp = document.querySelector('.creation-statement-container .bcc-select-input-inner');
      return (inp?.value || '').trim();
    });
  }

  const ok = /含AI生成内容/.test(after);
  if (ok) {
    console.log('BILIBILI_AI_DECLARED', after);
    return { ok: true, text: after };
  }
  console.warn('[bili] 创作声明回显未确认:', after);
  return { ok: false, text: after };
}
