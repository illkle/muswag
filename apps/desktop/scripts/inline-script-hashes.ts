import { createHash } from "node:crypto";

import type { Plugin } from "vite";

const CSP_META = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/;
const INLINE_SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

/**
 * Lets the page's inline scripts run under its Content-Security-Policy: adds the hash of each to the
 * policy's `script-src`. Fails when the page has no such policy, so that it is not dropped by mistake.
 */
export function addInlineScriptHashes(html: string): string {
  const meta = CSP_META.exec(html);
  if (!meta?.[2]?.includes("script-src")) throw new Error("The page has no Content-Security-Policy with a script-src to add its inline scripts to");
  // The browser hashes a script as it parsed it, with its line breaks made `\n`.
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map(([, body]) => `'sha256-${createHash("sha256").update(body!.replace(/\r\n?/g, "\n")).digest("base64")}'`);
  const policy = meta[2].replace(/script-src[^;]*/, (directive) => [directive.trimEnd(), ...hashes].join(" "));
  return html.replace(CSP_META, `$1${policy}$3`);
}

/**
 * Hashes the inline scripts of `index.html` into its policy, as they are once every other plugin has
 * had its turn: in development that includes React Refresh's preamble, which the policy cannot name
 * by itself.
 */
export function inlineScriptHashes(): Plugin {
  return {
    name: "muswag:inline-script-hashes",
    transformIndexHtml: { order: "post", handler: addInlineScriptHashes },
  };
}
