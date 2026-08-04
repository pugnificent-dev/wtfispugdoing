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
3. Build settings:
   - Framework preset: None
   - Build command: *(leave empty)*
   - Build output directory: `/`
4. Attach the custom domain `whatispugdoing.com`.

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
