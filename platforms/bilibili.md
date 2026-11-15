# bilibili

```yaml
id: bilibili
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
| topics | no | tags（最多 10 个；开启自动关联热点且传入超过 8 个时保留 2 槽位给实时「推荐标签」） |
| cover | no | cover image |
| hotspot / activity | no | optional explicit topic/activity search keyword(s); defaults to auto-derived keywords from `topics` + `title` |
| no-auto-hotspot / shot-dir | no | disable auto `推荐标签` / `参与话题` association or set screenshot directory |

## behavior

- Clears stale `.label-item-v2-container` tags before inserting `topics`.
- By default (`autoHotspot`), adds up to 3 relevant `推荐标签` pills into remaining slots and associates `参与话题` (`活动`) via matching pills or `搜索更多话题`.

## success_when

- draft: clicked save-draft and draft confirmed (`BILIBILI_DRAFT_SAVED` / `BILIBILI_DRAFT_DONE`)

## run

1. `node runtime/write_job.mjs --platform bilibili --profile-id <id> --video ... --title ...`
2. Ego: `runtime/social/bilibili_draft.mjs`

