/**
 * Website events (#184, flag `website.events`): announcements with a time,
 * a place and an optional link, one-off or repeating. Expanded with
 * `@repo/common/site-events` (DST-safe). Public marketing content only;
 * bookable experiences stay in the reservations module and are linked by id.
 */
import {
	eventPhase,
	expandOccurrences,
	lastOccurrenceEndMs,
	MAX_LISTED_OCCURRENCES,
	parseExceptions,
	parseRecurrence,
	siteEventExceptionsSchema,
	siteEventRecurrenceSchema,
	slugifyTitle,
	validateEventTimes,
	type SiteEventSchedule,
} from '@repo/common/site-events'
import { parseLocalizedString, pickLocalized } from '@repo/common/site-locales'
import {
	and,
	db,
	eq,
	ne,
	OrganizationLocation,
	SiteEvent,
} from '@repo/database'
import { z } from 'zod'
import { getReservationsFeatureState } from '#app/utils/reservations/access.server.ts'
import { isValidRedirectDestination } from '#app/utils/website/redirect-destination.ts'

/** Days of occurrences the public list carries. */
export const PUBLIC_EVENT_DAYS = 90

const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** The editor's form, already parsed from JSON fields. */
export const siteEventInputSchema = z.object({
	title: z.record(z.string(), z.string().max(200)),
	description: z.record(z.string(), z.string().max(5000)).default({}),
	slug: z
		.string()
		.max(80)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.optional(),
	locationId: z.string().max(64).nullish(),
	imageUrl: z.string().max(2000).nullish(),
	linkUrl: z.string().max(2000).nullish(),
	linkLabel: z.record(z.string(), z.string().max(80)).nullish(),
	experienceId: z.string().max(64).nullish(),
	startLocal: z.string().regex(localDateTime),
	endLocal: z.string().regex(localDateTime),
	timezone: z.string().max(64).optional(),
	recurrence: siteEventRecurrenceSchema,
	exceptions: siteEventExceptionsSchema.default({ skipped: [], moved: [] }),
})

export type SiteEventInput = z.infer<typeof siteEventInputSchema>

export type SiteEventError =
	| 'invalid_event'
	| 'invalid_event_time'
	| 'title_required'
	| 'slug_taken'
	| 'invalid_link'
	| 'location_not_found'

function cleanLocalized(map: Record<string, string>) {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(map)) {
		if (/^[a-z]{2}(-[A-Z]{2})?$/.test(key) && value.trim())
			out[key] = value.trim()
	}
	return out
}

/**
 * Validates an event and returns the row to write. The time zone is the
 * location's when one is chosen (so the event follows the place), otherwise
 * the given one.
 */
export async function prepareSiteEvent(
	organizationId: string,
	input: SiteEventInput,
	options: { eventId?: string; fallbackTimezone: string },
): Promise<
	| { ok: true; values: Omit<typeof SiteEvent.$inferInsert, 'organizationId'> }
	| { ok: false; error: SiteEventError }
> {
	const title = cleanLocalized(input.title)
	if (!Object.keys(title).length) return { ok: false, error: 'title_required' }
	let timezone = input.timezone || options.fallbackTimezone
	if (input.locationId) {
		const [location] = await db
			.select({ timezone: OrganizationLocation.timezone })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.id, input.locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			)
			.limit(1)
		if (!location) return { ok: false, error: 'location_not_found' }
		timezone = location.timezone || timezone
	}
	const times = validateEventTimes({
		startLocal: input.startLocal,
		endLocal: input.endLocal,
		timezone,
	})
	if (!times.ok) return { ok: false, error: 'invalid_event_time' }
	for (const moved of input.exceptions.moved) {
		if (moved.end === moved.start)
			return { ok: false, error: 'invalid_event_time' }
	}
	const linkUrl = input.linkUrl?.trim() || null
	if (linkUrl && !isValidRedirectDestination(linkUrl)) {
		return { ok: false, error: 'invalid_link' }
	}
	const imageUrl = input.imageUrl?.trim() || null
	if (imageUrl && !/^(https:\/\/|\/)/.test(imageUrl)) {
		return { ok: false, error: 'invalid_link' }
	}
	const slug =
		input.slug ||
		slugifyTitle(
			Object.values(title)[0] ?? '',
			`event-${Date.now().toString(36)}`,
		)
	const [taken] = await db
		.select({ id: SiteEvent.id })
		.from(SiteEvent)
		.where(
			and(
				eq(SiteEvent.organizationId, organizationId),
				eq(SiteEvent.slug, slug),
				options.eventId ? ne(SiteEvent.id, options.eventId) : undefined,
			),
		)
		.limit(1)
	if (taken) return { ok: false, error: 'slug_taken' }
	const linkLabel = input.linkLabel ? cleanLocalized(input.linkLabel) : {}
	return {
		ok: true,
		values: {
			slug,
			title: JSON.stringify(title),
			description: JSON.stringify(cleanLocalized(input.description)),
			organizationLocationId: input.locationId || null,
			imageUrl,
			linkUrl,
			linkLabel: Object.keys(linkLabel).length
				? JSON.stringify(linkLabel)
				: null,
			experienceId: input.experienceId?.trim() || null,
			startLocal: input.startLocal,
			endLocal: input.endLocal,
			timezone,
			recurrence: JSON.stringify(input.recurrence),
			exceptions: JSON.stringify({
				skipped: [...new Set(input.exceptions.skipped)].sort(),
				moved: input.exceptions.moved,
			}),
		},
	}
}

