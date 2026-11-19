/**
 * Generated landing pages (#137): one page per active location, optional dish
 * pages and delivery area pages. Pure rules shared by the App (which builds
 * the public payload) and Sites (which renders and lists them).
 */
import { slugifyTitle } from './site-events.ts'

/** Paths under `/menu/` that are ordering pages, never dish pages. */
export const RESERVED_DISH_SLUGS = ['checkout', 'success'] as const
/** At most this many area pages per organization. */
export const MAX_AREA_PAGES = 50

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidLandingSlug(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 80 && SLUG.test(value)
}

/** A dish slug from its name, unique among `taken`, never a reserved one. */
export function dishSlugFor(name: string, taken: ReadonlySet<string>): string {
	const base = slugifyTitle(name, 'dish')
	let candidate = base
	let n = 2
	while (
		taken.has(candidate) ||
		(RESERVED_DISH_SLUGS as readonly string[]).includes(candidate)
	) {
		candidate = `${base}-${n++}`
	}
	return candidate
}

export type ZoneLike = {
	id?: unknown
	name?: unknown
	enabled?: unknown
	restriction?: unknown
	provider?: unknown
	minimumOrder?: unknown
	deliveryFee?: unknown
}

export type AreaPageRow = {
	organizationLocationId: string
	zoneId: string
	slug: string
	intro: string | null
	enabled: boolean
}

export type AreaPage = {
	slug: string
	locationId: string
	zoneId: string
	name: string
	minimumOrder: number
	deliveryFee: number
	/** Localized JSON text the operator wrote, or null. */
	intro: string | null
	/** No intro yet: kept out of search results and the sitemap. */
	noIndex: boolean
}

function parseZones(value: unknown): ZoneLike[] {
	let raw = value
	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw)
		} catch {
			return []
		}
	}
	return Array.isArray(raw)
		? raw.filter((zone): zone is ZoneLike => !!zone && typeof zone === 'object')
		: []
}

function hasIntro(intro: string | null): boolean {
	if (!intro?.trim()) return false
	try {
		const parsed: unknown = JSON.parse(intro)
		if (parsed && typeof parsed === 'object') {
			return Object.values(parsed).some(
				(value) => typeof value === 'string' && value.trim().length > 0,
			)
		}
	} catch {
		/* plain text */
	}
	return true
}

/**
 * Area pages for an organization: named delivery zones that are on and
 * allowed, at active locations, minus the ones the operator switched off. At
 * most 50; pages without intro text are noindex.
 */
export function buildAreaPages(
	locations: ReadonlyArray<{
		id: string
		isActive: boolean
		deliveryZones: unknown
	}>,
	rows: readonly AreaPageRow[],
): AreaPage[] {
	const byZone = new Map(
		rows.map((row) => [`${row.organizationLocationId}:${row.zoneId}`, row]),
	)
	const pages: AreaPage[] = []
	const slugs = new Set<string>()
	for (const location of locations) {
		if (!location.isActive) continue
		for (const zone of parseZones(location.deliveryZones)) {
			const zoneId = typeof zone.id === 'string' ? zone.id : ''
			const name = typeof zone.name === 'string' ? zone.name.trim() : ''
			if (
				!zoneId ||
				!name ||
				zone.enabled === false ||
				zone.restriction === 'disallowed' ||
				zone.provider === 'restricted'
			) {
				continue
			}
			const row = byZone.get(`${location.id}:${zoneId}`)
			if (row && !row.enabled) continue
			let slug =
				row && isValidLandingSlug(row.slug)
					? row.slug
					: slugifyTitle(name, 'area')
			if (slugs.has(slug)) {
				let n = 2
				while (slugs.has(`${slug}-${n}`)) n++
				slug = `${slug}-${n}`
			}
			slugs.add(slug)
			const intro = row?.intro ?? null
			pages.push({
				slug,
				locationId: location.id,
				zoneId,
				name,
				minimumOrder: Number(zone.minimumOrder) || 0,
				deliveryFee: Number(zone.deliveryFee) || 0,
				intro: hasIntro(intro) ? intro : null,
				noIndex: !hasIntro(intro),
			})
			if (pages.length >= MAX_AREA_PAGES) return pages
		}
	}
	return pages
}
