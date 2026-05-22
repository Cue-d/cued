export type ChromiumAuthFailureCode =
  | "auth_window_closed"
  | "auth_timeout"
  | "auth_extraction_failed"
  | "browser_runtime_failed";

export function classifyChromiumAuthWaitFailure(lastExtractionError: string | null): {
  errorCode: ChromiumAuthFailureCode;
  stage: "extract_auth" | "wait_for_auth";
} {
  return lastExtractionError
    ? { errorCode: "auth_extraction_failed", stage: "extract_auth" }
    : { errorCode: "auth_timeout", stage: "wait_for_auth" };
}
