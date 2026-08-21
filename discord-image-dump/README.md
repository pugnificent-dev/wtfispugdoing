# Discord image dump

One-shot script: log in as a bot, pull every image from one text channel, and save them as **1024×1024 JPG** files.

## Discord setup (once)

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create an application.
2. **Bot** → Reset Token → copy it. Turn **Message Content Intent** **on**, then save.
3. **OAuth2 → URL Generator**:
   - Scope: `bot`
   - Permissions: **View Channels**, **Read Message History**, **Send Messages**, **Send Messages in Threads**, **Attach Files**, **Manage Messages**, **Manage Threads**, **Add Reactions**
   - Open the generated URL and invite the bot to your server.
4. In Discord: **User Settings → Advanced → Developer Mode**. Right-click the channel → **Copy Channel ID**.

## Run

```bash
cd discord-image-dump
copy .env.example .env
```

Paste the token and channel ID into `.env`, then:

```bash
npm install
npm run dump
```

Files land in `discord-image-dump/output/` as `1.jpg`, `2.jpg`, … in channel order (oldest first). `manifest.json` maps each file back to the original Discord URL.

## Slash commands

Keep the bot online:

```bash
npm start
```

| Command | What it does |
| --- | --- |
| `/snatchmarios` `thread:` `full:` | Pull new images after the **latest** of: the bot's **Snatched up to here** embed in that source thread, a human @Snatchin & Resizing mention (or a reply that tags the bot), and `output/.snatch-cursor.json`. Numbers continue from the current count. Posts only new numbers to **Edit per number**. Exports the lineup to Drive. Re-anchors one checkpoint embed at the bottom of the source thread (no extra spam). `full:true` scans the whole thread but still skips known images. Refuses Edit per number, Reconsider, and Rework so forwarded copies cannot re-enter the lineup. |
| `/reconsider-run` | Rebuild **Reconsider**: keep posts that are `:noted:` (or legacy 🔁) or blank (untriaged), plus Edit per number `:NotApproved:` / `:noted:`. Drops Reconsider posts marked `:NotApproved:` (does **not** gap them — use `/reconsider-clear` for PLACEHOLDER). Copies **`:noted:` only** onto the new posts. PLACEHOLDER slots are not posted. |
| `/reconsider-pull` | **Drive only:** export unique images currently in Reconsider to the [Google Drive folder](https://drive.google.com/drive/folders/1IyZN1dje6HMrIWE1fzWxyOZyO78-b7m2). Does **not** rebuild the Reconsider queue. |
| `/reconsider-replace` `number:` `image:` | Manually replace that numbered file (slash and right-click context menu share this path). Count stays the same. Writes Drive first (Final if locked, else All Mario Images) plus working cache. Unlocked numbers: edits the Edit per number post. **Locked numbers:** Final only; does **not** repost to Edit per number. This is the only way to fill a locked gap. |
| `/replace-bulk` | In **Reconsider**, find replies that have a new image on a numbered post and apply each as a replacement. Marks processed replies with ✅. **Skips locked numbers** — use `/reconsider-replace` for those. |
| `/reconsider-clear` | **Leaves the queue** only for: `:check:` (approve on Edit per number, remove from Reconsider), `:NotApproved:` **on the Reconsider post** (remove + gap/PLACEHOLDER unless already replaced), or a replacement. **Stays:** `:noted:` / legacy 🔁 (always) and blank/untriaged posts. **Does not touch locked numbers** (will not re-gap a locked slot). |
| `/gaps` | Lists **active** (unlocked) gaps separately from **locked** gaps. Locked gaps are not in Edit per number; fill them with `/reconsider-replace`. |
| `/reconsider-watermark` `number:` (optional) | Inpaint watermarks on Reconsider images (or one number) and write the same numbered file back. Does not recrop or renumber. **Skips locked numbers.** |
| `/quality-controlled` | Export every **Edit per number** post marked `:check:` to the Final Drive folder. Skips PLACEHOLDER/gap slots. Also removes those numbers from the Reconsider Drive folder. Prunes Final to currently-checked numbers. **Refuses to run** while any `/lockin` range is set. |
| `/lockin` `from:` `to:` `confirm:` `reset:` `unlock:` | Lock a lineup range into **Final** (append-only) and **remove those posts from Edit per number**. Multiple ranges accumulate. Default is a **dry-run** (includes how many Edit per number posts would be deleted). `confirm:true` upserts this range's real images into Final **without clearing Final**, verifies each file is there, then deletes those Discord posts (local files optional). `reset:true` is the destructive exception: trash Final files that are not in any locked range. `unlock:true` clears locks without changing files or Discord. |
| `/drive-dedupe` `folder:` `confirm:` | Count extra same-name files in a Drive folder (dry run by default). `confirm:true` deletes extras and keeps one file per name. Does not delete same pixels stored under different names. |
| `/update-snatched` `from:` `to:` | Update Edit per number posts in that range that are `:NotApproved:` or removed. Removed **unlocked** slots get **PLACEHOLDER**. **Skips every locked number**, including locked gaps (will not rewrite PLACEHOLDER into them). Use a range (e.g. 1–50) to avoid timeouts. |
| `/removebatch` `from:` `to:` | Batch-remove a range in **Edit per number**. Unlocked numbers become gaps. **Locked numbers in the range are skipped.** |
| `/snapshot-reactions` | Snapshot **unlocked** Edit per number posts: **sequence number**, **unique image hash**, attachment id, and status **reactions**. **Locked numbers are ignored** (Final-only; only `/reconsider-replace` may change them). Also scans unlocked Reconsider posts. Writes `byNumber` + `byHash`, merges reaction DB, updates local `sequence.json` count from unlocked Discord + lock high-water. Does not compact, wipe, or change Discord posts. |
| `/rework-sync` `prune:` | Scan Edit per number and Reconsider for `:noted:` (or legacy 🔁) marks and forward any missing **image hashes** to the **Rework** thread. Same picture from both sources appears once. Abort with `/killsnatchnow`. `prune:true` also deletes Rework posts whose image is no longer marked — default is leave them. |
| `/rework-notapproved` | Scan **Rework** for `:NotApproved:`. For each unlocked numbered post: add a **sequence gap**, replace **Edit per number** with PLACEHOLDER and clear reactions, remove from **Reconsider** and **Rework**. Locked numbers are skipped. |
| `/reworkcount` `start:` | **Dangerous if reactions are missing.** First writes `output/reaction-snapshot-by-hash.json` (attachment hashes, not Discord numbers) and rotates the previous file to `.prev.json`. Merges into `output/reactions-by-hash.json`. Locked numbers are excluded from the dump and from the unmarked-snapshot warning. Compact **never shifts a locked number**. Rebuild **does not repost locked numbers** into Edit per number. Discord wipe happens only when packing changed unlocked numbers. Then run `/reconsider-rework`. |
| `/killsnatchnow` | Stop whatever command is currently running. The reply says how to resume **that** job (snatch vs rework fill) — it does not always say `/reworkcount`. |
| `/reconsider-rework` | After `/reworkcount`: rebuild **Reconsider** at the new numbers with the same retention rules as `/reconsider-run` (keep `:noted:` and blank; copy `:noted:` only). |

Re-invite the bot with the `applications.commands` scope if commands do not appear. Commands are limited to members who can Manage Messages. The bot needs **Manage Messages** on Edit per number and Reconsider — without it, leftover `:NotApproved:` reactions and other people's replies cannot be removed. It also needs **View Channel**, **Read Message History**, **Send Messages**, **Attach Files**, and **Add Reactions** on the Rework thread.

Keep **exactly one** `npm start` process. The bot writes `output/.bot.lock` with its PID. A second `node bot.mjs` exits with an error instead of stealing the Discord gateway. Stale locks (dead PID) are taken over. One-shot scripts (`dump.mjs`, `post.mjs`, `rebuild-review.mjs`, `rebuild-reconsider.mjs`) refuse to log in while that lock is held.

### Reconsider queue retention

An image **leaves** Reconsider only when it is **replaced**, marked **`:NotApproved:` on the Reconsider post**, or marked **`:check:`** (existing approve path). **`:noted:`** (legacy 🔁 still counted) always stays. Blank / untriaged always stays. Lineup `:NotApproved:` alone does not remove a blank Reconsider post. `/reconsider-run` rebuilds the thread but re-queues `:noted:` and blank posts; it does not PLACEHOLDER anything.

`:noted:` is the rework mark the bot adds. 🔁 / `:repeat:` is still recognized. `/update-snatched` and watermark inpaint keep the rework mark; a true image replacement clears it.

### Rework thread

Images marked `:noted:` (or legacy 🔁) in **Edit per number** or **Reconsider** are forwarded to the Rework thread (`DISCORD_REWORK_THREAD_ID`, default `1539998609582456974`), except **locked numbers** (they stay out of Rework). Adding the emoji live forwards immediately; `/rework-sync` backfills existing marks. Dedupe is by **sha256 of the image bytes** (not number or message id), persisted in `output/.rework-thread-index.json` and reconciled against the live thread on startup/sync so a manually deleted post can be re-added. Captions use the lineup number. If that number later changes (after `/reworkcount`), `/rework-sync` or a live `:noted:` re-add **edits the caption** — it does not post a second copy. The forwarded post also gets `:noted:`. Removing the mark from the source does **not** delete the Rework post unless you pass `prune:true` on `/rework-sync`. Replacing pixels (new hash) leaves the old Rework post in place. This thread is blocked from `/snatchmarios` so forwarded copies cannot re-enter the lineup. There is no third live-status embed in Rework — progress for `/rework-sync` uses the existing Edit per number / Reconsider embeds.

### Google Drive folders

**Drive is the source of truth** for numbered images. Commands download into a working cache at `output/.drive-cache/{n}.jpg` when they need bytes for Discord or watermarking. A permanent `output/{n}.jpg` lineup is **not** required — wiping those files is fine if Drive is signed in.

Uploads are upserts by filename (`n.jpg`) in that folder: skip if md5 matches, otherwise update in place, create only if missing. Extra copies of the same name are collapsed. `/reworkcount` does **not** prune the Final/QC folder.

| User name | Drive folder | Contents |
| --- | --- | --- |
| All Mario Images | snatch/lineup | Unlocked lineup `1.jpg`…`{count}.jpg` (primary for unlocked numbers) |
| Reconsider | Reconsider | Numbers currently queued in the Reconsider thread |
| Final | Final | Union of locked ranges: real images only (no PLACEHOLDER). Append-only on each `/lockin`. Locked gaps stay absent from Final until `/reconsider-replace`. Unlocked numbers are not written while any lock exists. Without a lock: Edit per number `:check:` images via `/quality-controlled` |

**Resolve order:** locked → Final then All Mario Images; unlocked → All Mario Images then Reconsider; then working cache / legacy local.

`/lockin` upserts the new range into Final and **never clears Final** unless you pass `reset:true`. After each file is confirmed in Final, matching Edit per number posts are deleted. Local files are optional. Dry-run first. `/lockin unlock:true` clears all ranges and restores the old `:check:` workflow.

Run `/drive-dedupe` (no confirm) to count duplicates. `/drive-dedupe confirm:true` deletes extra same-name copies.

### Live status embed

A public live-status embed is kept at the **bottom** of both **Edit per number** and **Reconsider**. Same text and state-appropriate pug thumbnail in both; each has a jump-to-top link for **that** channel. Progress updates that embed instead of spamming ephemeral replies. `output/.status-message.json` stores a message id per channel.

### Snatch checkpoint embed

In the source thread (`#mario-bitch` or a thread inside it), `/snatchmarios` posts (and later re-anchors) a single **Snatched up to here** embed. That embed, a human @Snatchin & Resizing mention, and `output/.snatch-cursor.json` are all checkpoints — the next snatch starts after the **latest** of those. You can still reply-mention the bot; you do not have to every time. `full:true` scans the whole thread but still skips known images.

### `/reworkcount` safety

Reactions follow the **image hash**, never the Discord number.

1. Dump Edit per number and Reconsider by hashing **message attachment bytes**. If the local `n.jpg` hash matches that attachment, the same hash is stored; the dump does not blindly pair `local n.jpg` with post `n` after numbers may have drifted.
2. Rotate backups: current file plus one previous only (`reaction-snapshot-by-hash.json` and `reaction-snapshot-by-hash.prev.json`). Same rotation for `reactions-by-hash.json`.
3. fsync the JSON. If the dump fails, is empty, or `hashedWithReactions` is 0 while Discord posts still have reactions, **stop** — no compact, no wipe.
4. Compact locally (copy keepers to `output/.rework/`, then swap). Discord is not wiped until the snapshot is on disk from this run.
5. If a wipe is still required, write `output/.rework-checkpoint.json` `{ lastPosted, count, snapshotPath, phase }` and post from `lastPosted+1`. Kill/abort leaves that checkpoint. Next `/reworkcount` (or `start:N`) **fills missing numbers only** and does not delete 1…K that already exist.

`/reworkcount start:183` means resume at 183. It does **not** renumber in place.

Rebuild apply looks up `fileSha256(n.jpg)` in `reactions-by-hash.json` (merged with the snapshot). Never restore by Discord caption number.

Do not run a fresh `/reworkcount` until you have a good `/snapshot-reactions` (or the dump inside `/reworkcount` itself) showing almost every Edit per number post hashed with its status mark.

`/reconsider-watermark` uses a local Python OpenCV inpaint (no extra crop). One-time setup:

```bash
python -m venv .venv
.\.venv\Scripts\pip install -r requirements-watermark.txt
```

By default images are **center-cropped** to fill 1024×1024. For letterboxing instead of cropping, set `FIT=contain` in `.env`.

## Google Drive exports

The three Drive folders stay matched to Discord:

- **Snatch/lineup** — `1.jpg` through the current sequence count. `/snatchmarios`, replacements, and `/reworkcount` upload current files and delete leftovers above the count.
- **Reconsider** — only numbers still in the Reconsider thread. Replaced or approved images are removed from this folder, same as the thread. `/reconsider-rework` and `/reconsider-pull` also drop extras and duplicates.
- **Quality Controlled** — `:check:` approved images. Approving in Reconsider uploads here and removes the file from Reconsider Drive.

Local `output/` is still the working lineup.

One-time login:

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project, enable **Google Drive API**, and create an **OAuth client ID** of type **Desktop app**.
2. Download the JSON into `discord-image-dump/google-oauth.json`.
3. Run `npm run drive-login` and approve access with the Google account that owns those folders.
4. Restart the bot.
