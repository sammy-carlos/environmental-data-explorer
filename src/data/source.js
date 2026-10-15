import { state } from "../state.js";
import { clearSession } from "../auth/credentials.js";

// Per dataset: whether it is read from data/ and its release manifest.
const local = new Map();

// Files read from Hugging Face are kept in the browser's Cache Storage, so a second
// visit reads them without the network. Tables are keyed by the sha256 that the
// release manifest gives them: a new release downloads only the tables whose content
// changed, and a download that does not match its hash is never stored. Files the
// manifest does not hash (the guides) are keyed by the pinned revision.
const CACHE_NAME = "explorer-datasets-v1";
const CACHE_ORIGIN = "https://dataset-cache.invalid";
const traffic = { cached: 0, downloaded: 0, bytes: 0 };
const manifestRequests = new Map();

// On localhost the dataset can be synced into data/ with scripts/sync-data.sh;
// everywhere else the files come from the private Hugging Face release.
export async function usesLocalData() {
  const id = state.dataset.id;
  if (local.has(id)) return local.get(id);
  let found = false;
  if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    found = await fetch(`${state.dataset.localPath}/manifest.json`, { method: "HEAD", cache: "no-store" }).then((response) => response.ok, () => false);
  }
  local.set(id, found);
  return found;
}

export function localUrl(path) {
  return new URL(`${state.dataset.localPath}/${path}`, window.location.href).href;
}

function remoteUrl(path) {
  const { repository, revision } = state.dataset;
  return `https://huggingface.co/datasets/${repository}/resolve/${encodeURIComponent(revision)}/${path}`;
}

function sessionToken() {
  const token = state.session?.hfToken;
  if (!token) {
    // Forget the session so Retry asks to sign in again once credentials.json is updated.
    clearSession();
    throw new Error("This account has no access token for the dataset.");
  }
  return token;
}

async function download(path) {
  const response = await fetch(remoteUrl(path), { headers: { Authorization: `Bearer ${sessionToken()}` } });
  if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

// Cache Storage exists only on https and localhost, and a browser may refuse it; the
// explorer then reads from Hugging Face every time, as before.
async function openCache() {
  try {
    return await window.caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

const datasetPrefix = () => `${CACHE_ORIGIN}/${state.dataset.repository}/`;
const hashKey = (sha256) => `${datasetPrefix()}sha256/${sha256}`;
const revisionKey = (path) => `${datasetPrefix()}${encodeURIComponent(state.dataset.revision)}/${path}`;

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The manifest is asked for on every visit (a few kB), so a moved tag is noticed; when
// that fails the copy kept for this revision is used, and without one the files are
// read as they were before the cache existed.
function releaseManifest(cache) {
  const id = state.dataset.id;
  if (!manifestRequests.has(id)) manifestRequests.set(id, (async () => {
    try {
      const bytes = await download("manifest.json");
      await cache?.put(revisionKey("manifest.json"), new Response(bytes));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      const kept = await cache?.match(revisionKey("manifest.json"));
      if (kept) return kept.json();
      console.warn("Release manifest unavailable, reading files without the cache:", error);
      return null;
    }
  })());
  return manifestRequests.get(id);
}

async function cachedFile(path) {
  sessionToken();
  const cache = await openCache();
  if (!cache) return download(path);
  const manifest = await releaseManifest(cache);
  const entry = manifest && Object.values(manifest.tables || {}).find((table) => table.path === path);
  const key = entry?.sha256 ? hashKey(entry.sha256) : revisionKey(path);
  const kept = await cache.match(key);
  if (kept) {
    traffic.cached += 1;
    return new Uint8Array(await kept.arrayBuffer());
  }
  const bytes = await download(path);
  traffic.downloaded += 1;
  traffic.bytes += bytes.byteLength;
  if (entry?.sha256 && (await sha256Hex(bytes)) !== entry.sha256) {
    console.warn(`${path} does not match the hash in the release manifest; it is used but not kept.`);
    return bytes;
  }
  try {
    await cache.put(key, new Response(bytes));
  } catch (error) {
    console.warn(`Could not keep ${path} in the browser cache:`, error);
  }
  return bytes;
}

export async function datasetFile(path, as = "text") {
  let bytes;
  if (await usesLocalData()) {
    const response = await fetch(localUrl(path));
    if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    bytes = await cachedFile(path);
  }
  return as === "buffer" ? bytes : new TextDecoder().decode(bytes);
}

// After the tables are loaded, files of this dataset that the current release no longer
// names are deleted, so the cache holds about one release per dataset.
export async function pruneDatasetCache() {
  if (await usesLocalData()) return;
  const cache = await openCache();
  const manifest = cache && (await releaseManifest(cache));
  if (!manifest) return;
  const keep = new Set(Object.values(manifest.tables || {}).filter((table) => table.sha256).map((table) => hashKey(table.sha256)));
  const revision = revisionKey("");
  let removed = 0;
  for (const request of await cache.keys()) {
    const { href } = new URL(request.url);
    if (!href.startsWith(datasetPrefix()) || keep.has(href) || href.startsWith(revision)) continue;
    await cache.delete(request);
    removed += 1;
  }
  const megabytes = (traffic.bytes / 1e6).toFixed(1);
  console.info(`Dataset cache: ${traffic.cached} files read from the browser, ${traffic.downloaded} downloaded (${megabytes} MB), ${removed} old files removed.`);
}

// Signing out leaves nothing of the private datasets in the browser.
export async function clearDatasetCache() {
  try {
    await window.caches.delete(CACHE_NAME);
  } catch {}
}
