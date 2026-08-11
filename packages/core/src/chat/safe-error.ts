const REDACTED = '[REDACTED]';
const CREDENTIAL_NAME = /(api[_-]?key|token|secret|password|authorization)/iu;

export function safeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && CREDENTIAL_NAME.test(name)) {
      message = message.replaceAll(value, REDACTED);
    }
  }
  return message
    .replace(/(Bearer\s+)[^\s,;]+/giu, `$1${REDACTED}`)
    .replace(
      /((?:api[-_ ]?key|x-api-key|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      `$1${REDACTED}`
    );
}

export function credentialSafeError(error: unknown): Error {
  return new Error(safeErrorMessage(error));
}
