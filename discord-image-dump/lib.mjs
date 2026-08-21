import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { copyFile, mkdir, open as fsOpen, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TOKEN = process.env.DISCORD_BOT_TOKEN;
export const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
export const OUTPUT_DIR = path.resolve(ROOT, process.env.OUTPUT_DIR || "output");
export const BOT_LOCK_FILE = path.join(OUTPUT_DIR, ".bot.lock");
export const REWORK_CHECKPOINT_FILE = path.join(OUTPUT_DIR, ".rework-checkpoint.json");
export const REACTION_SNAP_FILE = path.join(OUTPUT_DIR, "reaction-snapshot-by-hash.json");
export const REACTION_SNAP_PREV_FILE = path.join(OUTPUT_DIR, "reaction-snapshot-by-hash.prev.json");
export const REACTION_DB_FILE = path.join(OUTPUT_DIR, "reactions-by-hash.json");
export const REACTION_DB_PREV_FILE = path.join(OUTPUT_DIR, "reactions-by-hash.prev.json");
export const SNATCH_CURSOR_FILE = path.join(OUTPUT_DIR, ".snatch-cursor.json");
export const LOCKIN_FILE = path.join(OUTPUT_DIR, ".lockin.json");
export const REVIEW_THREAD_ID = process.env.DISCORD_REVIEW_THREAD_ID || "1539393719017537637";
export const RECONSIDER_THREAD_ID = process.env.DISCORD_RECONSIDER_THREAD_ID || "1539402175397109810";
export const REWORK_THREAD_ID = process.env.DISCORD_REWORK_THREAD_ID || "1539998609582456974";
export const REWORK_THREAD_INDEX_FILE = path.join(OUTPUT_DIR, ".rework-thread-index.json");
export const NOT_APPROVED_NAME = (process.env.NOT_APPROVED_EMOJI || "NotApproved").toLowerCase();
export const APPROVED_NAME = (process.env.APPROVED_EMOJI || "check").toLowerCase();
export const REWORK_NAME = (process.env.REWORK_EMOJI || "noted").toLowerCase();
export const REWORK_EMOJI_ID = process.env.REWORK_EMOJI_ID || "";
export const REPEAT_NAME = (process.env.REPEAT_EMOJI || "repeat").toLowerCase();
export const REPEAT_EMOJI = "🔁";
export const REWORK_KEY = "rework";
export const FIT = process.env.FIT || "cover";
export const JPEG_QUALITY = Number(process.env.JPEG_QUALITY || 90);
export const SIZE = 1024;

let abortRequested = false;
let jobProgress = { command: null, number: null, detail: null };

export function requestAbort() {
  abortRequested = true;
}

export function clearAbort() {
  abortRequested = false;
}

export function isAborted() {
  return abortRequested;
}

export function getJobProgress() {
  return jobProgress;
}

export function resumeHint(progress = jobProgress) {
  const command = progress?.command || "";
  const n = Number.isInteger(progress?.number) ? progress.number : null;
  const next = n != null ? n + 1 : null;
  if (command === "snatchmarios") {
    return Number.isInteger(n)
      ? ` Stopped while snatching around ${n}. Run /snatchmarios again — already-saved numbers stay. Do not run /reworkcount.`
      : " Stopped while snatching. Run /snatchmarios again. Do not run /reworkcount.";
  }
  if (command === "snapshot" || command === "snapshot-reactions" || (command === "reworkcount" && String(progress?.detail || "").includes("snapshot"))) {
    return " Stopped during the reaction snapshot. Discord was not wiped. Re-run /reworkcount to snapshot again.";
  }
  if (command === "rework-sync") {
    return " Stopped /rework-sync. Already-forwarded hashes stay in the Rework thread. Re-run /rework-sync to continue.";
  }
  if (command === "rework-notapproved") {
    return " Stopped /rework-notapproved. Already-gapped numbers stay PLACEHOLDER. Re-run to continue remaining :NotApproved: Rework posts.";
  }
  if (command === "lockin") {
    return " Stopped /lockin. Final may be partially cleared or uploaded. Re-run /lockin from: to: confirm:true to finish.";
  }
  if (command === "rebuild-review" || command === "reworkcount") {
    const detail = String(progress?.detail || "");
    if (detail.startsWith("repost") || detail.startsWith("fill")) {
      const resumeAt = Number.isInteger(n) ? n : next;
      return Number.isInteger(resumeAt)
        ? ` Stopped during lineup fill/repost at ${resumeAt}. Resume with /reworkcount start:${resumeAt} — that continues from there and will not wipe posts that already exist.`
        : " Stopped during lineup fill. Resume with /reworkcount (uses the checkpoint). Do not wipe.";
    }
    if (detail.includes("pack") || detail.includes("Finding images")) {
      return " Stopped while packing local files. Discord was not wiped. Check output/, then re-run /reworkcount.";
    }
    return Number.isInteger(n)
      ? ` Stopped /reworkcount on ${n}. If Edit per number already has 1–K, resume with /reworkcount start:${n} (fill only — no wipe).`
      : " Stopped /reworkcount. If a checkpoint exists, run /reworkcount again to resume without wiping.";
  }
  if (Number.isInteger(n)) return ` Stopped on ${n}.`;
  return "";
}

export function throwIfAborted(action = "Stopped") {
  if (!abortRequested) return;
  throw new Error(`${action} by /killsnatchnow.${resumeHint()}`);
}

const SEQUENCE_FILE = path.join(OUTPUT_DIR, "sequence.json");
const MANIFEST_FILE = path.join(OUTPUT_DIR, "manifest.json");
const PROGRESS_FILE = path.join(OUTPUT_DIR, ".job-progress.json");
const LAST_JOB_FILE = path.join(OUTPUT_DIR, ".job-last.json");
const STATUS_FILE = path.join(OUTPUT_DIR, ".status-message.json");
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"]);
const STATUS_IDLE_MS = 60_000;
const STATUS_THROTTLE_MS = 2500;
const STATUS_REANCHOR_MS = 12_000;
const STATUS_FOOTER = "Public live status · stays at the bottom";
const SNATCH_CHECKPOINT_FOOTER = "Snatch checkpoint · pulled up to here";
const STATUS_KINDS = ["working", "stuck", "sleeping"];
const STATUS_THUMB_VERSION = 4;

let jobRunning = false;
let statusClient = null;
let statusChannelHint = null;
let cachedStatus = null;
let lastStatusStateKey = "";
let publishTimer = null;
let publishInFlight = false;
let publishChain = Promise.resolve();
let lastKnownProgress = { command: null, number: null, detail: "", at: null };
const lastReanchorAt = new Map();

export function setJobRunning(value) {
  jobRunning = Boolean(value);
}

export function isJobRunning() {
  return jobRunning;
}

export function bindStatusClient(client) {
  statusClient = client || null;
}

export function workingImagePath() {
  return statusImagePath("working");
}

export function statusImagePath(kind = "working") {
  const names = {
    working: ["working-pug.png", "working-pug.gif", "working-pug.webp"],
    stuck: ["stuck-pug.png", "stuck-pug.gif", "stuck-pug.webp"],
    sleeping: ["sleeping-pug.png", "sleeping-pug.gif", "sleeping-pug.webp"],
  }[kind] || ["working-pug.png", "working-pug.gif"];
  for (const name of names) {
    const filePath = path.join(ROOT, "assets", name);
    if (existsSync(filePath)) return filePath;
  }
  return kind === "sleeping" || kind === "stuck" ? statusImagePath("working") : null;
}

function statusImageKind(info) {
  if (info?.state === "stuck") return "stuck";
  if (jobRunning || info?.state === "working") return "working";
  return "sleeping";
}

export function statusSkipIds() {
  const ids = new Set();
  const channels = cachedStatus?.channels || {};
  for (const entry of Object.values(channels)) {
    if (entry?.messageId) ids.add(String(entry.messageId));
  }
  if (cachedStatus?.messageId) ids.add(String(cachedStatus.messageId));
  return ids;
}

async function persistJson(filePath, data) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2));
}

