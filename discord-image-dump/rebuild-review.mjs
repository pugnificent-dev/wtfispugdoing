import { Client, GatewayIntentBits, Partials } from "discord.js";
import {
  TOKEN,
  REVIEW_THREAD_ID,
  bindStatusClient,
  rememberStatusChannel,
  setJobRunning,
  publishJobStatus,
  ensureThread,
  loadSequence,
  loadReworkMapping,
  rebuildReviewThread,
  deleteLocalFilesAfter,
  assertBotLockFree,
} from "./lib.mjs";
import { pruneDriveToNumbers, DRIVE_FOLDER_RECONSIDER, syncSnatchFolder } from "./drive.mjs";

assertBotLockFree("rebuild-review.mjs");

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
  bindStatusClient(client);
  try {
    const review = await ensureThread(client, REVIEW_THREAD_ID);
    await rememberStatusChannel(review);
    setJobRunning(true);
    await publishJobStatus(client);
    const sequence = await loadSequence();
    const saved = await loadReworkMapping();
    const mapping = saved?.mapping?.size && saved.oldCount > saved.newCount ? saved.mapping : null;
    console.log(`Sequence count ${sequence.count}. Mapping: ${mapping ? `${saved.oldCount} → ${saved.newCount}` : "hash images in thread"}.`);
    const rebuilt = await rebuildReviewThread(client, async (text) => {
      console.log(text);
    }, { mapping, fillOnly: true });
    const localDeleted = await deleteLocalFilesAfter(rebuilt.count);
    if (localDeleted) console.log(`Removed ${localDeleted} leftover local file(s).`);
    try {
      await syncSnatchFolder(async (text) => console.log(text));
      const keep = [];
      for (let n = 1; n <= rebuilt.count; n++) keep.push(n);
      await pruneDriveToNumbers(DRIVE_FOLDER_RECONSIDER, keep);
    } catch (error) {
      console.error("Drive sync failed:", error.message || error);
    }
    console.log(`Done. Did not wipe. Filled ${rebuilt.filled || 0} missing. Restored reactions on ${rebuilt.restored} image(s) by file hash.`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    setJobRunning(false);
    try {
      await publishJobStatus(client);
    } catch {
      // ignore status failures on shutdown
    }
    client.destroy();
  }
});

await client.login(TOKEN);
