# fanqie_short

```yaml
id: fanqie_short
capabilities: [novel_short]
via: ego
default_mode: submit
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| title | yes | string |
| body / body-file | yes | text value, or absolute path to text/markdown file |
| cover | no | absolute path to cover image (optional; omitted when downgraded) |
| category | no | platform category string |
| trial | no | trial reading percentage (15–85, default 75) |
| result-file | no | absolute path to output result JSON |

## run

```text
node runtime/run.mjs --platform fanqie_short \
  --profile-id <id> \
  --title "..." \
  --body-file C:/abs/body.md \
  --cover C:/abs/cover.png \
  --category 都市日常
```

Add `--submit` to confirm publish; omit to stop before confirm (`draft`).
