/** The offline punch queue lives in `@repo/staffing/clock-queue`, shared with the Station till. */
export {
	createClockQueue as createKioskQueue,
	MAX_QUEUED_PUNCHES,
	QueueUnavailableError,
	type ClockQueue as KioskQueue,
	type EnqueueInput,
	type QueuedPunch,
	type QueuedPunchKind,
} from '@repo/staffing/clock-queue'
