# youtube

```yaml
id: youtube
capabilities: [video_mp4]
via: ego
default_mode: draft
allowed_modes: [draft]
```

## inputs（video_mp4）

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile（如 `Profile 2`） |
| video | yes | absolute path to mp4 |
| title | yes | video title（自动限制在 100 字符以内，填前清空 Studio 自动带入的文件名） |
| body | no | optional video description（若有 `topics` 则会在简介末尾附加 `#tag` 话题标签） |
| topics | no | comma-separated tags / hashtags（同时作为 `#tag` 附加到简介，并展开 `Show more` 后写入 `#tags-container`，最多 10 个） |
| cover | no | absolute path to custom thumbnail image（经 `#file-loader` / `ytcp-thumbnail-uploader` 上传） |
| ai-generated | no | boolean flag（默认 `false`；传 `--ai-generated` 时展开 `Show more` 并选择 Altered content `Yes` / `VIDEO_ALTERED_CONTENT_YES` → `YOUTUBE_AI_DECLARED`） |
| shot-dir | no | optional directory for `yt_before_draft.png` and `yt_after_draft.png` proof screenshots |

## behavior

- **Strict draft-only**: `mode` other than `draft` is rejected immediately (`YOUTUBE_SUBMIT_FORBIDDEN_DRAFT_ONLY`). The adapter never clicks `#next-button`, `#done-button`, `Save`, `Publish`, or `Public`.
- Navigates to `https://studio.youtube.com`; if redirected to `accounts.google.com` or gated by 2FA/CAPTCHA, aborts immediately with `NEED_LOGIN_YOUTUBE`.
- Triggers upload dialog via `button[aria-label="Create"]` → `#text-item-0` (`#upload-icon` / `?d=ud` fallback) and attaches MP4 to `ytcp-uploads-dialog input[type="file"][name="Filedata"]`.
- Polls up to 45s for Details step (`#title-textarea #textbox`), replaces auto-filled filename with `title` (≤ 100 chars), fills description (`body` + `#hashtags`), uploads optional `cover`, and selects `"No, it's not made for kids"` (`VIDEO_MADE_FOR_KIDS_NOT_MFK`).
- When `ai-generated` or `topics` is present, clicks `Show more` (`#toggle-button` in `ytcp-uploads-details`), optionally declares altered/synthetic content (`VIDEO_ALTERED_CONTENT_YES`), and enters up to 10 tags in `#tags-container` (`#text-input` + `Enter`).
- Waits up to 90s for upload completion / Studio auto-save (`Saved as draft` / `已保存为草稿` / `Checks` / `Processing` / `Upload complete`, never failing prematurely while upload is 0–99%), saves `yt_before_draft.png`, closes `ytcp-uploads-dialog` via `#close-button` / `#ytcp-uploads-dialog-close-button`, reloads `/channel/<id>/videos/upload` to confirm Draft status, and saves `yt_after_draft.png`.

## success_when

- draft: video uploaded + title/description/audience(+optional cover/tags/AI declaration) filled + Studio saved as draft + dialog closed cleanly (`YOUTUBE_DRAFT_SAVED`)

## run

```text
# 基础草稿（标题 + 简介 + 标签 + 封面）
node runtime/run.mjs --platform youtube --profile-id "Profile 2" --video C:/abs/video.mp4 --title "My Video Title" --body "Video description" --topics "tag1,tag2" --cover C:/abs/cover.jpg

# 含 AI 合成内容声明与截图目录
node runtime/run.mjs --platform youtube --profile-id "Profile 2" --video C:/abs/video.mp4 --title "AI Short Film" --body "Behind the scenes" --topics "aishort,cat" --ai-generated --shot-dir C:/abs/shots
```
