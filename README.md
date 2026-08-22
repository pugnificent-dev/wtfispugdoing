# whatispugdoing.com

Mobile-first landing page for Pugnificent, hosted on Cloudflare from this GitHub repo.

## Discord Activity

Public URLs used by the Rainbow Circuit Discord app:

- OAuth2 redirect: `https://whatispugdoing.com/discord-oauth`
- Activity host / URL mapping `/`: `circuit.whatispugdoing.com`

Launch from the **#rainbow-circuit** text channel. Stay in any voice call you already have — the race does not replace it.

In the Discord Developer Portal:

1. **OAuth2 → Redirects** add `https://whatispugdoing.com/discord-oauth` (and optionally `https://127.0.0.1`).
2. Enable **Activities**.
3. **Activities → URL Mappings**: prefix `/` → `circuit.whatispugdoing.com` (no `https://`).

After you have a Client ID and Client Secret:

```bash
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
```

## Local preview

```bash
npm run build
npx wrangler dev
```

## Deploy

```bash
npm run deploy
```


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
