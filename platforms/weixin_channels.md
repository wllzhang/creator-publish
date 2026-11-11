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
| body | no | description |

## notes

- Upload control lives in an **iframe**; adapter tags that input then `setInputFiles`.
- Draft path clicks the enabled `button`「保存草稿」(not the popover wrapper). Success: page shows **已保存** / `WEIXIN_CHANNELS_DRAFT_DONE`.
- Check **草稿箱** at `https://channels.weixin.qq.com/platform/post/draftListManager`.

## success_when

- draft: video uploaded + short title/body filled + **保存草稿** → `已保存`
- submit: only with explicit `--mode submit` / authorization (clicks 发表)

## run

```text
node runtime/run.mjs --platform weixin_channels --profile-id <id> --video C:/abs/视频.mp4 --title "短标题" --body "..."
```
