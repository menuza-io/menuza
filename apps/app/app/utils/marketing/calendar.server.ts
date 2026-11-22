import {
	and,
	asc,
	db,
	eq,
	MarketingOccasionChoice,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { buildOccasionMessage } from '@repo/marketing/occasion-message'
import {
	addDays,
	AUTO_SCHEDULE_LEAD_DAYS,
	DEFAULT_SEND_HOUR,
	getOccasion,
	isOccasionKey,
	isOccasionMarket,
	occasionsBetween,
	resolveOccasionMarket,
	suggestedOccasions,
	type OccasionKey,
	type OccasionMarket,
	type OccasionOccurrence,
} from '@repo/marketing/occasions'
import { zonedLocalToUtc } from '@repo/zoned-time'
import { type CalendarPost } from '#app/components/social/social-calendar.tsx'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { listSocialPostsBetween } from '#app/utils/social/posts.server.ts'
import { monthGrid } from '#app/utils/social/time.ts'
import { toCalendarPost } from '#app/utils/social/views.server.ts'

/**
 * The marketing calendar's data and the operator's choices (#152): which
 * occasions to show for the organization's market, which were dismissed this
 * year, which are set to auto-schedule, and what is already on the calendar
 * (scheduled broadcasts from the region, social posts from the control plane).
 * The occasion catalogue is code (`@repo/marketing/occasions`); the choices are
 * control-plane numbers and keys: no guest data.
 */

type Fetch = (path: string, init?: RequestInit) => Promise<Response>

export type OccasionStatus = 'open' | 'dismissed' | 'scheduled' | 'skipped'

export type CalendarOccasion = {
	key: OccasionKey
	date: string
	year: number
	/** A Hijri date (or a game day): it can move by a day. */
	expected: boolean
	sendDate: string
	/** When the recommended broadcast goes out, as an ISO instant. */
	sendAt: string
	status: OccasionStatus
	/** The year's auto-scheduled broadcast, once there is one. */
	campaignId: string | null
	skipReason: string | null
	autoSchedule: boolean
	autoChannel: 'email' | 'sms'
	/** Ready-made words in the site language, for the card. */
	preview: { subject: string; body: string; sms: string; social: string }
}

export type CalendarBroadcast = {
	id: string
	name: string
	channel: 'email' | 'sms' | 'push'
	status: string
	/** The send time, or when it was made when it has none (ISO). */
	at: string
}

type OrganizationFacts = {
	id: string
	slug: string
	name: string
	customDomain: string | null
	dataRegion: string
	marketingMarket: string | null
	siteDefaultLocale: string | null
}

export async function loadOrganizationFacts(
	organizationId: string,
): Promise<OrganizationFacts | null> {
	const [org] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			customDomain: Organization.customDomain,
			dataRegion: Organization.dataRegion,
			marketingMarket: Organization.marketingMarket,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org ?? null
}

export function marketOf(
	org: Pick<OrganizationFacts, 'dataRegion' | 'marketingMarket'>,
): OccasionMarket {
	return resolveOccasionMarket({
		override: org.marketingMarket,
		dataRegion: org.dataRegion,
	})
}

/** The time zone of the organization's first location, else UTC. */
export async function organizationTimeZone(organizationId: string) {
	const [first] = await db
		.select({ timezone: OrganizationLocation.timezone })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(asc(OrganizationLocation.createdAt))
		.limit(1)
	if (first?.timezone) return first.timezone
	const [org] = await db
		.select({ zone: Organization.staffingTimeZone })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org?.zone || 'UTC'
}

/**
 * When the recommended broadcast of an occasion goes out: its send date at 10:00
 * in the organization's time zone, or the soonest 10:00 at least an hour from
 * now when that has passed.
 */
export function recommendedSendAt(
	sendDate: string,
	timeZone: string,
	now: number,
): number {
	const at = (date: string) => {
		const [year, month, day] = date.split('-').map(Number) as [
			number,
			number,
			number,
		]
		return zonedLocalToUtc(year, month, day, DEFAULT_SEND_HOUR, 0, timeZone)
	}
	let candidate = at(sendDate)
	const earliest = now + 60 * 60 * 1000
	for (let i = 0; candidate < earliest && i < 3; i++) {
		sendDate = addDays(sendDate, 1)
		candidate = at(sendDate)
	}
	return candidate
}

export type OccasionChoiceRow = typeof MarketingOccasionChoice.$inferSelect

export async function loadOccasionChoices(organizationId: string) {
	const rows = await db
		.select()
		.from(MarketingOccasionChoice)
		.where(eq(MarketingOccasionChoice.organizationId, organizationId))
	return new Map(rows.map((row) => [row.occasionKey, row]))
}

export function statusOf(
	choice: OccasionChoiceRow | undefined,
	year: number,
): OccasionStatus {
	if (!choice) return 'open'
	if (choice.dismissedYear === year) return 'dismissed'
	if (choice.scheduledYear === year) return 'scheduled'
	if (choice.skippedYear === year) return 'skipped'
	return 'open'
}

function toCalendarOccasion(input: {
	occurrence: OccasionOccurrence
	choice: OccasionChoiceRow | undefined
	org: OrganizationFacts
	timeZone: string
	now: number
}): CalendarOccasion {
	const { occurrence, choice, org } = input
	const locale = org.siteDefaultLocale || 'en'
	const message = buildOccasionMessage({
		key: occurrence.key,
		locale,
		restaurant: org.name,
		siteOrigin: orgSiteUrl(org),
		year: occurrence.year,
	})
	const status = statusOf(choice, occurrence.year)
	return {
		key: occurrence.key,
		date: occurrence.date,
		year: occurrence.year,
		expected: occurrence.expected,
		sendDate: occurrence.sendDate,
		sendAt: new Date(
			recommendedSendAt(occurrence.sendDate, input.timeZone, input.now),
		).toISOString(),
		status,
		campaignId: status === 'scheduled' ? (choice?.campaignId ?? null) : null,
		skipReason: status === 'skipped' ? (choice?.skipReason ?? null) : null,
		autoSchedule: choice?.autoSchedule === true,
		autoChannel: choice?.channel === 'sms' ? 'sms' : 'email',
		preview: {
			subject: message.subject,
			body: message.emailText,
			sms: message.sms,
			social: message.social,
		},
	}
}

/**
 * What the calendar shows for a month: the occasions in the grid, the
 * suggestions for the next four weeks, the broadcasts and the social posts.
 */
export async function loadCalendar(input: {
	organizationId: string
	month: string
	today: string
	timeZone: string
	fetchTenant: Fetch
	now?: number
}) {
	const now = input.now ?? Date.now()
	const org = await loadOrganizationFacts(input.organizationId)
	if (!org) throw new Response('Not found', { status: 404 })
	const market = marketOf(org)
	const days = monthGrid(input.month)
	const gridFrom = days[0]!
	const gridTo = days.at(-1)!
	const choices = await loadOccasionChoices(input.organizationId)
	const orgTimeZone = await organizationTimeZone(input.organizationId)

	const shape = (occurrence: OccasionOccurrence) =>
		toCalendarOccasion({
			occurrence,
			choice: choices.get(occurrence.key),
			org,
			timeZone: orgTimeZone,
			now,
		})
	const inGrid = occasionsBetween(market, gridFrom, gridTo).map(shape)
	const suggestions = suggestedOccasions(market, input.today)
		.map(shape)
		.filter((occasion) => occasion.status !== 'dismissed')

	const [broadcasts, posts] = await Promise.all([
		listBroadcastsBetween(input.fetchTenant, gridFrom, gridTo),
		listSocialPostsBetween(
			input.organizationId,
			new Date(`${gridFrom}T00:00:00Z`),
			new Date(`${addDays(gridTo, 1)}T00:00:00Z`),
		).catch(() => []),
	])
	return {
		market,
		siteLocale: org.siteDefaultLocale || 'en',
		occasions: inGrid,
		suggestions,
		broadcasts,
		posts: posts.map(toCalendarPost) satisfies CalendarPost[],
		autoScheduleLeadDays: AUTO_SCHEDULE_LEAD_DAYS,
	}
}

/**
 * Scheduled, sending and finished broadcasts on the grid, from the region's
 * list: titles, channels, statuses and times, no recipient. A region that
 * cannot answer shows no broadcasts, not an error.
 */
export async function listBroadcastsBetween(
	fetchTenant: Fetch,
	from: string,
	to: string,
): Promise<CalendarBroadcast[]> {
	try {
		const res = await fetchTenant('/operator/marketing/campaigns')
		if (!res.ok) return []
		const body = (await res.json()) as {
			campaigns?: Array<{
				id: string
				name: string
				channel: 'email' | 'sms' | 'push'
				status: string
				scheduledAt?: string | number | null
				createdAt?: string | number | null
			}>
		}
		const fromMs = Date.parse(`${from}T00:00:00Z`) - 86_400_000
		const toMs = Date.parse(`${to}T23:59:59Z`) + 86_400_000
		const listed: CalendarBroadcast[] = []
		for (const campaign of body.campaigns ?? []) {
			if (!['Scheduled', 'Processing', 'Completed'].includes(campaign.status)) {
				continue
			}
			const raw = campaign.scheduledAt ?? campaign.createdAt
			const at =
				raw === null || raw === undefined ? NaN : new Date(raw).getTime()
			if (Number.isNaN(at) || at < fromMs || at > toMs) continue
			listed.push({
				id: campaign.id,
				name: campaign.name,
				channel: campaign.channel,
				status: campaign.status,
				at: new Date(at).toISOString(),
			})
		}
		return listed.sort((a, b) => a.at.localeCompare(b.at))
	} catch {
		return []
	}
}

// ---------------------------------------------------------------------------
// The operator's choices
// ---------------------------------------------------------------------------

async function ensureChoice(organizationId: string, key: OccasionKey) {
	await db
		.insert(MarketingOccasionChoice)
		.values({ organizationId, occasionKey: key })
		.onConflictDoNothing()
}

/** Dismisses an occasion for a year; it stays dismissed for that year only. */
export async function dismissOccasion(input: {
	organizationId: string
	key: string
	year: number
}): Promise<boolean> {
	if (!isOccasionKey(input.key) || !Number.isInteger(input.year)) return false
	await ensureChoice(input.organizationId, input.key)
	await db
		.update(MarketingOccasionChoice)
		.set({ dismissedYear: input.year })
		.where(
			and(
				eq(MarketingOccasionChoice.organizationId, input.organizationId),
				eq(MarketingOccasionChoice.occasionKey, input.key),
			),
		)
	return true
}

export async function restoreOccasion(input: {
	organizationId: string
	key: string
	year: number
}): Promise<boolean> {
	if (!isOccasionKey(input.key)) return false
	await db
		.update(MarketingOccasionChoice)
		.set({ dismissedYear: null })
		.where(
			and(
				eq(MarketingOccasionChoice.organizationId, input.organizationId),
				eq(MarketingOccasionChoice.occasionKey, input.key),
				eq(MarketingOccasionChoice.dismissedYear, input.year),
			),
		)
	return true
}

/**
 * Turns Auto-schedule on or off for an occasion. Off is the default: nothing
 * is ever created for an occasion the operator did not turn on. The channel is
 * email or text; the audience a saved audience id, empty for everyone subscribed.
 */
export async function setAutoSchedule(input: {
	organizationId: string
	key: string
	on: boolean
	channel?: 'email' | 'sms'
	audienceId?: string | null
}): Promise<boolean> {
	if (!isOccasionKey(input.key)) return false
	await ensureChoice(input.organizationId, input.key)
	await db
		.update(MarketingOccasionChoice)
		.set({
			autoSchedule: input.on,
			...(input.channel ? { channel: input.channel } : {}),
			...(input.audienceId !== undefined
				? { audienceId: input.audienceId }
				: {}),
		})
		.where(
			and(
				eq(MarketingOccasionChoice.organizationId, input.organizationId),
				eq(MarketingOccasionChoice.occasionKey, input.key),
			),
		)
	return true
}

/** The market the operator chose in Marketing settings, or null to follow the region. */
export async function setMarketingMarket(input: {
	organizationId: string
	market: string | null
}): Promise<boolean> {
	if (input.market !== null && !isOccasionMarket(input.market)) return false
	await db
		.update(Organization)
		.set({ marketingMarket: input.market })
		.where(eq(Organization.id, input.organizationId))
	return true
}

/**
 * What "Use this" opens: a new broadcast prefilled with the occasion's email
 * design (or text), scheduled for the recommended time. Null when the key is
 * not an occasion of the organization's market, or the day has passed.
 */
export async function occasionDraft(input: {
	organizationId: string
	key: string
	date: string
	now?: number
}) {
	const occasion = getOccasion(input.key)
	if (!occasion || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return null
	const org = await loadOrganizationFacts(input.organizationId)
	if (!org) return null
	// Only a date the rule gives, for the market this organization is in.
	const market = marketOf(org)
	if (occasion.market !== market) return null
	const occurrence = occasionsBetween(market, input.date, input.date).find(
		(entry) => entry.key === occasion.key,
	)
	const now = input.now ?? Date.now()
	if (!occurrence) return null
	const timeZone = await organizationTimeZone(input.organizationId)
	const message = buildOccasionMessage({
		key: occasion.key,
		locale: org.siteDefaultLocale || 'en',
		restaurant: org.name,
		siteOrigin: orgSiteUrl(org),
		year: occurrence.year,
	})
	return {
		key: occasion.key,
		date: occurrence.date,
		message,
		sendAt: recommendedSendAt(occurrence.sendDate, timeZone, now),
	}
}
