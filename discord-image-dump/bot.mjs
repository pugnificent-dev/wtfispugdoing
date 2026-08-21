import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  ApplicationCommandType,
  ChannelType,
  Client,
  ContextMenuCommandBuilder,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import {
  CHANNEL_ID,
  APPROVED_NAME,
  NOT_APPROVED_NAME,
  RECONSIDER_THREAD_ID,
  REVIEW_THREAD_ID,
  REWORK_THREAD_ID,
  TOKEN,
  addLocalFileHashes,
  cachePathFor,
  collectImages,
  deleteAllMessages,
  dewmarkSequenceFile,
  ensureImagePathFor,
  ensureThread,
  fetchAllMessages,
  fetchSnatchSourceMessages,
  getSavedSnatchCursor,
  saveSnatchCursor,
  upsertSnatchCheckpointEmbed,
  fetchBuffer,
  filePathFor,
  fileSha256,
  firstImageUrl,
  formatGapText,
  getPlaceholderHash,
  isReplaceMeNumber,
  rebuildReconsiderThread,
  dumpLineupReactionsByHash,
  summarizeReactionDump,
  rebuildReviewThread,
  restoreLineupReactionsByHash,
  knownKeys,
  loadSequence,
  numberedEntries,
  numberFromMessage,
  parseAttachmentId,
  postNumberedImage,
  addGaps,
  applyPlaceholderToNumber,
  compactSequence,
  deleteLocalFilesAfter,
  ensurePlaceholderFile,
  hasRepeatReaction,
  hasReworkReaction,
  isReworkEmoji,
  addReworkReaction,
  resolveReworkEmoji,
  handleReworkReactionAdd,
  reconcileReworkThreadIndex,
  syncReworkThread,
  deleteReworkPostsForNumbers,
  snatchBlockedThreadIds,
  reconsiderRetention,
  snapshotStatusReactions,
  applyReactionSnapshots,
  loadReworkMapping,
  saveReworkMapping,
  clearReworkMapping,
  loadLockin,
  parseLockin,
  clearLockin,
  hasLockin,
  isLockedNumber,
  assertNumberTouchable,
  formatLockinRanges,
  deleteNumberedMessagesAndReplies,
  requestAbort,
  clearAbort,
  throwIfAborted,
  resumeHint,
  acquireBotLock,
  releaseBotLock,
  loadReworkCheckpoint,
  assertReactionDumpSafe,
  mergeReactionDb,
  sequenceMatchesThread,
  setJobProgress,
  clearJobProgress,
  getJobProgress,
  loadJobProgress,
  bindStatusClient,
  ensureStatusChannel,
  rememberStatusChannel,
  setJobRunning,
  publishJobStatus,
  scheduleStatusPublish,
  startStatusWatchdog,
  normalizeGaps,
  removeGap,
  ensureSequenceNumber,
  splitDiscordText,
  saveResized,
  saveSequence,
  sha256,
  sortOldestFirst,
  sourceAllowed,
  stripUrl,
  tryEditNumberedImage,
} from "./lib.mjs";
import {
  DRIVE_FOLDER_QUALITY,
  DRIVE_FOLDER_RECONSIDER,
  deleteDriveNumbers,
  driveConfigured,
  driveSetupHint,
  pruneDriveToNumbers,
  pushQualityNumber,
  pushSnatchNumber,
  remapDriveNumbers,
  reportDriveDuplicates,
  dedupeDriveFolder,
  driveFoldersForChoice,
  listFolderFiles,
  syncReconsiderNumbers,
  syncSnatchFolder,
  upsertDriveFile,
  upsertNumberImage,
  ensureCachedNumber,
  lockinFinalFolder,
  confirmFinalFiles,
  assertFinalUnlocked,
} from "./drive.mjs";

if (!TOKEN) {
  console.error("Set DISCORD_BOT_TOKEN in .env");
  process.exit(1);
}
if (!CHANNEL_ID) {
  console.error("Set DISCORD_CHANNEL_ID in .env");
  process.exit(1);
}

try {
  await acquireBotLock();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

process.on("exit", () => {
  try { releaseBotLock(); } catch { /* ignore */ }
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try { releaseBotLock(); } catch { /* ignore */ }
    process.exit(0);
  });
}

const manageMessages = PermissionFlagsBits.ManageMessages;

