export type LogFields = Record<string, unknown>;

export interface IntegrationLogger {
  logInfo(message: string, fields?: LogFields): void;
  logWarn(message: string, fields?: LogFields): void;
  logError(message: string, fields?: LogFields): void;
  serializeError(error: unknown): LogFields;
  timeStep<T>(label: string, action: () => Promise<T>, fields?: LogFields): Promise<T>;
}

export function createIntegrationLogger(scope: string): IntegrationLogger {
  const startedAt = Date.now();

  function elapsedMs(): number {
    return Date.now() - startedAt;
  }

  function serializeError(error: unknown): LogFields {
    if (error instanceof Error) {
      return {
        errorName: error.name,
        errorMessage: error.message,
        errorStack: error.stack,
      };
    }

    return { errorMessage: String(error) };
  }

  function logMessage(level: "info" | "warn" | "error", message: string, fields?: LogFields): void {
    const suffix = fields ? ` ${JSON.stringify(fields)}` : "";
    const output = `[${scope} +${elapsedMs()}ms] ${message}${suffix}`;

    if (level === "info") {
      console.info(output);
      return;
    }
    if (level === "warn") {
      console.warn(output);
      return;
    }
    console.error(output);
  }

  async function timeStep<T>(
    label: string,
    action: () => Promise<T>,
    fields?: LogFields,
  ): Promise<T> {
    const stepStartedAt = Date.now();
    logMessage("info", `${label}:start`, fields);

    try {
      const result = await action();
      logMessage("info", `${label}:done`, {
        ...fields,
        durationMs: Date.now() - stepStartedAt,
      });
      return result;
    } catch (error) {
      logMessage("error", `${label}:failed`, {
        ...fields,
        durationMs: Date.now() - stepStartedAt,
        ...serializeError(error),
      });
      throw error;
    }
  }

  return {
    logInfo: (message, fields) => logMessage("info", message, fields),
    logWarn: (message, fields) => logMessage("warn", message, fields),
    logError: (message, fields) => logMessage("error", message, fields),
    serializeError,
    timeStep,
  };
}
