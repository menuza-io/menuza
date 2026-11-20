/**
 * Restaurant website sections (#86). Section config stores choices only
 * (which dishes, which locations, layout). Prices, hours and photos are
 * read from the live menu and locations when the page renders.
 *
 * The rewards promo is the existing `rewards` block: it already reads the
 * live program and stays hidden unless loyalty is on. This module does not
 * add a second one.
 */
import {
	locationLocalClock,
	parseSpecialHours,
	parseWeeklyHours,
	rangesForDate,
	type LocationHours,
} from '@repo/opening-hours'
import { addDays, zonedLocalToUtc } from '@repo/zoned-time'

export const MENU_HIGHLIGHT_SOURCES = ['popular', 'category', 'picked'] as const
export type MenuHighlightSource = (typeof MENU_HIGHLIGHT_SOURCES)[number]

export const MENU_HIGHLIGHT_LAYOUTS = ['row', 'grid'] as const

const SKIPPED_AVAILABILITY = new Set(['hidden', 'unavailable'])

export type CatalogDish = {
	id: string
	name: string
	description: string
	/** Base price in major units at the default location. */
	price: number
	currency: string
	imageUrl: string | null
	categoryIds: string[]
	isPopular: boolean
	/** `hidden` and `unavailable` are left out. Anything else is shown. */
	availability: string
	/** Options or variants: the price is shown as "from". */
	hasOptions: boolean
}

export type MenuHighlightConfig = {
	heading?: unknown
	subtitle?: unknown
	source?: unknown
	categoryId?: unknown
	itemIds?: unknown
	layout?: unknown
}

export function parseMenuHighlightConfig(raw: MenuHighlightConfig): {
	source: MenuHighlightSource
	categoryId: string
	itemIds: string[]
	layout: 'row' | 'grid'
} {
	const source = MENU_HIGHLIGHT_SOURCES.includes(
		raw.source as MenuHighlightSource,
	)
		? (raw.source as MenuHighlightSource)
		: 'popular'
	const layout = raw.layout === 'grid' ? 'grid' : 'row'
	const itemIds = Array.isArray(raw.itemIds)
		? raw.itemIds.filter(
				(id): id is string => typeof id === 'string' && id.length > 0,
			)
		: []
	return {
		source,
		categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
		itemIds,
		layout,
	}
}

/**
 * Dishes the section shows. Deleted dishes are simply absent from `dishes`.
 * Hidden or unavailable dishes are skipped. An empty result means the
 * section is hidden.
 */
export function resolveMenuHighlights(
	raw: MenuHighlightConfig,
	dishes: readonly CatalogDish[],
): CatalogDish[] {
	const config = parseMenuHighlightConfig(raw)
	const available = dishes.filter(
		(dish) => !SKIPPED_AVAILABILITY.has(dish.availability),
	)
	if (config.source === 'picked') {
		const byId = new Map(available.map((dish) => [dish.id, dish]))
		return config.itemIds
			.map((id) => byId.get(id))
			.filter((dish): dish is CatalogDish => Boolean(dish))
			.slice(0, 12)
	}
	if (config.source === 'category') {
		if (!config.categoryId) return []
		return available
			.filter((dish) => dish.categoryIds.includes(config.categoryId))
			.slice(0, 12)
	}
	return available.filter((dish) => dish.isPopular).slice(0, 12)
}

/** A location price replaces the base price. Missing override keeps the base. */
export function dishPriceAtLocation(
	base: number,
	override: number | null | undefined,
): number {
	return typeof override === 'number' && Number.isFinite(override)
		? override
		: base
}

export function highlightShowsFromPrice(dish: Pick<CatalogDish, 'hasOptions'>) {
	return dish.hasOptions
}

export function locationOffersOrdering(fulfillment: unknown): boolean {
	const value = jsonRecord(fulfillment)
	if (!value) return false
	return value.pickup === true || value.delivery === true
}

export function orderingIsPaused(
	pause: { until?: string | null } | null | undefined,
	now = new Date(),
): boolean {
	if (!pause) return false
	if (pause.until == null || pause.until === '') return true
	const until = new Date(pause.until)
	if (Number.isNaN(until.getTime())) return true
	return until.getTime() > now.getTime()
}

export type HeroLinkWhen = 'ordering' | 'reservations'

export type GatedHeroLink = {
	url?: unknown
	link?: { label?: string }
	variant?: string
	when?: HeroLinkWhen | ''
}

