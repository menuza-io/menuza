import { createId } from '@paralleldrive/cuid2'
import {
	and,
	asc,
	count,
	db,
	eq,
	inArray,
	isNull,
	lte,
	or,
	Organization,
	OrganizationLocation,
	SiteEvent,
	SiteEventCalendarSource,
} from '@repo/database'
import { decryptAsync, encryptAsync, getEncryptionKey } from '@repo/security'
import { isValidTimeZone } from '@repo/zoned-time'
import { ENV } from 'varlock/env'
import { getLandingFeatures } from '#app/utils/seo/landing-pages.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { normalizeCalendarAddress } from './calendar-address.ts'
import {
	fetchCalendarFeed,
	type CalendarFetchDeps,
	type CalendarFetchError,
} from './calendar-fetch.server.ts'
import { parseCalendar, type CalendarOccurrence } from './ical.ts'

/**
 * Google Calendar on the website's events (#319). A connected calendar is read
 * (never written) a few times a day and mapped into the existing `SiteEvent`
 * store with a source id, so imported and Menuza events are one list and one
 * public calendar.
 *
 * - What the calendar owns (title, description, time) is rewritten on every
 *   sync. What the operator adds (hidden, photo, ticket or booking link) lives
 *   in the same row and is never touched by a sync, so it survives updates.
 * - An occurrence that is no longer in the feed (deleted, cancelled, moved out
 *   of the window) is removed at the next sync. A failed fetch removes nothing.
 * - The address may be a secret one: it is stored encrypted and never logged,
 *   never part of an error, and never shown beyond its host.
 */

export const CALENDAR_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000
export const CALENDAR_FAILURE_RETRY_MS = 60 * 60 * 1000
export const MAX_CALENDARS_PER_ORGANIZATION = 5
const SWEEP_LIMIT = 25
const WRITE_CHUNK = 40

const key = () => getEncryptionKey('INTEGRATION_ENCRYPTION_KEY')

export type CalendarDeps = CalendarFetchDeps & {
	now?: () => number
	/** Ask jobs-cron to wake the App at the next sync (best effort). */
	wake?: (sourceId: string, runAt: Date) => Promise<boolean>
	purge?: (organizationId: string) => Promise<unknown>
}

export type ConnectError =
	| 'invalid_calendar_address'
	| 'url_not_allowed'
	| 'fetch_failed'
	| 'invalid_calendar'
	| 'too_large'
	| 'too_many_calendars'
	| 'location_not_found'

export type SyncReport = {
	created: number
	updated: number
	removed: number
	kept: number
	skipped: number
}

/**
 * Asks jobs-cron to run the calendar workflow at `runAt` (`step.sleepUntil`):
 * the payload carries only the source id and the time. The hourly sweep is the
 * fallback when this cannot be started.
 */
export async function wakeCalendarWorkflow(
	sourceId: string,
	runAt: Date,
): Promise<boolean> {
	const workerUrl =
		typeof ENV.JOBS_CRON_WORKER_URL === 'string'
			? ENV.JOBS_CRON_WORKER_URL.trim()
			: ''
	if (!workerUrl) return false
	try {
		const response = await fetch(
			`${workerUrl.replace(/\/$/u, '')}/workflows/calendar-sync/start`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ sourceId, runAt: runAt.toISOString() }),
				signal: AbortSignal.timeout(5_000),
			},
		)
		return response.ok
	} catch {
		return false
	}
}

