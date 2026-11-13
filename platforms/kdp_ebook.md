# kdp_ebook

```yaml
id: kdp_ebook
capabilities: [ebook_kdp]
via: ego
default_mode: submit
allowed_modes: [draft, submit]
```

## inputs

| field | required | notes |
|---|---|---|
| profileId | yes | ego profile |
| epub | yes | absolute path |
| cover | yes | absolute path |
| title | yes | string |
| subtitle | no | string |
| author-first / author-last | no | strings |
| description-html / description-file | no | HTML value or file |
| keywords | no | comma-separated |
| list-price | no | number |

## run

```text
node runtime/run.mjs --platform kdp_ebook \
  --profile-id <id> \
  --epub C:/abs/book.epub \
  --cover C:/abs/cover.jpg \
  --title "..." \
  --author-first A --author-last B
```