const commands = [
  new SlashCommandBuilder()
    .setName("snatchmarios")
    .setDescription("Pull new images after @bot checkpoint; post new numbers and export Drive")
    .addChannelOption((option) =>
      option
        .setName("thread")
        .setDescription("Thread (or the linked channel). Omit to use this thread/channel, else the linked channel.")
        .addChannelTypes(
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
          ChannelType.PublicThread,
          ChannelType.PrivateThread,
          ChannelType.AnnouncementThread,
        )
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName("full")
        .setDescription("Ignore @bot / saved cursor and scan the whole thread (still skips known images)")
        .setRequired(false),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reconsider-run")
    .setDescription("Rebuild Reconsider from lineup marks; keep :noted: and blank posts")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reconsider-replace")
    .setDescription("Replace a numbered file. Locked numbers update Final only (no Edit per number post).")
    .addIntegerOption((option) =>
      option
        .setName("number")
        .setDescription("Sequence number to replace (the named file, e.g. 42)")
        .setRequired(true)
        .setMinValue(1),
    )
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Replacement image").setRequired(true),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("replace-bulk")
    .setDescription("In Reconsider, apply every reply-with-image as a replacement for the numbered parent message")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reconsider-clear")
    .setDescription("Approve :check:; gap Reconsider :NotApproved:. :noted: and blank stay")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("gaps")
    .setDescription("List active lineup gaps vs locked gaps (locked gaps are Final-only)")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reconsider-watermark")
    .setDescription("Remove watermarks from Reconsider images (or one number) and write them back in sequence")
    .addIntegerOption((option) =>
      option
        .setName("number")
        .setDescription("Only this sequence number. Omit to process every number currently in Reconsider.")
        .setRequired(false)
        .setMinValue(1),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reconsider-pull")
    .setDescription("Export Reconsider to Google Drive only (does not rebuild the queue)")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("drive-dedupe")
    .setDescription("Count or delete extra same-name files in a Google Drive folder")
    .addStringOption((option) =>
      option
        .setName("folder")
        .setDescription("Which Drive folder. Omit for all three.")
        .addChoices(
          { name: "All Mario Images (lineup)", value: "snatch" },
          { name: "Reconsider", value: "reconsider" },
          { name: "Final (Quality Controlled)", value: "quality" },
          { name: "All three", value: "all" },
        )
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Delete extra copies. Omit for a dry-run count only.")
        .setRequired(false),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("quality-controlled")
    .setDescription("Export :check: images to Final (blocked while /lockin lock is set)")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("lockin")
    .setDescription("Lock a lineup range (immutable except /reconsider-replace). Dry-run unless confirm:true")
    .addIntegerOption((option) =>
      option.setName("from").setDescription("Start number (inclusive)").setRequired(false).setMinValue(1),
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("End number (inclusive)").setRequired(false).setMinValue(1),
    )
    .addBooleanOption((option) =>
      option
        .setName("confirm")
        .setDescription("Apply lock: upsert this range into Final; keep prior locked files. Omit for a dry-run.")
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName("unlock")
        .setDescription("Clear the Final lock so /quality-controlled can write again. Does not change files.")
        .setRequired(false),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("update-snatched")
    .setDescription("Update NotApproved/removed lineup posts. Use from/to to avoid timeouts.")
    .addIntegerOption((option) =>
      option.setName("from").setDescription("Start number (inclusive), e.g. 1").setRequired(false).setMinValue(1),
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("End number (inclusive), e.g. 100").setRequired(false).setMinValue(1),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("removebatch")
    .setDescription("Replace a range of Edit per number posts with PLACEHOLDER and list them as gaps")
    .addIntegerOption((option) =>
      option.setName("from").setDescription("Start number (inclusive). Omit with no to: for lock status.").setRequired(false).setMinValue(1),
    )
    .addIntegerOption((option) =>
      option.setName("to").setDescription("End number (inclusive)").setRequired(false).setMinValue(1),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("snapshot-reactions")
    .setDescription("Snapshot unlocked Edit per number (n, image hash, reactions); locked numbers ignored")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rework-sync")
    .setDescription("Forward :noted: images from Edit per number and Reconsider to Rework (hash-deduped)")
    .addBooleanOption((option) =>
      option
        .setName("prune")
        .setDescription("Also delete Rework posts whose image is no longer marked. Default: leave them.")
        .setRequired(false),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rework-notapproved")
    .setDescription("Gap Rework :NotApproved: images — PLACEHOLDER Edit per number, drop Reconsider & Rework")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reworkcount")
    .setDescription("Snapshot reactions by hash, compact locally, rebuild lineup (resumable)")
    .addIntegerOption((option) =>
      option
        .setName("start")
        .setDescription("Resume fill at this number; does not wipe existing 1…N")
        .setRequired(false)
        .setMinValue(1),
    )
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("killsnatchnow")
    .setDescription("Stop the command that is currently running")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reconsider-rework")
    .setDescription("After compact: rebuild Reconsider; keep :noted: and blank")
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
  new ContextMenuCommandBuilder()
    .setName("reconsider-replace")
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(manageMessages)
    .toJSON(),
];

let busy = false;

function hasNotApproved(message) {
  return message.reactions.cache.some((reaction) => reaction.emoji?.name?.toLowerCase() === NOT_APPROVED_NAME);
}

function isApprovedEmoji(emoji) {
  const name = emoji?.name?.toLowerCase();
  if (!name) return false;
  return name === APPROVED_NAME || name === "✅" || name === "white_check_mark";
}

function hasApproved(message) {
  return message.reactions.cache.some((reaction) => isApprovedEmoji(reaction.emoji));
}

function approvedReaction(message) {
  return message.reactions.cache.find((reaction) => isApprovedEmoji(reaction.emoji)) || null;
}

function approvedEmojiResolvable(guild, fromMessage) {
  const reaction = fromMessage && approvedReaction(fromMessage);
  if (reaction?.emoji?.id) return reaction.emoji;
  if (reaction?.emoji?.name === "✅") return "✅";
  const custom = guild?.emojis?.cache.find((emoji) => emoji.name.toLowerCase() === APPROVED_NAME);
  return custom || "✅";
}

async function markReviewApproved(reviewMessage, emoji) {
  if (!reviewMessage) return false;
  await clearPostReactions(reviewMessage);
  try {
    await reviewMessage.react(emoji);
    return true;
  } catch (error) {
    console.error(`Could not mark approved on ${reviewMessage.id}:`, error.message || error);
    return false;
  }
}

async function purgeReconsiderNumbers(client, numbers, cachedMessages) {
  const want = new Set([...numbers].filter((n) => n != null));
  if (want.size === 0) return 0;

  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
  const messages = cachedMessages || await fetchAllMessages(reconsider);
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
    try {
      await message.delete();
      deleted += 1;
    } catch (error) {
      console.error(`Could not delete reconsider ${message.id}:`, error.message || error);
    }
  }
  try {
    await deleteDriveNumbers(DRIVE_FOLDER_RECONSIDER, [...want]);
  } catch (error) {
    console.error("Drive reconsider delete failed:", error.message || error);
  }
  return deleted;
}

async function renumberThreadPosts(messages, mapping, botId, onProgress, start = 1) {
  const entries = numberedEntries(messages, botId)
    .filter((entry) => entry.n >= start && mapping.has(entry.n) && mapping.get(entry.n) !== entry.n)
    .sort((a, b) => a.n - b.n);

  let updated = 0;
  let failed = 0;
  let resumeFrom = null;
  let stoppedAt = null;
  for (let i = 0; i < entries.length; i++) {
    const { message, n: oldN } = entries[i];
    const newN = mapping.get(oldN);
    stoppedAt = oldN;
    await setJobProgress("reworkcount", oldN, `${oldN} → ${newN}`);
    if (onProgress && (i === 0 || i + 1 === entries.length || (i + 1) % 5 === 0)) {
      await onProgress(`Renumbering ${i + 1}/${entries.length} (${oldN} → ${newN})`);
    }
    throwIfAborted("Rework numbering");
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await message.edit({ content: String(newN) });
        ok = true;
        break;
      } catch (error) {
        console.error(`Could not renumber ${oldN} -> ${newN} (try ${attempt}/3):`, error.message || error);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
    if (ok) {
      updated += 1;
      continue;
    }
    failed += 1;
    resumeFrom = oldN;
    await setJobProgress("reworkcount", oldN, `failed ${oldN} → ${newN}`);
    break;
  }
  return { updated, failed, resumeFrom, stoppedAt };
}

function mappingFromResume(entries, start, newCount) {
  const below = entries.filter((entry) => entry.n < start);
  const nextNew = below.length ? Math.max(...below.map((entry) => entry.n)) + 1 : 1;
  const remaining = [...new Set(entries.filter((entry) => entry.n >= start).map((entry) => entry.n))]
    .sort((a, b) => a - b);

  const mapping = new Map();
  for (const entry of below) mapping.set(entry.n, entry.n);
  for (let i = 0; i < remaining.length; i++) {
    const newN = nextNew + i;
    if (newN > newCount) break;
    mapping.set(remaining[i], newN);
  }

  const oldCount = remaining.length ? Math.max(newCount, remaining[remaining.length - 1]) : newCount;
  return { oldCount, newCount, closed: Math.max(0, oldCount - newCount), mapping, unmapped: [] };
}

function hasReplacementReply(parent, messages) {
  return messages.some((message) => {
    if (message.reference?.messageId !== parent.id) return false;
    if (firstImageUrl(message)) return true;
    return message.reactions.cache.some((reaction) => reaction.emoji?.name === "✅");
  });
}

function logChannelPermissions(label, channel) {
  const me = channel.guild?.members?.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms) {
    console.log(`${label} permissions: unavailable`);
    return false;
  }
  const needed = [
    "ViewChannel",
    "ReadMessageHistory",
    "SendMessages",
    "SendMessagesInThreads",
    "AttachFiles",
    "AddReactions",
    "ManageMessages",
    "ManageThreads",
  ];
  const missing = needed.filter((name) => !perms.has(PermissionFlagsBits[name]));
  console.log(`${label} missing: ${missing.length ? missing.join(", ") : "none"}`);
  return perms.has(PermissionFlagsBits.ManageMessages);
}

function botInviteUrl(clientId) {
  const permissions = (
    PermissionFlagsBits.ViewChannel
    | PermissionFlagsBits.ReadMessageHistory
    | PermissionFlagsBits.SendMessages
    | PermissionFlagsBits.SendMessagesInThreads
    | PermissionFlagsBits.EmbedLinks
    | PermissionFlagsBits.AttachFiles
    | PermissionFlagsBits.AddReactions
    | PermissionFlagsBits.UseExternalEmojis
    | PermissionFlagsBits.ManageMessages
    | PermissionFlagsBits.ManageThreads
  );
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${permissions}`;
}

async function clearPostReactions(message, { preserveRework = false } = {}) {
  let target = message;
  try {
    target = await message.fetch(true);
  } catch (error) {
    console.error(`Could not fetch ${message.id} before clearing reactions:`, error.message || error);
  }

  const keepRework = preserveRework && hasReworkReaction(target);

  if (!preserveRework) {
    try {
      await Promise.race([
        target.reactions.removeAll(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("reaction clear timed out")), 10_000)),
      ]);
      return true;
    } catch (error) {
      console.error(`Could not clear all reactions on ${target.id}:`, error.message || error);
    }
  }

  let failed = 0;
  for (const reaction of [...target.reactions.cache.values()]) {
    if (preserveRework && isReworkEmoji(reaction.emoji)) continue;
    try {
      await reaction.remove();
      continue;
    } catch (error) {
      console.error(`Could not remove ${reaction.emoji?.name} on ${target.id}:`, error.message || error);
    }
    try {
      const users = await reaction.users.fetch();
      for (const user of users.values()) {
        try {
          await reaction.users.remove(user.id);
        } catch (error) {
          failed += 1;
          console.error(
            `Could not remove ${reaction.emoji?.name} from ${user.id} on ${target.id}:`,
            error.message || error,
          );
        }
      }
    } catch (error) {
      failed += 1;
      console.error(`Could not fetch reactors for ${reaction.emoji?.name} on ${target.id}:`, error.message || error);
    }
  }

  if (keepRework) {
    try {
      const fresh = await target.fetch(true);
      if (!hasReworkReaction(fresh)) await addReworkReaction(fresh);
    } catch {
      await addReworkReaction(target);
    }
  }
  return failed === 0;
}

async function attachmentForNumber(n, sourceMessage) {
  const filename = `${n}.jpg`;
  try {
    const path = await ensureImagePathFor(n);
    return { attachment: path, name: filename };
  } catch {
    // fall through to Discord message
  }

  const fromMessage = sourceMessage?.attachments?.find((file) => {
    return file.name?.match(new RegExp(`^${n}\\.jpe?g$`, "i")) || file.contentType?.startsWith("image/");
  }) || sourceMessage?.attachments?.first();

  if (!fromMessage) throw new Error(`No Drive/cache/Discord file found for ${n}`);
  return { attachment: fromMessage.url, name: filename };
}

async function safeEdit(interaction, text) {
  try {
    const fromJpg = String(text).match(/(\d+)\.jpg/i);
    const fromSlash = String(text).match(/(\d+)\s*\/\s*\d+/);
    const parsed = fromJpg || fromSlash;
    const number = parsed ? Number(parsed[1]) : (Number.isInteger(getJobProgress()?.number) ? getJobProgress().number : null);
    await setJobProgress(interaction.commandName || getJobProgress()?.command, number, String(text).slice(0, 200));
  } catch {
    // live status should not block the job
  }
}

async function finishReply(interaction, text) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: text });
    } else {
      await interaction.reply({ content: text, ephemeral: true });
    }
  } catch {
    // Interaction token expired; keep working.
  }
}

async function withBusy(interaction, work) {
  if (busy) {
    const payload = { content: "Another command is already running. Use /killsnatchnow to stop it.", ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply(payload);
    return;
  }

  busy = true;
  clearAbort();
  setJobRunning(true);
  bindStatusClient(client);
  try {
    await rememberStatusChannel(interaction.channel);
    await setJobProgress(interaction.commandName, null, "starting");
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: "Working — watch the public live-status embed." });
      }
    } catch {
      // ignore ack failures
    }
    scheduleStatusPublish(true);
    await work();
    await clearJobProgress();
  } finally {
    setJobRunning(false);
    busy = false;
    scheduleStatusPublish(true);
  }
}

async function resolveSnatchSource(client, interaction) {
  const blocked = snatchBlockedThreadIds();

  const chosen = interaction.options.getChannel("thread");
  if (chosen) {
    if (blocked.has(chosen.id)) {
      throw new Error("Don't snatch from Edit per number, Reconsider, or Rework — those are already in the sequence.");
    }
    const channel = await client.channels.fetch(chosen.id);
    if (!sourceAllowed(channel, CHANNEL_ID)) {
      throw new Error("Source must be the linked channel or a thread inside that channel.");
    }
    return channel;
  }

  const current = interaction.channel;
  if (current && !blocked.has(current.id) && sourceAllowed(current, CHANNEL_ID)) return current;
  return client.channels.fetch(CHANNEL_ID);
}

async function runSnatchMarios(client, interaction) {
  const source = await resolveSnatchSource(client, interaction);
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const sequence = await loadSequence();
  const known = knownKeys(sequence);
  await addLocalFileHashes(known.hashes, sequence.count);
  const fullScan = interaction.options.getBoolean("full") === true;
  const savedCursor = fullScan ? null : await getSavedSnatchCursor(source.id);

  await safeEdit(
    interaction,
    fullScan
      ? `Scanning all of ${source.name || source.id} (full scan). Known images still skipped…`
      : `Scanning ${source.name || source.id} after the @bot / saved snatch checkpoint…`,
  );

  const fetched = fullScan
    ? {
      messages: sortOldestFirst(await fetchAllMessages(source)),
      afterId: null,
      mentionMessageId: null,
      mentionCheckpointId: null,
      savedAfterId: null,
    }
    : await fetchSnatchSourceMessages(source, {
      botId: client.user.id,
      savedAfterId: savedCursor,
    });
  const messages = fetched.messages;
  let checkpointNote = "No @bot mention, checkpoint embed, or saved cursor — scanned the whole thread.";
  if (fullScan) {
    checkpointNote = "Full scan requested; checkpoint ignored. Known images still skipped.";
  } else if (fetched.afterId) {
    checkpointNote = `Started after the latest of saved cursor / @bot mention / snatch-checkpoint embed (${fetched.afterId}).`;
  }

  const added = [];
  let skippedDupes = 0;
  let lastDoneMessageId = fetched.afterId || null;

  for (const message of messages) {
    throwIfAborted("Snatch");
    if (message.author?.id === client.user.id) {
      lastDoneMessageId = message.id;
      continue;
    }

    const images = [];
    for (const image of collectImages(message)) {
      if (image.attachmentId && known.ids.has(String(image.attachmentId))) continue;
      const url = stripUrl(image.url);
      if (url && known.urls.has(url)) continue;
      images.push(image);
    }

    for (const image of images) {
      throwIfAborted("Snatch");
      let buffer;
      try {
        buffer = await fetchBuffer(image.url);
      } catch (error) {
        console.error(`Skip ${image.url}: ${error.message}`);
        continue;
      }

      const hash = sha256(buffer);
      if (known.hashes.has(hash)) {
        skippedDupes += 1;
        continue;
      }

      const n = sequence.count + 1;
      await setJobProgress("snatchmarios", n, `saving ${n}`);
      await mkdir(path.dirname(cachePathFor(n)), { recursive: true });
      const dest = cachePathFor(n);
      await saveResized(buffer, dest);
      const outHash = await fileSha256(dest);
      if (known.hashes.has(outHash)) {
        await unlink(dest);
        skippedDupes += 1;
        continue;
      }

      try {
        await upsertNumberImage(n, dest, { role: "snatch" });
      } catch (error) {
        console.error(`Drive snatch upload ${n} failed:`, error.message || error);
      }
      const item = {
        n,
        source: image.url,
        attachmentId: image.attachmentId || parseAttachmentId(image.url),
        sha256: hash,
        dirty: true,
        sourceMessageId: message.id,
      };
      sequence.count = n;
      sequence.items.push(item);
      known.ids.add(String(item.attachmentId || ""));
      known.urls.add(stripUrl(item.source));
      known.hashes.add(hash);
      known.hashes.add(outHash);
      added.push(item);
      await saveSequence(sequence);
      await safeEdit(interaction, `Saved ${n}.jpg (${added.length} new). Sequence count is ${sequence.count}.`);
    }

    lastDoneMessageId = message.id;
    await saveSnatchCursor(source.id, lastDoneMessageId, {
      source: "processed",
      mentionMessageId: fetched.mentionMessageId || null,
    });
  }

  if (lastDoneMessageId) {
    await saveSnatchCursor(source.id, lastDoneMessageId, {
      source: fetched.mentionMessageId ? "mention+processed" : "processed",
      mentionMessageId: fetched.mentionMessageId || null,
    });
  }

  if (added.length) {
    const alreadyPosted = new Set(
      numberedEntries(await fetchAllMessages(review), client.user.id).map((entry) => entry.n),
    );
    let posted = 0;
    for (const item of added) {
      if (alreadyPosted.has(item.n)) {
        item.dirty = false;
        continue;
      }
      await postNumberedImage(review, item.n);
      item.dirty = false;
      posted += 1;
      alreadyPosted.add(item.n);
      await safeEdit(interaction, `Posted ${item.n}.jpg (${posted}/${added.length} new)`);
    }
    await saveSequence(sequence);
  }

  await safeEdit(interaction, "Exporting lineup (including placeholders) to Google Drive…");
  let driveText;
  try {
    const drive = await syncSnatchFolder((text) => safeEdit(interaction, text));
    driveText = `Drive lineup 1–${sequence.count}: ${drive.uploaded} uploaded, ${drive.skipped} already current`;
    if (drive.pruned) driveText += `, ${drive.pruned} leftover file(s) removed`;
    if (drive.failed) driveText += `, ${drive.failed} failed`;
    driveText += ".";
  } catch (error) {
    console.error("Drive snatch export failed:", error.message || error);
    driveText = `Drive export failed: ${error.message || error}`;
  }

  try {
    const marker = await upsertSnatchCheckpointEmbed(source, {
      count: sequence.count,
      botId: client.user.id,
    });
    if (marker?.id) {
      await saveSnatchCursor(source.id, marker.id, {
        source: "checkpoint-embed",
        checkpointMessageId: marker.id,
        mentionMessageId: fetched.mentionMessageId || null,
      });
      checkpointNote += " Updated the snatch-checkpoint embed in the source thread.";
    }
  } catch (error) {
    console.error("Snatch checkpoint embed failed:", error.message || error);
  }

  if (added.length === 0) {
    return `No new images. Sequence count stays ${sequence.count}.${skippedDupes ? ` Skipped ${skippedDupes} duplicate(s).` : ""} ${checkpointNote} ${driveText}`;
  }

  return `Added ${added.length} image(s). Sequence count is ${sequence.count}.${skippedDupes ? ` Skipped ${skippedDupes} duplicate(s).` : ""} Posted new ones to Edit per number. ${checkpointNote} ${driveText}`;
}

async function runReconsider(client, interaction) {
  const result = await rebuildReconsiderThread(client, (text) => safeEdit(interaction, text));
  const gapText = formatGapText(result.gaps, result.count, await loadLockin());
  const driveText = await syncReconsiderDrive(result.posted, (text) => safeEdit(interaction, text));
  return `Rebuilt Reconsider with ${result.posted.length} unique image(s) (${result.lineupMarked ?? 0} marked :NotApproved:/:noted: on Edit per number). Kept :noted: and untriaged Reconsider posts. Pulled missing locals from Edit per number attachments. Copied :noted: only onto Reconsider — not :NotApproved: or check. Locked numbers skipped. PLACEHOLDER slots are gaps only.${driveText}\n${gapText}`;
}

async function runReconsiderRework(client, interaction) {
  const result = await rebuildReconsiderThread(client, (text) => safeEdit(interaction, text), {
    skipEmptyGapList: true,
  });
  const driveText = await syncReconsiderDrive(result.posted, (text) => safeEdit(interaction, text));
  return `Reconsider rebuilt at the new numbers with ${result.posted.length} unique image(s). Kept :noted: and untriaged posts; added remaining Edit per number :NotApproved: / :noted:. Copied :noted: only. Duplicates and PLACEHOLDER slots were skipped.${driveText}`;
}

async function syncReconsiderDrive(posted, onProgress) {
  if (!driveConfigured()) return "";
  try {
    const drive = await syncReconsiderNumbers(posted, onProgress);
    let text = ` Drive reconsider: ${drive.uploaded} uploaded, ${drive.skipped} already current`;
    if (drive.pruned) text += `, ${drive.pruned} extra file(s) removed`;
    if (drive.failed) text += `, ${drive.failed} failed`;
    return `${text}.`;
  } catch (error) {
    console.error("Drive reconsider sync failed:", error.message || error);
    return ` Drive reconsider sync failed: ${error.message || error}`;
  }
}

async function botMarkedProcessed(message, botId) {
  const reaction = message.reactions.cache.find((entry) => entry.emoji?.name === "✅");
  if (!reaction) return false;
  if (reaction.me) return true;
  try {
    const users = await reaction.users.fetch();
    return users.has(botId);
  } catch {
    return false;
  }
}

async function collectBulkReplacements(reconsider, botId) {
  const messages = await fetchAllMessages(reconsider);
  const byId = new Map(messages.map((message) => [message.id, message]));
  const latestByNumber = new Map();

  for (const message of messages) {
    const parentId = message.reference?.messageId;
    if (!parentId) continue;
    const url = firstImageUrl(message);
    if (!url) continue;

    let parent = byId.get(parentId);
    if (!parent) {
      try {
        parent = await reconsider.messages.fetch(parentId);
        byId.set(parent.id, parent);
      } catch {
        continue;
      }
    }

    const n = numberFromMessage(parent);
    if (n == null) continue;

    const prev = latestByNumber.get(n);
    if (!prev || BigInt(message.id) > BigInt(prev.reply.id)) {
      latestByNumber.set(n, { n, reply: message, url });
    }
  }

  const jobs = [];
  for (const job of latestByNumber.values()) {
    if (await botMarkedProcessed(job.reply, botId)) continue;
    jobs.push(job);
  }
  jobs.sort((a, b) => a.n - b.n);
  return jobs;
}

async function runReplaceBulk(client, interaction) {
  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
  await safeEdit(interaction, "Scanning Reconsider for reply replacements…");

  const jobs = await collectBulkReplacements(reconsider, client.user.id);
  if (jobs.length === 0) {
    return "No unprocessed image replies in Reconsider. Reply to a numbered NotApproved post with the new image, then run this again.";
  }

  const lockin = await loadLockin();
  const blocked = jobs.filter((job) => isLockedNumber(job.n, lockin));
  const runnable = jobs.filter((job) => !isLockedNumber(job.n, lockin));
  if (runnable.length === 0) {
    return `All ${blocked.length} bulk replacement(s) are in a /lockin range (${formatLockinRanges(lockin)}). Use /reconsider-replace for those numbers.`;
  }

  const replaced = [];
  const failed = [];
  let needUpdate = false;
  for (const [index, job] of runnable.entries()) {
    await safeEdit(interaction, `Replacing ${job.n}.jpg (${index + 1}/${runnable.length})…`);
    try {
      const result = await replaceNumber(client, job.n, job.url, (text) => safeEdit(interaction, text));
      await job.reply.react("✅").catch(() => {});
      replaced.push(job.n);
      if (result.includes("/update-snatched")) needUpdate = true;
    } catch (error) {
      console.error(`replace-bulk ${job.n} failed:`, error.message || error);
      failed.push(`${job.n} (${error.message || error})`);
    }
  }

  const sequence = await loadSequence();
  if (replaced.length === 0 && failed.length) {
    return `No replacements applied. Failures: ${failed.join("; ")}`;
  }
  const list = replaced.join(", ");
  let summary = `Replaced ${replaced.length} image(s): ${list}. Sequence count stays ${sequence.count}.`;
  if (blocked.length) {
    summary += ` Skipped ${blocked.length} locked number(s) (${blocked.map((job) => job.n).join(", ")}); use /reconsider-replace for those.`;
  }
  if (failed.length) {
    summary += ` Failed: ${failed.join("; ")}.`;
  }
  if (needUpdate) {
    summary += " Some Edit per number posts could not be edited in place — run /update-snatched.";
  }
  return summary;
}

async function replaceNumber(client, n, imageUrl, onProgress, { allowLocked = false } = {}) {
  const sequence = await loadSequence();
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Number must be a positive integer (got ${n}).`);
  }
  const lockin = await loadLockin();
  assertNumberTouchable(n, lockin, { allowLocked, via: "/reconsider-replace" });
  // Local lineup may be empty after a wipe; grow sequence so Discord/Drive replaces still work.
  ensureSequenceNumber(sequence, n);

  await onProgress(`Replacing ${n}.jpg on Drive…`);
  const raw = await fetchBuffer(imageUrl);
  await mkdir(path.dirname(cachePathFor(n)), { recursive: true });
  await saveResized(raw, cachePathFor(n));
  const buffer = await readFile(cachePathFor(n));

  const item = sequence.items[n - 1];
  item.n = n;
  item.source = imageUrl;
  item.attachmentId = parseAttachmentId(imageUrl);
  item.sha256 = sha256(buffer);
  item.dirty = true;
  item.placeholder = false;
  item.replaced = true;
  item.locked = isLockedNumber(n, lockin);
  sequence.items[n - 1] = item;
  removeGap(sequence, n);
  await saveSequence(sequence);
  await purgeReconsiderNumbers(client, [n]);

  const role = isLockedNumber(n, lockin) ? "quality" : "snatch";
  try {
    await upsertNumberImage(n, cachePathFor(n), { role });
  } catch (error) {
    console.error(`Drive ${role} upload ${n} failed:`, error.message || error);
  }
  if (isLockedNumber(n, lockin)) {
    let finalOk = false;
    try {
      const verified = await confirmFinalFiles([n]);
      finalOk = verified.confirmed.includes(n);
    } catch (error) {
      console.error(`Drive Final confirm ${n} failed:`, error.message || error);
    }
    const review = await ensureThread(client, REVIEW_THREAD_ID);
    const reviewMessages = await fetchAllMessages(review);
    const leftover = numberedEntries(reviewMessages, client.user.id).find((entry) => entry.n === n);
    if (leftover && finalOk) {
      try {
        await deleteNumberedMessagesAndReplies(reviewMessages, [n]);
      } catch (error) {
        console.error(`Could not remove leftover locked post ${n}:`, error.message || error);
      }
    }
    if (!finalOk) {
      return `Replaced ${n}.jpg on Drive cache. Final confirm failed — Edit per number was not changed. Retry /reconsider-replace. Sequence count stays ${sequence.count}. Number stays locked (Final only).`;
    }
    return `Replaced ${n}.jpg in Final (Drive). Sequence count stays ${sequence.count}. Number stays locked (Final only — not posted back to Edit per number).`;
  }

  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const reviewMessages = await fetchAllMessages(review);
  const entries = numberedEntries(reviewMessages, client.user.id);
  const target = entries.find((entry) => entry.n === n);

  if (target) {
    try {
      const ok = await tryEditNumberedImage(target.message, n);
      if (ok) {
        item.dirty = false;
        await saveSequence(sequence);
        await clearPostReactions(target.message);
        return `Replaced ${n}.jpg on Drive and Edit per number. Sequence count stays ${sequence.count}.`;
      }
    } catch (error) {
      console.error(`Could not edit message ${n}:`, error.message || error);
    }
  }

  return `Replaced ${n}.jpg on Drive. Sequence count stays ${sequence.count}. Run /update-snatched to refresh Edit per number.`;
}

async function runReconsiderWatermark(client, interaction) {
  const sequence = await loadSequence();
  const requested = interaction.options.getInteger("number");
  let numbers;
  if (requested != null) {
    if (requested < 1 || requested > sequence.count) {
      throw new Error(`Number must be between 1 and ${sequence.count}.`);
    }
    numbers = [requested];
  } else {
    const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
    const messages = await fetchAllMessages(reconsider);
    numbers = [...new Set(messages.map(numberFromMessage).filter((n) => n != null))].sort((a, b) => a - b);
    if (numbers.length === 0) {
      return "Reconsider has no numbered images. Pass number: to process one file, or run /reconsider-run first.";
    }
  }

  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const entries = numberedEntries(await fetchAllMessages(review), client.user.id);
  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
  const inReconsider = new Set(
    (await fetchAllMessages(reconsider)).map(numberFromMessage).filter((n) => n != null),
  );
  let updated = 0;
  let saved = 0;
  let failed = 0;
  let skippedLocked = 0;
  const lockin = await loadLockin();

  for (const [index, n] of numbers.entries()) {
    if (isLockedNumber(n, lockin)) {
      skippedLocked += 1;
      await safeEdit(interaction, `Skipping locked ${n}.jpg`);
      continue;
    }
    const item = sequence.items[n - 1];
    if (item?.placeholder) {
      await safeEdit(interaction, `Skipping ${n}.jpg (PLACEHOLDER)`);
      continue;
    }
    await safeEdit(interaction, `Removing watermark from ${n}.jpg (${index + 1}/${numbers.length})…`);
    try {
      const buffer = await dewmarkSequenceFile(n);
      const item = sequence.items[n - 1];
      if (!item) throw new Error(`Number ${n} is not in the sequence.`);
      item.sha256 = sha256(buffer);
      item.dirty = true;
      await saveSequence(sequence);
      try {
        await pushSnatchNumber(n, cachePathFor(n));
        if (inReconsider.has(n)) {
          await upsertNumberImage(n, cachePathFor(n), { role: "reconsider" });
        }
      } catch (error) {
        console.error(`Drive watermark sync ${n} failed:`, error.message || error);
      }

      const target = entries.find((entry) => entry.n === n);
      if (target) {
        try {
          const hadRework = hasReworkReaction(target.message);
          const ok = await tryEditNumberedImage(target.message, n);
          if (ok) {
            item.dirty = false;
            await saveSequence(sequence);
            await clearPostReactions(target.message, { preserveRework: true });
            if (hadRework) await addReworkReaction(target.message);
            updated += 1;
            continue;
          }
        } catch (error) {
          console.error(`Could not edit message ${n}:`, error.message || error);
        }
      }
      saved += 1;
    } catch (error) {
      console.error(`Watermark failed for ${n}:`, error.message || error);
      failed += 1;
    }
  }

  let result = `Watermark pass finished. ${updated + saved}/${numbers.length} written back in sequence. Count stays ${sequence.count}.`;
  if (updated) result += ` Updated ${updated} Edit per number post(s) in place.`;
  if (saved) result += ` ${saved} saved on Drive — run /update-snatched if the gallery still shows old images.`;
  if (failed) result += ` ${failed} failed.`;
  if (skippedLocked) result += ` Skipped ${skippedLocked} locked number(s).`;
  return result;
}

function formatLockinPlan(plan) {
  const folder = plan.folder?.name || "Final";
  const lines = [];
  if (plan.dryRun) {
    lines.push(`DRY RUN — nothing was changed. Run again with confirm:true to execute.`);
  }
  lines.push(`Final Drive folder "${folder}" (${plan.folder?.id || DRIVE_FOLDER_QUALITY}).`);
  lines.push(`This range: ${plan.from}–${plan.to}${plan.count ? ` of lineup 1–${plan.count}` : " (Drive/Discord-backed; local sequence empty)"}. Locked numbers stay reserved.`);
  if (plan.rangesBefore && plan.rangesBefore !== "none") {
    lines.push(`Already locked: ${plan.rangesBefore}.`);
  }
  lines.push(`Locked ranges after this command: ${plan.rangesAfter || `${plan.from}–${plan.to}`}.`);
  lines.push(`Locked images live in Final only. After confirm, matching Edit per number posts are deleted (local output/{n}.jpg files are kept if present; not required).`);
  lines.push(`Gaps inside locked ranges stay at the same number. Only /reconsider-replace can fill a locked gap (uploads to Final; does not repost to Edit per number).`);
  if (plan.appendOnly !== false && !plan.reset) {
    lines.push(`Final is append-only: previously locked files are kept. This range is upserted alongside them.`);
  }
  if (plan.driveBacked) {
    lines.push(`Drive-backed lockin: numbers already in Final do not need a local copy.`);
  }
  if (plan.reset) {
    lines.push(`RESET is on — Final files that are not in any locked range would be trashed.`);
  }
  if (plan.dryRun) {
    if (plan.reset) {
      lines.push(`Would trash ${plan.wouldTrash ?? 0} Final file(s) not in locked ranges (Drive trash, recoverable).`);
      if (plan.wouldKeep) lines.push(`Would keep ${plan.wouldKeep} Final file(s) that are in locked ranges.`);
    } else {
      lines.push(`Would not trash any Final files (append-only).`);
    }
    lines.push(`Would upload ${plan.upload} local image(s) from this range.`);
    if (plan.alreadyOnFinal?.length) {
      lines.push(`Already on Final (no local upload needed): ${plan.alreadyOnFinal.length}.`);
    }
    if (plan.wouldTrashGapFiles) {
      lines.push(`Would remove ${plan.wouldTrashGapFiles} PLACEHOLDER file(s) from Final for locked gaps (not a Final wipe).`);
    }
    lines.push(`Would delete ${plan.wouldDeleteReview ?? 0} Edit per number post(s) after those real images are confirmed in Final (placeholder/gap posts in the locked ranges are deleted too).`);
  } else {
    if (plan.reset) {
      lines.push(`Trashed ${plan.trashed || 0} file(s)${plan.trashFailed ? ` (${plan.trashFailed} failed)` : ""}. Leftover trashed ${plan.pruned || 0}.`);
    } else {
      lines.push(`Did not trash Final (append-only).`);
    }
    lines.push(`Uploaded ${plan.uploaded}, already current ${plan.already}.`);
    if (plan.gapTrashed) lines.push(`Removed ${plan.gapTrashed} PLACEHOLDER file(s) from Final for locked gaps.`);
    if (plan.failed) lines.push(`${plan.failed} upload(s) failed — those Edit per number posts were NOT deleted.`);
    if (plan.confirmed) lines.push(`Confirmed in Final (exists + md5 when available): ${plan.confirmed.length}.`);
    lines.push(`Deleted ${plan.deletedReview || 0} Edit per number message(s) (including replies) after Final confirm.`);
    if (plan.deletedGapPosts) lines.push(`Of those, ${plan.deletedGapPosts} were PLACEHOLDER/gap slots (no Final file).`);
    if (plan.heldBackReview?.length) {
      lines.push(`LEFT in Edit per number (not confirmed in Final): ${plan.heldBackReview.join(", ")}.`);
    }
    lines.push(`Lock saved. /quality-controlled will not overwrite Final.`);
  }
  if (plan.skippedGaps?.length) {
    lines.push(`PLACEHOLDER/gap slots in this range: ${plan.skippedGaps.join(", ")}. They leave Edit per number; fill later only with /reconsider-replace.`);
  } else {
    lines.push("No PLACEHOLDER/gap slots in this range.");
  }
  if (plan.missing?.length) {
    lines.push(`Missing from Final and local (posts not deleted): ${plan.missing.join(", ")}.`);
  }
  if (plan.dryRun && plan.reset && plan.trashNames?.length) {
    const sample = plan.trashNames.slice(0, 25).join(", ");
    const extra = plan.trashNames.length > 25 ? ` … +${plan.trashNames.length - 25} more` : "";
    lines.push(`Would trash: ${sample}${extra}.`);
  }
  return lines.join("\n");
}

async function runLockin(client, interaction) {
  if (interaction.options.getBoolean("unlock") === true) {
    const prev = await loadLockin();
    await clearLockin();
    return hasLockin(prev)
      ? `Unlocked all ranges (${formatLockinRanges(prev)}). /quality-controlled can write Final again. Files and Edit per number were not changed.`
      : "No locked ranges. Files were not changed.";
  }

  const from = interaction.options.getInteger("from");
  const to = interaction.options.getInteger("to");
  if (!Number.isInteger(from) && !Number.isInteger(to)) {
    const lock = await loadLockin();
    return hasLockin(lock)
      ? `Locked ranges: ${formatLockinRanges(lock)}. Those numbers live in Final only (not Edit per number). Immutable except /reconsider-replace. Sequence count continues. /quality-controlled is blocked.`
      : "No locked ranges. Use /lockin from: to: (dry-run) then confirm:true.";
  }
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error("Provide both from: and to: (or omit both for lock status, or unlock:true).");
  }
  const confirm = interaction.options.getBoolean("confirm") === true;
  const reset = interaction.options.getBoolean("reset") === true;
  await safeEdit(
    interaction,
    confirm
      ? `Locking ${from}–${to} (append to Final, then remove Edit per number posts)…`
      : `Dry-run: counting what /lockin ${from}–${to} would lock, upload, and delete from Edit per number…`,
  );
  const plan = await lockinFinalFolder({
    from,
    to,
    confirm,
    reset,
    onProgress: (text) => safeEdit(interaction, text),
  });

  const current = await loadLockin();
  const lockAfter = confirm
    ? current
    : parseLockin({ ranges: [...current.ranges, { from, to }] });

  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const reviewMessages = await fetchAllMessages(review);
  const presentLocked = [...new Set(
    numberedEntries(reviewMessages, client.user.id)
      .filter((entry) => isLockedNumber(entry.n, lockAfter))
      .map((entry) => entry.n),
  )].sort((a, b) => a - b);
  plan.wouldDeleteReview = presentLocked.length;

  if (plan.dryRun) {
    return formatLockinPlan(plan);
  }

  const sequence = await loadSequence();
  // Prefer Final Drive presence. Empty local sequence would otherwise mark every
  // number as a gap and skip Final confirmation.
  await safeEdit(interaction, `Confirming ${presentLocked.length} Edit per number number(s) against Final…`);
  const verified = presentLocked.length
    ? await confirmFinalFiles(presentLocked)
    : { confirmed: [], missing: [], mismatched: [] };
  const confirmedSet = new Set(verified.confirmed);
  const gapNums = [];
  for (const n of presentLocked) {
    if (confirmedSet.has(n)) continue;
    if (await isReplaceMeNumber(sequence, n)) gapNums.push(n);
  }
  const deletable = [...verified.confirmed, ...gapNums];
  plan.heldBackReview = presentLocked.filter((n) => !deletable.includes(n));
  plan.deletedGapPosts = gapNums.length;
  if (deletable.length) {
    await safeEdit(interaction, `Removing ${deletable.length} Edit per number post(s) after Final confirm (local files not required)…`);
    plan.deletedReview = await deleteNumberedMessagesAndReplies(reviewMessages, deletable);
  } else {
    plan.deletedReview = 0;
  }

  const nums = [];
  for (let n = from; n <= to; n++) nums.push(n);
  try {
    const removed = await purgeReconsiderNumbers(client, nums);
    if (removed) plan.purgedReconsider = removed;
  } catch (error) {
    console.error("Could not drop locked numbers from Reconsider:", error.message || error);
  }
  const text = formatLockinPlan(plan);
  return plan.purgedReconsider
    ? `${text}\nRemoved ${plan.purgedReconsider} Reconsider post(s) in this range (left the review cycle).`
    : text;
}

async function replyLong(interaction, text) {
  const chunks = splitDiscordText(text);
  await finishReply(interaction, chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, ephemeral: true }).catch(() => {});
  }
}

