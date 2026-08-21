import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
import sharp from "sharp";
import { assertBotLockFree } from "./lib.mjs";

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const OUTPUT_DIR = path.resolve(ROOT, process.env.OUTPUT_DIR || "output");
const FIT = process.env.FIT || "cover";
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 90);
const SIZE = 1024;
const DOWNLOAD_CONCURRENCY = 4;

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);

if (!TOKEN || !CHANNEL_ID) {
  console.error("Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID in .env (see .env.example).");
  process.exit(1);
}

assertBotLockFree("dump.mjs");

if (!["cover", "contain", "fill"].includes(FIT)) {
  console.error("FIT must be cover, contain, or fill.");
  process.exit(1);
}

function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith("image/")) return true;
  return IMAGE_EXT.has(path.extname(attachment.name || "").toLowerCase());
}

function collectImageUrls(message) {
  const found = [];

  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment) && attachment.url) {
      found.push({
        url: attachment.url,
        name: attachment.name || "image",
      });
    }
  }

  for (const embed of message.embeds) {
    const url = embed.image?.url || embed.thumbnail?.url;
    if (url) {
      found.push({ url, name: "embed" });
    }
  }

  return found;
}

async function fetchAllMessages(channel) {
  const all = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    process.stdout.write(`\rScanned ${all.length} messages...`);
  }

  process.stdout.write("\n");
  return all;
}

async function downloadAndResize(item, destPath) {
  const response = await fetch(item.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const pipeline = sharp(buffer, { animated: false, failOn: "none" }).resize(SIZE, SIZE, {
    fit: FIT,
    position: "centre",
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  }).jpeg({ quality: JPEG_QUALITY, mozjpeg: true });

  await pipeline.toFile(destPath);
}

async function runPool(items, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      await worker(items[current]);
    }
  });
  await Promise.all(workers);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased()) {
      throw new Error("That ID is not a text channel.");
    }

    console.log(`Dumping images from #${channel.name}`);
    await mkdir(OUTPUT_DIR, { recursive: true });

    const messages = (await fetchAllMessages(channel)).sort((a, b) => {
      const aid = BigInt(a.id);
      const bid = BigInt(b.id);
      if (aid < bid) return -1;
      if (aid > bid) return 1;
      return 0;
    });
    const seen = new Set();
    const jobs = [];
    let nextNumber = 1;

    for (const message of messages) {
      for (const image of collectImageUrls(message)) {
        if (seen.has(image.url)) continue;
        seen.add(image.url);
        jobs.push({
          ...image,
          filename: `${nextNumber}.jpg`,
        });
        nextNumber += 1;
      }
    }

    console.log(`Found ${jobs.length} unique images. Saving ${SIZE}x${SIZE} JPGs (${FIT})...`);

    let saved = 0;
    let failed = 0;
    await runPool(jobs, async (job) => {
      const dest = path.join(OUTPUT_DIR, job.filename);
      try {
        await downloadAndResize(job, dest);
        saved += 1;
      } catch (error) {
        failed += 1;
        console.error(`\nFailed ${job.filename}: ${error.message}`);
      }
      process.stdout.write(`\rSaved ${saved}/${jobs.length} (${failed} failed)...`);
    });

    const manifest = jobs.map((job) => ({ file: job.filename, source: job.url }));
    await writeFile(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

    console.log(`\nDone. ${saved} images in ${OUTPUT_DIR}`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
});

client.login(TOKEN);