async function persistJsonFsync(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  const fh = await fsOpen(tmp, "w");
  try {
    await fh.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (existsSync(filePath)) {
    try {
      await unlink(filePath);
    } catch {
      // Windows may still allow rename over the dest
    }
  }
  await rename(tmp, filePath);
}

async function rotateIfExists(currentPath, prevPath) {
  if (!existsSync(currentPath)) return false;
  await copyFile(currentPath, prevPath);
  return true;
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function readBotLock() {
  if (!existsSync(BOT_LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BOT_LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function releaseBotLock() {
  try {
    if (!existsSync(BOT_LOCK_FILE)) return;
    const data = readBotLock();
    if (Number.isInteger(data?.pid) && data.pid !== process.pid) return;
    unlinkSync(BOT_LOCK_FILE);
  } catch {
    // ignore
  }
}

export async function acquireBotLock() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const existing = readBotLock();
  const pid = Number(existing?.pid);
  if (Number.isInteger(pid) && pid !== process.pid && pidIsAlive(pid)) {
    throw new Error(
      `Another bot is already running (PID ${pid}). Stop that process first — a second node bot.mjs will steal the Discord gateway.\nLock: ${BOT_LOCK_FILE}`,
    );
  }
  if (Number.isInteger(pid) && pid !== process.pid && !pidIsAlive(pid)) {
    console.warn(`Removing stale lock from dead PID ${pid}`);
  }
  await persistJsonFsync(BOT_LOCK_FILE, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv,
  });
}

export function assertBotLockFree(scriptName = "this script") {
  const existing = readBotLock();
  const pid = Number(existing?.pid);
  if (Number.isInteger(pid) && pid !== process.pid && pidIsAlive(pid)) {
    console.error(`REFUSING to start ${scriptName}.`);
    console.error(`A live bot already holds the lock: PID ${pid}`);
    console.error(`Lock file: ${BOT_LOCK_FILE}`);
    console.error("Stop that npm start process first. Dual login with the same token kicks the bot off Discord.");
    process.exit(1);
  }
}

export async function loadReworkCheckpoint() {
  return loadJson(REWORK_CHECKPOINT_FILE);
}

export function normalizeLockinRanges(ranges) {
  const cleaned = (ranges || [])
    .map((range) => ({
      from: Number(range.from),
      to: Number(range.to),
      at: range.at || null,
    }))
    .filter((range) => Number.isInteger(range.from) && Number.isInteger(range.to) && range.from <= range.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged = [];
  for (const range of cleaned) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to + 1) {
      last.to = Math.max(last.to, range.to);
      last.at = range.at || last.at;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function parseLockin(data) {
  if (!data) return { ranges: [], at: null, last: null };
  let ranges = [];
  if (Array.isArray(data.ranges)) ranges = data.ranges;
  else if (Number.isInteger(data.from) && Number.isInteger(data.to)) {
    ranges = [{ from: data.from, to: data.to, at: data.at || null }];
  }
  return {
    ranges: normalizeLockinRanges(ranges),
    at: data.at || null,
    last: data.last || null,
  };
}

export async function loadLockin() {
  return parseLockin(await loadJson(LOCKIN_FILE));
}

export function hasLockin(lockin) {
  return Boolean(lockin?.ranges?.length);
}

export function isLockedNumber(n, lockin) {
  if (!Number.isInteger(n) || !hasLockin(lockin)) return false;
  return lockin.ranges.some((range) => n >= range.from && n <= range.to);
}

/** Locked numbers are Final-only — forbidden for normal sequence ops unless allowLocked (reconsider-replace). */
export function assertNumberTouchable(n, lockin, { allowLocked = false, via = "/reconsider-replace" } = {}) {
  if (!isLockedNumber(n, lockin)) return;
  if (allowLocked) return;
  throw new Error(
    `${n} is locked by /lockin (${formatLockinRanges(lockin)}). Locked numbers are ignored by the Edit per number sequence and can only be changed with ${via}.`,
  );
}

export function maxLockedNumber(lockin) {
  if (!hasLockin(lockin)) return 0;
  return Math.max(...lockin.ranges.map((range) => range.to));
}

export function formatLockinRanges(lockin) {
  if (!hasLockin(lockin)) return "none";
  return lockin.ranges.map((range) => `${range.from}–${range.to}`).join(", ");
}

export function lockedNumbersIn(from, to, lockin) {
  const found = [];
  if (!hasLockin(lockin)) return found;
  for (let n = from; n <= to; n++) {
    if (isLockedNumber(n, lockin)) found.push(n);
  }
  return found;
}

export async function saveLockin(data) {
  const parsed = parseLockin(data);
  await persistJsonFsync(LOCKIN_FILE, {
    ranges: parsed.ranges,
    at: new Date().toISOString(),
    last: parsed.last || null,
  });
  return parsed;
}

export async function addLockinRange(from, to, extra = {}) {
  const current = await loadLockin();
  const next = {
    ranges: [...current.ranges, { from, to, at: new Date().toISOString() }],
    last: { from, to, at: new Date().toISOString(), ...extra },
  };
  return saveLockin(next);
}

export async function clearLockin() {
  if (existsSync(LOCKIN_FILE)) await unlink(LOCKIN_FILE);
}

export async function saveReworkCheckpoint(data) {
  await persistJsonFsync(REWORK_CHECKPOINT_FILE, {
    ...data,
    at: new Date().toISOString(),
  });
}

export async function clearReworkCheckpoint() {
  if (existsSync(REWORK_CHECKPOINT_FILE)) await unlink(REWORK_CHECKPOINT_FILE);
}

async function loadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function saveLastKnown() {
  await persistJson(LAST_JOB_FILE, lastKnownProgress);
}

async function loadLastKnown() {
  const data = await loadJson(LAST_JOB_FILE);
  if (!data) return lastKnownProgress;
  lastKnownProgress = {
    command: data.command || null,
    number: Number.isInteger(data.number) ? data.number : null,
    detail: data.detail || "",
    at: data.at || null,
  };
  return lastKnownProgress;
}

function emptyChannelPointer() {
  return { messageId: null, firstMessageId: null };
}

function statusChannelIds() {
  return [REVIEW_THREAD_ID, RECONSIDER_THREAD_ID];
}

async function loadStatusPointer() {
  if (cachedStatus?.channels) return cachedStatus;
  const data = await loadJson(STATUS_FILE);
  const channels = {};
  if (data?.channels && typeof data.channels === "object") {
    for (const [id, entry] of Object.entries(data.channels)) {
      channels[String(id)] = {
        messageId: entry?.messageId ? String(entry.messageId) : null,
        firstMessageId: entry?.firstMessageId ? String(entry.firstMessageId) : null,
      };
    }
  } else if (data?.channelId) {
    channels[String(data.channelId)] = {
      messageId: data.messageId ? String(data.messageId) : null,
      firstMessageId: data.firstMessageId ? String(data.firstMessageId) : null,
    };
  }
  for (const id of statusChannelIds()) {
    if (!channels[id]) channels[id] = emptyChannelPointer();
  }
  cachedStatus = {
    guildId: data?.guildId || null,
    thumbVersion: Number(data?.thumbVersion) || 0,
    channels,
  };
  return cachedStatus;
}

async function saveStatusPointer(pointer) {
  cachedStatus = pointer;
  await persistJson(STATUS_FILE, pointer);
}

export async function rememberStatusChannel(channel) {
  if (!channel?.id) return;
  await loadStatusPointer();
}

export async function ensureStatusChannel(channel) {
  await rememberStatusChannel(channel);
  return loadStatusPointer();
}

function resumeHelp(info) {
  const hint = resumeHint(info).trim();
  if (hint) return `${hint} Stop a stuck job with \`/killsnatchnow\`.`;
  return "Start work with `/reworkcount` or `/snatchmarios`. Stop a stuck job with `/killsnatchnow`.";
}

export function describeJobStatus() {
  const current = (jobProgress.command || Number.isInteger(jobProgress.number)) ? jobProgress : lastKnownProgress;
  const at = current?.at ? Date.parse(current.at) : 0;
  const age = Number.isFinite(at) && at > 0 ? Date.now() - at : Infinity;
  const number = Number.isInteger(current?.number) ? current.number : null;
  const command = current?.command || null;
  const detail = current?.detail || "";

  let state = "idle";
  if (isAborted()) state = "stopped";
  else if (jobRunning && age > STATUS_IDLE_MS) state = "stuck";
  else if (jobRunning) state = "working";
  else if (age > STATUS_IDLE_MS) state = "idle";
  else if (command || Number.isInteger(number)) state = "done";

  return { state, command, number, detail, at: current?.at || null, age };
}

function statusEmbedPayload(info, filename, jumpUrl) {
  const titles = {
    working: "Pug is working",
    stuck: "Pug got stuck",
    stopped: "Pug stopped",
    idle: "Pug is idle",
    done: "Pug finished",
  };
  const colors = {
    working: 0xf5c16c,
    stuck: 0xe74c3c,
    stopped: 0xe67e22,
    idle: 0x95a5a6,
    done: 0x2ecc71,
  };
  const numberText = Number.isInteger(info.number) ? String(info.number) : "—";
  const commandText = info.command || "—";
  const detailText = (info.detail || "—").slice(0, 1024);
  let description = info.state === "working"
    ? "Live progress — this message stays at the bottom of the thread."
    : info.state === "stuck"
      ? "No progress for over a minute. Last number and how to restart:"
      : info.state === "stopped"
        ? "The bot stopped. Last number and how to restart:"
        : info.state === "done"
          ? "Last job finished. If nothing new starts, this will sit idle."
          : "Nothing is running. Last number and how to restart:";
  if (jumpUrl) description += `\n[Jump to top](${jumpUrl})`;
  const embed = new EmbedBuilder()
    .setTitle(titles[info.state] || "Pug status")
    .setColor(colors[info.state] || 0x95a5a6)
    .setDescription(description)
    .addFields(
      { name: "Command", value: `\`${commandText}\``, inline: true },
      { name: "Number", value: numberText, inline: true },
      { name: "Detail", value: detailText, inline: false },
      { name: "Restart", value: resumeHelp(info), inline: false },
    )
    .setFooter({ text: STATUS_FOOTER })
    .setTimestamp(info.at ? new Date(info.at) : new Date());

  if (filename) embed.setThumbnail(`attachment://${filename}`);
  return embed;
}

async function resolveJumpToTop(client, channel) {
  const saved = (await loadStatusPointer()) || {};
  const entry = saved.channels?.[channel.id] || {};
  if (saved.guildId && entry.firstMessageId) {
    return {
      url: `https://discord.com/channels/${saved.guildId}/${channel.id}/${entry.firstMessageId}`,
      guildId: saved.guildId,
      firstMessageId: entry.firstMessageId,
    };
  }
  try {
    const guildId = channel.guildId || saved.guildId || null;
    let firstMessageId = null;
    if (channel.isThread?.()) {
      try {
        const starter = await channel.fetchStarterMessage();
        firstMessageId = starter?.id || null;
      } catch {
        // no starter
      }
    }
    if (!firstMessageId) {
      const around = await channel.messages.fetch({ around: channel.id, limit: 10 });
      const oldest = [...around.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
      firstMessageId = oldest?.id || channel.id;
    }
    if (!guildId || !firstMessageId) return { url: null, guildId, firstMessageId };
    return {
      url: `https://discord.com/channels/${guildId}/${channel.id}/${firstMessageId}`,
      guildId,
      firstMessageId,
    };
  } catch (error) {
    console.error("Could not resolve jump-to-top link:", error.message || error);
    return { url: null, guildId: saved.guildId || null, firstMessageId: entry.firstMessageId || null };
  }
}

async function statusIsNewest(channel, messageId) {
  if (!messageId) return false;
  const recent = await channel.messages.fetch({ limit: 1 });
  const newest = recent.first();
  return Boolean(newest && String(newest.id) === String(messageId));
}

async function sendStatusMessage(channel, info, thumb, jumpUrl) {
  return channel.send({
    embeds: [statusEmbedPayload(info, thumb?.filename || null, jumpUrl)],
    files: thumb ? [thumb.builder] : [],
    allowedMentions: { parse: [] },
  });
}

async function editStatusMessage(message, info, thumb, jumpUrl) {
  return message.edit({
    embeds: [statusEmbedPayload(info, thumb?.filename || null, jumpUrl)],
    files: thumb ? [thumb.builder] : [],
    attachments: [],
    allowedMentions: { parse: [] },
  });
}

async function publishStatusToChannel(client, channel, info, thumb) {
  const pointer = await loadStatusPointer();
  const entry = pointer.channels[channel.id] || emptyChannelPointer();
  const jump = await resolveJumpToTop(client, channel);
  let message = null;
  if (entry.messageId) {
    try {
      message = await channel.messages.fetch(entry.messageId);
    } catch {
      message = null;
    }
  }
  if (!message) {
    const kept = await collapseStatusEmbeds(channel, client.user?.id, entry.messageId);
    if (kept) message = kept;
  }

  const atBottom = message ? await statusIsNewest(channel, message.id) : true;
  const lastAnchor = lastReanchorAt.get(channel.id) || 0;
  const shouldReanchor = Boolean(message) && !atBottom && (Date.now() - lastAnchor >= STATUS_REANCHOR_MS);

  try {
    if (!message) {
      message = await sendStatusMessage(channel, info, thumb, jump.url);
      lastReanchorAt.set(channel.id, Date.now());
      await collapseStatusEmbeds(channel, client.user?.id, message.id);
    } else if (shouldReanchor) {
      const posted = await sendStatusMessage(channel, info, thumb, jump.url);
      lastReanchorAt.set(channel.id, Date.now());
      try {
        await message.delete();
      } catch {
        // old status already gone
      }
      message = posted;
      await collapseStatusEmbeds(channel, client.user?.id, message.id);
    } else {
      message = await editStatusMessage(message, info, thumb, jump.url);
    }
  } catch (error) {
    console.error(`Status embed update failed in ${channel.id}:`, error.message || error);
    if (!message) return { message: null, jump };
    try {
      message = await editStatusMessage(message, info, thumb, jump.url);
    } catch (retryError) {
      console.error(`Status embed edit failed in ${channel.id}:`, retryError.message || retryError);
      return { message, jump };
    }
  }
  return { message, jump };
}

async function publishJobStatusUnlocked(client) {
  await loadLastKnown();
  const pointer = await loadStatusPointer();
  const info = describeJobStatus();
  const kind = statusImageKind(info);
  const thumb = statusThumbFile(kind);
  const key = `${info.state}|${kind}|${info.command || ""}|${info.number ?? ""}|${info.detail || ""}|${thumb?.filename || ""}`;
  const firstPublish = lastStatusStateKey === "";
  const skipContent = !firstPublish && key === lastStatusStateKey && info.state !== "working";
  lastStatusStateKey = key;

  const channels = [];
  for (const id of statusChannelIds()) {
    try {
      const channel = await ensureThread(client, id);
      channels.push(channel);
    } catch (error) {
      console.error(`Could not open status channel ${id}:`, error.message || error);
    }
  }
  if (channels.length === 0) return pointer;

  let anyMoved = false;
  for (const channel of channels) {
    const entry = pointer.channels[channel.id] || emptyChannelPointer();
    const atBottom = entry.messageId ? await statusIsNewest(channel, entry.messageId) : false;
    if (skipContent && atBottom) continue;
    const result = await publishStatusToChannel(client, channel, info, thumb);
    if (!result.message) continue;
    if (result.message.id !== entry.messageId) anyMoved = true;
    pointer.channels[channel.id] = {
      messageId: result.message.id,
      firstMessageId: result.jump.firstMessageId || entry.firstMessageId || null,
    };
    if (result.jump.guildId) pointer.guildId = result.jump.guildId;
  }
  pointer.thumbVersion = STATUS_THUMB_VERSION;
  await saveStatusPointer(pointer);
  void anyMoved;
  return pointer;
}

function isStatusEmbedMessage(message) {
  const footer = message?.embeds?.[0]?.footer?.text || "";
  return footer.startsWith("Public live status");
}

function isSnatchCheckpointEmbed(message) {
  const footer = message?.embeds?.[0]?.footer?.text || "";
  return footer.startsWith("Snatch checkpoint");
}

function statusThumbFile(kind) {
  const filePath = statusImagePath(kind);
  if (!filePath) return null;
  const filename = path.basename(filePath);
  return {
    filePath,
    filename,
    builder: new AttachmentBuilder(filePath, { name: filename }),
  };
}

async function findStatusEmbeds(channel, botId) {
  if (!channel?.messages) return [];
  const batch = await channel.messages.fetch({ limit: 100 });
  return [...batch.values()]
    .filter((message) => (!botId || message.author?.id === botId) && isStatusEmbedMessage(message))
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

async function collapseStatusEmbeds(channel, botId, keepId) {
  const found = await findStatusEmbeds(channel, botId);
  if (found.length === 0) return null;
  const keep = found.find((message) => keepId && message.id === String(keepId)) || found[found.length - 1];
  for (const extra of found) {
    if (extra.id === keep.id) continue;
    try {
      await extra.delete();
    } catch {
      // leftover status message
    }
  }
  return keep;
}

export async function publishJobStatus(client = statusClient) {
  if (!client) return null;
  let result;
  publishChain = publishChain.then(async () => {
    result = await publishJobStatusUnlocked(client);
  }).catch((error) => {
    console.error("Status embed failed:", error.message || error);
  });
  await publishChain;
  return result ?? cachedStatus;
}

export function scheduleStatusPublish(immediate = false) {
  if (!statusClient) return;
  if (immediate) {
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    void publishJobStatus(statusClient);
    return;
  }
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    void publishJobStatus(statusClient);
  }, STATUS_THROTTLE_MS);
}

export function startStatusWatchdog(client, intervalMs = 15_000) {
  bindStatusClient(client);
  return setInterval(() => {
    void publishJobStatus(client);
  }, intervalMs);
}

export async function setJobProgress(command, number, detail = "") {
  jobProgress = {
    command: command || null,
    number: Number.isInteger(number) ? number : null,
    detail: detail || "",
    at: new Date().toISOString(),
  };
  lastKnownProgress = { ...jobProgress };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(PROGRESS_FILE, JSON.stringify(jobProgress, null, 2));
  await saveLastKnown();
  scheduleStatusPublish();
}

export async function clearJobProgress() {
  jobProgress = { command: null, number: null, detail: null, at: new Date().toISOString() };
  if (existsSync(PROGRESS_FILE)) await unlink(PROGRESS_FILE);
  scheduleStatusPublish(true);
}

export async function loadJobProgress() {
  await loadLastKnown();
  if (!existsSync(PROGRESS_FILE)) {
    return jobProgress.number != null || jobProgress.command
      ? jobProgress
      : (lastKnownProgress.number != null || lastKnownProgress.command ? lastKnownProgress : null);
  }
  try {
    const data = JSON.parse(await readFile(PROGRESS_FILE, "utf8"));
    jobProgress = {
      command: data.command || null,
      number: Number.isInteger(data.number) ? data.number : null,
      detail: data.detail || "",
      at: data.at || null,
    };
    if (jobProgress.command || Number.isInteger(jobProgress.number)) {
      lastKnownProgress = { ...jobProgress };
    }
    return jobProgress.number != null || jobProgress.command ? jobProgress : null;
  } catch {
    return lastKnownProgress.command || Number.isInteger(lastKnownProgress.number) ? lastKnownProgress : null;
  }
}

export function filePathFor(n) {
  return path.join(OUTPUT_DIR, `${n}.jpg`);
}

/** Working cache path (Drive downloads). Prefer this over permanent lineup files. */
export function cachePathFor(n) {
  return path.join(OUTPUT_DIR, ".drive-cache", `${n}.jpg`);
}

function existingImagePath(n) {
  if (!Number.isInteger(n)) return null;
  if (existsSync(cachePathFor(n))) return cachePathFor(n);
  if (existsSync(filePathFor(n))) return filePathFor(n);
  return null;
}

async function driveApi() {
  return import("./drive.mjs");
}

/** Resolve a path usable for Discord/sharp: Drive cache (download if needed), else legacy local. */
export async function ensureImagePathFor(n) {
  const cache = cachePathFor(n);
  if (existsSync(cache)) return cache;
  try {
    const { ensureCachedNumber, driveConfigured } = await driveApi();
    if (driveConfigured()) return ensureCachedNumber(n);
  } catch (error) {
    if (!existsSync(filePathFor(n))) throw error;
  }
  const legacy = filePathFor(n);
  if (existsSync(legacy)) return legacy;
  throw new Error(`No Drive/cache image for ${n}.jpg`);
}

export async function deleteLocalFilesAfter(count) {
  if (!existsSync(OUTPUT_DIR)) return 0;
  const names = await readdir(OUTPUT_DIR);
  let deleted = 0;
  for (const name of names) {
    const match = name.match(/^(\d+)\.jpe?g$/i);
    if (!match) continue;
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n <= count) continue;
    throwIfAborted("Rework cleanup");
    await unlink(path.join(OUTPUT_DIR, name));
    deleted += 1;
  }
  return deleted;
}

export function reconsiderDir() {
  return path.join(OUTPUT_DIR, "reconsider");
}

export function qualityControlledDir() {
  return path.join(OUTPUT_DIR, "Quality Controlled");
}

export async function saveDumpFile(dir, name, source) {
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (typeof source === "string") {
    await copyFile(source, dest);
  } else {
    await saveResized(source, dest);
  }
  return dest;
}

export async function saveReconsiderDumpFile(name, source) {
  return saveDumpFile(reconsiderDir(), name, source);
}

export async function saveQualityControlledFile(name, source) {
  return saveDumpFile(qualityControlledDir(), name, source);
}

export function placeholderPath() {
  return path.join(ROOT, "PLACEHOLDER.jpg");
}

export async function ensurePlaceholderFile(sourcePath) {
  const dest = placeholderPath();
  if (sourcePath) {
    await sharp(sourcePath, { failOn: "none" })
      .flatten({ background: { r: 208, g: 208, b: 208 } })
      .resize(SIZE, SIZE, {
        fit: "contain",
        background: { r: 208, g: 208, b: 208, alpha: 1 },
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(dest);
  }
  if (!existsSync(dest)) {
    throw new Error("PLACEHOLDER.jpg is missing.");
  }
  return dest;
}

export async function applyPlaceholderToNumber(n) {
  const lockin = await loadLockin();
  if (isLockedNumber(n, lockin)) {
    console.warn(`Refusing PLACEHOLDER on locked number ${n}`);
    return false;
  }
  const src = await ensurePlaceholderFile();
  const buffer = await readFile(src);
  await mkdir(path.join(OUTPUT_DIR, ".drive-cache"), { recursive: true });
  await writeFile(cachePathFor(n), buffer);
  try {
    const { upsertNumberImage, driveConfigured } = await driveApi();
    if (driveConfigured()) await upsertNumberImage(n, buffer, { role: "snatch" });
  } catch (error) {
    console.error(`Drive PLACEHOLDER upload ${n} failed:`, error.message || error);
  }
  return true;
}

export function pythonBin() {
  const venvPy = process.platform === "win32"
    ? path.join(ROOT, ".venv", "Scripts", "python.exe")
    : path.join(ROOT, ".venv", "bin", "python");
  return existsSync(venvPy) ? venvPy : "python";
}

export function runWatermarkRemoval(inputPath, outputPath) {
  const script = path.join(ROOT, "remove_watermark.py");
  if (!existsSync(script)) {
    return Promise.reject(new Error("remove_watermark.py is missing."));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [script, inputPath, outputPath], { windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("watermark removal timed out after 20s"));
    }, 20_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `watermark script exited ${code}`));
    });
  });
}

