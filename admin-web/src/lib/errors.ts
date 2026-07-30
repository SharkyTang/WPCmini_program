export class AdminApiError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AdminApiError";
    this.code = code;
    this.details = details;
  }
}

export function getErrorMessage(error: unknown, fallback = "操作失败，请稍后重试"): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}
