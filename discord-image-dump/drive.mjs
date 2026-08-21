import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import dotenv from "dotenv";
import { google } from "googleapis";
import {
  addLockinRange,
  filePathFor,
  formatLockinRanges,
  hasLockin,
  isLockedNumber,
  isReplaceMeNumber,
  loadLockin,
  loadSequence,
  OUTPUT_DIR,
  parseLockin,
  throwIfAborted,
  setJobProgress,
} from "./lib.mjs";

dotenv.config();

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ["https://www.googleapis.com/auth/drive"];

export const DRIVE_FOLDER_SNATCH = process.env.DRIVE_FOLDER_SNATCH || "1hQyxQco8dXXcAw47fEjLI0dQ53OrnDCw";
export const DRIVE_FOLDER_RECONSIDER = process.env.DRIVE_FOLDER_RECONSIDER || "1IyZN1dje6HMrIWE1fzWxyOZyO78-b7m2";
export const DRIVE_FOLDER_QUALITY = process.env.DRIVE_FOLDER_QUALITY || "1AM-ujE9Pv17hFtrE22ES0GbcHdhMCMTf";

export const DRIVE_FOLDER_ROLES = {
  snatch: { key: "snatch", id: DRIVE_FOLDER_SNATCH, userName: "All Mario Images" },
  reconsider: { key: "reconsider", id: DRIVE_FOLDER_RECONSIDER, userName: "Reconsider" },
  quality: { key: "quality", id: DRIVE_FOLDER_QUALITY, userName: "Final" },
};

export function driveFoldersForChoice(choice = "all") {
  if (choice && DRIVE_FOLDER_ROLES[choice]) return [DRIVE_FOLDER_ROLES[choice]];
  return Object.values(DRIVE_FOLDER_ROLES);
}

export const OAUTH_PATH = path.resolve(ROOT, process.env.GOOGLE_OAUTH_PATH || "google-oauth.json");
export const TOKEN_PATH = path.resolve(ROOT, process.env.GOOGLE_TOKEN_PATH || "google-token.json");
export const SERVICE_ACCOUNT_PATH = path.resolve(
  ROOT,
  process.env.GOOGLE_SERVICE_ACCOUNT_PATH || "google-service-account.json",
);

let driveClient;

export function driveConfigured() {
  return existsSync(SERVICE_ACCOUNT_PATH) || (existsSync(OAUTH_PATH) && existsSync(TOKEN_PATH));
}

export function driveSetupHint() {
  return "Google Drive is not signed in. Add google-oauth.json and run `npm run drive-login`, or add google-service-account.json and share the three folders with that account.";
}

function requireDrive() {
  if (!driveConfigured()) throw new Error(driveSetupHint());
}

function md5Of(source) {
  if (Buffer.isBuffer(source)) return createHash("md5").update(source).digest("hex");
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    createReadStream(source)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function mediaBody(source) {
  if (Buffer.isBuffer(source)) return Readable.from(source);
  return createReadStream(source);
}

function oauthClient(oauthJson) {
  const spec = oauthJson.installed || oauthJson.web;
  if (!spec?.client_id || !spec?.client_secret) {
    throw new Error("google-oauth.json is missing client_id/client_secret.");
  }
  const redirect = "http://127.0.0.1:3333/oauth2callback";
  return { auth: new google.auth.OAuth2(spec.client_id, spec.client_secret, redirect), redirect };
}

async function authorize() {
  if (existsSync(SERVICE_ACCOUNT_PATH)) {
    const auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_PATH,
      scopes: SCOPES,
    });
    return google.drive({ version: "v3", auth });
  }

  if (!existsSync(OAUTH_PATH) || !existsSync(TOKEN_PATH)) {
    throw new Error(driveSetupHint());
  }

  const oauthJson = JSON.parse(await readFile(OAUTH_PATH, "utf8"));
  const { auth } = oauthClient(oauthJson);
  auth.setCredentials(JSON.parse(await readFile(TOKEN_PATH, "utf8")));
  return google.drive({ version: "v3", auth });
}

async function drive() {
  if (!driveClient) driveClient = await authorize();
  return driveClient;
}

const DRIVE_LIST = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
  spaces: "drive",
};

const driveNameLocks = new Map();

function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function nameKey(name) {
  return String(name || "").toLowerCase();
}

function asDriveFile(file) {
  return {
    id: file.id,
    name: file.name || "",
    md5: file.md5Checksum || file.md5 || "",
    modifiedTime: file.modifiedTime || "",
  };
}