async function runReconsiderClear(client, interaction) {
  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
  await safeEdit(interaction, "Finding Reconsider :check: / :NotApproved: (:noted: and blank stay)…");

  const messages = await fetchAllMessages(reconsider);
  const numbered = messages.filter((message) => numberFromMessage(message) != null && firstImageUrl(message));
  const sequence = await loadSequence();
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const reviewByNumber = new Map();
  for (const entry of numberedEntries(await fetchAllMessages(review), client.user.id)) {
    if (!reviewByNumber.has(entry.n)) reviewByNumber.set(entry.n, entry.message);
  }

  const lockin = await loadLockin();
  const checked = numbered.filter((message) => {
    const n = numberFromMessage(message);
    if (isLockedNumber(n, lockin)) return false;
    const reviewMessage = reviewByNumber.get(n);
    if (hasRepeatReaction(message) || hasRepeatReaction(reviewMessage)) return false;
    return hasApproved(message) || hasApproved(reviewMessage);
  });
  const flagged = numbered.filter((message) => {
    const n = numberFromMessage(message);
    if (isLockedNumber(n, lockin)) return false;
    const reviewMessage = reviewByNumber.get(n);
    if (hasRepeatReaction(message) || hasRepeatReaction(reviewMessage)) return false;
    if (hasApproved(message) || hasApproved(reviewMessage)) return false;
    return reconsiderRetention(message) === "rejected";
  });

  if (checked.length === 0 && flagged.length === 0) {
    const skippedLocked = numbered.filter((message) => isLockedNumber(numberFromMessage(message), lockin)).length;
    const gaps = normalizeGaps(sequence);
    const extra = skippedLocked ? ` Skipped ${skippedLocked} locked number(s).` : "";
    return gaps.length
      ? `Nothing new to clear.${extra}\n${formatGapText(gaps, sequence.count, lockin)}`
      : `Nothing to clear, and there are no gaps.${extra}`;
  }

  const gaps = new Set(normalizeGaps(sequence));

  const approvedByNumber = new Map();
  for (const message of checked) {
    const n = numberFromMessage(message);
    if (!approvedByNumber.has(n)) approvedByNumber.set(n, message);
  }
  const uniqueApproved = [...approvedByNumber.keys()].sort((a, b) => a - b);

  const skipLineup = [];
  const makeGaps = [];
  for (const message of flagged) {
    const n = numberFromMessage(message);
    if (approvedByNumber.has(n)) continue;
    const reviewMessage = reviewByNumber.get(n);
    if (hasRepeatReaction(message) || hasRepeatReaction(reviewMessage)) continue;
    if (reconsiderRetention(message) !== "rejected") continue;
    const item = sequence.items[n - 1];
    const alreadyReplaced = Boolean(
      item?.replaced
      || hasReplacementReply(message, messages)
      || (reviewMessage && !hasNotApproved(reviewMessage) && !gaps.has(n) && !item?.placeholder),
    );
    if (alreadyReplaced) skipLineup.push(n);
    else makeGaps.push(n);
  }

  const uniqueSkip = [...new Set(skipLineup)].sort((a, b) => a - b);
  const uniqueGaps = [...new Set(makeGaps)].filter((n) => !isLockedNumber(n, lockin)).sort((a, b) => a - b);

  for (const n of uniqueApproved) {
    await safeEdit(interaction, `Approving ${n} on Edit per number…`);
    const emoji = approvedEmojiResolvable(review.guild, approvedByNumber.get(n));
    await markReviewApproved(reviewByNumber.get(n), emoji);
    removeGap(sequence, n);
    const item = sequence.items[n - 1];
    if (item) item.placeholder = false;
    try {
      await pushQualityNumber(n);
    } catch (error) {
      console.error(`Drive QC upload ${n} failed:`, error.message || error);
    }
  }

  const allNumbers = [...new Set([...uniqueApproved, ...uniqueSkip, ...uniqueGaps])];
  const deleted = await purgeReconsiderNumbers(client, allNumbers, messages);

  if (uniqueGaps.length) {
    addGaps(sequence, uniqueGaps, lockin);
    for (const n of uniqueGaps) {
      const placed = await applyPlaceholderToNumber(n);
      if (!placed) continue;
      const item = sequence.items[n - 1];
      if (item) {
        item.placeholder = true;
        item.dirty = true;
        item.replaced = false;
      }
      try {
        await pushSnatchNumber(n);
      } catch (error) {
        console.error(`Drive snatch upload ${n} failed:`, error.message || error);
      }
      await safeEdit(interaction, `Placed PLACEHOLDER on ${n}.jpg`);
    }
    try {
      await deleteDriveNumbers(DRIVE_FOLDER_QUALITY, uniqueGaps);
    } catch (error) {
      console.error("Drive QC delete after gaps failed:", error.message || error);
    }
  }
  await saveSequence(sequence);

  const posted = formatGapText(normalizeGaps(sequence), sequence.count, lockin);
  for (const chunk of splitDiscordText(posted)) {
    await reconsider.send(chunk);
  }

  let result = `Removed ${deleted} Reconsider message(s). Sequence count stays ${sequence.count}.`;
  if (uniqueApproved.length) result += ` Approved on Edit per number: ${uniqueApproved.join(", ")}.`;
  if (uniqueSkip.length) result += ` Already replaced, lineup kept: ${uniqueSkip.join(", ")}.`;
  if (uniqueGaps.length) result += ` New gaps/PLACEHOLDER: ${uniqueGaps.join(", ")}.`;
  const skippedLocked = numbered.filter((message) => isLockedNumber(numberFromMessage(message), lockin)).length;
  if (skippedLocked) result += ` Skipped ${skippedLocked} locked number(s).`;
  result += `\n${posted}`;
  return result;
}