async function sha(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

/** The zone a calendar's floating and all-day times are read in. */
async function zoneFor(organizationId: string, locationId: string | null) {
	if (locationId) {
		const [location] = await db
			.select({ timezone: OrganizationLocation.timezone })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.limit(1)
		if (location?.timezone && isValidTimeZone(location.timezone)) {
			return location.timezone
		}
	}
	const [org] = await db
		.select({ staffingTimeZone: Organization.staffingTimeZone })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org?.staffingTimeZone && isValidTimeZone(org.staffingTimeZone)
		? org.staffingTimeZone
		: 'UTC'
}

export async function connectCalendar(
	input: {
		organizationId: string
		userId: string
		locationId: string | null
		address: unknown
		label?: string
	},
	deps: CalendarDeps = {},
): Promise<
	| { ok: true; sourceId: string; report: SyncReport }
	| { ok: false; error: ConnectError }
> {
	const now = deps.now?.() ?? Date.now()
	const address = normalizeCalendarAddress(input.address)
	if (!address.ok) return { ok: false, error: address.error }
	if (input.locationId) {
		const [location] = await db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, input.locationId),
					eq(OrganizationLocation.organizationId, input.organizationId),
				),
			)
			.limit(1)
		if (!location) return { ok: false, error: 'location_not_found' }
	}
	const [existing] = await db
		.select({ total: count() })
		.from(SiteEventCalendarSource)
		.where(eq(SiteEventCalendarSource.organizationId, input.organizationId))
	if ((existing?.total ?? 0) >= MAX_CALENDARS_PER_ORGANIZATION) {
		return { ok: false, error: 'too_many_calendars' }
	}
	// Read it first: an address that is not a calendar is refused before anything
	// is stored.
	const timezone = await zoneFor(input.organizationId, input.locationId)
	const fetched = await fetchCalendarFeed(address.url, deps)
	if (!fetched.ok) return { ok: false, error: fetched.error }
	const parsed = parseCalendar(fetched.text, { defaultTimezone: timezone, now })
	if (!parsed.ok) return { ok: false, error: parsed.error }

	const id = createId()
	await db.insert(SiteEventCalendarSource).values({
		id,
		organizationId: input.organizationId,
		organizationLocationId: input.locationId,
		label: (input.label?.trim() || parsed.name || 'Google Calendar').slice(
			0,
			120,
		),
		urlEncrypted: await encryptAsync(address.url, key()),
		urlHint: address.hint,
		timezone,
		createdById: input.userId,
		status: 'active',
		nextSyncAt: new Date(now),
	})
	const report = await applyFeed(
		id,
		parsed.occurrences,
		parsed.skipped,
		deps,
		now,
	)
	return { ok: true, sourceId: id, report }
}

