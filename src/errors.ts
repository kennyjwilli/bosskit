/**
 * Errors raised by the job platform itself — a misconfigured registry or a
 * broken provider contract, not a job that failed. Always thrown at
 * construction or boot, never from a job handler.
 *
 * A plain named subclass rather than the app's `ExInfo`: importing that would
 * re-couple this library to the application it is deliberately independent of.
 * (`instanceof` is reliable here — the project targets ES2022, so no prototype
 * fixup is needed.)
 */
export class JobPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobPlatformError";
  }
}
