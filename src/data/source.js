import { state } from "../state.js";
import { clearSession } from "../auth/credentials.js";

let local = null;

// On localhost the dataset can be synced into data/ with scripts/sync-data.sh;
// everywhere else the files come from the private Hugging Face release.
export async function usesLocalData() {
  if (local !== null) return local;
  if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return (local = false);
  try {
    const response = await fetch(`${state.dataset.localPath}/manifest.json`, { method: "HEAD", cache: "no-store" });
    local = response.ok;
  } catch {
    local = false;
  }
  return local;
}

export function localUrl(path) {
  return new URL(`${state.dataset.localPath}/${path}`, window.location.href).href;
}

function remoteUrl(path) {
  const { repository, revision } = state.dataset;
  return `https://huggingface.co/datasets/${repository}/resolve/${encodeURIComponent(revision)}/${path}`;
}

export async function datasetFile(path, as = "text") {
  let response;
  if (await usesLocalData()) {
    response = await fetch(localUrl(path));
  } else {
    const token = state.session?.hfToken;
    if (!token) {
      // Forget the session so Retry asks to sign in again once credentials.json is updated.
      clearSession();
      throw new Error("This account has no access token for the dataset.");
    }
    response = await fetch(remoteUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`);
  return as === "buffer" ? new Uint8Array(await response.arrayBuffer()) : response.text();
}
