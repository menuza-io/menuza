import { KioskApiError, KioskNetworkError, type KioskApi } from './kiosk-api.ts'
import { type KioskQueue } from './kiosk-queue.ts'

/**
 * Sends queued punches to the server, oldest first, one at a time. The order
 * matters (a clock-in must land before its break), so a punch that cannot be
 * judged yet (offline, an outage, a PIN pause) stops the run and everything
 * behind it waits. A punch the server refuses for good is set aside with its
 * reason so the tablet can tell a manager; it never blocks the line.
 */

/** After this many failed tries on server errors, give up and set it aside. */
export const MAX_SYNC_ATTEMPTS = 8

export type SyncOutcome = {
	synced: number
	failed: number
	/** Seconds the caller should wait before trying again, when known. */
	retryAfterSeconds: number | null
	/** The device was removed: stop everything and pair again. */
	deviceGone: boolean
	/** The refusal behind `deviceGone`; only a revocation is certain. */
	deviceGoneCode?: string
	/** Still waiting after this run. */
	remaining: number
}

export async function syncQueue(deps: {
	queue: KioskQueue
	api: Pick<KioskApi, 'punch'>
	now?: () => number
}): Promise<SyncOutcome> {
	const { queue, api } = deps
	const now = deps.now ?? (() => Date.now())
	const outcome: SyncOutcome = {
		synced: 0,
		failed: 0,
		retryAfterSeconds: null,
		deviceGone: false,
		remaining: 0,
	}

	for (const item of await queue.pending()) {
		let pin: string
		try {
			pin = await queue.readPin(item)
		} catch {
			await queue.markFailed(item.id, 'unreadable')
			outcome.failed += 1
			continue
		}
		try {
			await api.punch({
				id: item.id,
				kind: item.kind,
				pin,
				...(item.staffId ? { staffId: item.staffId } : {}),
				...(item.positionId ? { positionId: item.positionId } : {}),
				...(item.breakKind ? { breakKind: item.breakKind } : {}),
				...(item.cashTipsMinor !== undefined
					? { cashTipsMinor: item.cashTipsMinor }
					: {}),
				clientAt: item.clientAt,
				deviceNowAt: now(),
				offline: true,
			})
			await queue.remove(item.id)
			outcome.synced += 1
		} catch (error) {
			if (error instanceof KioskNetworkError) break
			if (error instanceof KioskApiError) {
				if (error.paused) {
					// An operator pause, not a verdict on this punch: keep it and wait.
					outcome.retryAfterSeconds = 60
					break
				}
				if (error.deviceGone) {
					outcome.deviceGone = true
					outcome.deviceGoneCode = error.code
					break
				}
				if (error.transient) {
					await queue.recordAttempt(item.id)
					if (item.attempts + 1 >= MAX_SYNC_ATTEMPTS && error.status >= 500) {
						await queue.markFailed(item.id, 'server_unavailable')
						outcome.failed += 1
						continue
					}
					outcome.retryAfterSeconds = error.retryAfterSeconds || null
					break
				}
				await queue.markFailed(item.id, error.code)
				outcome.failed += 1
				continue
			}
			// Anything unexpected: keep the punch and try again next time.
			await queue.recordAttempt(item.id)
			break
		}
	}
	outcome.remaining = (await queue.counts()).queued
	return outcome
}

/** Retry delay with jitter, capped, for the sync loop. */
export function syncBackoffMs(failures: number, random = Math.random): number {
	const base = Math.min(5 * 60_000, 2000 * 2 ** Math.max(0, failures - 1))
	return Math.round(base * (0.75 + random() * 0.5))
}