async function runReworkNotApproved(client, interaction) {
  const rework = await ensureThread(client, REWORK_THREAD_ID);
  await safeEdit(interaction, "Scanning Rework for :NotApproved:…");

  const reworkMessages = await fetchAllMessages(rework);
  const lockin = await loadLockin();
  const byNumber = new Map();
  let skippedLocked = 0;
  let skippedUnnumbered = 0;

  for (const message of reworkMessages) {
    throwIfAborted("Rework NotApproved");
    if (!firstImageUrl(message)) continue;
    if (!hasNotApproved(message)) continue;
    const n = numberFromMessage(message);
    if (n == null) {
      skippedUnnumbered += 1;
      continue;
    }
    if (isLockedNumber(n, lockin)) {
      skippedLocked += 1;
      continue;
    }
    if (!byNumber.has(n)) byNumber.set(n, message);
  }

  const numbers = [...byNumber.keys()].sort((a, b) => a - b);
  if (numbers.length === 0) {
    let text = "No :NotApproved: Rework posts to gap.";
    if (skippedLocked) text += ` Skipped ${skippedLocked} locked number(s).`;
    if (skippedUnnumbered) text += ` Skipped ${skippedUnnumbered} unnumbered :NotApproved: post(s).`;
    return text;
  }

  const sequence = await loadSequence();
  ensureSequenceNumber(sequence, Math.max(...numbers, sequence.count || 0));
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const reviewByNumber = new Map();
  for (const entry of numberedEntries(await fetchAllMessages(review), client.user.id)) {
    if (!reviewByNumber.has(entry.n)) reviewByNumber.set(entry.n, entry.message);
  }

  addGaps(sequence, numbers, lockin);
  let placeholders = 0;
  let reviewUpdated = 0;
  let failed = 0;

  for (const [index, n] of numbers.entries()) {
    throwIfAborted("Rework NotApproved");
    await safeEdit(interaction, `Gapping ${n}.jpg (${index + 1}/${numbers.length})…`);
    try {
      const placed = await applyPlaceholderToNumber(n);
      if (!placed) {
        failed += 1;
        continue;
      }
      placeholders += 1;
      const item = sequence.items[n - 1];
      if (item) {
        item.placeholder = true;
        item.dirty = true;
        item.replaced = false;
        item.locked = false;
      }
      const reviewMessage = reviewByNumber.get(n);
      if (reviewMessage) {
        const ok = await tryEditNumberedImage(reviewMessage, n);
        if (ok) {
          if (item) item.dirty = false;
          await clearPostReactions(reviewMessage);
          reviewUpdated += 1;
        } else {
          failed += 1;
        }
      }
    } catch (error) {
      console.error(`rework-notapproved failed for ${n}:`, error.message || error);
      failed += 1;
    }
  }
  await saveSequence(sequence);

  await safeEdit(interaction, "Removing from Reconsider…");
  const purgedReconsider = await purgeReconsiderNumbers(client, numbers);

  await safeEdit(interaction, "Removing from Rework…");
  const reworkRemoved = await deleteReworkPostsForNumbers(client, numbers, (text) => safeEdit(interaction, text));

  try {
    await deleteDriveNumbers(DRIVE_FOLDER_RECONSIDER, numbers);
  } catch (error) {
    console.error("Drive Reconsider delete after rework-notapproved failed:", error.message || error);
  }

  const gapText = formatGapText(normalizeGaps(sequence), sequence.count, lockin);
  let result = `Gapped ${placeholders} number(s) from Rework :NotApproved:: ${numbers.join(", ")}.`;
  result += ` Edit per number PLACEHOLDER updated ${reviewUpdated}.`;
  result += ` Removed ${purgedReconsider} Reconsider post(s), ${reworkRemoved.deleted} Rework post(s).`;
  result += ` Sequence count stays ${sequence.count}.`;
  if (failed) result += ` ${failed} Edit per number update(s) failed — run /update-snatched.`;
  if (skippedLocked) result += ` Skipped ${skippedLocked} locked number(s).`;
  if (skippedUnnumbered) result += ` Skipped ${skippedUnnumbered} unnumbered :NotApproved: Rework post(s).`;
  result += `\n${gapText}`;
  return result;
}

