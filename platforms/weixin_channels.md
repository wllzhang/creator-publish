# weixin_channels

```yaml
id: weixin_channels
capabilities: [video_mp4]
via: ego
default_mode: draft
allowed_modes: [draft, submit]
```

## inputs（video_mp4）

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| video | yes | absolute path to **usable** mp4（正式成片；过短/残片可能上传后仍无法保存草稿） |
| title | yes | short title |
| body | no | description（未传则回退为 `title`） |
| topics | no | topic/hashtag list（点击 `#话题` + 键入词条 + 敲空格 `Space` 生成真实可点击蓝色 `<span class="hl topic">` 标签） |

## notes

- Page mounts inside **`wujie-app` shadowRoot** and/or **iframe**; adapter traverses `document`, iframes, and `wujie-app.shadowRoot` uniformly, falling back to `waitForFileChooser` + mouse click when `input[type="file"]` lives inside shadowRoot.
- Description editor has **no** topic autocomplete dropdown; writing plain `innerText` leaves `#tag` as black text. Clicking `#话题` + typing keyword + pressing **`Space`** converts `#word` into `<span class="hl topic" data-type="topic">`.
- Draft path clicks the enabled `<button>`「保存草稿」(not the popover wrapper). Success: page shows **已保存** / `WEIXIN_CHANNELS_DRAFT_DONE`.
- Check **草稿箱** at `https://channels.weixin.qq.com/platform/post/draftListManager`.

## success_when

- draft: video uploaded + short title/body/topics filled + **保存草稿** → `已保存`
- submit: only with explicit `--mode submit` / authorization (clicks 发表)

## run

```text
node runtime/run.mjs --platform weixin_channels --profile-id <id> --video C:/abs/视频.mp4 --title "短标题" --body "..." --topics "话题1,话题2"
```
