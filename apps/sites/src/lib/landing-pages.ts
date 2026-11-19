/**
 * Pure helpers for the generated website pages (#137, #184): location pages,
 * dish pages, delivery area pages and event pages. The `.astro` routes fetch
 * the data and render; the rules (which page exists, which answers 404 or
 * 410, what the hours say) live here so they can be tested.
 */
import { cuisineLabel } from '@repo/common/cuisines'
import { DAYS_OF_WEEK } from '@repo/common/location-types'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { RESERVED_DISH_SLUGS } from '@repo/common/site-landing-pages'
import { localParts } from '@repo/zoned-time'
// Type-only: a value import would load the Workers runtime (verbatimModuleSyntax).
// eslint-disable-next-line import/consistent-type-specifier-style
import type {
	PublicLandingLocation,
	PublicLandingPayload,
	PublicMenuItemData,
	PublicSiteEvent,
	PublicSiteMenuPayload,
} from '~/lib/org'
import { formatAddress } from '~/lib/seo-files'

export type RouteOutcome<T> =
	| { kind: 'page'; value: T }
	/** Was a page, is not any more: 410 Gone. */
	| { kind: 'gone' }
	| { kind: 'not_found' }

/** `/locations/<slug>`: an active location's page, 410 for a removed one. */
export function resolveLocationPage(
	landing: PublicLandingPayload | null,
	slug: string,
): RouteOutcome<PublicLandingLocation> {
	if (!landing?.features.locationPages) return { kind: 'not_found' }
	const location = landing.locations.find((entry) => entry.slug === slug)
	if (location) return { kind: 'page', value: location }
	if (landing.goneLocationSlugs.includes(slug)) return { kind: 'gone' }
	return { kind: 'not_found' }
}

const HIDDEN = new Set(['hidden'])

/**
 * Visible online at some location: not hidden, and not switched off by
 * every location's override.
 */
export function isDishVisible(
	item: Pick<PublicMenuItemData, 'id' | 'availabilityStatus'>,
	menu: Pick<PublicSiteMenuPayload, 'locations' | 'locationOverrides'>,
): boolean {
	if (HIDDEN.has(item.availabilityStatus)) return false
	const locations = menu.locations ?? []
	if (!locations.length) return false
	return locations.some((location) => {
		const override = menu.locationOverrides?.[location.id]?.find(
			(entry) => entry.entityType === 'item' && entry.entityId === item.id,
		)
		return !(
			override?.isEnabled === false || override?.availabilityStatus === 'hidden'
		)
	})
}

export type DishPage = {
	item: PublicMenuItemData
	categoryName: string
	related: PublicMenuItemData[]
}

function allItems(menu: PublicSiteMenuPayload) {
	const out: Array<{
		item: PublicMenuItemData
		category: string
		categoryId: string
	}> = []
	for (const published of menu.menus ?? []) {
		const walk = (
			categories: PublicSiteMenuPayload['menus'][number]['categories'],
		) => {
			for (const category of categories ?? []) {
				for (const item of category.items ?? []) {
					out.push({
						item,
						category: category.displayName,
						categoryId: category.id,
					})
				}
				if (category.subcategories?.length) walk(category.subcategories)
			}
		}
		walk(published.categories)
	}
	return out
}

/**
 * `/menu/<slug>`: a dish with its own page switched on that is visible online.
 * A hidden or deleted dish, or one whose page is off, is a 404.
 */
export function resolveDishPage(
	landing: PublicLandingPayload | null,
	menu: PublicSiteMenuPayload | null,
	slug: string,
): RouteOutcome<DishPage> {
	if (
		!landing?.features.dishPages ||
		!menu ||
		(RESERVED_DISH_SLUGS as readonly string[]).includes(slug)
	) {
		return { kind: 'not_found' }
	}
	const entry = landing.dishes.find((dish) => dish.slug === slug)
	if (!entry) return { kind: 'not_found' }
	const items = allItems(menu)
	const found = items.find(({ item }) => item.id === entry.id)
	if (!found || !isDishVisible(found.item, menu)) return { kind: 'not_found' }
	const related = items
		.filter(
			({ item, categoryId }) =>
				categoryId === found.categoryId &&
				item.id !== found.item.id &&
				isDishVisible(item, menu),
		)
		.slice(0, 4)
		.map(({ item }) => item)
	return {
		kind: 'page',
		value: { item: found.item, categoryName: found.category, related },
	}
}

/** Dishes with a live page, for the sitemap and `llms.txt`. */
export function visibleDishPages(
	landing: PublicLandingPayload | null,
	menu: PublicSiteMenuPayload | null,
) {
	if (!landing?.features.dishPages || !menu) return []
	const items = new Map(allItems(menu).map(({ item }) => [item.id, item]))
	return landing.dishes.filter((dish) => {
		const item = items.get(dish.id)
		return item && isDishVisible(item, menu)
	})
}

