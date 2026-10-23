import {
	ClockApiError,
	ClockNetworkError,
	type ClockPunchBody,
} from './clock-client.ts'
import { type ClockQueue } from './clock-queue.ts'

/**
 * Sends queued punches to the server, oldest first, one at a time. The order
 * matters (a clock-in must land before its break), so a punch that cannot be
 * judged yet (offline, an outage, a PIN pause) stops the run and everything
 * behind it waits. A punch the server refuses for good is set aside with its
 * reason so the tablet can tell a manager; it never blocks the line.
 */

/** After this many failed tries on server errors, give up and set it aside. */
export const MAX_SYNC_ATTEMPTS = 8

/**
 * A punch still failing on server errors this long after it was made is set
 * aside. Judged by age, not by tries: a till syncs every few seconds during a
 * rush, and a few minutes of outage must never cost someone their clock-in
 * (their later punches would then be refused as out of order).
 */
export const MAX_PENDING_AGE_MS = 48 * 60 * 60 * 1000

/**
 * A punch the server breaks on (a 500 for it, while other punches in the same
 * run are answered) is set aside after `MAX_SYNC_ATTEMPTS` such 500s spread
 * over at least this long since the first, so a manager sees it. A 500 with
 * nobody else answered is an outage, and counts toward nothing.
 */
export const POISON_MIN_AGE_MS = 30 * 60 * 1000

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
	queue: ClockQueue
	api: { punch: (body: ClockPunchBody) => Promise<unknown> }
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

	/**
	 * People whose earlier punch is still waiting: their later punches wait
	 * too (order matters per person), but nobody else's do. A punch that does
	 * not say whose it is might be anyone's, so it waits behind any of them.
	 */
	const held = new Set<string>()
	/** Punches the server answered this run (accepted, or refused for good). */
	let answered = 0
	/** 500s in a row with nothing answered between them: an outage, stop. */
	let failingInARow = 0
	/** Punches that got a 500 this run: judged once the run shows whether others got through. */
	const broke: Array<{ id: string }> = []
	for (const item of await queue.pending()) {
		if (held.size > 0 && (!item.staffId || held.has(item.staffId))) continue
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
			answered += 1
			failingInARow = 0
		} catch (error) {
			if (error instanceof ClockNetworkError) break
			if (error instanceof ClockApiError) {
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
					if (
						item.attempts + 1 >= MAX_SYNC_ATTEMPTS &&
						error.status >= 500 &&
						now() - item.createdAt > MAX_PENDING_AGE_MS
					) {
						await queue.markFailed(item.id, 'server_unavailable')
						outcome.failed += 1
						continue
					}
					outcome.retryAfterSeconds = error.retryAfterSeconds || null
					// A 500 may be this punch, or the whole server: hold this person's
					// punches and try the next person's, unless 500s keep coming with
					// nothing answered (an outage) or the punch names nobody.
					failingInARow += 1
					if (error.status !== 500 || !item.staffId) break
					broke.push({ id: item.id })
					held.add(item.staffId)
					if (failingInARow >= 2 && answered === 0) break
					continue
				}
				await queue.markFailed(item.id, error.code)
				outcome.failed += 1
				answered += 1
				failingInARow = 0
				continue
			}
			// Anything unexpected: keep the punch and try again next time.
			await queue.recordAttempt(item.id)
			break
		}
	}
	// Others got through, so the server is up: those 500s were about these punches.
	if (answered > 0) {
		for (const { id } of broke) {
			const totals = await queue.recordServerError(id, now())
			if (
				totals &&
				totals.count >= MAX_SYNC_ATTEMPTS &&
				now() - totals.firstAt >= POISON_MIN_AGE_MS
			) {
				await queue.markFailed(id, 'server_error')
				outcome.failed += 1
			}
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