export function scheduleOf(row: {
	startLocal: string
	endLocal: string
	timezone: string
	recurrence: string
	exceptions: string
}): SiteEventSchedule {
	return {
		startLocal: row.startLocal,
		endLocal: row.endLocal,
		timezone: row.timezone,
		recurrence: parseRecurrence(row.recurrence),
		exceptions: parseExceptions(row.exceptions),
	}
}

export type PublicSiteEvent = {
	slug: string
	title: string
	description: string
	imageUrl: string | null
	link: { url: string; label: string | null } | null
	/** A reservations experience: its booking button shows only while booking is on. */
	experience: { id: string } | null
	location: {
		name: string
		slug: string
		address: unknown
	} | null
	timezone: string
	phase: 'upcoming' | 'ended' | 'gone'
	/** When the last occurrence ended, or null for an endless series. */
	lastEndsAt: string | null
	occurrences: Array<{
		date: string
		start: string
		end: string
		startMs: number
		endMs: number
	}>
	updatedAt: string
}

/**
 * Published events with their next occurrences (at most 12 each, within 90
 * days for the list). `eventSlug` picks one event, ended ones included (its
 * page says it ended, then answers 410).
 */
export async function buildPublicEventsPayload(
	organization: { id: string; siteDefaultLocale: string | null },
	options: {
		locale?: string | null
		eventSlug?: string | null
		now?: Date
	} = {},
): Promise<{ events: PublicSiteEvent[] }> {
	const now = (options.now ?? new Date()).getTime()
	const defaultLocale = organization.siteDefaultLocale || 'en'
	const locale = options.locale || defaultLocale
	const rows = await db
		.select({
			slug: SiteEvent.slug,
			title: SiteEvent.title,
			description: SiteEvent.description,
			imageUrl: SiteEvent.imageUrl,
			linkUrl: SiteEvent.linkUrl,
			linkLabel: SiteEvent.linkLabel,
			experienceId: SiteEvent.experienceId,
			startLocal: SiteEvent.startLocal,
			endLocal: SiteEvent.endLocal,
			timezone: SiteEvent.timezone,
			recurrence: SiteEvent.recurrence,
			exceptions: SiteEvent.exceptions,
			updatedAt: SiteEvent.updatedAt,
			locationName: OrganizationLocation.name,
			locationSlug: OrganizationLocation.slug,
			locationAddress: OrganizationLocation.address,
			locationActive: OrganizationLocation.isActive,
		})
		.from(SiteEvent)
		.leftJoin(
			OrganizationLocation,
			eq(OrganizationLocation.id, SiteEvent.organizationLocationId),
		)
		.where(
			and(
				eq(SiteEvent.organizationId, organization.id),
				eq(SiteEvent.status, 'published'),
				options.eventSlug ? eq(SiteEvent.slug, options.eventSlug) : undefined,
			),
		)
	const reservations = rows.some((row) => row.experienceId)
		? await getReservationsFeatureState(organization.id)
		: null
	const experiencesBookable = Boolean(
		reservations?.enabled && reservations.online && reservations.experiences,
	)
	const events: PublicSiteEvent[] = []
	for (const row of rows) {
		const schedule = scheduleOf(row)
		const phase = eventPhase(schedule, now)
		if (!options.eventSlug && phase !== 'upcoming') continue
		const occurrences = expandOccurrences(schedule, {
			fromMs: now,
			limit: MAX_LISTED_OCCURRENCES,
			untilMs: options.eventSlug
				? undefined
				: now + PUBLIC_EVENT_DAYS * 86_400_000,
		}).map(({ date, start, end, startMs, endMs }) => ({
			date,
			start,
			end,
			startMs,
			endMs,
		}))
		if (!options.eventSlug && !occurrences.length) continue
		const lastEnd = lastOccurrenceEndMs(schedule)
		const linkLabel = row.linkLabel
			? pickLocalized(
					parseLocalizedString(row.linkLabel, defaultLocale),
					locale,
					defaultLocale,
				)
			: ''
		events.push({
			slug: row.slug,
			title: pickLocalized(row.title, locale, defaultLocale),
			description: row.description
				? pickLocalized(row.description, locale, defaultLocale)
				: '',
			imageUrl: row.imageUrl,
			link: row.linkUrl ? { url: row.linkUrl, label: linkLabel || null } : null,
			experience:
				row.experienceId && experiencesBookable
					? { id: row.experienceId }
					: null,
			location:
				row.locationName && row.locationActive
					? {
							name:
								pickLocalized(row.locationName, locale, defaultLocale) ||
								row.locationName,
							slug: row.locationSlug ?? '',
							address: (() => {
								try {
									return row.locationAddress
										? JSON.parse(row.locationAddress)
										: null
								} catch {
									return null
								}
							})(),
						}
					: null,
			timezone: row.timezone,
			phase,
			lastEndsAt: lastEnd === null ? null : new Date(lastEnd).toISOString(),
			occurrences,
			updatedAt: row.updatedAt.toISOString(),
		})
	}
	events.sort(
		(a, b) =>
			(a.occurrences[0]?.startMs ?? Infinity) -
			(b.occurrences[0]?.startMs ?? Infinity),
	)
	return { events }
}
