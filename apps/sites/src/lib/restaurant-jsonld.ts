import { serializeJsonLd } from '@repo/common/job-posting'
import { DAYS_OF_WEEK, type DayOfWeek } from '@repo/common/location-types'
import { getLocaleHref } from '@repo/common/site-locales'
import { localizedName, type SeoLocales } from '~/lib/seo-files'

/**
 * schema.org `Restaurant` structured data for a site's home page
 * (https://developers.google.com/search/docs/appearance/structured-data/local-business).
 *
 * Pure: the page fetches the data and passes it in. Only public facts the
 * restaurant published (name, icon, locations, hours, phone, whether the menu
 * and bookings are online) go in, and a field we have no data for is left
 * out rather than guessed. Never customer data.
 */

export type RestaurantJsonLdLocation = {
	id: string
	/** Plain or localized (`{"en":"…","ar":"…"}`) name. */
	name: string
	phone: string | null
	/** `LocationAddress` from `@repo/common/location-types`, possibly partial. */
	address: unknown
	/** `WeeklySchedule`, possibly a JSON string. */
	storeHours: unknown
	fulfillmentOptions?: unknown
}

export type RestaurantJsonLdInput = {
	/** Site origin, e.g. `https://example.com` (no trailing slash). */
	origin: string
	name: string
	/** Language of the page; names and links are given in it. */
	locale: string
	locales: SeoLocales
	logoUrl?: string | null
	locations: RestaurantJsonLdLocation[]
	/** The site has at least one published menu. */
	hasMenu: boolean
	/** Online booking is on (the reservations gate's `online`). */
	reservationsOnline: boolean
}

type JsonObject = Record<string, unknown>

const DAY_NAMES: Record<DayOfWeek, string> = {
	monday: 'Monday',
	tuesday: 'Tuesday',
	wednesday: 'Wednesday',
	thursday: 'Thursday',
	friday: 'Friday',
	saturday: 'Saturday',
	sunday: 'Sunday',
}

/** The App's "until the end of the day" marker; overnight hours are split here. */
const END_OF_DAY = '23:59'
const START_OF_DAY = '00:00'

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value
	try {
		return JSON.parse(value)
	} catch {
		return null
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	const parsed = parseJson(value)
	return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}

function time(value: unknown): string | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(text(value))
	if (!match) return null
	const hours = Number(match[1])
	const minutes = Number(match[2])
	if (hours > 23 || minutes > 59) return null
	return `${String(hours).padStart(2, '0')}:${match[2]}`
}

type Slot = { opens: string; closes: string }

function readSchedule(schedule: unknown): Map<DayOfWeek, Slot[]> | null {
	const value = parseJson(schedule)
	if (!Array.isArray(value)) return null
	const byDay = new Map<DayOfWeek, Slot[]>()
	for (const entry of value) {
		const record = asRecord(entry)
		const day = text(record?.day) as DayOfWeek
		if (!record || !DAYS_OF_WEEK.includes(day)) continue
		const slots =
			record.isOpen === false || !Array.isArray(record.slots)
				? []
				: record.slots
						.map((slot) => {
							const item = asRecord(slot)
							const opens = time(item?.start)
							const closes = time(item?.end)
							return opens && closes && opens !== closes
								? { opens, closes }
								: null
						})
						.filter((slot): slot is Slot => slot !== null)
						.sort((a, b) => a.opens.localeCompare(b.opens))
		byDay.set(day, slots)
	}
	return byDay.size ? byDay : null
}

/**
 * `openingHoursSpecification` from a weekly schedule. Days with the same hours
 * share one entry. The App stores overnight hours split at midnight (Friday
 * 18:00–23:59 plus Saturday 00:00–02:00); they are joined back into one span
 * (Friday 18:00–02:00), as Google asks for hours past midnight. A closed day
 * is `00:00`–`00:00`. Days missing from the schedule, or open only for the
 * end of the night before, are left out.
 */
