import { existsSync } from "node:fs";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  TOKEN,
  applyReactionSnapshots,
  dumpLineupReactionsByHash,
  filePathFor,
  fileSha256,
  loadSequence,
  numberedEntries,
  ensureThread,
  REVIEW_THREAD_ID,
  fetchAllMessages,
  postNumberedImage,
  restoreLineupReactionsByHash,
  assertBotLockFree,
} from "./lib.mjs";

assertBotLockFree("snapshot-restore-reactions.mjs");

if (!TOKEN) {
  console.error("Set DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("ready", async () => {
  try {
    console.log(`Logged in as ${client.user.tag}`);
    const sequence = await loadSequence();
    const snapshot = await dumpLineupReactionsByHash(client, async (text) => console.log(text));
    const missing = [];
    for (let n = 1; n <= sequence.count; n++) {
      if (!snapshot.review.find((row) => row.n === n && row.messageId)) missing.push(n);
    }
    console.log(JSON.stringify({
      count: snapshot.count,
      reviewPosts: snapshot.reviewPosts,
      reviewNumbers: snapshot.reviewNumbers,
      missingNumbers: missing.length,
      missingPreview: missing.slice(0, 20),
      reconsiderPosts: snapshot.reconsiderPosts,
      hashedWithReactions: snapshot.hashedWithReactions,
      reviewWithReactions: snapshot.review.filter((row) => row.reactions?.length).length,
      reconsiderWithReactions: snapshot.reconsider.filter((row) => row.reactions?.length).length,
    }, null, 2));

    const restored = await restoreLineupReactionsByHash(client, snapshot, async (text) => console.log(text));
    console.log("Restore on existing posts:", restored);

    if (missing.length) {
      console.log(`Filling ${missing.length} missing lineup post(s) without wiping existing ones…`);
      const review = await ensureThread(client, REVIEW_THREAD_ID);
      const have = new Set(
        numberedEntries(await fetchAllMessages(review), client.user.id).map((entry) => entry.n),
      );
      let posted = 0;
      let reacted = 0;
      for (const n of missing) {
        if (have.has(n)) continue;
        const localPath = filePathFor(n);
        if (!existsSync(localPath)) continue;
        const message = await postNumberedImage(review, n);
        posted += 1;
        have.add(n);
        const hash = await fileSha256(localPath);
        const snaps = snapshot.byHash[hash] || [];
        if (snaps.length) {
          await applyReactionSnapshots(message, snaps);
          reacted += 1;
        }
        if (posted === 1 || posted === missing.length || posted % 10 === 0) {
          console.log(`Filled ${posted}/${missing.length} (now ${n}.jpg)`);
        }
      }
      console.log(`Filled missing posts: ${posted}. Reactions applied on fill: ${reacted}.`);
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

await client.login(TOKEN);