/** `/delivery/<slug>`. */
export function resolveAreaPage(
	landing: PublicLandingPayload | null,
	slug: string,
) {
	if (!landing?.features.areaPages) return { kind: 'not_found' } as const
	const area = landing.areas.find((entry) => entry.slug === slug)
	return area
		? ({ kind: 'page', value: area } as const)
		: ({ kind: 'not_found' } as const)
}

/** `/events/<slug>`: 410 thirty days after the last occurrence. */
export function resolveEventPage(
	payload: { events: PublicSiteEvent[] } | null,
	slug: string,
): RouteOutcome<PublicSiteEvent> {
	const event = payload?.events.find((entry) => entry.slug === slug)
	if (!event) return { kind: 'not_found' }
	if (event.phase === 'gone') return { kind: 'gone' }
	return { kind: 'page', value: event }
}

/** A Google Maps directions link to the location (coordinates when known). */
export function directionsUrl(address: unknown): string | null {
	const record =
		address && typeof address === 'object'
			? (address as Record<string, unknown>)
			: null
	const lat = record?.lat
	const lng = record?.lng
	if (
		typeof lat === 'number' &&
		typeof lng === 'number' &&
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		!(lat === 0 && lng === 0)
	) {
		return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
	}
	const text = formatAddress(address)
	return text
		? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(text)}`
		: null
}

type Slot = { start: string; end: string }

function slotsOf(day: unknown): Slot[] | null {
	if (!day || typeof day !== 'object') return null
	const record = day as { isOpen?: unknown; slots?: unknown }
	if (record.isOpen === false) return []
	return Array.isArray(record.slots)
		? record.slots.filter(
				(slot): slot is Slot =>
					!!slot &&
					typeof (slot as Slot).start === 'string' &&
					typeof (slot as Slot).end === 'string',
			)
		: []
}

function parseList(value: unknown): unknown[] {
	let raw = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return []
		}
	}
	return Array.isArray(raw) ? raw : []
}

function formatTime(time: string, locale: string): string {
	const [h, m] = time.split(':').map(Number)
	if (!Number.isFinite(h) || !Number.isFinite(m)) return time
	return new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2024, 0, 1, h!, m!)))
}

/** Localized weekday name; `day` is a `DayOfWeek` key. */
function weekdayName(
	day: (typeof DAYS_OF_WEEK)[number],
	locale: string,
): string {
	// 1 January 2024 was a Monday.
	const index = DAYS_OF_WEEK.indexOf(day)
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		timeZone: 'UTC',
	}).format(new Date(Date.UTC(2024, 0, 1 + index)))
}

export type HoursRow = { day: string; text: string; today: boolean }

/**
 * The week's opening hours in the reader's language, Monday first, with
 * today marked (in the location's time zone). A special-hours entry for
 * today replaces the weekly hours.
 */
export function weeklyHoursRows(
	location: Pick<
		PublicLandingLocation,
		'storeHours' | 'specialHours' | 'timezone'
	>,
	locale: string,
	closedLabel: string,
	now = new Date(),
): HoursRow[] {
	const byDay = new Map<string, Slot[] | null>()
	for (const entry of parseList(location.storeHours)) {
		const day = (entry as { day?: unknown })?.day
		if (typeof day === 'string') byDay.set(day, slotsOf(entry))
	}
	if (!byDay.size) return []
	const parts = localParts(now.getTime(), location.timezone || 'UTC')
	const today = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
	const todayIndex =
		(new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay() +
			6) %
		7
	const special = parseList(location.specialHours).find(
		(entry) => (entry as { date?: unknown })?.date === today,
	)
	return DAYS_OF_WEEK.map((day, index) => {
		const isToday = index === todayIndex
		const slots = isToday && special ? slotsOf(special) : byDay.get(day)
		const text = slots?.length
			? slots
					.map(
						(slot) =>
							`${formatTime(slot.start, locale)}–${formatTime(slot.end, locale)}`,
					)
					.join(', ')
			: closedLabel
		return { day: weekdayName(day, locale), text, today: isToday }
	})
}

/**
 * The parts of the default `<title>` ("Al Bait Olaya – Lebanese restaurant
 * in Olaya, Riyadh"): the branch's full name, its first cuisine in the
 * reader's language and its city. The page words them with a translated
 * template, so word order follows the language.
 */
export function locationTitleParts(input: {
	brand: string
	location: Pick<PublicLandingLocation, 'name' | 'address' | 'cuisines'>
	locale: string
	defaultLocale: string
}): { name: string; cuisine: string; city: string } {
	const name = getLocalizedMenuValue(
		input.location.name,
		input.locale,
		input.defaultLocale,
	).trim()
	const record =
		input.location.address && typeof input.location.address === 'object'
			? (input.location.address as Record<string, unknown>)
			: {}
	return {
		name:
			!name || name.includes(input.brand)
				? name || input.brand
				: `${input.brand} ${name}`,
		cuisine: input.location.cuisines[0]
			? cuisineLabel(input.location.cuisines[0], input.locale)
			: '',
		city: typeof record.city === 'string' ? record.city.trim() : '',
	}
}
