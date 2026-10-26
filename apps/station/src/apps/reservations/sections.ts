import {
	isFreeKind,
	isOnFloor,
	tableState,
	type DayFeed,
	type DaySectionLayout,
} from './feed.ts'

/**
 * Server sections: how the floor is split between servers for a service. A
 * manager draws the sections in the App (Reservations, Settings, Sections) and
 * picks one layout per service; the host gives each section a server at the
 * start of the shift. The stand uses them to show who has which table, and to
 * keep the servers evenly busy: the table it suggests leans to the section
 * that has been sat least lately (a rotation, as hosts keep it by hand).
 */

/** The palette a manager picks from in the App, by token (`blue`) or slot (`2`). */
const SECTION_COLORS: Record<string, string> = {
	'1': '#3b82f6',
	'2': '#10b981',
	'3': '#f59e0b',
	'4': '#8b5cf6',
	'5': '#ec4899',
	'6': '#06b6d4',
	'7': '#f97316',
	'8': '#6366f1',
	blue: '#3b82f6',
	emerald: '#10b981',
	green: '#10b981',
	amber: '#f59e0b',
	purple: '#8b5cf6',
	violet: '#8b5cf6',
	pink: '#ec4899',
	rose: '#f43f5e',
	cyan: '#06b6d4',
	teal: '#14b8a6',
	orange: '#f97316',
	indigo: '#6366f1',
	slate: '#64748b',
}
/** For a section with no colour (or `neutral`): the palette in order, so neighbours differ. */
const ROTATING = ['1', '2', '3', '4', '5', '6', '7', '8'] as const

export function sectionColor(token: string | null | undefined, index: number) {
	const key = token?.trim().toLowerCase() ?? ''
	if (/^#[0-9a-f]{3,8}$/.test(key)) return key
	return (
		SECTION_COLORS[key] ?? SECTION_COLORS[ROTATING[index % ROTATING.length]!]!
	)
}

export type SectionServer = { staffId: string | null; name: string }

export type FloorSection = {
	id: string
	name: string
	/** A CSS colour for the section's outline and dot. */
	color: string
	tableIds: string[]
	/** Who works it this service, or null while nobody is assigned. */
	server: SectionServer | null
}

/**
 * The sections in force for a service: the service's own layout, else the
 * only one there is (or the first). Null where nobody drew sections, or for
 * "All day" with several services (each may split the floor differently).
 */
export function sectionLayoutFor(
	feed: Pick<DayFeed, 'sectionLayouts' | 'services'>,
	serviceId: string | null,
): DaySectionLayout | null {
	const layouts = feed.sectionLayouts.filter(
		(layout) => layout.sections.length > 0,
	)
	if (!layouts.length || serviceId === null) return null
	const own = feed.services.find(
		(service) => service.id === serviceId,
	)?.sectionLayoutId
	return (own && layouts.find((layout) => layout.id === own)) || layouts[0]!
}

/** The sections of a service, with their colours and who works each. */
export function floorSections(
	feed: Pick<
		DayFeed,
		'sectionLayouts' | 'services' | 'sectionAssignments' | 'tables'
	>,
	serviceId: string | null,
): FloorSection[] {
	const layout = sectionLayoutFor(feed, serviceId)
	if (!layout) return []
	const live = new Set(
		feed.tables.filter((table) => !table.archivedAt).map((table) => table.id),
	)
	return [...layout.sections]
		.sort((a, b) => a.sort - b.sort)
		.map((section, index) => {
			const assigned = feed.sectionAssignments.find(
				(row) => row.serviceId === serviceId && row.sectionId === section.id,
			)
			const name = assigned?.serverLabel?.trim() ?? ''
			return {
				id: section.id,
				name: section.name,
				color: sectionColor(section.colorToken, index),
				tableIds: section.tableIds.filter((id) => live.has(id)),
				server:
					name || assigned?.staffId
						? { staffId: assigned?.staffId ?? null, name }
						: null,
			}
		})
}

/** Table id to its section, for the floor and the sheets. */
export function sectionByTable(sections: readonly FloorSection[]) {
	const map = new Map<string, FloorSection>()
	for (const section of sections)
		for (const id of section.tableIds) map.set(id, section)
	return map
}

/** "Maya S." reads MS on a table; one name, its first two letters. */
export function initialsOf(name: string) {
	const words = name
		.trim()
		.split(/\s+/)
		.filter((word) => /\p{L}/u.test(word))
	if (!words.length) return ''
	const letters =
		words.length === 1
			? [...words[0]!].filter((c) => /\p{L}/u.test(c)).slice(0, 2)
			: words
					.slice(0, 2)
					.map((word) => [...word].find((c) => /\p{L}/u.test(c))!)
	return letters.join('').toLocaleUpperCase()
}

/** How long "sat lately" looks back, for the rotation. */
export const ROTATION_WINDOW_MIN = 45

export type SectionLoad = {
	section: FloorSection
	/** Covers at the section's tables now. */
	covers: number
	/** Covers sat in the section in the last `ROTATION_WINDOW_MIN` minutes. */
	recentCovers: number
	/** Tables free to seat now (open, or due later than half an hour). */
	free: number
	tables: number
}

/** How busy each section is now, and how busy it was made lately. */
export function sectionLoads(
	sections: readonly FloorSection[],
	feed: Pick<DayFeed, 'tables' | 'reservations' | 'blocks'>,
	now: number,
): SectionLoad[] {
	const since = now - ROTATION_WINDOW_MIN * 60_000
	return sections.map((section) => {
		const ids = new Set(section.tableIds)
		const tables = feed.tables.filter(
			(table) => ids.has(table.id) && !table.archivedAt,
		)
		const here = feed.reservations.filter((r) =>
			r.tableIds.some((id) => ids.has(id)),
		)
		return {
			section,
			covers: here.filter(isOnFloor).reduce((sum, r) => sum + r.partySize, 0),
			recentCovers: here
				.filter(
					(r) =>
						typeof r.seatedAt === 'number' &&
						r.seatedAt >= since &&
						r.seatedAt <= now,
				)
				.reduce((sum, r) => sum + r.partySize, 0),
			free: tables.filter((table) =>
				isFreeKind(tableState(table, feed, now).kind),
			).length,
			tables: tables.length,
		}
	})
}

/**
 * The section to seat next: of those with a server and a free table, the one
 * sat least lately, then the one with the fewest covers now. Null when no
 * section has a server (the stand then suggests by size alone).
 */
export function upNext(loads: readonly SectionLoad[]): string | null {
	const ready = loads.filter((load) => load.section.server && load.free > 0)
	ready.sort((a, b) => a.recentCovers - b.recentCovers || a.covers - b.covers)
	return ready[0]?.section.id ?? null
}