/** Order and Reserve links render only while that feature is on. */
export function visibleHeroLinks<T extends GatedHeroLink>(
	links: readonly T[] | undefined,
	features: { ordering: boolean; reservations: boolean },
): T[] {
	return (links ?? []).filter((link) => {
		if (!link.link?.label) return false
		if (link.when === 'ordering') return features.ordering
		if (link.when === 'reservations') return features.reservations
		return true
	})
}

export type OpenNowState = {
	open: boolean
	/** Local time the current range ends, when open. */
	closesAt?: string
	/** Local time the next range starts, when closed. */
	opensAt?: string
	/** Include the weekday on `opensAt` when it is not today. */
	opensAnotherDay?: boolean
}

export function storeLocationHours(input: {
	timeZone: string
	isActive?: boolean | null
	storeHours: unknown
	specialHours: unknown
}): LocationHours {
	const weekly = parseWeeklyHours(input.storeHours)
	const special = parseSpecialHours(input.specialHours)
	return {
		timeZone: input.timeZone || 'UTC',
		isActive: input.isActive !== false,
		storeHours: weekly.value,
		onlineHours: null,
		specialHours: special.value,
	}
}

function formatLocalMinute(
	date: string,
	minute: number,
	timeZone: string,
	locale: string,
	withDay: boolean,
): string | undefined {
	const [year, month, day] = date.split('-').map(Number)
	if (!year || !month || !day) return undefined
	const hour = Math.floor(minute / 60)
	const mins = minute % 60
	try {
		const ms = zonedLocalToUtc(year, month, day, hour, mins, timeZone)
		return new Intl.DateTimeFormat(locale, {
			timeZone,
			hour: 'numeric',
			minute: '2-digit',
			...(withDay ? { weekday: 'short' } : {}),
		}).format(new Date(ms))
	} catch {
		return undefined
	}
}

/**
 * "Open now" from store hours (not online-ordering hours) in the location's
 * time zone. An overnight slot (18:00–02:00) is still open after midnight.
 * A special-hours day replaces that date, including a closure.
 */
export function describeOpenNow(
	input: {
		timeZone: string
		isActive?: boolean | null
		storeHours: unknown
		specialHours: unknown
	},
	now = new Date(),
	locale = 'en',
): OpenNowState {
	const hours = storeLocationHours(input)
	if (!hours.isActive) return { open: false }
	const zone = hours.timeZone
	const { date, minute } = locationLocalClock(now.getTime(), zone)
	const today = rangesForDate(hours, date, 'store')
	const current = today.ranges.find(
		([from, to]) => minute >= from && minute <= to,
	)
	if (current) {
		let endDate = date
		let endMinute = current[1]
		// A range that runs to the end of the day continues into an overnight tail.
		if (endMinute >= 1439) {
			const nextDate = addDays(date, 1)
			const next = rangesForDate(hours, nextDate, 'store')
			const tail = next.ranges.find(([from]) => from === 0)
			if (tail && tail[1] < 1439) {
				endDate = nextDate
				endMinute = tail[1]
			}
		}
		return {
			open: true,
			closesAt: formatLocalMinute(endDate, endMinute, zone, locale, false),
		}
	}
	let cursor = date
	for (let i = 0; i < 8; i += 1) {
		const day = i === 0 ? today : rangesForDate(hours, cursor, 'store')
		const start = day.ranges.find(([from]) => i > 0 || from > minute)
		if (start) {
			return {
				open: false,
				opensAt: formatLocalMinute(cursor, start[0], zone, locale, i > 0),
				opensAnotherDay: i > 0,
			}
		}
		cursor = addDays(cursor, 1)
	}
	return { open: false }
}

export function selectedLocationIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return []
	return raw.filter(
		(id): id is string => typeof id === 'string' && id.length > 0,
	)
}

/** Empty selection means every location. */
export function locationsForSection<T extends { id: string }>(
	locations: readonly T[],
	selectedIds: readonly string[],
): T[] {
	if (selectedIds.length === 0) return [...locations]
	const wanted = new Set(selectedIds)
	return locations.filter((location) => wanted.has(location.id))
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'string') {
		try {
			return jsonRecord(JSON.parse(value) as unknown)
		} catch {
			return null
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

const LOGIN_PATH = /^\/login(?:[/?#]|$)/

/** True when any string in the tree is a `/login` link. */
export function containsLoginCta(value: unknown): boolean {
	if (typeof value === 'string') return LOGIN_PATH.test(value.trim())
	if (Array.isArray(value)) return value.some((item) => containsLoginCta(item))
	if (value && typeof value === 'object') {
		return Object.values(value as Record<string, unknown>).some((item) =>
			containsLoginCta(item),
		)
	}
	return false
}
