import {
	clockRequest,
	type ClockPunchBody,
	type ClockRequestOptions,
} from '@repo/staffing/clock-client'
import {
	clockIdentifyResponseSchema,
	clockPunchResponseSchema,
} from '@repo/staffing/clock-flow'
import { createClockQueue, type ClockQueue } from '@repo/staffing/clock-queue'
import { syncQueue, type SyncOutcome } from '@repo/staffing/clock-sync'
import { type PosSettings } from '~/lib/config.ts'

/**
 * The time clock on this till: the terminal's own credential against
 * `/pos/timeclock`, the same requests and answers as the kiosk. Punches made
 * while the till is offline wait in their own IndexedDB queue with the PIN
 * encrypted at rest, and go out, oldest first, with the till's other uploads.
 */

function options(settings: PosSettings): ClockRequestOptions {
	return {
		baseUrl: `${settings.tenantApiUrl.replace(/\/+$/, '')}/pos/timeclock`,
		deviceSecret: settings.deviceToken ?? undefined,
		// Answers name people: never keep them in the browser's disk cache.
		requestInit: { cache: 'no-store' },
	}
}

export function stationClockApi(settings: PosSettings) {
	return {
		identify: (pin: string) =>
			clockRequest(
				options(settings),
				'/identify',
				clockIdentifyResponseSchema,
				{
					method: 'POST',
					json: { pin },
				},
			),
		punch: (body: ClockPunchBody) =>
			clockRequest(options(settings), '/punch', clockPunchResponseSchema, {
				method: 'POST',
				json: body,
			}),
	}
}

export type StationClockApi = ReturnType<typeof stationClockApi>

let queue: ClockQueue | null = null
/** The till's punch queue, opened on first use (tests start from a fresh one). */
export function punchQueue(): ClockQueue {
	queue ??= createClockQueue({ dbName: 'station-punches' })
	return queue
}
export function resetPunchQueueForTests(next: ClockQueue | null = null) {
	queue = next
}

let flushing: Promise<SyncOutcome | null> | null = null

/**
 * Sends waiting punches. One run at a time; nothing to do without a pairing or
 * a connection. The caller handles a removed device (`deviceGone`).
 */
export function flushPunches(
	settings: PosSettings,
	online: boolean,
): Promise<SyncOutcome | null> {
	if (
		!online ||
		!settings.deviceToken ||
		!settings.tenantApiUrl ||
		settings.demo
	)
		return Promise.resolve(null)
	flushing ??= (async () => {
		const q = punchQueue()
		if (!q.supported || (await q.counts()).queued === 0) return null
		return syncQueue({ queue: q, api: stationClockApi(settings) })
	})().finally(() => {
		flushing = null
	})
	return flushing
}
