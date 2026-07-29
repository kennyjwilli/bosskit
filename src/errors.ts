/**
 * Errors raised by the job platform itself — a misconfigured registry, or a
 * declared schedule whose payload doesn't satisfy its queue's schema. Never a
 * job that failed. Always thrown at construction, boot, or schedule sync,
 * never from a job handler.
 *
 * A plain named subclass rather than a richer error type from some error
 * framework: bosskit has zero runtime dependencies, and an error class is not
 * worth acquiring one — nor worth forcing a dependency on callers who already
 * have their own. (`instanceof` is reliable here — the package targets ES2022,
 * so no prototype fixup is needed.)
 */
export class JobPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobPlatformError";
  }
}
