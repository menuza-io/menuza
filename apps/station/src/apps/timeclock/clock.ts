import {
	ClockApiError,
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
import { z } from 'zod'
import { serverNow } from '~/lib/clock.ts'
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

const announcementSchema = z.object({
	id: z.string(),
	title: z.string(),
	body: z.string(),
	expiresAt: z.number(),
	createdAt: z.number(),
	readAt: z.number().nullable(),
})
export type StationAnnouncement = z.infer<typeof announcementSchema>

const announcementsSchema = z.object({
	serverNow: z.number(),
	announcements: z.array(announcementSchema),
})

const myWeekSchema = z.object({
	firstName: z.string(),
	week: z.object({
		serverNow: z.number(),
		weekStart: z.string(),
		weekEnd: z.string(),
		timeZone: z.string(),
		workedMinutes: z.number(),
		scheduledMinutes: z.number(),
		nextShift: z
			.object({
				startsAt: z.number(),
				endsAt: z.number(),
				timeZone: z.string(),
			})
			.nullable(),
		/** Only when the organization turned it on. Never on the lock screen. */
		pay: z
			.object({
				label: z.literal('estimate_before_tax'),
				periodStart: z.string(),
				periodEnd: z.string(),
				estimateMinor: z.number().nullable(),
				currency: z.string().nullable(),
				overtimeMinutes: z.number(),
			})
			.optional(),
	}),
})
export type StationMyWeek = z.infer<typeof myWeekSchema>['week']

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
		/**
		 * After a punch: the announcements this person has not read, and their own
		 * week. Each call names the person by PIN again; the till holds the PIN
		 * only while the after-punch screen is open.
		 */
		announcements: (pin: string) =>
			clockRequest(options(settings), '/announcements', announcementsSchema, {
				method: 'POST',
				json: { pin },
			}),
		readAnnouncement: (pin: string, announcementId: string) =>
			clockRequest(
				options(settings),
				'/announcements/read',
				z.object({ readAt: z.number() }),
				{ method: 'POST', json: { pin, announcementId } },
			),
		myWeek: (pin: string) =>
			clockRequest(options(settings), '/my-week', myWeekSchema, {
				method: 'POST',
				json: { pin },
			}),
	}
}

export type StationClockApi = ReturnType<typeof stationClockApi>

/**
 * Refusals that say nothing about the punch itself (the server, or the App it
 * asks, is down or paused): the punch is saved on the till and sent later,
 * like one made with no connection. A PIN backoff is never one of them.
 */
const SAVE_FOR_LATER = new Set([
	'service_unavailable',
	'time_zone_unavailable',
	'kiosk_disabled',
	'pos_disabled',
	'rate_limit_exceeded',
])

export function worthSavingForLater(error: unknown): boolean {
	if (!(error instanceof ClockApiError)) return false
	if (error.code === 'backoff' || error.code === 'person_locked') return false
	return error.status >= 500 || SAVE_FOR_LATER.has(error.code)
}

let queue: ClockQueue | null = null
/** The till's punch queue, opened on first use (tests start from a fresh one). */
export function punchQueue(): ClockQueue {
	queue ??= createClockQueue({ dbName: 'station-punches' })
	return queue
}
export function resetPunchQueueForTests(next: ClockQueue | null = null) {
	queue = next
}

/**
 * Sets aside, PINs dropped, waiting punches the server would refuse as too
 * old, judged by the server's time as best known (punches are stamped in it).
 * Runs whether or not this till can send: a removed or unpaired till would
 * otherwise keep their encrypted PINs, and the key beside them, for good.
 */
export function expirePunches(at = serverNow()): Promise<number> {
	return punchQueue().expire(at)
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