function groupFilesByName(files) {
  const groups = new Map();
  for (const file of files) {
    if (!file?.name) continue;
    const key = nameKey(file.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  return groups;
}

function pickKeeper(group, preferredMd5) {
  if (!group?.length) return null;
  if (preferredMd5) {
    const match = group.find((file) => file.md5 && file.md5 === preferredMd5);
    if (match) return match;
  }
  const exact = group.filter((file) => /^\d+\.jpe?g$/i.test(file.name));
  const pool = exact.length ? exact : group;
  return [...pool].sort((a, b) => String(b.modifiedTime || "").localeCompare(String(a.modifiedTime || "")))[0];
}

function withDriveNameLock(folderId, name, fn) {
  const key = `${folderId}::${nameKey(name)}`;
  const prev = driveNameLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  driveNameLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

async function listDrivePages(api, params) {
  const files = [];
  let pageToken;
  do {
    const res = await api.files.list({
      ...DRIVE_LIST,
      ...params,
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);
  return files.map(asDriveFile);
}

export async function getDriveFolderInfo(folderId) {
  const api = await drive();
  const res = await api.files.get({
    fileId: folderId,
    fields: "id, name",
    supportsAllDrives: true,
  });
  return { id: res.data.id, name: res.data.name };
}

export async function listAllDriveFiles(folderId) {
  const api = await drive();
  return listDrivePages(api, {
    q: `'${escapeDriveQuery(folderId)}' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, md5Checksum, modifiedTime)",
  });
}

export async function findDriveFilesByName(folderId, name) {
  const api = await drive();
  return listDrivePages(api, {
    q: `name = '${escapeDriveQuery(name)}' and '${escapeDriveQuery(folderId)}' in parents and trashed = false`,
    fields: "nextPageToken, files(id, name, md5Checksum, modifiedTime)",
  });
}

export function driveCacheDir() {
  return path.join(OUTPUT_DIR, ".drive-cache");
}

export function driveCachePathFor(n) {
  return path.join(driveCacheDir(), `${n}.jpg`);
}

/** Download file bytes from Drive. */
export async function downloadDriveFile(fileId) {
  requireDrive();
  const api = await drive();
  const res = await api.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data);
}

/** Exact `n.jpg` / `n.jpeg` keeper in one folder, or null. */
export async function findNumberOnDrive(n, folderId) {
  if (!Number.isInteger(n) || n < 1 || !folderId) return null;
  const jpg = await findDriveFilesByName(folderId, `${n}.jpg`);
  if (jpg.length) return pickKeeper(jpg);
  const jpeg = await findDriveFilesByName(folderId, `${n}.jpeg`);
  return jpeg.length ? pickKeeper(jpeg) : null;
}

export function driveFoldersForNumber(n, lockin) {
  if (isLockedNumber(n, lockin)) {
    return [DRIVE_FOLDER_QUALITY, DRIVE_FOLDER_SNATCH];
  }
  return [DRIVE_FOLDER_SNATCH, DRIVE_FOLDER_RECONSIDER];
}

/**
 * Resolve numbered image bytes. Prefer working cache, then Drive folders, then legacy output/{n}.jpg.
 * @returns {{ buffer: Buffer, path: string|null, folderId: string|null, fileId: string|null, source: "cache"|"drive"|"local" }}
 */
export async function resolveNumberImage(n, options = {}) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Number must be a positive integer (got ${n}).`);
  }
  const cachePath = driveCachePathFor(n);
  if (!options.skipCache && existsSync(cachePath)) {
    return {
      buffer: await readFile(cachePath),
      path: cachePath,
      folderId: null,
      fileId: null,
      source: "cache",
    };
  }

  if (driveConfigured()) {
    const lockin = options.lockin || await loadLockin();
    const folders = options.folders || driveFoldersForNumber(n, lockin);
    for (const folderId of folders) {
      const file = await findNumberOnDrive(n, folderId);
      if (!file?.id) continue;
      const buffer = await downloadDriveFile(file.id);
      return {
        buffer,
        path: null,
        folderId,
        fileId: file.id,
        source: "drive",
      };
    }
  }

  const legacy = filePathFor(n);
  if (existsSync(legacy)) {
    return {
      buffer: await readFile(legacy),
      path: legacy,
      folderId: null,
      fileId: null,
      source: "local",
    };
  }

  throw new Error(`No Drive/cache image for ${n}.jpg`);
}

/** Ensure `output/.drive-cache/{n}.jpg` exists; download from Drive if needed. */
export async function ensureCachedNumber(n, options = {}) {
  const cachePath = driveCachePathFor(n);
  await mkdir(driveCacheDir(), { recursive: true });
  if (!options.force && existsSync(cachePath)) return cachePath;
  const resolved = await resolveNumberImage(n, { ...options, skipCache: Boolean(options.force) });
  if (resolved.path === cachePath && !options.force) return cachePath;
  await writeFile(cachePath, resolved.buffer);
  return cachePath;
}

/** True if `n.jpg` exists in the Drive folders for that number (or working cache / legacy local). */
export async function numberExistsOnDrive(n, options = {}) {
  if (!Number.isInteger(n) || n < 1) return false;
  if (existsSync(driveCachePathFor(n)) || existsSync(filePathFor(n))) return true;
  if (!driveConfigured()) return false;
  const lockin = options.lockin || await loadLockin();
  const folders = options.folders || driveFoldersForNumber(n, lockin);
  for (const folderId of folders) {
    const file = await findNumberOnDrive(n, folderId);
    if (file?.id) return true;
  }
  return false;
}

/**
 * Upsert image bytes to the correct Drive folder and refresh the working cache.
 * role: "snatch" | "reconsider" | "quality" | undefined (auto: locked→Final, else snatch)
 */
export async function upsertNumberImage(n, source, { role } = {}) {
  requireDrive();
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Number must be a positive integer (got ${n}).`);
  }
  const lockin = await loadLockin();
  let folderId = DRIVE_FOLDER_SNATCH;
  if (role === "reconsider") folderId = DRIVE_FOLDER_RECONSIDER;
  else if (role === "quality") folderId = DRIVE_FOLDER_QUALITY;
  else if (role === "snatch") folderId = DRIVE_FOLDER_SNATCH;
  else if (isLockedNumber(n, lockin)) folderId = DRIVE_FOLDER_QUALITY;

  const result = await upsertDriveFile(folderId, `${n}.jpg`, source);
  const buffer = Buffer.isBuffer(source) ? source : await readFile(source);
  await mkdir(driveCacheDir(), { recursive: true });
  await writeFile(driveCachePathFor(n), buffer);
  return { result, folderId };
}

function matchesFromIndex(index, name) {
  if (!index) return null;
  const direct = index.get(name) || index.get(nameKey(name));
  if (!direct) return [];
  if (Array.isArray(direct)) return direct;
  const extras = direct.extras || [];
  return [{ id: direct.id, name, md5: direct.md5 || "", modifiedTime: direct.modifiedTime || "" }, ...extras];
}

function writeIndex(index, name, file, extras = []) {
  if (!index) return;
  index.set(name, { id: file.id, md5: file.md5 || "", extras });
  if (nameKey(name) !== name) index.set(nameKey(name), { id: file.id, md5: file.md5 || "", extras });
}

async function trashDriveFile(api, fileId) {
  try {
    await api.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    return "trashed";
  } catch {
    await api.files.delete({
      fileId,
      supportsAllDrives: true,
    });
    return "deleted";
  }
}

export function finalLockMessage(lock, action = "This command") {
  if (!hasLockin(lock)) return "";
  return `Final/lineup numbers ${formatLockinRanges(lock)} are locked by /lockin. ${action} would overwrite that. Lock another range with /lockin from: to:, or /lockin unlock:true to clear all locks.`;
}

export async function assertFinalUnlocked(action = "This command") {
  const lock = await loadLockin();
  if (!hasLockin(lock)) return;
  throw new Error(finalLockMessage(lock, action));
}

export async function listFolderFiles(folderId) {
  const groups = groupFilesByName(await listAllDriveFiles(folderId));
  const byName = new Map();
  for (const [key, group] of groups) {
    const keeper = pickKeeper(group);
    if (!keeper) continue;
    const extras = group.filter((file) => file.id !== keeper.id);
    byName.set(keeper.name, { id: keeper.id, md5: keeper.md5, extras });
    byName.set(key, { id: keeper.id, md5: keeper.md5, extras });
  }
  return byName;
}

async function collapseSameNameFiles(folderId, files, { keepMd5, dryRun = false } = {}) {
  if (!files?.length) return { kept: null, deleted: [] };
  if (files.length === 1) return { kept: files[0], deleted: [] };
  const kept = pickKeeper(files, keepMd5);
  const extras = files.filter((file) => file.id !== kept.id);
  const deleted = [];
  if (!dryRun) {
    const api = await drive();
    for (const extra of extras) {
      try {
        await api.files.delete({ fileId: extra.id, supportsAllDrives: true });
        deleted.push({ ...extra, identicalMd5: Boolean(extra.md5 && kept.md5 && extra.md5 === kept.md5) });
        console.log(`Drive deleted extra ${extra.name} (${extra.id})`);
      } catch (error) {
        console.error(`Drive delete extra ${extra.name} failed:`, error.message || error);
      }
    }
  } else {
    for (const extra of extras) {
      deleted.push({ ...extra, identicalMd5: Boolean(extra.md5 && kept.md5 && extra.md5 === kept.md5) });
    }
  }
  return { kept, deleted };
}

export function summarizeDriveDuplicates(files) {
  const groups = groupFilesByName(files);
  const byMd5 = new Map();
  const nameSamples = [];
  let extraFiles = 0;
  let nameGroups = 0;
  let identicalMd5Extras = 0;
  let mixedMd5Groups = 0;
  for (const [key, group] of groups) {
    if (group.length <= 1) continue;
    nameGroups += 1;
    extraFiles += group.length - 1;
    const md5s = new Set(group.map((file) => file.md5).filter(Boolean));
    const identical = md5s.size <= 1;
    if (identical) identicalMd5Extras += group.length - 1;
    else mixedMd5Groups += 1;
    if (nameSamples.length < 20) {
      nameSamples.push({
        name: group[0].name,
        key,
        count: group.length,
        identicalMd5: identical,
        ids: group.map((file) => file.id),
      });
    }
  }
  for (const file of files) {
    if (!file.md5) continue;
    if (!byMd5.has(file.md5)) byMd5.set(file.md5, []);
    byMd5.get(file.md5).push(file);
  }
  const contentAcrossNames = [...byMd5.values()]
    .map((group) => {
      const names = [...new Set(group.map((file) => nameKey(file.name)))];
      return names.length > 1 ? { md5: group[0].md5, names, count: group.length } : null;
    })
    .filter(Boolean);
  return {
    fileCount: files.length,
    uniqueNames: groups.size,
    nameDupeGroups: nameGroups,
    extraFiles,
    identicalMd5Extras,
    mixedMd5Groups,
    contentDupesAcrossNames: contentAcrossNames.length,
    nameSamples,
    contentSamples: contentAcrossNames.slice(0, 10),
  };
}

export async function reportDriveDuplicates(folderId) {
  requireDrive();
  const [info, files] = await Promise.all([
    getDriveFolderInfo(folderId),
    listAllDriveFiles(folderId),
  ]);
  return { folder: info, ...summarizeDriveDuplicates(files) };
}

export async function dedupeDriveFolder(folderId, { confirm = false, identicalMd5Only = true } = {}) {
  requireDrive();
  const files = await listAllDriveFiles(folderId);
  const info = await getDriveFolderInfo(folderId);
  const summary = summarizeDriveDuplicates(files);
  if (!confirm) {
    return { folder: info, dryRun: true, deleted: 0, ...summary };
  }
  const deleted = [];
  for (const group of groupFilesByName(files).values()) {
    if (group.length <= 1) continue;
    const md5s = new Set(group.map((file) => file.md5).filter(Boolean));
    const identical = md5s.size <= 1;
    if (identicalMd5Only && !identical) continue;
    const result = await collapseSameNameFiles(folderId, group);
    deleted.push(...result.deleted);
  }
  return {
    folder: info,
    dryRun: false,
    deleted: deleted.length,
    deletedIds: deleted.map((file) => file.id),
    identicalMd5Deleted: deleted.filter((file) => file.identicalMd5).length,
    ...summary,
  };
}

export async function upsertDriveFile(folderId, name, source, index) {
  requireDrive();
  return withDriveNameLock(folderId, name, async () => {
    const md5 = await md5Of(source);
    let matches = matchesFromIndex(index, name);
    if (!matches || matches.length === 0) {
      matches = await findDriveFilesByName(folderId, name);
    }
    if (matches.length > 1) {
      const collapsed = await collapseSameNameFiles(folderId, matches, { keepMd5: md5 });
      matches = collapsed.kept ? [collapsed.kept] : [];
    }
    const existing = matches[0];
    if (existing?.md5 && existing.md5 === md5) {
      writeIndex(index, name, { ...existing, md5 });
      return "skipped";
    }

    const api = await drive();
    const media = { mimeType: "image/jpeg", body: mediaBody(source) };

    if (existing?.id) {
      await api.files.update({
        fileId: existing.id,
        media,
        supportsAllDrives: true,
      });
      writeIndex(index, name, { id: existing.id, md5, name });
      console.log(`Drive updated ${name}`);
      return "updated";
    }

    const created = await api.files.create({
      requestBody: { name, parents: [folderId] },
      media,
      fields: "id",
      supportsAllDrives: true,
    });
    const after = await findDriveFilesByName(folderId, name);
    if (after.length > 1) {
      await collapseSameNameFiles(folderId, after, { keepMd5: md5 });
    }
    const id = created.data.id;
    writeIndex(index, name, { id, md5, name });
    console.log(`Drive created ${name}`);
    return "created";
  });
}


function isFileForNumber(name, n) {
  return new RegExp(`^${n}(?:-\\d+)?\\.jpe?g$`, "i").test(name);
}

function numberFromDriveName(name) {
  const match = String(name || "").match(/^(\d+)(?:-\d+)?\.jpe?g$/i);
  return match ? Number(match[1]) : null;
}

function isExactNumberName(name, n) {
  return new RegExp(`^${n}\\.jpe?g$`, "i").test(name);
}

export async function pruneDriveToNumbers(folderId, keepNumbers) {
  if (!driveConfigured()) return 0;
  const keep = new Set([...keepNumbers].filter((n) => Number.isInteger(n)));
  if (folderId === DRIVE_FOLDER_QUALITY) {
    const lock = await loadLockin();
    if (hasLockin(lock)) {
      const sequence = await loadSequence();
      for (const range of lock.ranges) {
        for (let n = range.from; n <= range.to; n++) {
          if (!(await isReplaceMeNumber(sequence, n))) keep.add(n);
        }
      }
    }
  }
  const files = await listAllDriveFiles(folderId);
  const api = await drive();
  let deleted = 0;

  const keepers = new Map();
  for (const file of files) {
    const n = numberFromDriveName(file.name);
    if (n != null && keep.has(n) && isExactNumberName(file.name, n)) {
      const prev = keepers.get(n);
      if (!prev) keepers.set(n, file);
      else keepers.set(n, pickKeeper([prev, file]));
    }
  }

  for (const file of files) {
    const leftoverRework = /^__rework_\d+\.jpe?g$/i.test(file.name);
    const n = numberFromDriveName(file.name);
    if (!leftoverRework && n == null) continue;
    const keeper = n != null ? keepers.get(n) : null;
    if (keeper && keeper.id === file.id) continue;
    try {
      await api.files.delete({ fileId: file.id, supportsAllDrives: true });
      deleted += 1;
      console.log(`Drive deleted ${file.name}`);
    } catch (error) {
      console.error(`Drive delete ${file.name} failed:`, error.message || error);
    }
  }
  return deleted;
}

export async function deleteDriveNumbers(folderId, numbers) {
  if (!driveConfigured()) return 0;
  const lock = folderId === DRIVE_FOLDER_QUALITY ? await loadLockin() : { ranges: [] };
  const want = [...new Set(numbers.filter((n) => Number.isInteger(n) && !isLockedNumber(n, lock)))];
  if (want.length === 0) return 0;

  const files = await listAllDriveFiles(folderId);
  const api = await drive();
  let deleted = 0;
  for (const file of files) {
    if (!want.some((n) => isFileForNumber(file.name, n))) continue;
    try {
      await api.files.delete({ fileId: file.id, supportsAllDrives: true });
      deleted += 1;
    } catch (error) {
      console.error(`Drive delete ${file.name} failed:`, error.message || error);
    }
  }
  return deleted;
}

export async function remapDriveNumbers(folderId, mapping) {
  if (!driveConfigured()) return 0;
  const jobs = [];
  for (const [oldN, newN] of mapping) {
    if (!Number.isInteger(oldN) || !Number.isInteger(newN) || oldN === newN) continue;
    jobs.push({ oldN, newN, tempName: `__rework_${newN}.jpg`, finalName: `${newN}.jpg` });
  }
  if (jobs.length === 0) return 0;

  const files = await listAllDriveFiles(folderId);
  const api = await drive();
  for (const job of jobs) {
    const existing = files.find((file) => isFileForNumber(file.name, job.oldN));
    if (!existing) continue;
    job.id = existing.id;
  }

  let renamed = 0;
  for (const job of jobs) {
    if (!job.id) continue;
    try {
      await api.files.update({
        fileId: job.id,
        requestBody: { name: job.tempName },
        supportsAllDrives: true,
      });
    } catch (error) {
      console.error(`Drive temp rename ${job.oldN} failed:`, error.message || error);
      job.id = null;
    }
  }
  for (const job of jobs) {
    if (!job.id) continue;
    try {
      await api.files.update({
        fileId: job.id,
        requestBody: { name: job.finalName },
        supportsAllDrives: true,
      });
      renamed += 1;
    } catch (error) {
      console.error(`Drive rename ${job.finalName} failed:`, error.message || error);
    }
  }
  return renamed;
}

async function mapPool(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      throwIfAborted("Drive sync");
      const index = next;
      next += 1;
      await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
}

export async function syncSnatchFolder(onProgress) {
  requireDrive();
  const sequence = await loadSequence();
  const keep = [];
  for (let n = 1; n <= sequence.count; n++) keep.push(n);
  const index = await listFolderFiles(DRIVE_FOLDER_SNATCH);
  const jobs = [];
  for (const n of keep) {
    const cachePath = driveCachePathFor(n);
    const localPath = filePathFor(n);
    const source = existsSync(cachePath) ? cachePath : existsSync(localPath) ? localPath : null;
    if (!source) continue;
    jobs.push({ name: `${n}.jpg`, source });
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  if (jobs.length) {
    let done = 0;
    await mapPool(jobs, 4, async (job) => {
      try {
        const result = await upsertDriveFile(DRIVE_FOLDER_SNATCH, job.name, job.source, index);
        if (result === "skipped") skipped += 1;
        else uploaded += 1;
      } catch (error) {
        failed += 1;
        console.error(`Drive snatch upload ${job.name} failed:`, error.message || error);
      }
      done += 1;
      if (done === jobs.length || done % 10 === 0) {
        const text = `Drive lineup ${done}/${jobs.length} (${uploaded} uploaded, ${skipped} already current)`;
        await setJobProgress("drive-sync", done, text);
        if (onProgress) await onProgress(text);
      }
    });
  }

  if (onProgress) await onProgress("Removing leftover Drive lineup files…");
  const pruned = await pruneDriveToNumbers(DRIVE_FOLDER_SNATCH, keep);
  return { uploaded, skipped, failed, total: jobs.length, pruned };
}

export async function pushSnatchNumber(n, source = null) {
  if (!driveConfigured()) return;
  const src = source
    || (existsSync(driveCachePathFor(n)) ? driveCachePathFor(n) : null)
    || (existsSync(filePathFor(n)) ? filePathFor(n) : null);
  if (!src) return;
  await upsertNumberImage(n, src, { role: "snatch" });
}

export async function pushQualityNumber(n, source = null) {
  if (!driveConfigured()) return;
  const lock = await loadLockin();
  if (hasLockin(lock) && !isLockedNumber(n, lock)) {
    console.warn(`Skipping Final upload ${n}.jpg — number is not in a /lockin range`);
    return "locked";
  }
  const sequence = await loadSequence();
  if (await isReplaceMeNumber(sequence, n)) {
    console.warn(`Skipping Final upload ${n}.jpg — PLACEHOLDER/gap`);
    return "gap";
  }
  const src = source
    || (existsSync(driveCachePathFor(n)) ? driveCachePathFor(n) : null)
    || (existsSync(filePathFor(n)) ? filePathFor(n) : null);
  if (!src) return;
  await upsertNumberImage(n, src, { role: "quality" });
}

export async function syncReconsiderNumbers(numbers, onProgress) {
  requireDrive();
  const keep = [...new Set(numbers.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const index = await listFolderFiles(DRIVE_FOLDER_RECONSIDER);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let done = 0;
  for (const n of keep) {
    let source = existsSync(driveCachePathFor(n)) ? driveCachePathFor(n) : null;
    if (!source && existsSync(filePathFor(n))) source = filePathFor(n);
    if (!source && driveConfigured()) {
      try {
        source = await ensureCachedNumber(n);
      } catch {
        source = null;
      }
    }
    if (!source) continue;
    try {
      const result = await upsertDriveFile(DRIVE_FOLDER_RECONSIDER, `${n}.jpg`, source, index);
      if (result === "skipped") skipped += 1;
      else uploaded += 1;
    } catch (error) {
      failed += 1;
      console.error(`Drive reconsider upload ${n} failed:`, error.message || error);
    }
    done += 1;
    if (onProgress && (done === keep.length || done % 10 === 0)) {
      await onProgress(`Drive reconsider ${done}/${keep.length} (${uploaded} uploaded, ${skipped} already current)`);
    }
  }
  const pruned = await pruneDriveToNumbers(DRIVE_FOLDER_RECONSIDER, keep);
  return { uploaded, skipped, failed, pruned, total: keep.length };
}

function finalEntryForNumber(index, n) {
  const name = `${n}.jpg`;
  return index.get(name) || index.get(name.toLowerCase()) || null;
}

function driveFilesHaveNumber(files, n) {
  return (files || []).some((file) => isExactNumberName(file.name, n));
}

/**
 * Confirm numbers are present in Final.
 * Local files are optional: if Final already has n.jpg and there is no local copy,
 * that counts as confirmed (Drive-only lockin / delete Edit-per-number path).
 * When a local file exists, md5 must match Final when Drive reports md5.
 */
export async function confirmFinalFiles(numbers) {
  requireDrive();
  const want = [...new Set((numbers || []).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const index = await listFolderFiles(DRIVE_FOLDER_QUALITY);
  const confirmed = [];
  const missing = [];
  const mismatched = [];
  for (const n of want) {
    throwIfAborted("Lock-in");
    const entry = finalEntryForNumber(index, n);
    if (!entry?.id) {
      missing.push(n);
      continue;
    }
    const localPath = filePathFor(n);
    const cachePath = driveCachePathFor(n);
    const comparePath = existsSync(cachePath) ? cachePath : existsSync(localPath) ? localPath : null;
    if (!comparePath) {
      confirmed.push(n);
      continue;
    }
    if (entry.md5) {
      const localMd5 = await md5Of(comparePath);
      if (entry.md5 !== localMd5) {
        mismatched.push(n);
        continue;
      }
    }
    confirmed.push(n);
  }
  return { confirmed, missing, mismatched };
}

export async function lockinFinalFolder({ from, to, confirm = false, reset = false, onProgress = async () => {} } = {}) {
  requireDrive();
  const sequence = await loadSequence();
  const count = Number(sequence.count) || 0;
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error("Provide from: and to: lineup numbers.");
  }
  if (from > to) throw new Error(`from (${from}) must be <= to (${to}).`);
  if (from < 1) throw new Error(`from (${from}) must be >= 1.`);
  // Local lineup may be empty (Drive + Discord only). Allow lockin when count is 0;
  // still refuse ranges past a known local count.
  if (count > 0 && to > count) {
    throw new Error(`Range ${from}–${to} is outside the lineup 1–${count}.`);
  }

  const current = await loadLockin();
  const nextLock = parseLockin({
    ranges: [...current.ranges, { from, to, at: new Date().toISOString() }],
  });

  const info = await getDriveFolderInfo(DRIVE_FOLDER_QUALITY);
  const existing = await listAllDriveFiles(DRIVE_FOLDER_QUALITY);
  const upload = [];
  const skippedGaps = [];
  const missing = [];
  const alreadyOnFinal = [];
  for (let n = from; n <= to; n++) {
    throwIfAborted("Lock-in");
    const onFinal = driveFilesHaveNumber(existing, n);
    // Empty local sequence marks every n as a "gap". If Final already has n.jpg,
    // treat it as a real locked image — do not skip or trash it.
    if (!onFinal && (await isReplaceMeNumber(sequence, n))) {
      skippedGaps.push(n);
      continue;
    }
    const localPath = filePathFor(n);
    const cachePath = driveCachePathFor(n);
    if (!existsSync(localPath) && !existsSync(cachePath)) {
      if (onFinal) alreadyOnFinal.push(n);
      else missing.push(n);
      continue;
    }
    upload.push({
      n,
      name: `${n}.jpg`,
      localPath: existsSync(cachePath) ? cachePath : localPath,
    });
  }

  const keep = new Set();
  const lockedGapNs = new Set();
  for (const range of nextLock.ranges) {
    for (let n = range.from; n <= range.to; n++) {
      const onFinal = driveFilesHaveNumber(existing, n);
      if (!onFinal && (await isReplaceMeNumber(sequence, n))) lockedGapNs.add(n);
      else keep.add(n);
    }
  }
  const toTrash = reset
    ? existing.filter((file) => {
      const n = numberFromDriveName(file.name);
      return n == null || !keep.has(n) || !isExactNumberName(file.name, n);
    })
    : [];
  const gapFiles = existing.filter((file) => {
    const n = numberFromDriveName(file.name);
    return n != null && lockedGapNs.has(n) && isExactNumberName(file.name, n);
  });

  const plan = {
    folder: info,
    from,
    to,
    count,
    reset,
    appendOnly: !reset,
    driveBacked: count === 0 || alreadyOnFinal.length > 0,
    rangesAfter: formatLockinRanges(nextLock),
    rangesBefore: formatLockinRanges(current),
    existing: existing.length,
    existingNames: existing.map((file) => file.name),
    wouldTrash: toTrash.length,
    trashNames: toTrash.map((file) => file.name),
    wouldTrashGapFiles: gapFiles.length,
    gapFileNames: gapFiles.map((file) => file.name),
    wouldKeep: existing.length - toTrash.length,
    upload: upload.length,
    alreadyOnFinal,
    skippedGaps,
    missing,
    dryRun: !confirm,
  };
  if (!confirm) return plan;

  const api = await drive();
  let trashed = 0;
  let trashFailed = 0;
  if (toTrash.length) {
    await onProgress(`RESET: trashing ${toTrash.length} Final file(s) that are not in locked ranges…`);
    for (const file of toTrash) {
      throwIfAborted("Lock-in");
      try {
        const how = await trashDriveFile(api, file.id);
        trashed += 1;
        console.log(`Drive ${how} ${file.name}`);
      } catch (error) {
        trashFailed += 1;
        console.error(`Drive trash ${file.name} failed:`, error.message || error);
      }
      if (trashed === toTrash.length || trashed % 25 === 0) {
        await setJobProgress("lockin", trashed, `Trashing Final extras ${trashed}/${toTrash.length}`);
        await onProgress(`Trashed ${trashed}/${toTrash.length} extras in Final…`);
      }
    }
  }

  const index = await listFolderFiles(DRIVE_FOLDER_QUALITY);
  let uploaded = 0;
  let already = 0;
  let failed = 0;
  let done = 0;
  if (upload.length) {
    await mapPool(upload, 4, async (job) => {
      try {
        const result = await upsertDriveFile(DRIVE_FOLDER_QUALITY, job.name, job.localPath, index);
        if (result === "skipped") already += 1;
        else uploaded += 1;
      } catch (error) {
        failed += 1;
        console.error(`Drive lock-in ${job.name} failed:`, error.message || error);
      }
      done += 1;
      if (done === upload.length || done % 10 === 0) {
        const text = `Lock-in ${done}/${upload.length} (${uploaded} uploaded, ${already} already current)`;
        await setJobProgress("lockin", job.n, text);
        await onProgress(text);
      }
    });
  }

  let pruned = 0;
  if (reset) {
    const leftovers = (await listAllDriveFiles(DRIVE_FOLDER_QUALITY)).filter((file) => {
      const n = numberFromDriveName(file.name);
      return n == null || !keep.has(n) || !isExactNumberName(file.name, n);
    });
    for (const file of leftovers) {
      throwIfAborted("Lock-in");
      try {
        await trashDriveFile(api, file.id);
        pruned += 1;
        console.log(`Drive trashed leftover ${file.name}`);
      } catch (error) {
        console.error(`Drive leftover trash ${file.name} failed:`, error.message || error);
      }
    }
  }

  let gapTrashed = 0;
  const liveForGaps = reset ? await listAllDriveFiles(DRIVE_FOLDER_QUALITY) : existing;
  const gapToTrash = liveForGaps.filter((file) => {
    const n = numberFromDriveName(file.name);
    return n != null && lockedGapNs.has(n) && isExactNumberName(file.name, n);
  });
  if (gapToTrash.length) {
    await onProgress(`Removing ${gapToTrash.length} PLACEHOLDER file(s) from Final (locked gaps have no Final image)…`);
    for (const file of gapToTrash) {
      throwIfAborted("Lock-in");
      try {
        await trashDriveFile(api, file.id);
        gapTrashed += 1;
        console.log(`Drive trashed locked-gap ${file.name}`);
      } catch (error) {
        console.error(`Drive locked-gap trash ${file.name} failed:`, error.message || error);
      }
    }
  }

  await onProgress("Confirming this range is present in Final…");
  // Confirm every real number in the range (local uploads + already on Final).
  const toVerify = [
    ...upload.map((job) => job.n),
    ...alreadyOnFinal,
  ];
  const verified = await confirmFinalFiles(toVerify);

  await addLockinRange(from, to, {
    uploaded: uploaded + already,
    alreadyOnFinal: alreadyOnFinal.length,
    skippedGaps,
    missing,
    confirmed: verified.confirmed,
  });

  return {
    ...plan,
    dryRun: false,
    trashed,
    trashFailed,
    uploaded,
    already: already + alreadyOnFinal.length,
    failed,
    pruned,
    gapTrashed,
    confirmed: verified.confirmed,
    verifyMissing: verified.missing,
    verifyMismatched: verified.mismatched,
  };
}

function openUrl(url) {
  const command = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(command);
}

export async function runDriveLogin() {
  if (!existsSync(OAUTH_PATH)) {
    throw new Error(`Missing ${OAUTH_PATH}. Create an OAuth Desktop client in Google Cloud, enable Drive API, and save the JSON here.`);
  }

  const oauthJson = JSON.parse(await readFile(OAUTH_PATH, "utf8"));
  const { auth, redirect } = oauthClient(oauthJson);
  const redirectUrl = new URL(redirect);
  const port = Number(redirectUrl.port || 3333);
  const authUrl = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  const tokens = await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `${redirectUrl.protocol}//${redirectUrl.host}`);
        const code = reqUrl.searchParams.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing code");
          return;
        }
        const result = await auth.getToken(code);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Google Drive is connected. You can close this tab.");
        server.close();
        resolve(result.tokens);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(error.message || "Login failed");
        server.close();
        reject(error);
      }
    });
    server.on("error", reject);
    server.listen(port, redirectUrl.hostname, () => {
      console.log("Open this URL if the browser does not launch:");
      console.log(authUrl);
      openUrl(authUrl);
    });
  });

  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`Saved ${TOKEN_PATH}`);
}
