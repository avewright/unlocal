/**
 * Every failure unlocal reports has a stable, machine-readable code.
 * Agents branch on `code` and exit status — never on message text.
 */
export type ErrorCode =
  | "USAGE"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_EXISTS"
  | "CONFIG_INVALID"
  | "SITE_NOT_FOUND"
  | "STATE_CORRUPT"
  | "BUSY"
  | "APPROVAL_REQUIRED"
  | "BUDGET_EXCEEDED"
  | "DESTRUCTIVE_CHANGE"
  | "CAP_NOT_SET"
  | "CAP_EXCEEDED"
  | "FUNDS_INSUFFICIENT"
  | "ACCOUNT_FROZEN"
  | "HUMAN_REQUIRED"
  | "NAME_TAKEN"
  | "UNAUTHENTICATED"
  | "CLOUD_AUTH"
  | "PLAN_STALE"
  | "PLAN_INVALID"
  | "APPLY_FAILED"
  | "PROVIDER_UNAVAILABLE"
  | "PAYMENT_FAILED"
  | "INTERNAL";

/** Exit codes: 1 = failure, 2 = needs a human/agent decision, 3 = bad config, 4 = stale plan, 64 = bad usage. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE: 64,
  CONFIG_NOT_FOUND: 3,
  CONFIG_EXISTS: 3,
  CONFIG_INVALID: 3,
  SITE_NOT_FOUND: 3,
  STATE_CORRUPT: 1,
  BUSY: 1,
  APPROVAL_REQUIRED: 2,
  BUDGET_EXCEEDED: 2,
  DESTRUCTIVE_CHANGE: 2,
  CAP_NOT_SET: 2,
  CAP_EXCEEDED: 2,
  FUNDS_INSUFFICIENT: 2,
  ACCOUNT_FROZEN: 2,
  HUMAN_REQUIRED: 2,
  NAME_TAKEN: 3,
  UNAUTHENTICATED: 2,
  CLOUD_AUTH: 2,
  PLAN_STALE: 4,
  PLAN_INVALID: 4,
  APPLY_FAILED: 1,
  PROVIDER_UNAVAILABLE: 1,
  PAYMENT_FAILED: 1,
  INTERNAL: 1,
};

export interface UnlocalErrorOptions {
  /** What the caller should do next, phrased as an instruction. */
  hint?: string;
  /** Structured context (validation issues, partial results, ...). */
  details?: unknown;
  cause?: unknown;
}

export class UnlocalError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: UnlocalErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "UnlocalError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}
