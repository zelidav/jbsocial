# JB Social Desk

Team page for the Jerome Baker social agents: the Analyst's numbers, the Scout's finds, the
Strategist's weekly calendar and captions, the Clip Factory's clips and queue, and the run log.

Live at https://jbsocial.cannacrypted.com (GitHub Pages, `main`, root).

## How it works

- The repo and the page are public, the data is not. Every report is packed into
  `data/site.enc`, encrypted (AES-256-GCM, PBKDF2) with the team passphrase. The page asks for
  the passphrase and decrypts in the browser. Nothing readable is ever committed.
- Source of truth is the `reports` folder in the Jerome Baker Drive (`00-Library/reports`).
  A scheduled task ("JB Social Desk: publish") copies new and changed reports from Drive each
  morning, rebuilds `data/site.enc` and pushes it.
- No build service, no dependencies, no CDN scripts. `index.html` is the whole front end.

## Rebuild by hand

Needs Node 20+ and the passphrase.

```
export JBSOCIAL_KEY="the team passphrase"
node tools/build.mjs unpack     # restore work/reports from the current bundle
# drop new or changed .md reports into work/incoming/
node tools/build.mjs ingest
node tools/build.mjs build      # writes data/site.enc and verifies it
git add data/site.enc && git commit -m "Update desk" && git push
```

`work/` is ignored by git. Never commit it, and never commit the passphrase.

## Changing the passphrase

`unpack` with the old one, then `build` with the new one, push, and tell the team.

## Font

Headings use Nexa Heavy when `assets/fonts/Nexa-Heavy.woff2` is present (or the font is
installed on the viewer's machine) and fall back to a heavy system face otherwise.

## Adding a new kind of report

Any `.md` file in the Drive reports folder shows up under All reports. To give an agent its
own view, add a parser in `tools/build.mjs` and a view in `index.html`.
