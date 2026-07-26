/**
 * Type-safe, user-scoped job queues for pg-boss.
 *
 * Build a platform with `createJobPlatform`, passing a registry declared with
 * `defineQueues` plus providers for the boss, the worker runtime, and a
 * database adapter. pg-boss ships the adapters (`fromDrizzle`, `fromKnex`,
 * `fromKysely`, `fromPrisma`, `fromPglite`); any client that can run one SQL
 * statement is a few lines away from its own.
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
