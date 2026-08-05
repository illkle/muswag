import { spawn } from "node:child_process";

export type CommandResult = {
  code: number | null;
  errorCode: string | null;
  stdout: string;
  stderr: string;
};

export function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      finish({ code: null, errorCode: error.code ?? "UNKNOWN", stderr, stdout });
      return;
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, errorCode: "ETIMEDOUT", stderr, stdout });
    }, options.timeoutMs ?? 5_000);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause: NodeJS.ErrnoException) => {
      finish({ code: null, errorCode: cause.code ?? "UNKNOWN", stderr, stdout });
    });
    child.on("close", (code) => {
      finish({ code, errorCode: null, stderr, stdout });
    });
  });
}
