const SESSION_KEY = "explorer-session";
const OWN_KEY = "explorer-anthropic-key";

const fromBase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

// credentials.json holds a payload encrypted with a key derived from "user:password".
// A wrong pair fails to decrypt, so nothing about the account is stored in clear text.
export async function unlock(user, password) {
  const config = await fetch("credentials.json", { cache: "no-store" }).then((response) => response.json());
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${user}:${password}`), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: fromBase64(config.salt), iterations: config.iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(config.iv) }, key, fromBase64(config.ciphertext));
  return JSON.parse(new TextDecoder().decode(plain));
}

export function savedSession() {
  try { return JSON.parse(window.sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}

export function saveSession(session) {
  try { window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}

export function clearSession() {
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export function ownApiKey() {
  try { return window.localStorage.getItem(OWN_KEY) || ""; } catch { return ""; }
}

export function setOwnApiKey(value) {
  try {
    if (value) window.localStorage.setItem(OWN_KEY, value);
    else window.localStorage.removeItem(OWN_KEY);
  } catch {}
}
