# wechat_mp

```yaml
id: wechat_mp
capabilities: [mp_article]
via: api
default_mode: draft
allowed_modes: [draft]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | no | unused (API, not ego) |
| api-env | yes | abs path; see env keys below |
| title | yes | string |
| html / html-file | yes | article HTML (value or file) |
| cover | yes | abs path; thumb via `material/add_material` |
| body-images | no | comma-separated local files → `media/uploadimg` |
| digest / author | no | author falls back to `WECHAT_MP_AUTHOR` in api-env |
| egress | no | override; see egress resolution |

## api-env keys

| key | purpose |
|---|---|
| `WECHAT_MP_APPID` / `WECHAT_MP_APPSECRET` | required |
| `WECHAT_MP_AUTHOR` | optional |
| `WECHAT_MP_EGRESS` | `local` or `user@host` — preferred explicit mode |
| `WECHAT_MP_EGRESS_SSH` | SSH target when using IP-based / SSH mode |
| `WECHAT_MP_EGRESS_IP` | expected whitelist public IP (if set and no Egress host key → SSH mode) |

## egress resolution (first hit)

1. `--egress`
2. process `WECHAT_MP_EGRESS`
3. api-env `WECHAT_MP_EGRESS`
4. api-env `WECHAT_MP_EGRESS_SSH`
5. api-env `WECHAT_MP_EGRESS_IP` present → SSH (requires `WECHAT_MP_EGRESS_SSH` or `WECHAT_MP_EGRESS`)
6. else `local`

**Do not** reach `api.weixin.qq.com` through VPN. Local = allowlisted IP + DIRECT. SSH = scp `api_draft.mjs` and run `node` on whitelist host (Node only; no Python).

## success_when

- `draft/add` returns `media_id`; cover thumb bound; body images are mmbiz CDN when provided

## run

```text
node runtime/wechat/wechat_mp_draft.mjs \
  --api-env C:/abs/wechat_mp.env \
  --title "..." \
  --html-file C:/abs/article.html \
  --cover C:/abs/cover.jpg \
  --body-images C:/abs/1.jpg,C:/abs/2.jpg
```
