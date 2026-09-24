// Writes credentials.json for a shared account.
//
//   node scripts/make-credentials.mjs <user> <password>
//
// Secrets are read from the environment and stored encrypted with a key derived
// from "user:password":
//   HF_TOKEN           read-only Hugging Face token scoped to the dataset repository
//   ANTHROPIC_API_KEY  key used by the assistant (set a spend limit on it)
import { webcrypto as crypto } from "node:crypto";
import { writeFileSync } from "node:fs";

const [user, password] = process.argv.slice(2);
if (!user || !password) {
  console.error("Usage: node scripts/make-credentials.mjs <user> <password>");
  process.exit(1);
}

const ITERATIONS = 250000;
const encoder = new TextEncoder();
const toBase64 = (bytes) => Buffer.from(bytes).toString("base64");
const payload = {
  hfToken: process.env.HF_TOKEN || null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
};

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const material = await crypto.subtle.importKey("raw", encoder.encode(`${user}:${password}`), "PBKDF2", false, ["deriveKey"]);
const key = await crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
  material,
  { name: "AES-GCM", length: 256 },
  false,
  ["encrypt"],
);
const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));

const file = new URL("../credentials.json", import.meta.url);
writeFileSync(file, `${JSON.stringify({
  version: 1,
  kdf: "PBKDF2-SHA256",
  iterations: ITERATIONS,
  salt: toBase64(salt),
  iv: toBase64(iv),
  ciphertext: toBase64(new Uint8Array(ciphertext)),
}, null, 2)}\n`);

const secrets = [payload.hfToken && "Hugging Face token", payload.anthropicApiKey && "Anthropic key"].filter(Boolean);
console.log(`credentials.json written for "${user}"${secrets.length ? ` with ${secrets.join(" and ")}` : " without secrets"}`);