export function openingHoursSpecification(schedule: unknown): JsonObject[] {
	const byDay = readSchedule(schedule)
	if (!byDay) return []

	const merged = new Map<DayOfWeek, Slot[]>()
	for (const day of DAYS_OF_WEEK) {
		const slots = byDay.get(day)
		if (slots)
			merged.set(
				day,
				slots.map((slot) => ({ ...slot })),
			)
	}
	DAYS_OF_WEEK.forEach((day, index) => {
		const today = merged.get(day)
		const next = merged.get(DAYS_OF_WEEK[(index + 1) % DAYS_OF_WEEK.length]!)
		const last = today?.at(-1)
		const carried = next?.[0]
		if (
			!last ||
			!carried ||
			last.closes !== END_OF_DAY ||
			carried.opens !== START_OF_DAY ||
			// A day open around the clock stays its own entry.
			carried.closes === END_OF_DAY
		) {
			return
		}
		last.closes = carried.closes
		next.shift()
		// Open only past the previous midnight: not a day of its own (and not
		// "closed" either).
		if (!next.length)
			merged.delete(DAYS_OF_WEEK[(index + 1) % DAYS_OF_WEEK.length]!)
	})

	const groups = new Map<string, { days: DayOfWeek[]; slots: Slot[] }>()
	for (const day of DAYS_OF_WEEK) {
		const slots = merged.get(day)
		if (!slots) continue
		const key = slots.length
			? slots.map((slot) => `${slot.opens}-${slot.closes}`).join(',')
			: 'closed'
		const group = groups.get(key)
		if (group) group.days.push(day)
		else groups.set(key, { days: [day], slots })
	}

	const result: JsonObject[] = []
	for (const { days, slots } of groups.values()) {
		const dayOfWeek = days.map((day) => DAY_NAMES[day])
		const spans = slots.length
			? slots
			: [{ opens: START_OF_DAY, closes: START_OF_DAY }]
		for (const slot of spans) {
			result.push({
				'@type': 'OpeningHoursSpecification',
				dayOfWeek: dayOfWeek.length === 1 ? dayOfWeek[0] : dayOfWeek,
				opens: slot.opens,
				closes: slot.closes,
			})
		}
	}
	return result
}

/** `PostalAddress` from a `LocationAddress`, or null with nothing to say. */
export function postalAddress(address: unknown): JsonObject | null {
	const record = asRecord(address)
	if (!record) return null
	const city = text(record.city)
	let street = [
		[text(record.streetNumber), text(record.streetName)]
			.filter(Boolean)
			.join(' '),
		text(record.unit),
	]
		.filter(Boolean)
		.join(', ')
	if (!street) {
		// Older addresses only have the one-line form: its first part is the street.
		const first = text(record.formattedAddress).split(',')[0]?.trim() ?? ''
		if (first && first !== city) street = first
	}
	const fields: Array<[string, string]> = [
		['streetAddress', street],
		['addressLocality', city],
		['addressRegion', text(record.state)],
		['postalCode', text(record.postalCode)],
		['addressCountry', text(record.country)],
	]
	const present = fields.filter(([, value]) => value)
	if (!present.length) return null
	return { '@type': 'PostalAddress', ...Object.fromEntries(present) }
}

function geoCoordinates(address: unknown): JsonObject | null {
	const record = asRecord(address)
	const latitude = record?.lat
	const longitude = record?.lng
	if (
		typeof latitude !== 'number' ||
		typeof longitude !== 'number' ||
		!Number.isFinite(latitude) ||
		!Number.isFinite(longitude) ||
		Math.abs(latitude) > 90 ||
		Math.abs(longitude) > 180 ||
		// An unset address is stored as 0,0: not a real place to send people.
		(latitude === 0 && longitude === 0)
	) {
		return null
	}
	return { '@type': 'GeoCoordinates', latitude, longitude }
}

