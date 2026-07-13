export type RelayErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "TENANT_SCOPE_DENIED"
  | "VALIDATION_FAILED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "IDEMPOTENCY_FAILED"
  | "CONFIGURATION_INVALID"
  | "DEPENDENCY_UNAVAILABLE"
  | "POLICY_BLOCKED"
  | "VEIL_DECISION_REQUIRED"
  | "VEIL_DECISION_INVALID"
  | "VEIL_DECISION_REPLAYED";

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly status: number;
  readonly details: readonly string[];
  readonly retryable: boolean;

  constructor(
    code: RelayErrorCode,
    message: string,
    status: number,
    details: readonly string[] = [],
    retryable = false,
  ) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

export function validationFailed(details: readonly string[]): RelayError {
  return new RelayError("VALIDATION_FAILED", "Request validation failed.", 422, details);
}
