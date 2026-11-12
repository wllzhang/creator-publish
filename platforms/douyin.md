# douyin

```yaml
id: douyin
capabilities: [video_mp4]
via: ego
default_mode: draft
allowed_modes: [draft, submit]
```

## inputs（video_mp4）

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| video | yes | absolute path to mp4 |
| title | yes | title |
| topics | no | topic/hashtag list（抖音单条最多支持 5 个 `#话题`，超出会自动截断前 5 个以避免编辑器粘连） |
| body | no | optional description placed before topics |

## notes

- Draft path clicks **「暂存离开」**（never「发布」）and confirms any leave/save prompt; merely stopping on `/content/publish` before closing `taskSpace` does NOT persist the draft.
- Douyin stores the suspended draft in **「作品发布 → 发布视频」**（`https://creator.douyin.com/creator-micro/content/upload`）top banner：**`你还有上次未发布的视频，是否继续编辑？ → 继续编辑`**（not in `内容管理 → 作品`）.

## success_when

- draft: uploaded + title/topics(≤5) filled + clicked **暂存离开** → `/content/upload` shows resume banner (`DOUYIN_DRAFT_SAVED` / `DOUYIN_STAGED_STOP_BEFORE_PUBLISH`)

## run

1. `node runtime/write_job.mjs --platform douyin --profile-id <id> --video ... --title ... [--body ...] --topics a,b`
2. Ego: `runtime/social/douyin_draft.mjs`