/** schema.org delivery methods for the order types a location takes. */
function deliveryMethods(fulfillmentOptions: unknown): string[] {
	const options = asRecord(fulfillmentOptions) ?? {}
	// Same defaults as the menu page: pickup and delivery unless turned off.
	const methods: string[] = []
	if (options.pickup !== false)
		methods.push('http://purl.org/goodrelations/v1#DeliveryModePickUp')
	if (options.delivery !== false)
		methods.push('http://purl.org/goodrelations/v1#DeliveryModeOwnFleet')
	return methods
}

function entryPoint(url: string): JsonObject {
	return {
		'@type': 'EntryPoint',
		urlTemplate: url,
		actionPlatform: [
			'https://schema.org/DesktopWebPlatform',
			'https://schema.org/MobileWebPlatform',
		],
	}
}

/**
 * The structured data object: one `Restaurant` for a single location (or
 * none), or a `@graph` with the `Organization` and one `Restaurant` per
 * location (each its `department`) when there are several.
 */
export function buildRestaurantJsonLd(
	input: RestaurantJsonLdInput,
): JsonObject {
	const { origin, locale } = input
	const names: SeoLocales = { ...input.locales, defaultLocale: locale }
	const href = (path: string) =>
		`${origin}${getLocaleHref(path, locale, null, input.locales.defaultLocale)}`
	const homeUrl = href('/')
	const menuUrl = input.hasMenu ? href('/menu') : null
	const reserveUrl = input.reservationsOnline ? href('/reserve') : null
	const name = input.name.trim()
	const logo = input.logoUrl?.trim() || null

	const restaurant = (
		location: RestaurantJsonLdLocation | null,
	): JsonObject => {
		const node: JsonObject = { '@type': 'Restaurant' }
		const locationName = location ? localizedName(location.name, names) : ''
		// With several locations each is named, keeping the brand in front.
		node.name =
			input.locations.length > 1 && locationName
				? locationName.includes(name)
					? locationName
					: `${name} - ${locationName}`
				: name
		node.url = homeUrl
		if (logo) {
			node.logo = logo
			node.image = logo
		}
		if (location) {
			const phone = text(location.phone)
			if (phone) node.telephone = phone
			const address = postalAddress(location.address)
			if (address) node.address = address
			const geo = geoCoordinates(location.address)
			if (geo) node.geo = geo
			const hours = openingHoursSpecification(location.storeHours)
			if (hours.length) node.openingHoursSpecification = hours
		}
		if (menuUrl) node.hasMenu = menuUrl
		if (reserveUrl) node.acceptsReservations = true
		const actions: JsonObject[] = []
		if (reserveUrl) {
			actions.push({
				'@type': 'ReserveAction',
				target: entryPoint(reserveUrl),
			})
		}
		// Ordering happens on the menu page and needs a location to order from.
		if (menuUrl && location) {
			const methods = deliveryMethods(location.fulfillmentOptions)
			actions.push({
				'@type': 'OrderAction',
				target: entryPoint(menuUrl),
				...(methods.length ? { deliveryMethod: methods } : {}),
			})
		}
		if (actions.length) {
			node.potentialAction = actions.length === 1 ? actions[0] : actions
		}
		return node
	}

	if (input.locations.length <= 1) {
		return {
			'@context': 'https://schema.org',
			...restaurant(input.locations[0] ?? null),
		}
	}

	const organizationId = `${origin}/#organization`
	const departments = input.locations.map((location) => ({
		'@id': `${origin}/#location-${encodeURIComponent(location.id)}`,
		...restaurant(location),
		parentOrganization: { '@id': organizationId },
	}))
	const organization: JsonObject = {
		'@type': 'Organization',
		'@id': organizationId,
		name,
		url: homeUrl,
		...(logo ? { logo } : {}),
		department: departments.map((department) => ({ '@id': department['@id'] })),
	}
	return {
		'@context': 'https://schema.org',
		'@graph': [organization, ...departments],
	}
}

/** The `application/ld+json` text, safe inside a `<script>` element. */
export function restaurantStructuredData(input: RestaurantJsonLdInput): string {
	return serializeJsonLd(buildRestaurantJsonLd(input))
}
