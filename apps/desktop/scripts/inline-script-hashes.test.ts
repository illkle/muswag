import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { addInlineScriptHashes } from "./inline-script-hashes.ts";

const hash = (script: string) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`;
const page = (head: string) => `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'" />${head}</head></html>`;
const policyOf = (html: string) => /Content-Security-Policy"\s+content="([^"]*)"/.exec(html)![1];

describe("addInlineScriptHashes", () => {
  it("adds the hash of every inline script to script-src, and leaves scripts with a source to 'self'", () => {
    const html = addInlineScriptHashes(page(`<script>first()</script><script type="module">second()</script><script type="module" src="/main.js"></script>`));

    expect(policyOf(html)).toBe(`default-src 'self'; script-src 'self' ${hash("first()")} ${hash("second()")}; style-src 'self'`);
  });

  it("hashes a script with its line breaks as the browser reads them", () => {
    const html = addInlineScriptHashes(page("<script>\r\n  run();\r\n</script>"));

    expect(policyOf(html)).toContain(hash("\n  run();\n"));
  });

  it("fails for a page without a policy to add to", () => {
    expect(() => addInlineScriptHashes("<html><head><script>run()</script></head></html>")).toThrow("no Content-Security-Policy");
  });

  it("finds the policy and the theme script of the renderer's page", async () => {
    const html = await readFile(new URL("../src/renderer/index.html", import.meta.url), "utf8");
    const theme = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;

    expect(policyOf(addInlineScriptHashes(html))).toContain(`script-src 'self' ${hash(theme)};`);
  });
});
