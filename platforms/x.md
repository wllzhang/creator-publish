# x

```yaml
id: x
capabilities: [text_post, image_carousel, video_mp4]
via: ego
default_mode: draft
allowed_modes: [draft]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile (e.g. `Profile 2`) |
| body / body-file | conditional | post body text (at least one of `body`, `title`, `images`, or `video` is required) |
| title | conditional | optional headline; if both `title` and `body` are provided and `body` does not already include `title`, joins as `${title}\n\n${body}` |
| images | conditional | comma-separated absolute image paths (supports up to 4 images per post; ignored if `video` is also provided) |
| video | conditional | absolute path to a single MP4 video (waits up to 120s for upload completion and media preview) |
| topics / tags | no | comma-separated hashtags; missing `#tag` items are appended while respecting X character length |
| shot-dir | no | optional directory for `x_before_draft.png` and `x_after_draft.png` proof screenshots |

## behavior

- **Draft-only safety gate**: `allowed_modes` is strictly `[draft]`. Any non-`draft` mode (such as `submit`) immediately throws `X_SUBMIT_FORBIDDEN_DRAFT_ONLY`. The adapter **never** clicks X's Post/Publish button (`tweetButton` / `tweetButtonInline`).
- Opens `https://x.com/compose/post` in the target Ego profile, suppresses native OS file-chooser dialogs, and aborts immediately with `NEED_LOGIN_X` if redirected to login or challenge.
- Scopes composer selectors to the modal `[role="dialog"]` (`tweetTextarea_0`, `fileInput`, `app-bar-close`) so the background timeline inline composer never causes selector ambiguity.
- Inserts text with human-paced typing (`humanInsertText`), attaches optional video or up to 4 images via `setInputFiles`, waits for upload/preview settlement, and captures `${shotDir}/x_before_draft.png`.
- Closes the composer (`[data-testid="app-bar-close"]`), confirms **Save / 保存** (`[data-testid="confirmationSheetConfirm"]`), waits 1.5–2.5s, opens `https://x.com/compose/post/unsent/drafts` to verify the draft entry, and captures `${shotDir}/x_after_draft.png`.

## success_when

- draft: composer filled (and optional media preview settled) -> closed & saved via **Save / 保存** -> verified on `https://x.com/compose/post/unsent/drafts` (`X_DRAFT_SAVED`)

## run

```text
# Pure text post with topics (draft-only)
node runtime/run.mjs --platform x --profile-id "Profile 2" --title "Quick Update" --body "Testing draft workflow on X." --topics "AI,Productivity"

# Image carousel (up to 4 images)
node runtime/run.mjs --platform x --profile-id "Profile 2" --images "C:/abs/1.png,C:/abs/2.png" --body "Two frames from today's render." --topics "3D,Render" --shot-dir "C:/abs/shots"

# Single MP4 video draft
node runtime/run.mjs --platform x --profile-id "Profile 2" --video "C:/abs/clip.mp4" --body "Short clip preview." --topics "Video"
```
