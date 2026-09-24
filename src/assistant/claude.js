import Anthropic from "@anthropic-ai/sdk";
import { state } from "../state.js";

export { Anthropic };

let client = null;
let clientKey = null;

function clientFor(apiKey) {
  if (!client || clientKey !== apiKey) {
    // The key is either the demo key decrypted after sign-in or one the user pasted.
    client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    clientKey = apiKey;
  }
  return client;
}

export function modelLabel() {
  const words = [];
  const numbers = [];
  for (const part of state.assistant.model.split("-")) (/^\d+$/.test(part) ? numbers : words).push(part);
  return [...words.map((word) => word[0].toUpperCase() + word.slice(1)), numbers.join(".")].filter(Boolean).join(" ");
}

// One streamed turn. Top-level cache_control caches the growing conversation, so the
// guide and tool definitions are billed at the cache-read rate after the first call.
export function streamTurn({ apiKey, system, tools, messages, onText }) {
  const { model, effort, maxTokens, fallbacks } = state.assistant;
  const request = {
    model,
    max_tokens: maxTokens,
    output_config: { effort },
    cache_control: { type: "ephemeral" },
    system,
    tools,
    messages,
  };
  const stream = fallbacks
    ? clientFor(apiKey).beta.messages.stream({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks })
    : clientFor(apiKey).messages.stream(request);
  stream.on("text", onText);
  return stream.finalMessage();
}
