import type { MpvLocatorDeps } from "./mpv-locator";

const VERSION_PROBE_TIMEOUT_MS = 5_000;
const MINIMUM_MPV_VERSION = [0, 41, 0] as const;

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
  const version = parseMpvVersion(result.stdout);
  if (!version) return { missing: false, ok: false, reason: "The mpv version could not be parsed from `--version` output." };
  if (isBelowMinimum(version.parts)) {
    return { missing: false, ok: false, reason: `mpv ${version.text} is too old. Muswag requires mpv ${MINIMUM_MPV_VERSION.join(".")} or newer.` };
  }
  return { ok: true, version: version.text };
}

type VersionParts = readonly [number, number, number];

function parseMpvVersion(stdout: string): { parts: VersionParts; text: string } | null {
  const [, text, major, minor, patch] = /^mpv\s+v?((\d+)\.(\d+)\.(\d+)(?:[-+]\S+)?)/im.exec(stdout) ?? [];
  if (!text) return null;
  return { parts: [Number(major), Number(minor), Number(patch)], text };
}

function isBelowMinimum([major, minor, patch]: VersionParts): boolean {
  const [minimumMajor, minimumMinor, minimumPatch] = MINIMUM_MPV_VERSION;
  if (major !== minimumMajor) return major < minimumMajor;
  if (minor !== minimumMinor) return minor < minimumMinor;
  return patch < minimumPatch;
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
