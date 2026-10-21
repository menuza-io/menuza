import { type ReservationLabels } from './labels.ts'
import { formatMinor } from './money.ts'
import { formatClock, formatDateShort } from './time.ts'
import { type PublicExperience } from './types.ts'
import { fillTemplate } from '~/lib/ordering/money'

/**
 * Public experience catalog helpers. The catalog is public, non-guest data:
 * the server renders it (3 s timeout, short cache) and the browser books
 * through the regional tenant-api like every other reservation.
 */

const SLUG_RE = /^[a-z0-9-]{1,64}$/

export function isExperienceSlug(value: string | undefined): value is string {
	return Boolean(value && SLUG_RE.test(value))
}

type FetchOptions = {
	tenantApiUrl: string
	/** The site's own origin: tenant-api resolves the organization from it. */
	origin: string
	locale?: string | null
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

async function getJson<T>(
	url: string,
	options: FetchOptions,
): Promise<T | null> {
	const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args))
	try {
		const response = await fetchImpl(url, {
			headers: { Accept: 'application/json', Origin: options.origin },
			signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
		})
		if (!response.ok) return null
		return (await response.json()) as T
	} catch {
		return null
	}
}

function search(params: Record<string, string | null | undefined>) {
	const query = new URLSearchParams()
	for (const [key, value] of Object.entries(params)) {
		if (value) query.set(key, value)
	}
	const text = query.toString()
	return text ? `?${text}` : ''
}

/** Published experiences, or `null` when tenant-api says no (uniform 404) or is unreachable. */
export async function fetchPublicExperiences(
	options: FetchOptions,
): Promise<PublicExperience[] | null> {
	const base = options.tenantApiUrl.replace(/\/$/, '')
	const data = await getJson<{ experiences?: PublicExperience[] }>(
		`${base}/reservations/experiences${search({ locale: options.locale })}`,
		options,
	)
	return Array.isArray(data?.experiences) ? data.experiences : null
}

export async function fetchPublicExperience(
	slug: string,
	options: FetchOptions & { locationId?: string | null },
): Promise<PublicExperience | null> {
	if (!isExperienceSlug(slug)) return null
	const base = options.tenantApiUrl.replace(/\/$/, '')
	const data = await getJson<{ experience?: PublicExperience }>(
		`${base}/reservations/experiences/${slug}${search({
			locale: options.locale,
			locationId: options.locationId,
		})}`,
		options,
	)
	return data?.experience ?? null
}

/** Only `https:` images are shown. */
export function safeImageUrl(value: string | null | undefined): string | null {
	if (!value) return null
	try {
		const url = new URL(value)
		return url.protocol === 'https:' ? url.toString() : null
	} catch {
		return null
	}
}

export function priceText(
	experience: Pick<PublicExperience, 'price'>,
	labels: ReservationLabels,
	locale: string,
): string | null {
	const price = experience.price
	if (!price) return null
	const formatted = formatMinor(price.priceMinor, price.currency, locale)
	return fillTemplate(
		price.perCover ? labels.expPricePerGuest : labels.expPricePerBooking,
		{ price: formatted },
	)
}

export function partyText(
	experience: Pick<PublicExperience, 'partyMin' | 'partyMax'>,
	labels: ReservationLabels,
): string {
	return experience.partyMin === experience.partyMax
		? fillTemplate(labels.expPartyExact, { count: experience.partyMin })
		: fillTemplate(labels.expPartyRange, {
				min: experience.partyMin,
				max: experience.partyMax,
			})
}

/** A one-paragraph preview that never cuts a word in half. */
export function snippet(text: string | null | undefined, max = 160): string {
	const clean = (text ?? '').replace(/\s+/g, ' ').trim()
	if (clean.length <= max) return clean
	const cut = clean.slice(0, max)
	const space = cut.lastIndexOf(' ')
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** "Sat, Nov 1: 7:00 PM, 8:30 PM" for the next few days that have seatings. */
export function seatingPreview(
	experience: Pick<PublicExperience, 'seatings'>,
	locale: string,
	days = 3,
	timesPerDay = 4,
): Array<{ date: string; label: string; times: string[] }> {
	return experience.seatings.slice(0, days).map((day) => ({
		date: day.date,
		label: formatDateShort(day.date, locale),
		times: day.times
			.slice(0, timesPerDay)
			.map((time) => formatClock(time.localMin, locale)),
	}))
}
