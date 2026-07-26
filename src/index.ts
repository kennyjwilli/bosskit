/**
 * Type-safe, user-scoped job queues for pg-boss.
 *
 * Build a platform with `createJobPlatform`, passing a registry declared with
 * `defineQueues` plus providers for the boss, the worker runtime, and a
 * database adapter. The drizzle adapter lives at `bosskit/drizzle`.
 */
export { createBoss } from "./boss";
export { JobPlatformError } from "./errors";
export { createJobPlatform } from "./platform";
export { type ScheduleDefinition, schedulesToRemove } from "./schedules";
export {
  $UserScoped,
  defineQueues,
  type JobLogger,
  type JobOptions,
  type QueueDefinition,
  type QueueNameOf,
  type QueuePayloadOf,
  type RegisteredWorker,
  type SendableOf,
  type UserScoped,
} from "./types";
