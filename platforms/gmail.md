# gmail

```yaml
id: gmail
capabilities: [email_compose]
via: ego
default_mode: draft
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile (`--profile-id`) |
| to | yes | recipient email or comma-separated emails (`--to a@x.com,b@y.com`) |
| subject | yes | email subject string |
| body / body-file | yes | plain text string or absolute path to UTF-8 text/markdown file |
| attachments | no | comma-separated absolute file paths (`fs.existsSync` verified pre-flight + chip upload verified in UI) |
| account-index | no | Gmail `/u/<index>/` session slot (integer, default `0`) |
| result-file | no | absolute path to output result JSON |

## run

```text
node runtime/run.mjs --platform gmail \
  --profile-id <id> \
  --account-index 1 \
  --to recipient@example.com \
  --subject "Pitch Deck" \
  --body-file C:/abs/email_body.txt \
  --attachments C:/abs/pitch_deck.pdf
```

Default mode is **`draft`** (auto-saves draft in Gmail with verified attachments and stops without sending). Pass `--submit` only when explicitly authorized to click Send.
