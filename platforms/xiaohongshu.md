# xiaohongshu

```yaml
id: xiaohongshu
capabilities: [image_carousel, video_mp4]
via: ego
default_mode: draft
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| images | conditional | comma-separated absolute image paths（图文模式必填） |
| video | conditional | absolute path to mp4（视频模式必填；与 `images` 二选一） |
| cover | no | absolute path to custom cover image（视频模式下悬停封面缩略图进入「编辑封面」弹窗上传） |
| title | yes | string（先完整写入并结合平台计数器做中英加权长度保护，不粗暴截断末尾字符） |
| body / body-file | no | caption HTML/text value or file（纯文本保留段落/`<br>`） |
| topics / tags | no | comma-separated；点「话题」+ 键入词条 → 优先鼠标点击 `.tippy-content` 实时热词推荐（未匹配时敲 `Space` 兜底），生成可点击蓝色 `<a class="tiptap-topic">` |
| ai-generated | no | boolean flag（默认 `false`；传 `--ai-generated` 时在「添加内容类型声明」选择 `笔记含AI合成内容` → `XHS_AI_DECLARED`） |
| hotspot / activity / no-auto-hotspot / shot-dir | no | optional hotspot keyword(s), opt-out flag (`--no-auto-hotspot`), or screenshot directory |

## behavior

- **Image carousel mode** (`--images`): clicks **上传图文**, uploads images, fills title/body/topics.
- **Video mode** (`--video`): selects **上传视频**, uploads MP4 and waits for upload completion, dismisses onboarding popups (`我知道了` e.g. PK封面 prompt), optionally uploads custom `cover` via `.cover-edit-entry` → `.main-cover-editor-modal` (`XHS_VIDEO_COVER_SET`).
- Topics: click **话题** → type keyword → match & click the live `.tippy-content` trending suggestion to attach `<a class="tiptap-topic">` with platform topic ID (falls back to **Space** only if no suggestion matches). When `<6` topics and `autoHotspot` is on, may add 1–2 matching recommend topic chips.
- **原创声明** is turned ON by default after form fill.
- When `--ai-generated` is set, opens **添加内容类型声明** and selects **笔记含AI合成内容** (`XHS_AI_DECLARED`).
- draft: media + optional cover + title/body/topics + originality + optional AI disclosure + screenshots saved (`xhs_before_draft.png` / `xhs_after_draft.png`, plus `xhs_before_draft_top.png` in video mode) + **暂存离开**

## run

```text
# 图文模式
node runtime/run.mjs --platform xiaohongshu --profile-id <id> --images C:/a.jpg,C:/b.jpg --title "..." --body "..." --topics a,b

# 视频模式（含自定义封面与 AI 声明）
node runtime/run.mjs --platform xiaohongshu --profile-id <id> --video C:/abs/video.mp4 --cover C:/abs/cover.png --title "..." --body "..." --topics a,b --ai-generated
```