async function runSnapshotReactions(client, interaction) {
  const dump = await dumpLineupReactionsByHash(client, (text) => safeEdit(interaction, text), {
    jobName: "snapshot-reactions",
    syncSequence: true,
  });
  await mergeReactionDb(dump.byHash, { rotate: true, extra: { source: "snapshot-reactions" } });
  const stats = dump.stats || summarizeReactionDump(dump);
  const noStatus = stats.reviewNoStatus;
  const hashFail = stats.reviewHashFailures;
  const review = stats.reviewPosts;
  const loudNone = review > 0 && (noStatus / review > 0.05 || noStatus > 40);
  const loudHash = review > 0 && (hashFail / review > 0.02 || hashFail > 20);
  const hashedZero = stats.postsWithReactions > 0 && stats.hashedWithReactions === 0;

  const lines = [
    `Wrote output/reaction-snapshot-by-hash.json (previous copy in .prev.json) and merged output/reactions-by-hash.json.`,
    `Each unlocked Edit per number post stored as: sequence number (n), unique image hash, attachment id, reactions.`,
    `Sequence count now ${dump.count} (Discord unlocked max ${dump.discordMax ?? "—"}, unlocked posts ${dump.discordPosts ?? review}). Locked ranges stay Final-only and are ignored by the editable sequence.`,
    `Locked numbers (Final only, ignored by sequence): ${dump.lockedSkipped || 0} absent + ${dump.lockedPresent || 0} leftover in Edit per number.`,
    `Unlocked posts in snapshot: ${dump.unlockedCount ?? review}.`,
    `Edit per number with a status reaction (:check: / :NotApproved: / :noted:): ${stats.reviewPosts - stats.reviewNoStatus}.`,
    `Edit per number with no status reaction: ${noStatus}.`,
    `Could not hash Edit per number attachment: ${hashFail}${stats.unhashedNumbers.length ? ` (numbers: ${stats.unhashedNumbers.join(", ")}${hashFail > stats.unhashedNumbers.length ? ", …" : ""})` : ""}.`,
    `Distinct image hashes with reactions: ${stats.hashedWithReactions}.`,
    `Emoji on Edit per number posts: :check: ${stats.emoji.check}, :NotApproved: ${stats.emoji.notApproved}, :noted:/repeat ${stats.emoji.repeat}.`,
    `Reconsider image posts: ${stats.reconsiderPosts} (no status: ${stats.reconsiderNoStatus}, unhashed: ${stats.reconsiderHashFailures}).`,
    `Did not compact, wipe, or change any Discord message.`,
  ];
  if (loudNone || hashedZero) {
    lines.push(
      `WARNING: ${noStatus} Edit per number posts have no check/NotApproved/:noted:. This snapshot is NOT trustworthy for compact. Do not run /reworkcount until those posts are marked.`,
    );
  }
  if (loudHash || hashedZero) {
    lines.push(
      `WARNING: attachment hashing failed on ${hashFail} Edit per number posts. A compact would drop those marks. Do not run /reworkcount until hashing succeeds.`,
    );
  }
  if (!loudNone && !loudHash && !hashedZero) {
    lines.push(`Looks usable: most lineup posts have a status mark and hashes landed. You can run /reworkcount next if you want to compact.`);
  }
  return lines.join("\n");
}
async function runGaps() {
  const sequence = await loadSequence();
  return formatGapText(normalizeGaps(sequence), sequence.count, await loadLockin());
}

