import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import { assertBotLockFree } from "./lib.mjs";

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const THREAD_ID = process.argv[2] || process.env.DISCORD_THREAD_ID;
const OUTPUT_DIR = path.resolve(ROOT, process.env.OUTPUT_DIR || "output");
const PROGRESS_FILE = path.join(OUTPUT_DIR, ".post-progress.json");

if (!TOKEN || !THREAD_ID) {
  console.error("Set DISCORD_BOT_TOKEN in .env and pass a thread ID: npm run post -- 1234567890");
  process.exit(1);
}

assertBotLockFree("post.mjs");

function numberedJpgs(names) {
  return names
    .map((name) => {
      const match = name.match(/^(\d+)\.jpg$/i);
      return match ? { n: Number(match[1]), name } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

async function loadProgress() {
  try {
    const data = JSON.parse(await readFile(PROGRESS_FILE, "utf8"));
    return Number(data.lastPosted) || 0;
  } catch {
    return 0;
  }
}

async function saveProgress(lastPosted) {
  await writeFile(PROGRESS_FILE, JSON.stringify({ lastPosted, threadId: THREAD_ID }, null, 2));
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const thread = await client.channels.fetch(THREAD_ID);
    if (!thread?.isTextBased()) {
      throw new Error("That ID is not a text channel or thread.");
    }
    if (thread.isThread?.() && thread.joinable) {
      await thread.join();
    }

    const files = numberedJpgs(await readdir(OUTPUT_DIR));
    if (files.length === 0) {
      throw new Error(`No numbered JPGs found in ${OUTPUT_DIR}`);
    }

    const alreadyPosted = await loadProgress();
    const remaining = files.filter((file) => file.n > alreadyPosted);
    console.log(`Posting ${remaining.length} of ${files.length} images to ${thread.name || THREAD_ID} (starting after ${alreadyPosted || 0})`);

    for (const file of remaining) {
      const filePath = path.join(OUTPUT_DIR, file.name);
      await thread.send({
        content: String(file.n),
        files: [{ attachment: filePath, name: file.name }],
      });
      await saveProgress(file.n);
      process.stdout.write(`\rPosted ${file.n}/${files[files.length - 1].n}`);
    }

    console.log("\nDone.");
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(TOKEN);