export async function disconnectCalendar(input: {
	organizationId: string
	sourceId: string
	purge?: CalendarDeps['purge']
}) {
	const [source] = await db
		.select({ id: SiteEventCalendarSource.id })
		.from(SiteEventCalendarSource)
		.where(
			and(
				eq(SiteEventCalendarSource.id, input.sourceId),
				eq(SiteEventCalendarSource.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!source) return { ok: false as const }
	// Imported events go with the connection (the row's foreign key cascades too).
	await db.delete(SiteEvent).where(eq(SiteEvent.sourceId, source.id))
	await db
		.delete(SiteEventCalendarSource)
		.where(eq(SiteEventCalendarSource.id, source.id))
	await (input.purge ?? purgeFor)(input.organizationId)
	return { ok: true as const }
}

async function purgeFor(organizationId: string) {
	const [org] = await db
		.select({
			slug: Organization.slug,
			customDomain: Organization.customDomain,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (org) {
		await purgeOrganizationSiteCache(organizationId, org.slug, org.customDomain)
	}
}

/**
 * Makes the stored events of one source equal to the feed, keeping what the
 * operator added. Returns what changed.
 */
async function applyFeed(
	sourceId: string,
	occurrences: CalendarOccurrence[],
	skipped: number,
	deps: CalendarDeps,
	now: number,
): Promise<SyncReport> {
	const [source] = await db
		.select()
		.from(SiteEventCalendarSource)
		.where(eq(SiteEventCalendarSource.id, sourceId))
		.limit(1)
	if (!source) return { created: 0, updated: 0, removed: 0, kept: 0, skipped }
	const [org] = await db
		.select({ defaultLocale: Organization.siteDefaultLocale })
		.from(Organization)
		.where(eq(Organization.id, source.organizationId))
		.limit(1)
	const defaultLocale = org?.defaultLocale || 'en'
	const existing = await db
		.select({
			id: SiteEvent.id,
			sourceKey: SiteEvent.sourceKey,
			title: SiteEvent.title,
			description: SiteEvent.description,
			startLocal: SiteEvent.startLocal,
			endLocal: SiteEvent.endLocal,
			timezone: SiteEvent.timezone,
			organizationLocationId: SiteEvent.organizationLocationId,
		})
		.from(SiteEvent)
		.where(eq(SiteEvent.sourceId, sourceId))
	const byKey = new Map(existing.map((row) => [row.sourceKey ?? '', row]))
	const report: SyncReport = {
		created: 0,
		updated: 0,
		removed: 0,
		kept: 0,
		skipped,
	}

	const inserts: Array<typeof SiteEvent.$inferInsert> = []
	const updates: Array<{
		id: string
		values: Partial<typeof SiteEvent.$inferInsert>
	}> = []
	const wanted = new Set<string>()
	for (const occurrence of occurrences) {
		wanted.add(occurrence.key)
		const title = JSON.stringify({ [defaultLocale]: occurrence.title })
		const description = occurrence.description
			? JSON.stringify({ [defaultLocale]: occurrence.description })
			: null
		const row = byKey.get(occurrence.key)
		if (!row) {
			inserts.push({
				id: createId(),
				organizationId: source.organizationId,
				organizationLocationId: source.organizationLocationId,
				slug: `cal-${(await sha(`${sourceId}|${occurrence.key}`)).slice(0, 14)}`,
				// A new imported event is shown at once; hiding it is the operator's call.
				status: 'published',
				title,
				description,
				startLocal: occurrence.startLocal,
				endLocal: occurrence.endLocal,
				timezone: occurrence.timezone,
				sourceId,
				sourceKey: occurrence.key,
			})
			report.created++
			continue
		}
		const same =
			row.title === title &&
			(row.description ?? null) === description &&
			row.startLocal === occurrence.startLocal &&
			row.endLocal === occurrence.endLocal &&
			row.timezone === occurrence.timezone &&
			row.organizationLocationId === source.organizationLocationId
		if (same) {
			report.kept++
			continue
		}
		// Only what the calendar owns. `status`, `imageUrl`, `linkUrl`,
		// `linkLabel`, `experienceId` and `slug` are the operator's and stay.
		updates.push({
			id: row.id,
			values: {
				title,
				description,
				startLocal: occurrence.startLocal,
				endLocal: occurrence.endLocal,
				timezone: occurrence.timezone,
				organizationLocationId: source.organizationLocationId,
			},
		})
		report.updated++
	}
	const removed = existing.filter((row) => !wanted.has(row.sourceKey ?? ''))
	report.removed = removed.length

	for (let i = 0; i < inserts.length; i += WRITE_CHUNK) {
		await db.batch(
			inserts
				.slice(i, i + WRITE_CHUNK)
				.map((values) => db.insert(SiteEvent).values(values)) as never,
		)
	}
	for (const update of updates) {
		await db
			.update(SiteEvent)
			.set(update.values)
			.where(eq(SiteEvent.id, update.id))
	}
	for (let i = 0; i < removed.length; i += 80) {
		await db.delete(SiteEvent).where(
			inArray(
				SiteEvent.id,
				removed.slice(i, i + 80).map((row) => row.id),
			),
		)
	}
	const nextSyncAt = new Date(now + CALENDAR_SYNC_INTERVAL_MS)
	await db
		.update(SiteEventCalendarSource)
		.set({
			status: 'active',
			lastError: null,
			lastSyncedAt: new Date(now),
			nextSyncAt,
		})
		.where(eq(SiteEventCalendarSource.id, sourceId))
	if (report.created || report.updated || report.removed) {
		await (deps.purge ?? purgeFor)(source.organizationId)
	}
	await (deps.wake ?? wakeCalendarWorkflow)(sourceId, nextSyncAt).catch(
		() => false,
	)
	return report
}

export type SyncOutcome =
	| { ok: true; report: SyncReport }
	| {
			ok: false
			error:
				| CalendarFetchError
				| 'not_found'
				| 'paused'
				| 'not_due'
				| 'events_disabled'
				| 'decrypt_failed'
	  }

/**
 * Reads one calendar and reconciles its events. A failed read changes no
 * event: the source is marked and tried again in an hour.
 */
export async function syncCalendarSource(
	sourceId: string,
	deps: CalendarDeps = {},
	options: { onlyIfDue?: boolean } = {},
): Promise<SyncOutcome> {
	const now = deps.now?.() ?? Date.now()
	const [source] = await db
		.select()
		.from(SiteEventCalendarSource)
		.where(eq(SiteEventCalendarSource.id, sourceId))
		.limit(1)
	if (!source) return { ok: false, error: 'not_found' }
	if (source.status === 'paused') return { ok: false, error: 'paused' }
	// A wake-up that arrives after another sync already moved the time on does
	// nothing, so two pending wake-ups never double the chain.
	if (
		options.onlyIfDue &&
		source.nextSyncAt &&
		source.nextSyncAt.getTime() > now
	) {
		return { ok: false, error: 'not_due' }
	}
	const retry = async (error: string, delay: number) => {
		await db
			.update(SiteEventCalendarSource)
			.set({
				status: 'error',
				lastError: error,
				nextSyncAt: new Date(now + delay),
			})
			.where(eq(SiteEventCalendarSource.id, sourceId))
		await (deps.wake ?? wakeCalendarWorkflow)(
			sourceId,
			new Date(now + delay),
		).catch(() => false)
	}
	// Website events are off: nothing to show, nothing to fetch.
	if (!(await getLandingFeatures(source.organizationId)).events) {
		await db
			.update(SiteEventCalendarSource)
			.set({ nextSyncAt: new Date(now + CALENDAR_SYNC_INTERVAL_MS) })
			.where(eq(SiteEventCalendarSource.id, sourceId))
		return { ok: false, error: 'events_disabled' }
	}
	let url: string
	try {
		url = await decryptAsync(source.urlEncrypted, key())
	} catch {
		await retry('decrypt_failed', CALENDAR_SYNC_INTERVAL_MS)
		return { ok: false, error: 'decrypt_failed' }
	}
	const fetched = await fetchCalendarFeed(url, deps)
	if (!fetched.ok) {
		await retry(fetched.error, CALENDAR_FAILURE_RETRY_MS)
		return { ok: false, error: fetched.error }
	}
	const parsed = parseCalendar(fetched.text, {
		defaultTimezone: source.timezone,
		now,
	})
	// A feed that yields nothing but problems must not wipe the site's events.
	if (!parsed.ok || (parsed.occurrences.length === 0 && parsed.skipped > 0)) {
		const error = parsed.ok ? 'invalid_calendar' : parsed.error
		await retry(error, CALENDAR_FAILURE_RETRY_MS)
		return { ok: false, error }
	}
	return {
		ok: true,
		report: await applyFeed(
			sourceId,
			parsed.occurrences,
			parsed.skipped,
			deps,
			now,
		),
	}
}

/**
 * The hourly sweep (and the wake-up of a source that is due): syncs every
 * calendar whose time has come. One source failing never stops the others.
 */
export async function syncDueCalendars(deps: CalendarDeps = {}) {
	const now = deps.now?.() ?? Date.now()
	const due = await db
		.select({ id: SiteEventCalendarSource.id })
		.from(SiteEventCalendarSource)
		.where(
			and(
				or(
					isNull(SiteEventCalendarSource.nextSyncAt),
					lte(SiteEventCalendarSource.nextSyncAt, new Date(now)),
				),
				or(
					eq(SiteEventCalendarSource.status, 'active'),
					eq(SiteEventCalendarSource.status, 'error'),
				),
			),
		)
		.orderBy(asc(SiteEventCalendarSource.nextSyncAt))
		.limit(SWEEP_LIMIT)
	let synced = 0
	let failed = 0
	for (const { id } of due) {
		try {
			const outcome = await syncCalendarSource(id, deps)
			if (outcome.ok) synced++
			else failed++
		} catch {
			failed++
		}
	}
	return { due: due.length, synced, failed }
}