export async function dewmarkSequenceFile(n) {
  const input = await ensureImagePathFor(n);
  const tmp = path.join(OUTPUT_DIR, `.wm-${n}.jpg`);
  await runWatermarkRemoval(input, tmp);
  const buffer = await readFile(tmp);
  await mkdir(path.join(OUTPUT_DIR, ".drive-cache"), { recursive: true });
  await writeFile(cachePathFor(n), buffer);
  await unlink(tmp).catch(() => {});
  try {
    const { upsertNumberImage, driveConfigured } = await driveApi();
    if (driveConfigured()) {
      const lockin = await loadLockin();
      await upsertNumberImage(n, buffer, {
        role: isLockedNumber(n, lockin) ? "quality" : "snatch",
      });
    }
  } catch (error) {
    console.error(`Drive watermark upload ${n} failed:`, error.message || error);
  }
  return buffer;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function stripUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

export function parseAttachmentId(url) {
  const match = String(url || "").match(/\/attachments\/\d+\/(\d+)\//);
  return match ? match[1] : null;
}

export function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith("image/")) return true;
  return IMAGE_EXT.has(path.extname(attachment.name || "").toLowerCase());
}

export function collectImages(message) {
  const found = [];

  for (const attachment of message.attachments.values()) {
    if (isImageAttachment(attachment) && attachment.url) {
      found.push({
        url: attachment.url,
        name: attachment.name || "image",
        attachmentId: attachment.id,
        messageId: message.id,
      });
    }
  }

  for (const embed of message.embeds) {
    const url = embed.image?.url || embed.thumbnail?.url;
    if (url) {
      found.push({
        url,
        name: "embed",
        attachmentId: parseAttachmentId(url),
        messageId: message.id,
      });
    }
  }

  return found;
}

export function firstImageUrl(message) {
  return collectImages(message)[0]?.url || null;
}

export function numberFromMessage(message) {
  const fromContent = message.content?.trim().match(/^(\d+)\b/);
  if (fromContent) return Number(fromContent[1]);

  for (const attachment of message.attachments.values()) {
    const match = attachment.name?.match(/^(\d+)\.jpe?g$/i);
    if (match) return Number(match[1]);
  }

  return null;
}

export async function fetchAllMessages(channel) {
  const all = [];
  let before;

  while (true) {
    throwIfAborted("Fetch");
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
  }

  return all;
}

export function messageMentionsBot(message, botId) {
  if (!message || !botId) return false;
  const id = String(botId);
  if (message.mentions?.users?.has(id)) return true;
  const text = String(message.content || "");
  return text.includes(`<@${id}>`) || text.includes(`<@!${id}>`);
}

export function mentionCheckpointId(message) {
  if (!message) return null;
  const tagged = message.reference?.messageId;
  if (tagged) return String(tagged);
  return String(message.id);
}

export function laterSnowflake(a, b) {
  if (!a) return b ? String(b) : null;
  if (!b) return String(a);
  return BigInt(a) >= BigInt(b) ? String(a) : String(b);
}

export async function loadSnatchCursors() {
  const data = await loadJson(SNATCH_CURSOR_FILE);
  return data?.byThread ? data : { byThread: {} };
}

export async function getSavedSnatchCursor(threadId) {
  const data = await loadSnatchCursors();
  return data.byThread?.[String(threadId)]?.afterMessageId || null;
}

export async function saveSnatchCursor(threadId, afterMessageId, extra = {}) {
  if (!threadId || !afterMessageId) return;
  const data = await loadSnatchCursors();
  if (!data.byThread) data.byThread = {};
  data.byThread[String(threadId)] = {
    afterMessageId: String(afterMessageId),
    at: new Date().toISOString(),
    ...extra,
  };
  await persistJsonFsync(SNATCH_CURSOR_FILE, data);
}

export async function fetchSnatchSourceMessages(channel, { botId, savedAfterId } = {}) {
  const all = [];
  let latestMention = null;
  let latestCheckpoint = null;
  let before;
  const saved = savedAfterId ? BigInt(savedAfterId) : null;

  while (true) {
    throwIfAborted("Fetch");
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;

    let reachedSaved = false;
    for (const message of batch.values()) {
      all.push(message);
      if (botId && !latestMention && messageMentionsBot(message, botId) && !isSnatchCheckpointEmbed(message) && !isStatusEmbedMessage(message)) {
        latestMention = message;
      }
      if (botId && !latestCheckpoint && isSnatchCheckpointEmbed(message) && (!botId || message.author?.id === botId)) {
        latestCheckpoint = message;
      }
      if (saved && BigInt(message.id) <= saved) reachedSaved = true;
    }

    const oldestInBatch = batch.last().id;
    const mentionAfter = latestMention ? mentionCheckpointId(latestMention) : null;
    const checkpointAfter = latestCheckpoint?.id || null;
    const floor = laterSnowflake(laterSnowflake(savedAfterId || null, mentionAfter), checkpointAfter);
    before = oldestInBatch;
    if (floor && BigInt(oldestInBatch) <= BigInt(floor)) break;
    if (reachedSaved && (latestMention || latestCheckpoint)) break;
    if (reachedSaved && !botId) break;
  }

  const mentionAfter = latestMention ? mentionCheckpointId(latestMention) : null;
  const checkpointAfter = latestCheckpoint?.id || null;
  const afterId = laterSnowflake(laterSnowflake(savedAfterId || null, mentionAfter), checkpointAfter);
  const window = afterId
    ? all.filter((message) => BigInt(message.id) > BigInt(afterId))
    : all;

  return {
    messages: sortOldestFirst(window),
    afterId,
    mentionMessageId: latestMention?.id || null,
    mentionCheckpointId: mentionAfter,
    checkpointMessageId: checkpointAfter,
    savedAfterId: savedAfterId || null,
    scanned: all.length,
  };
}

function snatchCheckpointEmbed(count, at) {
  const when = at ? new Date(at).toUTCString() : new Date().toUTCString();
  return new EmbedBuilder()
    .setTitle("Snatched up to here")
    .setColor(0xf5c16c)
    .setDescription(`Everything above this mark has been pulled into the lineup.\n**${count}** image(s) in sequence.\nLast pulled: ${when}`)
    .setFooter({ text: SNATCH_CHECKPOINT_FOOTER })
    .setTimestamp(at ? new Date(at) : new Date());
}