async function runUpdateSnatched(client, interaction) {
  const sequence = await loadSequence();
  if (sequence.count === 0) {
    return "Sequence is empty. Run /snatchmarios first.";
  }

  const start = interaction.options.getInteger("from") ?? 1;
  const end = interaction.options.getInteger("to") ?? sequence.count;
  if (start > end) throw new Error("`from` must be less than or equal to `to`.");
  if (end > sequence.count) throw new Error(`Sequence only goes to ${sequence.count}.`);

  const review = await ensureThread(client, REVIEW_THREAD_ID);
  await safeEdit(interaction, `Scanning Edit per number for ${start}–${end}…`);

  const allMessages = await fetchAllMessages(review);
  const byNumber = new Map();
  for (const entry of numberedEntries(allMessages, client.user.id)) {
    if (!byNumber.has(entry.n)) byNumber.set(entry.n, entry.message);
  }

  const gaps = new Set(normalizeGaps(sequence));
  const lockin = await loadLockin();
  const targets = [];
  let skippedLocked = 0;
  for (let n = start; n <= end; n++) {
    if (isLockedNumber(n, lockin)) {
      skippedLocked += 1;
      continue;
    }
    const message = byNumber.get(n);
    if (!message) continue;
    const item = sequence.items[n - 1];
    const removed = gaps.has(n) || Boolean(item?.placeholder);
    const flagged = hasNotApproved(message);
    if (!removed && !flagged) continue;
    targets.push({ n, message, removed });
  }

  if (targets.length === 0) {
    const lockedNote = skippedLocked ? ` Skipped ${skippedLocked} locked number(s).` : "";
    return `Nothing to update in ${start}–${end}. Mark posts :NotApproved: or they must be gaps/removed.${lockedNote}`;
  }

  let updated = 0;
  let placeholders = 0;
  let failed = 0;
  const purged = [];
  for (const [index, target] of targets.entries()) {
    await safeEdit(interaction, `Updating ${target.n}.jpg (${index + 1}/${targets.length} in ${start}–${end})…`);
    try {
      if (target.removed) {
        await applyPlaceholderToNumber(target.n);
        const item = sequence.items[target.n - 1];
        if (item) {
          item.placeholder = true;
          item.dirty = true;
        }
        placeholders += 1;
      }
      const hadRework = hasReworkReaction(target.message);
      const ok = await tryEditNumberedImage(target.message, target.n);
      if (!ok) throw new Error("edit did not replace the attachment");
      const item = sequence.items[target.n - 1];
      if (item) item.dirty = false;
      if (!target.removed) {
        if (item) item.replaced = true;
        await clearPostReactions(target.message, { preserveRework: true });
        if (hadRework) await addReworkReaction(target.message);
        purged.push(target.n);
      }
      try {
        await pushSnatchNumber(target.n);
      } catch (error) {
        console.error(`Drive snatch upload ${target.n} failed:`, error.message || error);
      }
      updated += 1;
    } catch (error) {
      console.error(`Edit failed for ${target.n}:`, error.message || error);
      failed += 1;
    }
  }

  await saveSequence(sequence);
  if (purged.length) {
    const removed = await purgeReconsiderNumbers(client, purged);
    await safeEdit(interaction, `Removed ${removed} leftover Reconsider message(s) for replaced numbers.`);
  }
  let result = `Updated ${updated}/${targets.length} in ${start}–${end}. Sequence count stays ${sequence.count}.`;
  if (placeholders) result += ` ${placeholders} removed slot(s) set to PLACEHOLDER.`;
  if (skippedLocked) result += ` Skipped ${skippedLocked} locked number(s).`;
  if (failed) result += ` ${failed} could not be edited. Re-run this range if needed.`;
  return result;
}

