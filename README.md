# whatispugdoing.com

Mobile-first landing page for Pugnificent, hosted on Cloudflare Pages from this GitHub repo.

## Local preview

Open `index.html` in a browser, or from this folder:

```bash
npx --yes serve .
```

## Cloudflare Pages

1. Push this repo to GitHub.
2. In Cloudflare → Workers & Pages → Create → Connect to Git.
3. Build settings (Workers / Pages CI):
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - Do **not** put `/` or `$` in Deploy command — those are paths, not commands
4. After deploy → **Custom domains** → add `whatispugdoing.com`.

## Drop-in assets

Replace the placeholders:

| File | What it is |
| --- | --- |
| `assets/pug-hero.jpg` | Hero portrait (the Polaroid photo) |
| `assets/club2252-thumb.jpg` | About Club2252 thumbnail (your “image 4”) |

Then update `index.html` image `src` values from the `.svg` placeholders to the `.jpg` files if needed.

## Links to fill in

Search the repo for `REPLACE_ME` and `REPLACE_GAROOVY`:

- Discord invite URL
- Garoovy / Club2252 Venmo handle
- Confirm Facebook URLs for Club2252
