/**
 * Same schedule as the Station till's outbox (`apps/station/src/lib/outbox.ts`):
 * 5 s, 15 s, 1 min, 5 min, then every 15 min.
 */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000]

export const backoffFor = (attempts: number): number =>
	BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0]!

/** One upload gives up after this long, so a live request is never older. */
export const UPLOAD_TIMEOUT_MS = 60_000

/**
 * A row left `uploading` this long belongs to a request that died with the
 * app (or never answered); it is reclaimed instead of waiting forever.
 */
export const STALE_UPLOADING_MS = UPLOAD_TIMEOUT_MS + 30_000

/** Tries that count (offline never does) before the item stops and asks the person. */
export const MAX_ATTEMPTS = 10

/** While anything waits the queue looks again at least this often. */
export const POLL_MS = 60_000

/** After a refresh that could not finish, wait this long before trying again. */
export const SESSION_RETRY_MS = 60_000