async function runRemoveBatch(client, interaction) {
  const sequence = await loadSequence();
  if (sequence.count === 0) {
    return "Sequence is empty. Run /snatchmarios first.";
  }

  const start = interaction.options.getInteger("from", true);
  const end = interaction.options.getInteger("to", true);
  if (start > end) throw new Error("`from` must be less than or equal to `to`.");
  if (end > sequence.count) throw new Error(`Sequence only goes to ${sequence.count}.`);

  const numbers = [];
  const lockin = await loadLockin();
  const skippedLocked = [];
  for (let n = start; n <= end; n++) {
    if (isLockedNumber(n, lockin)) skippedLocked.push(n);
    else numbers.push(n);
  }
  if (numbers.length === 0) {
    throw new Error(`Every number in ${start}–${end} is locked by /lockin (${formatLockinRanges(lockin)}). Use /reconsider-replace to swap a locked image.`);
  }

  const review = await ensureThread(client, REVIEW_THREAD_ID);
  await safeEdit(interaction, `Removing ${start}–${end} (${numbers.length} slots)…`);

  const byNumber = new Map();
  for (const entry of numberedEntries(await fetchAllMessages(review), client.user.id)) {
    if (!byNumber.has(entry.n)) byNumber.set(entry.n, entry.message);
  }

  addGaps(sequence, numbers, lockin);
  let updated = 0;
  let failed = 0;
  for (const [index, n] of numbers.entries()) {
    await safeEdit(interaction, `PLACEHOLDER on ${n}.jpg (${index + 1}/${numbers.length})`);
    try {
      await applyPlaceholderToNumber(n);
      if (isLockedNumber(n, lockin)) continue;
      const item = sequence.items[n - 1];
      if (item) {
        item.placeholder = true;
        item.dirty = true;
        item.replaced = false;
      }
      const message = byNumber.get(n);
      if (message) {
        const ok = await tryEditNumberedImage(message, n);
        if (!ok) throw new Error("edit did not replace the attachment");
        if (item) item.dirty = false;
      }
      try {
        await pushSnatchNumber(n);
      } catch (error) {
        console.error(`Drive snatch upload ${n} failed:`, error.message || error);
      }
      updated += 1;
    } catch (error) {
      console.error(`removebatch failed for ${n}:`, error.message || error);
      failed += 1;
    }
  }

  await saveSequence(sequence);
  await purgeReconsiderNumbers(client, numbers);
  try {
    await deleteDriveNumbers(DRIVE_FOLDER_QUALITY, numbers);
  } catch (error) {
    console.error("Drive QC delete after removebatch failed:", error.message || error);
  }

  const posted = formatGapText(normalizeGaps(sequence), sequence.count, lockin);
  let result = `Removed ${updated}/${numbers.length} in ${start}–${end}. Sequence count stays ${sequence.count}.`;
  if (failed) result += ` ${failed} could not be updated in Edit per number.`;
  if (skippedLocked.length) result += ` Skipped ${skippedLocked.length} locked number(s): ${skippedLocked.join(", ")}.`;
  result += `\n${posted}`;
  return result;
}

async function runReworkCount(client, interaction) {
  const startOpt = interaction.options.getInteger("start");
  const checkpoint = await loadReworkCheckpoint();
  const before = await loadSequence();
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  const entries = numberedEntries(await fetchAllMessages(review), client.user.id);
  const lockin = await loadLockin();
  const truncated = !sequenceMatchesThread(entries, before.count, lockin);
  const resuming = Number.isInteger(startOpt)
    || checkpoint?.phase === "repost"
    || (truncated && entries.length > 0);

  if (resuming) {
    const resumeAt = Number.isInteger(startOpt) ? startOpt : (Number(checkpoint?.lastPosted) || 0) + 1;
    await setJobProgress("reworkcount", resumeAt, `fill ${resumeAt}`);
    await safeEdit(
      interaction,
      `Resuming lineup fill from ${resumeAt}. Existing posts will not be wiped. The saved reaction snapshot will not be overwritten.`,
    );
    const rebuilt = await rebuildReviewThread(client, (text) => safeEdit(interaction, text), {
      start: startOpt,
      fillOnly: true,
    });
    let text = `Resumed Edit per number without wiping existing posts. Sequence count ${rebuilt.count}.`;
    text += ` Filled ${rebuilt.filled || 0} missing number(s). Restored reactions on ${rebuilt.restored} new post(s) via image hash.`;
    text += `\nIf this was a truncated rebuild, re-react any numbers that still lack status emoji before running a fresh /reworkcount.`;
    return text;
  }

  await setJobProgress("reworkcount", 1, "snapshot reactions");
  await safeEdit(interaction, "Saving reactions by attachment hash before any number changes…");
  const dump = await dumpLineupReactionsByHash(client, (text) => safeEdit(interaction, text), {
    jobName: "reworkcount",
  });
  assertReactionDumpSafe(dump, { forWipe: true });
  await mergeReactionDb(dump.byHash, { rotate: true, extra: { source: "reworkcount-dump" } });

  await setJobProgress("reworkcount", 1, "starting");
  await safeEdit(interaction, `Closing gaps and compacting the lineup from ${before.count}…`);
  let result = await compactSequence((text) => safeEdit(interaction, text));
  let mapping = result.closed > 0 ? result.mapping : null;
  if (result.closed === 0) {
    const saved = await loadReworkMapping();
    if (saved?.mapping?.size && saved.oldCount > saved.newCount) {
      result = saved;
      mapping = saved.mapping;
    }
  } else {
    await saveReworkMapping(result);
  }

  await safeEdit(interaction, "Rebuild Edit per number from the packed files (wipe only if numbers no longer match, checkpointed)…");
  const rebuilt = await rebuildReviewThread(client, (text) => safeEdit(interaction, text), {
    mapping,
    packed: result.closed > 0,
    freshSnapshotAt: dump.at,
  });
  const localDeleted = await deleteLocalFilesAfter(rebuilt.count);

  try {
    await syncSnatchFolder((text) => safeEdit(interaction, text));
    const keep = [];
    for (let n = 1; n <= rebuilt.count; n++) keep.push(n);
    await pruneDriveToNumbers(DRIVE_FOLDER_RECONSIDER, keep);
  } catch (error) {
    console.error("Drive reworkcount sync failed:", error.message || error);
  }

  let text = result.closed
    ? `Closed ${result.closed} gap(s). Sequence count ${result.oldCount} → ${result.newCount}.`
    : `Sequence count is ${rebuilt.count}.`;
  if (rebuilt.wiped) text += ` Cleared unlocked Edit per number posts and filled missing unlocked numbers (locked numbers stay in Final only).`;
  else text += ` Did not wipe existing Edit per number posts. Filled ${rebuilt.filled || 0} missing number(s).`;
  text += ` Restored reactions on ${rebuilt.restored} image(s) via file hash.`;
  if (result.frozenGaps?.length) {
    text += ` Locked-range gaps left in place: ${result.frozenGaps.join(", ")}.`;
  }
  if (result.maxLocked) text += ` Numbers 1–${result.maxLocked} were not renumbered.`;
  if (localDeleted) text += ` Removed ${localDeleted} leftover local file(s).`;
  text += `\nRun /reconsider-rework next so Reconsider matches the new numbers.`;
  return text;
}

async function runDriveDedupe(interaction) {
  if (!driveConfigured()) return driveSetupHint();
  const choice = interaction.options.getString("folder") || "all";
  const confirm = interaction.options.getBoolean("confirm") === true;
  const folders = driveFoldersForChoice(choice);
  const lines = [];
  lines.push(confirm
    ? "Deleting extra same-name copies (keeping one file per name)."
    : "Dry run — no files deleted. Re-run with confirm:true to delete extras.");
  for (const folder of folders) {
    await safeEdit(interaction, `Scanning Drive folder ${folder.userName}…`);
    const result = confirm
      ? await dedupeDriveFolder(folder.id, { confirm: true, identicalMd5Only: false })
      : await reportDriveDuplicates(folder.id);
    const liveName = result.folder?.name || folder.userName;
    const nameNote = liveName !== folder.userName ? ` (Drive name: ${liveName})` : "";
    lines.push("");
    lines.push(`**${folder.userName}**${nameNote}`);
    lines.push(`Files: ${result.fileCount}. Unique names: ${result.uniqueNames}.`);
    lines.push(`Same-name extras: ${result.extraFiles} in ${result.nameDupeGroups} name(s) (${result.identicalMd5Extras} identical md5, ${result.mixedMd5Groups} mixed content).`);
    lines.push(`Same bytes under different names: ${result.contentDupesAcrossNames} group(s) (not deleted).`);
    if (confirm) lines.push(`Deleted ${result.deleted} extra file(s).`);
    for (const sample of result.nameSamples || []) {
      lines.push(`- ${sample.name} ×${sample.count}${sample.identicalMd5 ? " (same md5)" : " (different md5)"}`);
    }
  }
  if (!confirm) lines.push("\nNothing was deleted. `/drive-dedupe confirm:true` removes extra copies of the same filename in the same folder.");
  return lines.join("\n");
}

async function runReconsiderPull(client, interaction) {
  const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
  const sequence = await loadSequence();
  await safeEdit(interaction, "Pulling unique Reconsider images to Google Drive…");
  const messages = sortOldestFirst(await fetchAllMessages(reconsider));
  const seenNumbers = new Set();
  const seenHashes = new Set();
  const placeholderHash = await getPlaceholderHash();
  const lockin = await loadLockin();
  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const message of messages) {
    const images = collectImages(message);
    if (images.length === 0) continue;
    const n = numberFromMessage(message);
    if (n == null || seenNumbers.has(n) || isLockedNumber(n, lockin) || await isReplaceMeNumber(sequence, n)) {
      skipped += images.length;
      continue;
    }

    try {
      let source = null;
      try {
        source = await ensureCachedNumber(n);
      } catch {
        source = null;
      }
      if (!source) {
        source = await fetchBuffer(images[0].url);
      }
      const hash = typeof source === "string" ? await fileSha256(source) : sha256(source);
      if (hash === placeholderHash || seenHashes.has(hash)) {
        skipped += 1;
        continue;
      }
      await upsertNumberImage(n, source, { role: "reconsider" });
      seenNumbers.add(n);
      seenHashes.add(hash);
      saved += 1;
      await safeEdit(interaction, `Uploaded ${saved} unique to Google Drive (${n}.jpg)`);
    } catch (error) {
      console.error(`Reconsider pull failed:`, error.message || error);
      failed += 1;
    }
  }

  let pruned = 0;
  try {
    pruned = await pruneDriveToNumbers(DRIVE_FOLDER_RECONSIDER, [...seenNumbers]);
  } catch (error) {
    console.error("Drive reconsider prune failed:", error.message || error);
  }

  if (saved === 0 && failed === 0 && pruned === 0) {
    return skipped
      ? `Nothing to pull. Skipped ${skipped} duplicate/PLACEHOLDER image(s).`
      : "Reconsider has no images to pull.";
  }
  let result = `Saved ${saved} unique image(s) to the Reconsider Google Drive folder.`;
  if (pruned) result += ` Removed ${pruned} leftover file(s) that are no longer in the thread.`;
  if (skipped) result += ` Skipped ${skipped} duplicate/PLACEHOLDER.`;
  if (failed) result += ` ${failed} failed.`;
  return result;
}

