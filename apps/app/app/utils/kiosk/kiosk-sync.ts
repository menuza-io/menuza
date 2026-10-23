/** The punch sync lives in `@repo/staffing/clock-sync`, shared with the Station till. */
export {
	MAX_SYNC_ATTEMPTS,
	syncBackoffMs,
	syncQueue,
	type SyncOutcome,
} from '@repo/staffing/clock-sync'
