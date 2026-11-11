import { DAYS_OF_WEEK, type DayOfWeek } from '@repo/common/location-types'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { getLocaleHref } from '@repo/common/site-locales'
import { formatMoney } from '~/lib/ordering/money'

/**
 * Builders for the per-site `robots.txt`, `sitemap.xml` and `llms.txt`.
 * Pure: the routes in `src/pages` fetch the data and pass it in.
 *
 * Only public content goes in: published pages, menu names and prices,
 * location address and hours. Never customer data.
 */

export type SitemapEntry = {
	/** Root-relative path in the default language, e.g. `/` or `/about`. */
	path: string
	lastModified?: string | null
}

export type SeoLocales = {
	locales: string[]
	defaultLocale: string
}

/** Paths that are never useful in search results. */
const DISALLOWED_PATHS = [
	'/api/',
	'/login',
	'/verify',
	'/complete-name',
	'/profile',
	'/menu/checkout',
	'/menu/success',
	'/reserve/manage',
	'/reserve/pay',
	'/shop/',
]

export function buildRobotsTxt(options: {
	origin: string
	/** False when the host serves no published site. */
	indexable: boolean
}): string {
	if (!options.indexable) {
		return 'User-agent: *\nDisallow: /\n'
	}
	return [
		'User-agent: *',
		'Allow: /',
		...DISALLOWED_PATHS.map((path) => `Disallow: ${path}`),
		'',
		`Sitemap: ${options.origin}/sitemap.xml`,
		'',
	].join('\n')
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

function localizedUrl(
	origin: string,
	path: string,
	locale: string,
	defaultLocale: string,
): string {
	return `${origin}${getLocaleHref(path, locale, null, defaultLocale)}`
}

/** Normalize a page slug into a root-relative path (`''` / `home` is `/`). */
export function pagePath(slug: string, isHomePage = false): string {
	const clean = slug.replace(/^\/+|\/+$/g, '')
	if (isHomePage || clean === '' || clean === 'home') return '/'
	return `/${clean
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/')}`
}

/**
 * One `<url>` per path and language, each listing every language version
 * (`xhtml:link` hreflang), matching the alternates the pages themselves emit.
 */
export function buildSitemapXml(
	origin: string,
	entries: SitemapEntry[],
	{ locales, defaultLocale }: SeoLocales,
): string {
	const languages = locales.length ? locales : [defaultLocale]
	const seen = new Set<string>()
	const unique = entries.filter((entry) => {
		if (seen.has(entry.path)) return false
		seen.add(entry.path)
		return true
	})
	const multilingual = languages.length > 1

	const urls = unique.flatMap((entry) =>
		languages.map((locale) => {
			const lines = [
				'  <url>',
				`    <loc>${escapeXml(localizedUrl(origin, entry.path, locale, defaultLocale))}</loc>`,
			]
			const lastModified = entry.lastModified?.slice(0, 10)
			if (lastModified && /^\d{4}-\d{2}-\d{2}$/.test(lastModified)) {
				lines.push(`    <lastmod>${lastModified}</lastmod>`)
			}
			if (multilingual) {
				for (const alternate of languages) {
					lines.push(
						`    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate)}" href="${escapeXml(localizedUrl(origin, entry.path, alternate, defaultLocale))}"/>`,
					)
				}
				lines.push(
					`    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(localizedUrl(origin, entry.path, defaultLocale, defaultLocale))}"/>`,
				)
			}
			lines.push('  </url>')
			return lines.join('\n')
		}),
	)

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${multilingual ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>`,
		...urls,
		'</urlset>',
		'',
	].join('\n')
}

// ---------------------------------------------------------------------------
// llms.txt (https://llmstxt.org): a Markdown summary written for AI assistants.
// ---------------------------------------------------------------------------

export type LlmsLocation = {
	name: string
	phone: string | null
	address: unknown
	storeHours: unknown
}

export type LlmsMenuCategory = {
	name: string
	/** `price` in major units (12.5 is $12.50), as the public menu sends it. */
	items: Array<{ name: string; price: number | null }>
}

export type LlmsInput = {
	origin: string
	name: string
	description?: string | null
	currency?: string | null
	locales: SeoLocales
	locations: LlmsLocation[]
	menu: LlmsMenuCategory[]
	links: Array<{ title: string; path: string; description?: string | null }>
}

/** Keeps the file small enough to read in one go. */
const MAX_MENU_ITEMS = 200

const DAY_LABELS: Record<DayOfWeek, string> = {
	monday: 'Monday',
	tuesday: 'Tuesday',
	wednesday: 'Wednesday',
	thursday: 'Thursday',
	friday: 'Friday',
	saturday: 'Saturday',
	sunday: 'Sunday',
}

/** One line of Markdown text: no line breaks, no stray link syntax. */
function inline(value: string | null | undefined): string {
	return (value ?? '')
		.replace(/\s+/g, ' ')
		.replace(/([[\]])/g, '\\$1')
		.trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === 'string') {
		try {
			return asRecord(JSON.parse(value))
		} catch {
			return null
		}
	}
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}

export function formatAddress(address: unknown): string {
	const record = asRecord(address)
	if (!record) return ''
	const formatted = text(record.formattedAddress)
	if (formatted) return formatted
	const street = [text(record.streetNumber), text(record.streetName)]
		.filter(Boolean)
		.join(' ')
	return [
		street,
		text(record.unit),
		text(record.city),
		[text(record.state), text(record.postalCode)].filter(Boolean).join(' '),
		text(record.country),
	]
		.filter(Boolean)
		.join(', ')
}

function to12Hour(time: string): string {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time)
	if (!match) return time
	const hours = Number(match[1])
	const suffix = hours >= 12 && hours < 24 ? 'PM' : 'AM'
	const hour12 = hours % 12 === 0 ? 12 : hours % 12
	return `${hour12}:${match[2]} ${suffix}`
}

/** "Monday: 9:00 AM–9:00 PM" lines; empty when the schedule is unreadable. */
export function formatWeeklyHours(schedule: unknown): string[] {
	let value = schedule
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	const byDay = new Map<string, { isOpen?: unknown; slots?: unknown }>()
	for (const day of value) {
		const record = asRecord(day)
		if (record && typeof record.day === 'string') byDay.set(record.day, record)
	}
	if (!byDay.size) return []
	return DAYS_OF_WEEK.map((day) => {
		const entry = byDay.get(day)
		const slots = Array.isArray(entry?.slots)
			? entry.slots
					.map((slot) => asRecord(slot))
					.filter(
						(slot): slot is Record<string, unknown> =>
							!!slot && !!text(slot.start) && !!text(slot.end),
					)
			: []
		if (!entry || entry.isOpen === false || !slots.length) {
			return `${DAY_LABELS[day]}: Closed`
		}
		return `${DAY_LABELS[day]}: ${slots
			.map(
				(slot) => `${to12Hour(text(slot.start))}–${to12Hour(text(slot.end))}`,
			)
			.join(', ')}`
	})
}

export function buildLlmsTxt(input: LlmsInput): string {
	const { origin, locales } = input
	const lines: string[] = [`# ${inline(input.name)}`, '']
	if (input.description) {
		lines.push(`> ${inline(input.description)}`, '')
	}
	lines.push(`Official website: ${origin}/`)
	if (locales.locales.length > 1) {
		lines.push(`Languages: ${locales.locales.join(', ')}`)
	}
	lines.push('')

	if (input.locations.length) {
		lines.push(input.locations.length > 1 ? '## Locations' : '## Location', '')
		for (const location of input.locations) {
			if (input.locations.length > 1) {
				lines.push(`### ${inline(location.name) || inline(input.name)}`, '')
			}
			const address = formatAddress(location.address)
			if (address) lines.push(`- Address: ${inline(address)}`)
			if (location.phone) lines.push(`- Phone: ${inline(location.phone)}`)
			const hours = formatWeeklyHours(location.storeHours)
			if (hours.length) {
				lines.push('- Hours:')
				for (const line of hours) lines.push(`  - ${line}`)
			}
			lines.push('')
		}
	}

	if (input.links.length) {
		lines.push('## Pages', '')
		for (const link of input.links) {
			const description = inline(link.description)
			lines.push(
				`- [${inline(link.title)}](${origin}${getLocaleHref(link.path, locales.defaultLocale, null, locales.defaultLocale)})${description ? `: ${description}` : ''}`,
			)
		}
		lines.push('')
	}

	const categories = input.menu.filter((category) => category.items.length)
	if (categories.length) {
		lines.push('## Menu', '')
		let listed = 0
		let truncated = false
		for (const category of categories) {
			if (listed >= MAX_MENU_ITEMS) {
				truncated = true
				break
			}
			lines.push(`### ${inline(category.name)}`, '')
			for (const item of category.items) {
				if (listed >= MAX_MENU_ITEMS) {
					truncated = true
					break
				}
				const price =
					item.price !== null && item.price > 0
						? `: ${formatMoney(item.price, input.currency ?? undefined, 'en')}`
						: ''
				lines.push(`- ${inline(item.name)}${price}`)
				listed++
			}
			lines.push('')
		}
		if (truncated) {
			lines.push(`The full menu is at ${origin}/menu.`, '')
		}
	}

	return `${lines.join('\n').trimEnd()}\n`
}

/** Localize a menu or location name stored as `{"en":"…","ar":"…"}`. */
export function localizedName(
	value: string | null | undefined,
	locales: SeoLocales,
): string {
	return getLocalizedMenuValue(
		value,
		locales.defaultLocale,
		locales.defaultLocale,
	).trim()
}