async function runQualityControlled(client, interaction) {
  await assertFinalUnlocked("/quality-controlled");
  const review = await ensureThread(client, REVIEW_THREAD_ID);
  await safeEdit(interaction, "Finding :check: posts in Edit per number…");
  const sequence = await loadSequence();
  const gaps = new Set(normalizeGaps(sequence));
  const entries = numberedEntries(await fetchAllMessages(review), client.user.id);

  const seen = new Set();
  const approved = [];
  for (const entry of entries) {
    if (seen.has(entry.n) || !hasApproved(entry.message)) continue;
    seen.add(entry.n);
    const item = sequence.items[entry.n - 1];
    if (gaps.has(entry.n) || item?.placeholder) continue;
    approved.push(entry);
  }

  if (approved.length === 0) {
    return "No :check: approved images on Edit per number to pull.";
  }

  let saved = 0;
  let failed = 0;
  for (const [i, entry] of approved.entries()) {
    const filename = `${entry.n}.jpg`;
    await safeEdit(interaction, `Saving ${filename} (${i + 1}/${approved.length})…`);
    try {
      let source = null;
      try {
        source = await ensureCachedNumber(entry.n);
      } catch {
        source = null;
      }
      if (!source) {
        const url = firstImageUrl(entry.message);
        if (!url) throw new Error("no image on the Edit per number post");
        source = await fetchBuffer(url);
      }
      await upsertNumberImage(entry.n, source, { role: "quality" });
      saved += 1;
    } catch (error) {
      console.error(`Quality Controlled pull failed for ${entry.n}:`, error.message || error);
      failed += 1;
    }
  }

  let pruned = 0;
  try {
    await deleteDriveNumbers(DRIVE_FOLDER_RECONSIDER, approved.map((entry) => entry.n));
    pruned = await pruneDriveToNumbers(DRIVE_FOLDER_QUALITY, approved.map((entry) => entry.n));
  } catch (error) {
    console.error("Drive reconsider/QC sync after QC failed:", error.message || error);
  }

  let result = `Saved ${saved} approved image(s) to the Quality Controlled Google Drive folder.`;
  if (pruned) result += ` Removed ${pruned} leftover QC file(s) that are not currently :check:.`;
  if (failed) result += ` ${failed} failed.`;
  return result;
}

const client = new Client({
  rest: { timeout: 20_000 },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const review = await ensureThread(client, REVIEW_THREAD_ID);
    const reconsider = await ensureThread(client, RECONSIDER_THREAD_ID);
    const sequence = await loadSequence();
    await ensurePlaceholderFile();
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, review.guildId), { body: commands });
    console.log("Registered slash commands");
    console.log(`Linked channel: ${CHANNEL_ID}`);
    console.log(`Review thread: ${review.name} (${REVIEW_THREAD_ID})`);
    console.log(`Reconsider thread: ${RECONSIDER_THREAD_ID}`);
    try {
      const rework = await ensureThread(client, REWORK_THREAD_ID);
      const reconciled = await reconcileReworkThreadIndex(rework);
      logChannelPermissions("Rework", rework);
      if (rework.parent) logChannelPermissions("Rework parent", rework.parent);
      console.log(`Rework thread: ${rework.name} (${REWORK_THREAD_ID}) indexed ${Object.keys(reconciled.index.byHash).length} image(s)`);
    } catch (error) {
      console.error(`Rework thread unavailable (${REWORK_THREAD_ID}):`, error.message || error);
    }
    console.log(`Sequence count: ${sequence.count}`);
    const lockin = await loadLockin();
    console.log(`Lockin ranges: ${formatLockinRanges(lockin)}`);
    if (hasLockin(lockin)) {
      console.log(`Locked numbers are Final-only — ignored by Edit per number sequence except /reconsider-replace`);
    }
    const last = await loadJobProgress();
    if (last?.command || Number.isInteger(last?.number)) {
      const hint = resumeHint(last).trim();
      console.log(`Last job: ${last.command || "unknown"}${Number.isInteger(last.number) ? ` @ ${last.number}` : ""}`);
      if (hint) console.log(hint);
    }
    console.log(driveConfigured() ? "Google Drive: signed in (image source of truth; cache under output/.drive-cache)" : driveSetupHint());
    const canManageReview = logChannelPermissions("Edit per number", review);
    const canManageReconsider = logChannelPermissions("Reconsider", reconsider);
    if (review.parent) logChannelPermissions("Edit per number parent", review.parent);
    if (reconsider.parent) logChannelPermissions("Reconsider parent", reconsider.parent);
    if (!canManageReview || !canManageReconsider) {
      console.log(`Bot cannot clear others' :NotApproved: reactions without Manage Messages.`);
      console.log(`Re-invite (or enable Manage Messages on the bot role): ${botInviteUrl(client.user.id)}`);
    }
    bindStatusClient(client);
    await resolveReworkEmoji(review.guild);
    await ensureStatusChannel(review);
    startStatusWatchdog(client);
    await publishJobStatus(client);
    client.on("messageReactionAdd", (reaction) => {
      void handleReworkReactionAdd(client, reaction);
    });
  } catch (error) {
    console.error("Startup failed:", error.message || error);
    process.exit(1);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === "reconsider-replace") {
      const url = firstImageUrl(interaction.targetMessage);
      if (!url) {
        await interaction.reply({ content: "That message has no image to replace with.", ephemeral: true });
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId(`reconsider-replace:${interaction.targetMessage.id}`)
        .setTitle("Replace sequence image");
      const input = new TextInputBuilder()
        .setCustomId("number")
        .setLabel("Number file to replace (e.g. 42)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(6);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith("reconsider-replace:")) {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const messageId = interaction.customId.slice("reconsider-replace:".length);
        const n = Number.parseInt(interaction.fields.getTextInputValue("number").trim(), 10);
        const message = await interaction.channel.messages.fetch(messageId);
        const url = firstImageUrl(message);
        if (!url) throw new Error("That message has no image.");
        const result = await replaceNumber(client, n, url, (text) => safeEdit(interaction, text), { allowLocked: true });
        await finishReply(interaction, result);
      });
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "killsnatchnow") {
      const current = getJobProgress();
      const last = Number.isInteger(current?.number) || current?.command ? current : await loadJobProgress();
      const resume = resumeHint(last || current);
      if (!busy) {
        await interaction.reply({
          content: resume ? `Nothing is running.${resume}` : "Nothing is running.",
          ephemeral: true,
        });
        return;
      }
      requestAbort();
      scheduleStatusPublish(true);
      await interaction.reply({
        content: resume ? `Stopping.${resume}` : "Stopping the current job. It will quit after the step it’s on.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "snatchmarios") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runSnatchMarios(client, interaction);
        await finishReply(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "reconsider-run") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReconsider(client, interaction);
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "reconsider-replace") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const n = interaction.options.getInteger("number", true);
        const attachment = interaction.options.getAttachment("image", true);
        if (!attachment.contentType?.startsWith("image/") && !/\.(png|jpe?g|gif|webp)$/i.test(attachment.name || "")) {
          throw new Error("The attachment is not an image.");
        }
        const result = await replaceNumber(client, n, attachment.url, (text) => safeEdit(interaction, text), { allowLocked: true });
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "replace-bulk") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReplaceBulk(client, interaction);
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "reconsider-clear") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReconsiderClear(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "gaps") {
      await interaction.deferReply({ ephemeral: true });
      const result = await runGaps();
      await replyLong(interaction, result);
      return;
    }

    if (interaction.commandName === "reconsider-watermark") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReconsiderWatermark(client, interaction);
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "reconsider-pull") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReconsiderPull(client, interaction);
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "quality-controlled") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runQualityControlled(client, interaction);
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "update-snatched") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runUpdateSnatched(client, interaction);
        await safeEdit(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "lockin") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runLockin(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "removebatch") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runRemoveBatch(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "snapshot-reactions") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runSnapshotReactions(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "rework-sync") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const prune = interaction.options.getBoolean("prune") === true;
        const stats = await syncReworkThread(client, {
          prune,
          onProgress: (text) => safeEdit(interaction, text),
        });
        const lines = [
          `Rework sync: scanned ${stats.scanned}, marked ${stats.marked}, already in thread ${stats.already}, newly forwarded ${stats.forwarded}, recaptioned ${stats.recaptioned || 0}, skipped ${stats.skipped}${stats.locked ? `, locked ${stats.locked}` : ""}.`,
        ];
        if (stats.collapsed) lines.push(`Collapsed ${stats.collapsed} extra same-hash post(s) in Rework.`);
        else if (stats.extras) lines.push(`${stats.extras} extra same-hash post(s) were already indexed to the oldest copy.`);
        if (prune) lines.push(`Pruned ${stats.pruned} Rework post(s) that are no longer marked.`);
        else lines.push("Unmarked source posts were left in Rework (prune:true to remove them).");
        await finishReply(interaction, lines.join(" "));
      });
      return;
    }

    if (interaction.commandName === "rework-notapproved") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReworkNotApproved(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "reworkcount") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReworkCount(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }

    if (interaction.commandName === "reconsider-rework") {
      await interaction.deferReply({ ephemeral: true });
      await withBusy(interaction, async () => {
        const result = await runReconsiderRework(client, interaction);
        await replyLong(interaction, result);
      });
      return;
    }
  } catch (error) {
    console.error(error);
    const progress = getJobProgress();
    let text = error.message || "Command failed.";
    const hint = resumeHint(progress);
    if (hint && !text.includes(hint.trim()) && !text.includes("/killsnatchnow")) {
      text += hint;
    }
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: text });
      else await interaction.reply({ content: text, ephemeral: true });
    } catch {
      // ignore
    }
  }
});

client.login(TOKEN);