export async function upsertSnatchCheckpointEmbed(channel, { count, botId }) {
  if (!channel?.isTextBased?.()) return null;
  const found = [];
  let newest = null;
  let before;
  for (let page = 0; page < 20; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    if (!newest) newest = batch.first();
    for (const message of batch.values()) {
      if ((!botId || message.author?.id === botId) && isSnatchCheckpointEmbed(message)) {
        found.push(message);
      }
    }
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  found.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  const keep = found[found.length - 1] || null;
  for (const extra of found) {
    if (keep && extra.id === keep.id) continue;
    try {
      await extra.delete();
    } catch {
      // leftover checkpoint
    }
  }
  const embed = snatchCheckpointEmbed(count, new Date().toISOString());
  const atBottom = keep && newest && String(newest.id) === String(keep.id);
  let message = keep;
  if (keep && atBottom) {
    message = await keep.edit({ embeds: [embed], allowedMentions: { parse: [] } });
  } else {
    message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    if (keep) {
      try {
        await keep.delete();
      } catch {
        // old checkpoint gone
      }
    }
  }
  return message;
}

export function sortOldestFirst(messages) {
  return [...messages].sort((a, b) => {
    const aid = BigInt(a.id);
    const bid = BigInt(b.id);
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return 0;
  });
}

export async function ensureThread(client, id) {
  const channel = await client.channels.fetch(id);
  if (!channel?.isTextBased()) {
    throw new Error(`Channel ${id} is not a text channel or thread.`);
  }
  if (channel.isThread?.()) {
    if (channel.joinable) await channel.join();
    if (channel.archived) {
      await channel.setArchived(false);
    }
  }
  return channel;
}

export function sourceAllowed(channel, linkedId) {
  if (!channel || !linkedId) return false;
  if (channel.id === linkedId) return true;
  const parentId = channel.parentId ?? channel.parent?.id;
  return Boolean(channel.isThread?.() && parentId === linkedId);
}

export async function fetchBuffer(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function saveResized(buffer, destPath) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await sharp(buffer, { animated: false, failOn: "none" })
    .resize(SIZE, SIZE, {
      fit: FIT,
      position: "centre",
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toFile(destPath);
}

export async function saveSequence(sequence) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(SEQUENCE_FILE, JSON.stringify(sequence, null, 2));
  const manifest = sequence.items.map((item) => ({
    file: `${item.n}.jpg`,
    source: item.source,
  }));
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

function emptyItem(n, extra = {}) {
  return {
    n,
    source: extra.source || null,
    attachmentId: extra.attachmentId || null,
    sha256: extra.sha256 || null,
    dirty: extra.dirty ?? false,
    placeholder: extra.placeholder ?? false,
    replaced: extra.replaced ?? false,
    locked: extra.locked ?? false,
  };
}

export { emptyItem };

/** Grow an empty/partial local sequence so number n is addressable. */
export function ensureSequenceNumber(sequence, n) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Number must be a positive integer (got ${n}).`);
  }
  if (!sequence.items) sequence.items = [];
  if (!sequence.gaps) sequence.gaps = [];
  while (sequence.items.length < n) {
    sequence.items.push(emptyItem(sequence.items.length + 1));
  }
  for (let i = 0; i < sequence.items.length; i++) {
    if (!sequence.items[i]) sequence.items[i] = emptyItem(i + 1);
    else sequence.items[i].n = i + 1;
  }
  sequence.count = Math.max(Number(sequence.count) || 0, n, sequence.items.length);
  return sequence;
}

export async function loadSequence() {
  if (existsSync(SEQUENCE_FILE)) {
    const sequence = JSON.parse(await readFile(SEQUENCE_FILE, "utf8"));
    sequence.items = (sequence.items || []).map((item, index) => emptyItem(item.n ?? index + 1, item));
    sequence.count = Number(sequence.count) || sequence.items.length;
    sequence.gaps = sequence.gaps || [];
    normalizeGaps(sequence);
    return sequence;
  }

  const names = existsSync(OUTPUT_DIR) ? await readdir(OUTPUT_DIR) : [];
  const numbers = names
    .map((name) => name.match(/^(\d+)\.jpg$/i))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const count = numbers.length ? Math.max(...numbers) : 0;

  let manifest = [];
  if (existsSync(MANIFEST_FILE)) {
    try {
      manifest = JSON.parse(await readFile(MANIFEST_FILE, "utf8"));
    } catch {
      manifest = [];
    }
  }
  const byFile = Object.fromEntries((manifest || []).map((entry) => [entry.file, entry.source]));

  const items = [];
  for (let n = 1; n <= count; n++) {
    const source = byFile[`${n}.jpg`] || null;
    items.push(emptyItem(n, {
      source,
      attachmentId: parseAttachmentId(source),
      dirty: false,
    }));
  }

  const sequence = { count, items, gaps: [] };
  if (count > 0) await saveSequence(sequence);
  return sequence;
}

export function normalizeGaps(sequence) {
  const count = Number(sequence.count) || 0;
  sequence.gaps = [...new Set((sequence.gaps || []).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= count)
    .sort((a, b) => a - b);
  return sequence.gaps;
}

export function addGaps(sequence, numbers, lockin = null) {
  sequence.gaps = sequence.gaps || [];
  for (const n of numbers) {
    if (lockin && isLockedNumber(n, lockin)) continue;
    sequence.gaps.push(n);
  }
  return normalizeGaps(sequence);
}

export function removeGap(sequence, n) {
  sequence.gaps = (sequence.gaps || []).filter((gap) => gap !== n);
  return normalizeGaps(sequence);
}

export function formatGapText(gaps, count, lockin = null) {
  if (!gaps.length) return `No gaps. Sequence 1–${count} is complete.`;
  const locked = [];
  const active = [];
  for (const n of gaps) {
    if (isLockedNumber(n, lockin)) locked.push(n);
    else active.push(n);
  }
  const lines = [];
  if (active.length) {
    lines.push(`Active gaps that still need a lineup replacement (${active.length}). Sequence count stays ${count}.\n${active.join(", ")}`);
  } else {
    lines.push(`No active (unlocked) gaps. Sequence count stays ${count}.`);
  }
  if (locked.length) {
    lines.push(`Locked gaps (${locked.length}) — not in Edit per number; fill only with /reconsider-replace: ${locked.join(", ")}`);
  }
  return lines.join("\n");
}

export function splitDiscordText(text, limit = 1900) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(", ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^,\s*/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function knownKeys(sequence) {
  const ids = new Set();
  const urls = new Set();
  const hashes = new Set();
  for (const item of sequence.items) {
    if (item.attachmentId) ids.add(String(item.attachmentId));
    const url = stripUrl(item.source);
    if (url) urls.add(url);
    if (item.sha256) hashes.add(item.sha256);
  }
  return { ids, urls, hashes };
}

export async function addLocalFileHashes(hashes, count) {
  for (let n = 1; n <= count; n++) {
    for (const localPath of [cachePathFor(n), filePathFor(n)]) {
      if (!existsSync(localPath)) continue;
      hashes.add(sha256(await readFile(localPath)));
      break;
    }
  }
  return hashes;
}

export async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

let cachedPlaceholderHash;

export async function getPlaceholderHash() {
  if (!cachedPlaceholderHash) {
    cachedPlaceholderHash = sha256(await readFile(placeholderPath()));
  }
  return cachedPlaceholderHash;
}

export async function isReplaceMeNumber(sequence, n) {
  const count = Number(sequence.count) || 0;
  if (!Number.isInteger(n) || n < 1 || n > count) return true;
  if (normalizeGaps(sequence).includes(n) || sequence.items[n - 1]?.placeholder) return true;

  for (const localPath of [cachePathFor(n), filePathFor(n)]) {
    if (!existsSync(localPath)) continue;
    return (await fileSha256(localPath)) === (await getPlaceholderHash());
  }

  try {
    const { numberExistsOnDrive, driveConfigured } = await driveApi();
    if (driveConfigured() && (await numberExistsOnDrive(n))) return false;
  } catch {
    // Drive unavailable — fall through
  }
  return true;
}

const REWORK_PACK_FILE = path.join(OUTPUT_DIR, ".rework-pack.json");

function tmpPackComplete(tmpDir, newCount) {
  if (!newCount) return false;
  for (let n = 1; n <= newCount; n++) {
    if (!existsSync(path.join(tmpDir, `${n}.jpg`))) return false;
  }
  return true;
}

async function applyCompactedFiles(keepers, oldCount, newCount, tmpDir, onProgress, extra = {}) {
  const sequence = await loadSequence();
  const maxLocked = Number(extra.maxLocked) || 0;
  const frozenGaps = [...new Set((extra.frozenGaps || []).map(Number))].filter((n) => n >= 1 && n <= maxLocked);
  await setJobProgress("reworkcount", newCount, `Swapping packed images 0/${newCount}`);
  await mkdir(path.join(OUTPUT_DIR, ".drive-cache"), { recursive: true });
  let driveUpsert = null;
  try {
    const drive = await driveApi();
    if (drive.driveConfigured()) driveUpsert = drive.upsertNumberImage;
  } catch {
    driveUpsert = null;
  }
  for (let n = 1; n <= newCount; n++) {
    throwIfAborted("Rework packing");
    const packed = path.join(tmpDir, `${n}.jpg`);
    await copyFile(packed, cachePathFor(n));
    if (driveUpsert) {
      try {
        const lockin = await loadLockin();
        await driveUpsert(n, packed, {
          role: isLockedNumber(n, lockin) ? "quality" : "snatch",
        });
      } catch (error) {
        console.error(`Drive rework upsert ${n} failed:`, error.message || error);
      }
    }
    if (n === 1 || n === newCount || n % 25 === 0) {
      await setJobProgress("reworkcount", n, `Swapping packed images ${n}/${newCount}`);
      await onProgress(`Swapping packed images ${n}/${newCount}`);
    }
  }
  for (let n = newCount + 1; n <= oldCount; n++) {
    for (const leftover of [filePathFor(n), cachePathFor(n)]) {
      if (existsSync(leftover)) await unlink(leftover);
    }
  }

  const oldItems = sequence.items;
  const frozen = new Set(frozenGaps);
  sequence.items = keepers.map((oldN, index) => emptyItem(index + 1, {
    ...oldItems[oldN - 1],
    n: index + 1,
    placeholder: frozen.has(index + 1),
    dirty: true,
  }));
  sequence.count = newCount;
  sequence.gaps = frozenGaps;
  await saveSequence(sequence);
  await rm(tmpDir, { recursive: true, force: true });
  if (existsSync(REWORK_PACK_FILE)) await unlink(REWORK_PACK_FILE);

  const mapping = new Map(keepers.map((oldN, index) => [oldN, index + 1]));
  const unmapped = [];
  for (let n = 1; n <= oldCount; n++) {
    if (!mapping.has(n)) unmapped.push(n);
  }
  return {
    oldCount,
    newCount,
    closed: unmapped.length,
    mapping,
    unmapped,
    frozenGaps,
    maxLocked,
  };
}

export async function compactSequence(onProgress = async () => {}) {
  const tmpDir = path.join(OUTPUT_DIR, ".rework");
  const lockin = await loadLockin();
  const maxLocked = maxLockedNumber(lockin);
  const savedPack = await loadJson(REWORK_PACK_FILE);
  if (savedPack?.keepers?.length && tmpPackComplete(tmpDir, savedPack.newCount)) {
    const current = await loadSequence();
    if (current.count === savedPack.newCount) {
      await rm(tmpDir, { recursive: true, force: true });
      if (existsSync(REWORK_PACK_FILE)) await unlink(REWORK_PACK_FILE);
      await onProgress("Packed files already swapped. Cleaning leftover temp.");
      const mapping = new Map(savedPack.keepers.map((oldN, index) => [oldN, index + 1]));
      return {
        oldCount: savedPack.oldCount,
        newCount: savedPack.newCount,
        closed: savedPack.oldCount - savedPack.newCount,
        mapping,
        unmapped: savedPack.packedGaps || [],
        frozenGaps: savedPack.frozenGaps || [],
        maxLocked: savedPack.maxLocked || 0,
      };
    }
    await onProgress("Resuming packed temp files from output/.rework/ (copy-to-temp already finished).");
    return applyCompactedFiles(savedPack.keepers, savedPack.oldCount, savedPack.newCount, tmpDir, onProgress, {
      maxLocked: savedPack.maxLocked || 0,
      frozenGaps: savedPack.frozenGaps || [],
    });
  }

  const sequence = await loadSequence();
  const oldCount = sequence.count;
  const keepers = [];
  const frozenGaps = [];
  const packedGaps = [];
  for (let n = 1; n <= oldCount; n++) {
    throwIfAborted("Rework packing");
    if (n === 1 || n === oldCount || n % 50 === 0) {
      await setJobProgress("reworkcount", n, `Finding images to keep ${n}/${oldCount}`);
      await onProgress(`Finding images to keep ${n}/${oldCount}`);
    }
    const frozen = n <= maxLocked;
    const gap = await isReplaceMeNumber(sequence, n);
    if (frozen) {
      keepers.push(n);
      if (gap) frozenGaps.push(n);
      continue;
    }
    if (gap) {
      packedGaps.push(n);
      continue;
    }
    keepers.push(n);
  }

  const newCount = keepers.length;
  const mapping = new Map(keepers.map((oldN, index) => [oldN, index + 1]));
  const unmapped = packedGaps;
  if (newCount === 0) {
    throw new Error("Nothing left to keep. Fill or replace before running /reworkcount.");
  }
  if (newCount === oldCount) {
    return {
      oldCount,
      newCount,
      closed: 0,
      mapping,
      unmapped,
      frozenGaps,
      maxLocked,
    };
  }

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
  await ensurePlaceholderFile();

  for (let i = 0; i < keepers.length; i++) {
    throwIfAborted("Rework packing");
    const newN = i + 1;
    const dest = path.join(tmpDir, `${newN}.jpg`);
    let packed = false;
    try {
      const src = await ensureImagePathFor(keepers[i]);
      await copyFile(src, dest);
      packed = true;
    } catch {
      // fall through to PLACEHOLDER
    }
    if (!packed) {
      await copyFile(placeholderPath(), dest);
    }
    if (newN % 25 === 0 || newN === newCount) {
      await setJobProgress("reworkcount", newN, `Packing kept images ${newN}/${newCount}`);
      await onProgress(`Packing kept images ${newN}/${newCount}`);
    }
  }
  if (!tmpPackComplete(tmpDir, newCount)) {
    throw new Error("Pack to temp failed — Discord was not wiped. Re-run /reworkcount.");
  }

  await persistJsonFsync(REWORK_PACK_FILE, {
    oldCount,
    newCount,
    keepers,
    maxLocked,
    frozenGaps,
    packedGaps,
  });
  return applyCompactedFiles(keepers, oldCount, newCount, tmpDir, onProgress, { maxLocked, frozenGaps });
}

const REWORK_MAP_FILE = path.join(OUTPUT_DIR, ".rework-mapping.json");

export async function saveReworkMapping(result) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(REWORK_MAP_FILE, JSON.stringify({
    oldCount: result.oldCount,
    newCount: result.newCount,
    closed: result.closed,
    mapping: [...result.mapping],
    unmapped: result.unmapped || [],
  }));
}

export async function loadReworkMapping() {
  if (!existsSync(REWORK_MAP_FILE)) return null;
  try {
    const data = JSON.parse(await readFile(REWORK_MAP_FILE, "utf8"));
    return {
      oldCount: Number(data.oldCount) || 0,
      newCount: Number(data.newCount) || 0,
      closed: Number(data.closed) || 0,
      mapping: new Map(data.mapping || []),
      unmapped: data.unmapped || [],
    };
  } catch {
    return null;
  }
}

export async function clearReworkMapping() {
  if (existsSync(REWORK_MAP_FILE)) await unlink(REWORK_MAP_FILE);
}

export function hasNotApprovedReaction(message) {
  return Boolean(message?.reactions?.cache.some((reaction) => reaction.emoji?.name?.toLowerCase() === NOT_APPROVED_NAME));
}

let resolvedRework = {
  name: REWORK_NAME,
  id: REWORK_EMOJI_ID || null,
  animated: false,
};

export function getResolvedReworkEmoji() {
  return { ...resolvedRework };
}

export function isReworkEmoji(emoji) {
  if (!emoji) return false;
  const raw = emoji.name;
  const name = String(raw || "").toLowerCase();
  if (raw === REPEAT_EMOJI || name === "repeat" || name === REPEAT_NAME) return true;
  if (name === REWORK_NAME || name === "noted") return true;
  if (resolvedRework.id && emoji.id && String(emoji.id) === String(resolvedRework.id)) return true;
  if (REWORK_EMOJI_ID && emoji.id && String(emoji.id) === String(REWORK_EMOJI_ID)) return true;
  return false;
}

export function isRepeatEmoji(emoji) {
  return isReworkEmoji(emoji);
}

export function hasReworkReaction(message) {
  return Boolean(message?.reactions?.cache.some((reaction) => isReworkEmoji(reaction.emoji)));
}

export function hasRepeatReaction(message) {
  return hasReworkReaction(message);
}

export function reworkEmojiToReact() {
  if (resolvedRework.id) return resolvedRework.id;
  return REPEAT_EMOJI;
}

export async function addReworkReaction(message) {
  if (!message) return false;
  if (hasReworkReaction(message)) return true;
  const resolvable = reworkEmojiToReact();
  try {
    await message.react(resolvable);
    return true;
  } catch (error) {
    if (resolvable !== REPEAT_EMOJI) {
      try {
        await message.react(REPEAT_EMOJI);
        console.warn(`Could not add :${REWORK_NAME}:, fell back to 🔁 on ${message.id}`);
        return true;
      } catch {
        // fall through
      }
    }
    console.error(`Could not add rework emoji on ${message.id}:`, error.message || error);
    return false;
  }
}

const REWORK_FORWARD_GAP_MS = 400;

let reworkLock = Promise.resolve();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withReworkLock(work) {
  const run = reworkLock.then(work, work);
  reworkLock = run.then(() => {}, () => {});
  return run;
}

export function isReworkSourceChannelId(channelId) {
  return channelId === REVIEW_THREAD_ID || channelId === RECONSIDER_THREAD_ID;
}

export function snatchBlockedThreadIds() {
  return new Set([REVIEW_THREAD_ID, RECONSIDER_THREAD_ID, REWORK_THREAD_ID]);
}

async function loadReworkThreadIndex() {
  const data = await loadJson(REWORK_THREAD_INDEX_FILE);
  const byHash = {};
  if (data?.byHash && typeof data.byHash === "object") {
    for (const [hash, entry] of Object.entries(data.byHash)) {
      if (!hash || !entry?.messageId) continue;
      byHash[hash] = {
        messageId: String(entry.messageId),
        n: Number.isInteger(entry.n) ? entry.n : Number.isInteger(entry.number) ? entry.number : null,
      };
    }
  }
  return {
    at: data?.at || null,
    threadId: data?.threadId || REWORK_THREAD_ID,
    byHash,
  };
}

async function saveReworkThreadIndex(index) {
  await persistJsonFsync(REWORK_THREAD_INDEX_FILE, {
    at: new Date().toISOString(),
    threadId: REWORK_THREAD_ID,
    byHash: index?.byHash || {},
  });
}

async function imageBytesFromMessage(message) {
  const url = firstImageUrl(message);
  if (!url) return null;
  try {
    const buffer = await fetchBuffer(url);
    return { buffer, hash: sha256(buffer) };
  } catch (error) {
    console.error(`Could not read image on ${message.id}:`, error.message || error);
    return null;
  }
}

async function destMessageExists(thread, messageId) {
  if (!messageId) return false;
  try {
    const message = await thread.messages.fetch(String(messageId));
    return Boolean(firstImageUrl(message));
  } catch {
    return false;
  }
}

export async function reconcileReworkThreadIndex(thread, { collapseExtras = false } = {}) {
  const previous = await loadReworkThreadIndex();
  const messages = await fetchAllMessages(thread);
  const byHash = {};
  const extras = [];
  const placeholderHash = await getPlaceholderHash();

  for (const message of sortOldestFirst(messages)) {
    throwIfAborted("Rework reconcile");
    if (isStatusEmbedMessage(message)) continue;
    const packed = await imageBytesFromMessage(message);
    if (!packed?.hash || packed.hash === placeholderHash) continue;
    if (byHash[packed.hash]) {
      extras.push(message);
      continue;
    }
    byHash[packed.hash] = {
      messageId: message.id,
      n: numberFromMessage(message),
    };
  }

  const liveMessageIds = new Set(Object.values(byHash).map((entry) => entry.messageId));
  for (const [hash, entry] of Object.entries(previous.byHash || {})) {
    if (!hash || !entry?.messageId || !liveMessageIds.has(String(entry.messageId))) continue;
    if (byHash[hash]) continue;
    byHash[hash] = {
      messageId: String(entry.messageId),
      n: Number.isInteger(entry.n) ? entry.n : null,
    };
  }

  let collapsed = 0;
  if (collapseExtras) {
    for (const extra of extras) {
      throwIfAborted("Rework reconcile");
      try {
        await extra.delete();
        collapsed += 1;
      } catch (error) {
        console.error(`Could not collapse extra Rework post ${extra.id}:`, error.message || error);
      }
    }
  }

  const index = { at: new Date().toISOString(), threadId: thread.id, byHash };
  await saveReworkThreadIndex(index);
  return { index, extras: extras.length, collapsed };
}

async function rememberReworkPost(index, hash, posted, n) {
  const entry = { messageId: posted.id, n };
  index.byHash[hash] = entry;
  const packed = await imageBytesFromMessage(posted);
  if (packed?.hash && packed.hash !== hash) index.byHash[packed.hash] = entry;
}

async function recaptionReworkPost(thread, existing, n, index) {
  if (!Number.isInteger(n) || !existing?.messageId || existing.n === n) return false;
  try {
    const message = await thread.messages.fetch(String(existing.messageId));
    if (String(message.content || "").trim() !== String(n)) {
      await message.edit({ content: String(n) });
    }
    for (const entry of Object.values(index.byHash)) {
      if (String(entry.messageId) === String(existing.messageId)) entry.n = n;
    }
    await saveReworkThreadIndex(index);
    await delay(REWORK_FORWARD_GAP_MS);
    return true;
  } catch (error) {
    console.error(`Could not recaption Rework post ${existing.messageId} to ${n}:`, error.message || error);
    return false;
  }
}

async function forwardHashToRework(thread, { hash, buffer, n, index, verify = true }) {
  const existing = index.byHash[hash];
  if (existing && (!verify || await destMessageExists(thread, existing.messageId))) {
    if (await recaptionReworkPost(thread, existing, n, index)) return "recaptioned";
    return "already";
  }
  if (existing) delete index.byHash[hash];

  const posted = await thread.send({
    content: String(n),
    files: [new AttachmentBuilder(buffer, { name: `${n}.jpg` })],
  });
  await addReworkReaction(posted);
  await rememberReworkPost(index, hash, posted, n);
  await saveReworkThreadIndex(index);
  await delay(REWORK_FORWARD_GAP_MS);
  return "forwarded";
}

export async function forwardMarkedSourceToRework(client, message, { assumeMarked = false } = {}) {
  const n = numberFromMessage(message);
  if (!Number.isInteger(n)) return "skipped";
  if (isStatusEmbedMessage(message)) return "skipped";
  if (isLockedNumber(n, await loadLockin())) return "locked";
  if (!assumeMarked && !hasReworkReaction(message)) return "skipped";

  const packed = await imageBytesFromMessage(message);
  if (!packed?.hash) return "skipped";
  const placeholderHash = await getPlaceholderHash();
  if (packed.hash === placeholderHash) return "skipped";

  const thread = await ensureThread(client, REWORK_THREAD_ID);
  const index = await loadReworkThreadIndex();
  return forwardHashToRework(thread, { hash: packed.hash, buffer: packed.buffer, n, index });
}

export async function handleReworkReactionAdd(client, reaction) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (!isReworkEmoji(reaction.emoji)) return;
    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!isReworkSourceChannelId(message.channelId)) return;
    if (isStatusEmbedMessage(message)) return;
    await withReworkLock(() => forwardMarkedSourceToRework(client, message, { assumeMarked: true }));
  } catch (error) {
    console.error("Rework reaction forward failed:", error.message || error);
  }
}

export async function syncReworkThread(client, { prune = false, onProgress = async () => {} } = {}) {
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
  const dest = await ensureThread(client, REWORK_THREAD_ID);
  const placeholderHash = await getPlaceholderHash();
  const stats = {
    scanned: 0,
    marked: 0,
    already: 0,
    forwarded: 0,
    recaptioned: 0,
    skipped: 0,
    locked: 0,
    extras: 0,
    collapsed: 0,
    pruned: 0,
  };

  return withReworkLock(async () => {
    await onProgress("Reconciling Rework thread index…");
    const reconciled = await reconcileReworkThreadIndex(dest, { collapseExtras: true });
    let index = reconciled.index;
    stats.extras = reconciled.extras;
    stats.collapsed = reconciled.collapsed;

    const markedByHash = new Map();
    const lockin = await loadLockin();
    const sources = [
      { thread: review, label: "Edit per number" },
      { thread: reconsider, label: "Reconsider" },
    ];

    for (const source of sources) {
      const entries = numberedEntries(await fetchAllMessages(source.thread), client.user.id);
      for (let i = 0; i < entries.length; i++) {
        throwIfAborted("Rework sync");
        const { message, n } = entries[i];
        stats.scanned += 1;
        if (i === 0 || i + 1 === entries.length || (i + 1) % 25 === 0) {
          await onProgress(`Scanning ${source.label} ${i + 1}/${entries.length}`);
        }
        if (!hasReworkReaction(message)) continue;
        if (isLockedNumber(n, lockin)) {
          stats.locked += 1;
          continue;
        }
        stats.marked += 1;
        const packed = await imageBytesFromMessage(message);
        if (!packed?.hash || packed.hash === placeholderHash) {
          stats.skipped += 1;
          continue;
        }
        if (!markedByHash.has(packed.hash)) {
          markedByHash.set(packed.hash, { n, buffer: packed.buffer });
        }
      }
    }

    let done = 0;
    for (const [hash, item] of markedByHash) {
      throwIfAborted("Rework sync");
      done += 1;
      if (done === 1 || done === markedByHash.size || done % 10 === 0) {
        await onProgress(`Forwarding Rework ${done}/${markedByHash.size}`);
      }
      const result = await forwardHashToRework(dest, {
        hash,
        buffer: item.buffer,
        n: item.n,
        index,
        verify: false,
      });
      if (result === "already") stats.already += 1;
      else if (result === "forwarded") stats.forwarded += 1;
      else if (result === "recaptioned") stats.recaptioned += 1;
      else stats.skipped += 1;
    }

    if (prune) {
      await onProgress("Pruning Rework posts that are no longer marked…");
      const keepIds = new Set();
      for (const hash of markedByHash.keys()) {
        const entry = index.byHash[hash];
        if (entry?.messageId) keepIds.add(String(entry.messageId));
      }
      const deletedIds = new Set();
      for (const [hash, entry] of Object.entries(index.byHash)) {
        throwIfAborted("Rework sync");
        if (keepIds.has(String(entry.messageId))) continue;
        if (!deletedIds.has(entry.messageId)) {
          try {
            const message = await dest.messages.fetch(entry.messageId);
            await message.delete();
          } catch {
            // already gone
          }
          deletedIds.add(entry.messageId);
          stats.pruned += 1;
        }
        delete index.byHash[hash];
      }
      await saveReworkThreadIndex(index);
    }

    return stats;
  });
}

/** Delete Rework posts for the given lineup numbers and drop them from the hash index. */
export async function deleteReworkPostsForNumbers(client, numbers, onProgress = async () => {}) {
  const want = new Set([...numbers].filter((n) => Number.isInteger(n)));
  if (want.size === 0) return { deleted: 0, numbers: [] };
  const thread = await ensureThread(client, REWORK_THREAD_ID);
  return withReworkLock(async () => {
    const messages = await fetchAllMessages(thread);
    const deletedIds = new Set();
    const hitNumbers = new Set();
    for (const message of messages) {
      throwIfAborted("Rework NotApproved");
      if (isStatusEmbedMessage(message)) continue;
      const n = numberFromMessage(message);
      if (n == null || !want.has(n)) continue;
      try {
        await message.delete();
        deletedIds.add(message.id);
        hitNumbers.add(n);
      } catch (error) {
        console.error(`Could not delete Rework post ${message.id}:`, error.message || error);
      }
    }
    const index = await loadReworkThreadIndex();
    for (const [hash, entry] of Object.entries(index.byHash || {})) {
      if (deletedIds.has(String(entry?.messageId)) || want.has(entry?.n)) {
        delete index.byHash[hash];
      }
    }
    await saveReworkThreadIndex(index);
    await onProgress(`Removed ${deletedIds.size} Rework post(s)`);
    return { deleted: deletedIds.size, numbers: [...hitNumbers].sort((a, b) => a - b) };
  });
}

export async function resolveReworkEmoji(guild) {
  if (!guild) {
    console.warn(`WARNING: no guild available to resolve :${REWORK_NAME}:. Falling back to 🔁.`);
    resolvedRework = { name: REWORK_NAME, id: null, animated: false };
    return null;
  }
  let cache = guild.emojis?.cache;
  try {
    cache = await guild.emojis.fetch();
  } catch (error) {
    console.warn("Could not fetch guild emojis:", error.message || error);
  }
  let found = REWORK_EMOJI_ID ? cache.get(REWORK_EMOJI_ID) : null;
  if (!found) {
    found = cache.find((emoji) => String(emoji.name || "").toLowerCase() === REWORK_NAME);
  }
  if (found) {
    resolvedRework = { name: found.name, id: found.id, animated: Boolean(found.animated) };
    console.log(`Rework emoji: :${found.name}: (${found.id})${found.animated ? " animated" : ""}`);
    return found;
  }
  console.warn(
    `WARNING: this server has no :${REWORK_NAME}: custom emoji. Rework marks the bot adds will be 🔁 until you add :${REWORK_NAME}: or set REWORK_EMOJI / REWORK_EMOJI_ID.`,
  );
  resolvedRework = { name: REWORK_NAME, id: null, animated: false };
  return null;
}

export function isApprovedEmoji(emoji) {
  const name = emoji?.name?.toLowerCase();
  if (!name) return false;
  return name === APPROVED_NAME || name === "✅" || name === "white_check_mark" || name === "check";
}

export function hasApprovedReaction(message) {
  return Boolean(message?.reactions?.cache.some((reaction) => isApprovedEmoji(reaction.emoji)));
}

export function needsReworkReaction(message) {
  return hasNotApprovedReaction(message) || hasReworkReaction(message);
}

/**
 * Queue retention for a Reconsider post. Rework (:noted: / legacy 🔁) always wins (keep, never gap).
 * Unknown emojis count as blank (keep). Only :NotApproved: without rework is rejected.
 */
export function reconsiderRetention(message) {
  if (!message) return "blank";
  if (hasReworkReaction(message)) return "repeat";
  if (hasApprovedReaction(message)) return "approved";
  if (hasNotApprovedReaction(message)) return "rejected";
  return "blank";
}

function reactionKey(emoji) {
  if (!emoji) return "";
  if (isReworkEmoji(emoji)) return REWORK_KEY;
  return emoji.id || String(emoji.name || "").toLowerCase();
}

export function snapshotStatusReactions(message) {
  if (!message) return [];
  const snapshots = [];
  const seen = new Set();
  for (const reaction of message.reactions.cache.values()) {
    const emoji = reaction.emoji;
    const name = emoji?.name?.toLowerCase() || "";
    const status = (
      name === NOT_APPROVED_NAME
      || name === APPROVED_NAME
      || name === "✅"
      || name === "white_check_mark"
      || isRepeatEmoji(emoji)
    );
    if (!status) continue;
    const key = reactionKey(emoji);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    snapshots.push({
      id: isReworkEmoji(emoji) ? (emoji.id || resolvedRework.id || null) : (emoji.id || null),
      name: isReworkEmoji(emoji) ? (resolvedRework.name || REWORK_NAME) : emoji.name,
    });
  }
  return snapshots;
}

export function mergeReactionSnapshots(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const snap of list || []) {
      const key = isReworkEmoji(snap) ? REWORK_KEY : (snap.id || String(snap.name || "").toLowerCase());
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(snap);
    }
  }
  return merged;
}

export function withRepeatSnapshot(snapshots) {
  return mergeReactionSnapshots(snapshots, [{
    id: resolvedRework.id || null,
    name: resolvedRework.name || REWORK_NAME,
  }]);
}

export async function applyReactionSnapshots(message, snapshots) {
  if (!message || !snapshots?.length) return;
  const have = new Set(
    [...message.reactions.cache.values()].map((reaction) => reactionKey(reaction.emoji)),
  );
  for (const snap of snapshots) {
    const key = isReworkEmoji(snap) ? REWORK_KEY : (snap.id || String(snap.name || "").toLowerCase());
    if (!key || have.has(key)) continue;
    const resolvable = isReworkEmoji(snap) ? reworkEmojiToReact() : (snap.id || snap.name);
    try {
      await message.react(resolvable);
      have.add(key);
    } catch (error) {
      if (isReworkEmoji(snap) && resolvable !== REPEAT_EMOJI) {
        try {
          await message.react(REPEAT_EMOJI);
          have.add(REWORK_KEY);
          continue;
        } catch {
          // fall through
        }
      }
      console.error(`Could not add ${snap.name} on ${message.id}:`, error.message || error);
    }
  }
}

export async function hashMessageImage(message) {
  const url = firstImageUrl(message);
  if (!url) return null;
  try {
    return sha256(await fetchBuffer(url));
  } catch (error) {
    console.error(`Could not hash image on ${message.id}:`, error.message || error);
    return null;
  }
}

function reactionSnapPayload(reactions) {
  return (reactions || []).map((snap) => ({
    id: snap.id || null,
    name: snap.name || null,
  }));
}

function addSnapsForHash(byHash, hash, reactions) {
  if (!hash || !reactions?.length) return;
  byHash[hash] = mergeReactionSnapshots(byHash[hash] || [], reactions);
}

export async function mergeReactionDb(byHash, { rotate = false, extra = {} } = {}) {
  const existing = (await loadJson(REACTION_DB_FILE)) || {};
  const merged = { ...(existing.byHash || {}) };
  for (const [hash, snaps] of Object.entries(byHash || {})) {
    if (!hash) continue;
    merged[hash] = reactionSnapPayload(mergeReactionSnapshots(merged[hash], snaps));
  }
  const payload = {
    ...existing,
    ...extra,
    at: new Date().toISOString(),
    hashedWithReactions: Object.keys(merged).length,
    byHash: merged,
  };
  if (rotate) await rotateIfExists(REACTION_DB_FILE, REACTION_DB_PREV_FILE);
  await persistJsonFsync(REACTION_DB_FILE, payload);
  return payload;
}

export async function loadCombinedReactionMap() {
  const db = (await loadJson(REACTION_DB_FILE))?.byHash || {};
  const snap = (await loadJson(REACTION_SNAP_FILE))?.byHash || {};
  const combined = { ...db };
  for (const [hash, snaps] of Object.entries(snap)) {
    combined[hash] = mergeReactionSnapshots(combined[hash], snaps);
  }
  return combined;
}

export function assertReactionDumpSafe(payload, { forWipe = false } = {}) {
  if (!payload) throw new Error("Reaction dump failed: no payload. Aborting — no compact, no wipe.");
  const dest = payload.writtenPath || REACTION_SNAP_FILE;
  if (!existsSync(dest)) {
    throw new Error("Reaction dump failed: snapshot file missing on disk. Aborting — no compact, no wipe.");
  }
  const hashed = Number(payload.hashedWithReactions) || 0;
  const reacted = Number(payload.postsWithReactions) || 0;
  if (reacted > 0 && hashed === 0) {
    throw new Error("Reaction dump failed: hashedWithReactions is 0 but Discord posts have reactions. Aborting — no compact, no wipe.");
  }
  const unlockedCount = Number.isInteger(payload.unlockedCount)
    ? payload.unlockedCount
    : Number(payload.count) || 0;
  if (forWipe && (payload.reviewPosts || 0) === 0 && unlockedCount > 0) {
    throw new Error("Reaction dump is empty (no Edit per number posts). Aborting — no compact, no wipe.");
  }
  return payload;
}

function assertFreshSnapshotOnDisk(expectedAt) {
  if (!existsSync(REACTION_SNAP_FILE)) {
    throw new Error("Refuse wipe: no reaction-snapshot-by-hash.json on disk.");
  }
  let data;
  try {
    data = JSON.parse(readFileSync(REACTION_SNAP_FILE, "utf8"));
  } catch {
    throw new Error("Refuse wipe: reaction snapshot file is unreadable.");
  }
  if (expectedAt && data.at !== expectedAt) {
    throw new Error("Refuse wipe: snapshot file is not from this run.");
  }
  const hashed = Number(data.hashedWithReactions) || 0;
  const reacted = Number(data.postsWithReactions) || 0;
  if (reacted > 0 && hashed === 0) {
    throw new Error("Refuse wipe: snapshot has 0 hashed reactions but Discord had reactions.");
  }
  return data;
}

export function summarizeReactionDump(payload) {
  const review = payload?.review || [];
  const reconsider = payload?.reconsider || [];
  const emoji = { check: 0, notApproved: 0, repeat: 0 };
  let reviewNoStatus = 0;
  let reviewHashFailures = 0;
  const unhashedNumbers = [];
  for (const row of review) {
    const names = (row.reactions || []).map((snap) => String(snap.name || "").toLowerCase());
    const hasRepeat = names.some((name) => (
      name === REPEAT_EMOJI
      || name === "repeat"
      || name === REPEAT_NAME
      || name === REWORK_NAME
      || name === "noted"
    ));
    const hasCheck = names.some((name) => name === APPROVED_NAME || name === "✅" || name === "white_check_mark" || name === "check");
    const hasNA = names.some((name) => name === NOT_APPROVED_NAME);
    if (hasCheck) emoji.check += 1;
    if (hasNA) emoji.notApproved += 1;
    if (hasRepeat) emoji.repeat += 1;
    if (!hasCheck && !hasNA && !hasRepeat) reviewNoStatus += 1;
    if (!row.discordHash) {
      reviewHashFailures += 1;
      if (Number.isInteger(row.n) && unhashedNumbers.length < 40) unhashedNumbers.push(row.n);
    }
  }
  let reconsiderHashFailures = 0;
  let reconsiderNoStatus = 0;
  for (const row of reconsider) {
    if (!row.discordHash) reconsiderHashFailures += 1;
    if (!(row.reactions || []).length) reconsiderNoStatus += 1;
  }
  return {
    reviewPosts: review.length,
    reconsiderPosts: reconsider.length,
    postsWithReactions: Number(payload?.postsWithReactions) || 0,
    hashedWithReactions: Number(payload?.hashedWithReactions) || Object.keys(payload?.byHash || {}).length,
    emoji,
    reviewNoStatus,
    reviewHashFailures,
    reconsiderHashFailures,
    reconsiderNoStatus,
    unhashedNumbers,
    count: Number(payload?.count) || 0,
  };
}

/** Grow/update local sequence metadata from unlocked Edit per number rows only. Locked slots stay Final-only. */
export async function syncSequenceFromEditSnapshot(rows, lockin = null) {
  const sequence = await loadSequence();
  const unlockedRows = (rows || []).filter(
    (row) => Number.isInteger(row.n) && row.n >= 1 && !isLockedNumber(row.n, lockin),
  );
  const numbers = unlockedRows.map((row) => row.n);
  let maxN = numbers.length ? Math.max(...numbers) : 0;
  // Keep high-water count so numbering continues past locked ranges, but do not treat locked slots as editable.
  const lockMax = maxLockedNumber(lockin);
  if (lockMax > maxN) maxN = lockMax;
  if (maxN < 1) return sequence;

  ensureSequenceNumber(sequence, maxN);
  for (let i = 0; i < sequence.items.length; i++) {
    const n = i + 1;
    const item = sequence.items[i];
    if (!item) continue;
    if (isLockedNumber(n, lockin)) {
      item.locked = true;
      // Locked = Final only; drop Edit per number message linkage from sequence inventory.
      delete item.messageId;
      continue;
    }
    item.locked = false;
  }
  for (const row of unlockedRows) {
    const item = sequence.items[row.n - 1];
    if (!item) continue;
    item.locked = false;
    if (row.discordHash || row.imageHash) item.sha256 = row.discordHash || row.imageHash;
    if (row.source) item.source = row.source;
    if (row.attachmentId) item.attachmentId = String(row.attachmentId);
    if (row.messageId) item.messageId = String(row.messageId);
  }
  await saveSequence(sequence);
  return sequence;
}

export async function dumpLineupReactionsByHash(client, onProgress = async () => {}, options = {}) {
  const sequence = await loadSequence();
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const dest = options.filePath || REACTION_SNAP_FILE;
  const rotate = options.rotate !== false && dest === REACTION_SNAP_FILE;
  const jobName = options.jobName || getJobProgress()?.command || "snapshot-reactions";
  await setJobProgress(jobName, 1, "snapshot reactions");
  await onProgress("Snapshotting unlocked Edit per number posts (number, image hash, reactions)…");
  const reviewEntries = numberedEntries(await fetchAllMessages(review), client.user.id);
  const lockin = await loadLockin();

  const rows = [];
  const byHash = {};
  const byNumber = {};
  let postsWithReactions = 0;
  let lockedPresent = 0;
  for (let i = 0; i < reviewEntries.length; i++) {
    throwIfAborted("Reaction snapshot");
    const { message, n } = reviewEntries[i];
    // Locked numbers are Final-only — ignored by the editable sequence (leftovers are counted, not inventoried).
    if (isLockedNumber(n, lockin)) {
      lockedPresent += 1;
      continue;
    }
    const reactions = snapshotStatusReactions(message);
    if (reactions.length) postsWithReactions += 1;
    const imageUrl = firstImageUrl(message);
    const discordHash = await hashMessageImage(message);
    const localPath = Number.isInteger(n) ? (existsSync(cachePathFor(n)) ? cachePathFor(n) : filePathFor(n)) : null;
    const localHash = localPath && existsSync(localPath) ? await fileSha256(localPath) : null;
    const hashMatch = Boolean(discordHash && localHash && discordHash === localHash);
    const attachmentId = parseAttachmentId(imageUrl);
    const row = {
      n,
      imageHash: discordHash,
      discordHash,
      attachmentId,
      messageId: message?.id || null,
      source: imageUrl || null,
      localHash,
      hashMatch,
      locked: false,
      reactions: reactionSnapPayload(reactions),
    };
    rows.push(row);
    if (Number.isInteger(n)) byNumber[String(n)] = row;
    addSnapsForHash(byHash, discordHash, reactions);
    if (hashMatch) addSnapsForHash(byHash, localHash, reactions);
    if (i === 0 || i + 1 === reviewEntries.length || (i + 1) % 25 === 0) {
      await setJobProgress(jobName, i + 1, `snapshot lineup ${i + 1}/${reviewEntries.length}`);
      await onProgress(`Hashed lineup attachment ${i + 1}/${reviewEntries.length}`);
    }
  }

  let reconsiderRows = [];
  if (!options.skipReconsider) {
    await onProgress("Snapshotting Reconsider reactions by attachment hash…");
    const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
    const reconsiderMessages = await fetchAllMessages(reconsider);
    for (let i = 0; i < reconsiderMessages.length; i++) {
      throwIfAborted("Reaction snapshot");
      const message = reconsiderMessages[i];
      if (!firstImageUrl(message)) continue;
      const n = numberFromMessage(message);
      // Locked numbers stay out of sequence inventory (reconsider-replace only).
      if (isLockedNumber(n, lockin)) continue;
      const reactions = snapshotStatusReactions(message);
      if (reactions.length) postsWithReactions += 1;
      const imageUrl = firstImageUrl(message);
      const discordHash = await hashMessageImage(message);
      const localPath = Number.isInteger(n)
        ? (existsSync(cachePathFor(n)) ? cachePathFor(n) : filePathFor(n))
        : null;
      const localHash = localPath && existsSync(localPath) ? await fileSha256(localPath) : null;
      const hashMatch = Boolean(discordHash && localHash && discordHash === localHash);
      reconsiderRows.push({
        n,
        imageHash: discordHash,
        discordHash,
        attachmentId: parseAttachmentId(imageUrl),
        messageId: message.id,
        source: imageUrl || null,
        localHash,
        hashMatch,
        locked: false,
        reactions: reactionSnapPayload(reactions),
      });
      addSnapsForHash(byHash, discordHash, reactions);
      if (hashMatch) addSnapsForHash(byHash, localHash, reactions);
      if (i === 0 || i + 1 === reconsiderMessages.length || (i + 1) % 25 === 0) {
        await setJobProgress(jobName, i + 1, `snapshot reconsider ${i + 1}/${reconsiderMessages.length}`);
        await onProgress(`Hashed Reconsider ${i + 1}/${reconsiderMessages.length}`);
      }
    }
  }

  let lockedSkipped = 0;
  for (const range of lockin?.ranges || []) {
    const from = Number(range?.from);
    const to = Number(range?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    for (let n = from; n <= to; n++) lockedSkipped += 1;
  }
  // Subtract leftovers still sitting in Edit per number from the "absent/Final-only" count.
  lockedSkipped = Math.max(0, lockedSkipped - lockedPresent);
  const unlockedCount = rows.length;
  const discordNumbers = rows.map((row) => row.n).filter((n) => Number.isInteger(n));
  const discordMax = discordNumbers.length ? Math.max(...discordNumbers) : 0;
  const lockinMax = maxLockedNumber(lockin);
  const count = Math.max(Number(sequence.count) || 0, discordMax, lockinMax);

  if (options.syncSequence !== false) {
    await onProgress(`Updating local sequence from unlocked Edit per number only (count → ${count}; locked ignored)…`);
    await syncSequenceFromEditSnapshot(rows, lockin);
  }

  const payload = {
    at: new Date().toISOString(),
    count,
    discordMax,
    discordPosts: rows.length,
    unlockedCount,
    lockedSkipped,
    lockedPresent,
    reviewPosts: rows.length,
    reviewNumbers: rows.filter((row) => row.messageId).length,
    reconsiderPosts: reconsiderRows.length,
    postsWithReactions,
    hashedWithReactions: Object.keys(byHash).length,
    byNumber,
    byHash: Object.fromEntries(
      Object.entries(byHash).map(([hash, snaps]) => [hash, reactionSnapPayload(snaps)]),
    ),
    review: rows,
    reconsider: reconsiderRows,
    writtenPath: dest,
  };
  payload.stats = summarizeReactionDump(payload);
  if (rotate) await rotateIfExists(dest, dest === REACTION_SNAP_FILE ? REACTION_SNAP_PREV_FILE : `${dest}.prev.json`);
  await persistJsonFsync(dest, payload);
  const onDisk = JSON.parse(await readFile(dest, "utf8"));
  if (!onDisk || typeof onDisk.byHash !== "object") {
    throw new Error("Reaction dump failed to persist JSON.");
  }
  payload.hashedWithReactions = Object.keys(onDisk.byHash || {}).length;
  payload.stats = summarizeReactionDump(payload);
  await onProgress(`Wrote ${dest} (${payload.discordPosts} unlocked posts, count ${payload.count}, ${payload.hashedWithReactions} hashes)`);
  return payload;
}

async function persistReactionHashMap(snapsByHash, extra = {}) {
  const asObj = {};
  for (const [hash, snaps] of snapsByHash.entries()) {
    asObj[hash] = reactionSnapPayload(snaps);
  }
  return mergeReactionDb(asObj, { rotate: false, extra });
}

export async function restoreLineupReactionsByHash(client, snapshot, onProgress = async () => {}) {
  const sequence = await loadSequence();
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const entries = numberedEntries(await fetchAllMessages(review), client.user.id);
  const byNumber = new Map();
  for (const entry of entries) {
    if (!byNumber.has(entry.n)) byNumber.set(entry.n, entry.message);
  }
  const combined = await loadCombinedReactionMap();
  for (const [hash, snaps] of Object.entries(snapshot?.byHash || {})) {
    combined[hash] = mergeReactionSnapshots(combined[hash], snaps);
  }
  let restored = 0;
  let skipped = 0;
  const lockin = await loadLockin();
  for (let n = 1; n <= sequence.count; n++) {
    throwIfAborted("Reaction restore");
    if (isLockedNumber(n, lockin)) {
      skipped += 1;
      continue;
    }
    const message = byNumber.get(n);
    let localPath = null;
    try {
      localPath = await ensureImagePathFor(n);
    } catch {
      localPath = null;
    }
    if (!message || !localPath) {
      skipped += 1;
      continue;
    }
    const hash = await fileSha256(localPath);
    const snaps = combined[hash] || [];
    if (!snaps.length) continue;
    const before = snapshotStatusReactions(message).length;
    await applyReactionSnapshots(message, snaps);
    const after = snapshotStatusReactions(message).length;
    if (after > before) restored += 1;
    if (n === 1 || n === sequence.count || n % 50 === 0) {
      await onProgress(`Restored reactions ${n}/${sequence.count}`);
    }
  }
  return { restored, skipped, present: entries.length, count: sequence.count };
}

export async function rebuildReconsiderThread(client, onProgress = async () => {}, options = {}) {
  const sequence = await loadSequence();
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);

  const reworkHashes = new Set();
  const repeatHashes = new Set();
  const rejectedHashes = new Set();
  const lineupHashes = new Set();
  /** @type {Map<string, { n: number, url?: string|null, path?: string|null, repeat: boolean }>} */
  const sourceByHash = new Map();
  const snapsByHash = new Map();
  const placeholderHash = await getPlaceholderHash();

  const rememberSource = (hash, entry) => {
    if (!hash || hash === placeholderHash) return;
    const prev = sourceByHash.get(hash);
    // Prefer Edit per number (lineup) number/url when both exist.
    if (!prev || (entry.fromLineup && !prev.fromLineup) || (entry.n != null && (prev.n == null || entry.n < prev.n))) {
      sourceByHash.set(hash, entry);
    }
  };
  const addReworkHash = (hash, { repeat = false } = {}) => {
    if (!hash || hash === placeholderHash) return;
    reworkHashes.add(hash);
    if (repeat) repeatHashes.add(hash);
  };
  const addRejectedHash = (hash) => {
    if (!hash || hash === placeholderHash) return;
    rejectedHashes.add(hash);
  };

  await onProgress("Keeping :noted: / untriaged Reconsider posts, then adding Edit per number :NotApproved: / :noted:…");
  const lockin = await loadLockin();
  const reconsiderEntries = numberedEntries(await fetchAllMessages(reconsider), client.user.id);
  for (let i = 0; i < reconsiderEntries.length; i++) {
    const { message, n } = reconsiderEntries[i];
    throwIfAborted("Reconsider rebuild");
    if (isLockedNumber(n, lockin)) continue;
    const retention = reconsiderRetention(message);
    const discordHash = await hashMessageImage(message);
    const imageUrl = firstImageUrl(message);
    const localPath = existingImagePath(n);
    const localHash = localPath ? await fileSha256(localPath) : null;
    if (retention === "rejected") {
      addRejectedHash(discordHash);
      addRejectedHash(localHash);
    } else if (retention !== "approved") {
      const repeat = retention === "repeat";
      addReworkHash(discordHash, { repeat });
      addReworkHash(localHash, { repeat });
      rememberSource(discordHash, { n, url: imageUrl, path: localPath, repeat, fromLineup: false });
      if (localHash) rememberSource(localHash, { n, url: imageUrl, path: localPath, repeat, fromLineup: false });
    }
    if (i === 0 || i + 1 === reconsiderEntries.length || (i + 1) % 25 === 0) {
      await onProgress(`Checked Reconsider queue ${i + 1}/${reconsiderEntries.length}`);
    }
  }

  const reviewEntries = numberedEntries(await fetchAllMessages(review), client.user.id);
  let lineupMarked = 0;
  for (let i = 0; i < reviewEntries.length; i++) {
    const { message, n } = reviewEntries[i];
    throwIfAborted("Reconsider rebuild");
    if (isLockedNumber(n, lockin)) continue;
    if (needsReworkReaction(message)) {
      lineupMarked += 1;
      const imageUrl = firstImageUrl(message);
      const discordHash = await hashMessageImage(message);
      const localPath = existingImagePath(n);
      const localHash = localPath ? await fileSha256(localPath) : null;
      const repeat = hasReworkReaction(message);
      if (discordHash) {
        lineupHashes.add(discordHash);
        snapsByHash.set(discordHash, mergeReactionSnapshots(snapsByHash.get(discordHash) || [], snapshotStatusReactions(message)));
      }
      if (localHash) lineupHashes.add(localHash);
      addReworkHash(discordHash, { repeat });
      addReworkHash(localHash, { repeat });
      rememberSource(discordHash, {
        n,
        url: imageUrl,
        path: localPath,
        repeat,
        fromLineup: true,
      });
      if (localHash) {
        rememberSource(localHash, {
          n,
          url: imageUrl,
          path: localPath,
          repeat,
          fromLineup: true,
        });
      }
    }
    if (i === 0 || i + 1 === reviewEntries.length || (i + 1) % 25 === 0) {
      await onProgress(`Checked lineup ${i + 1}/${reviewEntries.length}`);
    }
  }

  // Drop Reconsider-only :NotApproved: hashes, but keep anything still marked on Edit per number.
  for (const hash of rejectedHashes) {
    if (repeatHashes.has(hash) || lineupHashes.has(hash)) continue;
    reworkHashes.delete(hash);
    sourceByHash.delete(hash);
  }

  // Fill any rework hash that only exists as a cache/local/Drive file (no Discord source remembered).
  for (let n = 1; n <= sequence.count; n++) {
    if (isLockedNumber(n, lockin)) continue;
    let localPath = existingImagePath(n);
    if (!localPath) {
      try {
        localPath = await ensureImagePathFor(n);
      } catch {
        continue;
      }
    }
    const hash = await fileSha256(localPath);
    if (!reworkHashes.has(hash) || hash === placeholderHash) continue;
    rememberSource(hash, { n, url: null, path: localPath, repeat: repeatHashes.has(hash), fromLineup: false });
  }

  await persistReactionHashMap(snapsByHash, { source: "reconsider-rebuild-lineup" });
  await onProgress(
    `Rebuilding Reconsider from ${reworkHashes.size} unique image(s) (${lineupMarked} Edit per number :NotApproved:/:noted:)…`,
  );
  await deleteAllMessages(reconsider, { skipIds: statusSkipIds() });

  const posted = [];
  const seenHash = new Set();
  const jobs = [...reworkHashes]
    .map((hash) => ({ hash, source: sourceByHash.get(hash) }))
    .filter((job) => job.source && Number.isInteger(job.source.n))
    .sort((a, b) => a.source.n - b.source.n);

  for (const job of jobs) {
    throwIfAborted("Reconsider rebuild");
    const { hash, source } = job;
    if (seenHash.has(hash)) continue;
    if (isLockedNumber(source.n, lockin)) continue;

    let filePath = source.path && existsSync(source.path) ? source.path : null;
    if (!filePath) {
      try {
        filePath = await ensureImagePathFor(source.n);
      } catch {
        filePath = null;
      }
    }
    if (!filePath && source.url) {
      try {
        const buffer = await fetchBuffer(source.url);
        await mkdir(path.join(OUTPUT_DIR, ".drive-cache"), { recursive: true });
        await saveResized(buffer, cachePathFor(source.n));
        filePath = cachePathFor(source.n);
        try {
          const { upsertNumberImage, driveConfigured } = await driveApi();
          if (driveConfigured()) {
            await upsertNumberImage(source.n, filePath, { role: "reconsider" });
          }
        } catch (error) {
          console.error(`Drive reconsider cache ${source.n} failed:`, error.message || error);
        }
      } catch (error) {
        console.error(`Could not pull Edit per number ${source.n} for Reconsider:`, error.message || error);
        continue;
      }
    }
    if (!filePath || !existsSync(filePath)) continue;

    const postedHash = await fileSha256(filePath);
    if (postedHash === placeholderHash || seenHash.has(postedHash)) continue;
    seenHash.add(postedHash);
    seenHash.add(hash);

    const postedMessage = await reconsider.send({
      content: String(source.n),
      files: [new AttachmentBuilder(filePath, { name: `${source.n}.jpg` })],
    });
    if (source.repeat || repeatHashes.has(hash) || repeatHashes.has(postedHash)) {
      try {
        await addReworkReaction(postedMessage);
      } catch (error) {
        console.error(`Could not add :${REWORK_NAME}: on Reconsider ${source.n}:`, error.message || error);
      }
    }
    posted.push(source.n);
    await onProgress(`Posted unique ${posted.length}/${jobs.length} (${source.n}.jpg)`);
  }
  void options.addRepeat;

  const gapText = formatGapText(normalizeGaps(sequence), sequence.count, lockin);
  if (!options.skipEmptyGapList || normalizeGaps(sequence).length > 0) {
    for (const chunk of splitDiscordText(gapText)) {
      await reconsider.send(chunk);
    }
  }

  return { posted, gaps: normalizeGaps(sequence), count: sequence.count, lineupMarked };
}

export function localFileCount(sequence) {
  let present = 0;
  for (let n = 1; n <= sequence.count; n++) {
    if (existsSync(cachePathFor(n)) || existsSync(filePathFor(n))) present += 1;
  }
  return present;
}

export async function postNumberedImage(thread, n) {
  const filePath = await ensureImagePathFor(n);
  return thread.send({
    content: String(n),
    files: [new AttachmentBuilder(filePath, { name: `${n}.jpg` })],
  });
}

export async function tryEditNumberedImage(message, n) {
  const filePath = await ensureImagePathFor(n);

  const edited = await Promise.race([
    message.edit({
      content: String(n),
      files: [new AttachmentBuilder(filePath, { name: `${n}.jpg` })],
      attachments: [],
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Discord edit timed out")), 20_000);
    }),
  ]);

  const images = [...edited.attachments.values()].filter((file) => isImageAttachment(file));
  return images.length === 1;
}

export function inferMappingFromThread(entries, newCount) {
  const present = [...new Set(entries.map((entry) => entry.n))].sort((a, b) => a - b);
  const have = new Set(present);
  let nextNew = newCount + 1;
  for (let n = 1; n <= newCount; n++) {
    if (!have.has(n)) {
      nextNew = n;
      break;
    }
  }
  const mapping = new Map();
  for (const n of present) {
    if (n < nextNew && n <= newCount) mapping.set(n, n);
  }
  const remaining = present.filter((n) => n >= nextNew);
  for (let i = 0; i < remaining.length; i++) {
    const newN = nextNew + i;
    if (newN > newCount) break;
    mapping.set(remaining[i], newN);
  }
  return mapping;
}

export async function rebuildReviewThread(client, onProgress = async () => {}, options = {}) {
  if (options instanceof Map) options = { mapping: options };
  void options.mapping;

  const sequence = await loadSequence();
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const entries = numberedEntries(await fetchAllMessages(review), client.user.id);
  const present = new Map();
  for (const entry of entries) {
    if (!present.has(entry.n)) present.set(entry.n, entry.message);
  }
  const checkpoint = await loadReworkCheckpoint();
  const startOpt = Number.isInteger(options.start) && options.start >= 1 ? options.start : null;
  const lockin = await loadLockin();
  const lockedSkipIds = new Set();
  for (const entry of entries) {
    if (isLockedNumber(entry.n, lockin)) lockedSkipIds.add(String(entry.message.id));
  }
  const complete = sequenceMatchesThread(entries, sequence.count, lockin);
  const resuming = options.fillOnly === true
    || startOpt != null
    || checkpoint?.phase === "repost";
  const wipe = options.packed === true && !resuming && !complete;
  const combined = await loadCombinedReactionMap();
  const jobName = getJobProgress()?.command || "reworkcount";

  let from = 1;
  if (startOpt != null) from = startOpt;
  else if (checkpoint?.phase === "repost") from = (Number(checkpoint.lastPosted) || 0) + 1;

  if (wipe) {
    assertFreshSnapshotOnDisk(options.freshSnapshotAt);
    await onProgress(`Clearing unlocked Edit per number posts. Locked numbers are not reposted (they live in Final only).`);
    await deleteAllMessages(review, { skipIds: new Set([...statusSkipIds(), ...lockedSkipIds]) });
    for (const [n] of present) {
      if (!isLockedNumber(n, lockin)) present.delete(n);
    }
    from = 1;
    await saveReworkCheckpoint({
      phase: "repost",
      lastPosted: 0,
      count: sequence.count,
      snapshotPath: REACTION_SNAP_FILE,
      snapshotAt: options.freshSnapshotAt || null,
    });
  } else if (resuming || !complete) {
    await onProgress(
      startOpt != null
        ? `Resuming lineup fill from ${from}. Existing posts will not be wiped.`
        : "Filling missing Edit per number posts. Existing posts will not be wiped.",
    );
    await saveReworkCheckpoint({
      phase: "repost",
      lastPosted: Math.max(0, from - 1),
      count: sequence.count,
      snapshotPath: REACTION_SNAP_FILE,
      snapshotAt: checkpoint?.snapshotAt || options.freshSnapshotAt || null,
    });
  } else {
    await onProgress(`Edit per number already has every unlocked number. Locked numbers stay in Final only. Skipping wipe.`);
    await clearReworkCheckpoint();
    await clearReworkMapping();
    return { count: sequence.count, restored: 0, filled: 0, wiped: false, complete: true };
  }

  let restored = 0;
  let filled = 0;
  for (let n = from; n <= sequence.count; n++) {
    if (isLockedNumber(n, lockin)) continue;
    if (present.has(n)) continue;
    throwIfAborted("Repost lineup");
    await setJobProgress(jobName, n, `fill ${n}/${sequence.count}`);
    await saveReworkCheckpoint({
      phase: "repost",
      lastPosted: n - 1,
      count: sequence.count,
      snapshotPath: REACTION_SNAP_FILE,
      snapshotAt: options.freshSnapshotAt || checkpoint?.snapshotAt || null,
    });
    if (n === from || n === sequence.count || n % 10 === 0) {
      await onProgress(`Posting missing ${n}/${sequence.count}`);
    }
    let posted = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        posted = await postNumberedImage(review, n);
        break;
      } catch (error) {
        console.error(`Repost ${n} failed (try ${attempt}/3):`, error.message || error);
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    filled += 1;
    present.set(n, posted);
    let hash = null;
    try {
      hash = await fileSha256(await ensureImagePathFor(n));
    } catch {
      hash = null;
    }
    const snaps = (hash && combined[hash]) || [];
    if (posted && snaps.length) {
      await applyReactionSnapshots(posted, snaps);
      restored += 1;
    }
    const item = sequence.items[n - 1];
    if (item) item.dirty = false;
    await saveReworkCheckpoint({
      phase: "repost",
      lastPosted: n,
      count: sequence.count,
      snapshotPath: REACTION_SNAP_FILE,
      snapshotAt: options.freshSnapshotAt || checkpoint?.snapshotAt || null,
    });
  }

  await saveSequence(sequence);
  await clearReworkMapping();
  await clearReworkCheckpoint();
  return { count: sequence.count, restored, filled, wiped: wipe, complete: true };
}

export function numberedEntries(messages, botId) {
  return sortOldestFirst(messages)
    .filter((message) => !botId || message.author?.id === botId)
    .map((message) => ({ message, n: numberFromMessage(message) }))
    .filter((entry) => entry.n != null);
}

export function sequenceMatchesThread(entries, count, lockin = null) {
  const expected = [];
  for (let n = 1; n <= count; n++) {
    if (!isLockedNumber(n, lockin)) expected.push(n);
  }
  const live = (entries || []).filter((entry) => !isLockedNumber(entry.n, lockin));
  if (live.length !== expected.length) return false;
  const seen = new Set();
  for (let i = 0; i < live.length; i++) {
    const n = live[i].n;
    if (n !== expected[i] || seen.has(n)) return false;
    seen.add(n);
  }
  return true;
}

export async function deleteNumberedMessagesAndReplies(messages, numbers) {
  const want = new Set([...numbers].filter((n) => n != null));
  if (want.size === 0) return 0;

  const parentIds = new Set();
  for (const message of messages) {
    const n = numberFromMessage(message);
    if (n != null && want.has(n)) parentIds.add(message.id);
  }

  const toDelete = messages.filter((message) => {
    if (parentIds.has(message.id)) return true;
    return Boolean(message.reference?.messageId && parentIds.has(message.reference.messageId));
  });
  toDelete.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));

  let deleted = 0;
  for (const message of toDelete) {
    throwIfAborted("Delete posts");
    try {
      await message.delete();
      deleted += 1;
    } catch (error) {
      console.error(`Could not delete ${message.id}:`, error.message || error);
    }
  }
  return deleted;
}

export async function deleteAllMessages(channel, options = {}) {
  const skipIds = options.skipIds instanceof Set
    ? options.skipIds
    : new Set([...(options.skipIds || [])].map(String));
  let guard = 0;
  while (guard < 500) {
    guard += 1;
    const liveSkip = new Set([...skipIds, ...statusSkipIds()]);
    const batch = [...(await channel.messages.fetch({ limit: 100 })).values()]
      .filter((message) => !message.system && !liveSkip.has(String(message.id)) && !isStatusEmbedMessage(message));
    if (batch.length === 0) return;

    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = batch.filter((message) => message.createdTimestamp > cutoff);
    const old = batch.filter((message) => message.createdTimestamp <= cutoff);
    let deleted = 0;

    if (recent.length >= 2 && channel.bulkDelete) {
      const gone = new Set();
      try {
        const result = await channel.bulkDelete(recent, true);
        deleted += result.size;
        for (const id of result.keys()) gone.add(id);
      } catch (error) {
        console.error("bulkDelete failed:", error.message || error);
      }
      for (const leftover of recent.filter((message) => !gone.has(message.id))) {
        try {
          await leftover.delete();
          deleted += 1;
        } catch {
          // system, already gone, or missing permissions
        }
      }
    } else {
      for (const message of recent) {
        try {
          await message.delete();
          deleted += 1;
        } catch {
          // ignore undeletable
        }
      }
    }

    for (const message of old) {
      try {
        await message.delete();
        deleted += 1;
      } catch {
        // ignore undeletable
      }
    }

    if (deleted === 0) return;
  }

  throw new Error("Timed out clearing the thread.");
}
