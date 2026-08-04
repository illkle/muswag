import type { MpvLocatorDeps } from "./mpv-locator";

const VERSION_PROBE_TIMEOUT_MS = 5_000;

export type MpvValidation = { ok: true; version: string } | { ok: false; missing: boolean; reason: string };

export async function validateMpvBinary(binaryPath: string, deps: MpvLocatorDeps): Promise<MpvValidation> {
  const result = await deps.runCommand(binaryPath, ["--version"], { env: deps.env, timeoutMs: VERSION_PROBE_TIMEOUT_MS });
  if (result.errorCode === "ENOENT") return { missing: true, ok: false, reason: "The file does not exist." };
  if (result.errorCode) return { missing: false, ok: false, reason: describeSpawnErrorCode(result.errorCode) };
  if (result.code !== 0) {
    const detail = firstNonEmptyLine(result.stderr) ?? firstNonEmptyLine(result.stdout);
    return {
      missing: false,
      ok: false,
      reason: detail ? `\`--version\` exited with code ${result.code}: ${detail}` : `\`--version\` exited with code ${result.code}.`,
    };
  }
  return { ok: true, version: parseMpvVersion(result.stdout) };
}

function parseMpvVersion(stdout: string): string {
  return /^mpv\s+v?(\S+)/im.exec(stdout)?.[1] ?? firstNonEmptyLine(stdout) ?? "unknown";
}

function firstNonEmptyLine(value: string): string | null {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function describeSpawnErrorCode(errorCode: string): string {
  if (errorCode === "EACCES") return "The file is not executable.";
  if (errorCode === "ETIMEDOUT") return "`--version` did not finish in time.";
  if (errorCode === "EFTYPE" || errorCode === "ENOEXEC") return "The file is not a runnable binary for this machine.";
  return `The binary could not be started (${errorCode}).`;
}
