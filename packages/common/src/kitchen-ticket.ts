/**
 * Shared kitchen ticket view: the name, highlight and course a screen or a
 * later print layout can choose among. No guest contact data.
 */
import { z } from 'zod'
import { getLocalizedMenuValue } from './menu-types.ts'
import { type KitchenHighlight, type KdsLine } from './kds.ts'

const REMOVAL = /^(?:no|without|hold the|hold|minus)\b|^(?:بدون|لا)(?:\s|$)/iu

/** Options that take something off default to Attention until a person chooses. */
export function defaultKitchenHighlight(
	name: string | null | undefined,
): 'attention' | 'none' {
	const plain = (getLocalizedMenuValue(name) || name || '').trim()
	return REMOVAL.test(plain) ? 'attention' : 'none'
}

/**
 * A stored highlight, or the removal default when nothing was chosen.
 * `none` is an explicit choice and stays quiet.
 */
export function effectiveHighlight(
	stored: string | null | undefined,
	name: string,
): Exclude<KitchenHighlight, 'none'> | null {
	if (stored === 'allergy' || stored === 'attention' || stored === 'long_prep')
		return stored
	if (stored === 'none') return null
	const fallback = defaultKitchenHighlight(name)
	return fallback === 'none' ? null : fallback
}

export const courseSettingsSchema = z.object({
	enabled: z.boolean(),
	autoFireMinutes: z.number().int().min(1).max(180).nullable().optional(),
	courses: z
		.array(
			z.object({
				id: z.string().min(1).max(40),
				name: z.string().trim().min(1).max(40),
			}),
		)
		.max(8),
})

export const DEFAULT_COURSES = [
	{ id: 'starter', name: 'Starter' },
	{ id: 'main', name: 'Main' },
	{ id: 'dessert', name: 'Dessert' },
] as const

/** Stored JSON for a location, or null when the posted value cannot be read. */
export function courseSettingsJson(raw: string | undefined): string | null {
	if (!raw) return null
	try {
		const parsed = courseSettingsSchema.safeParse(JSON.parse(raw))
		return parsed.success ? JSON.stringify(parsed.data) : null
	} catch {
		return null
	}
}

/** Course names a category can pick. Locations that already named courses win. */
export function courseChoicesFromLocations(
	locations: readonly { courseSettings?: unknown }[],
): Array<{ id: string; name: string }> {
	const seen = new Map<string, string>()
	for (const location of locations) {
		const raw = location.courseSettings
		const parsed =
			typeof raw === 'string'
				? courseSettingsSchema.safeParse(safeJson(raw))
				: courseSettingsSchema.safeParse(raw)
		if (!parsed.success) continue
		for (const course of parsed.data.courses) {
			if (!seen.has(course.id)) seen.set(course.id, course.name)
		}
	}
	if (seen.size === 0) {
		for (const course of DEFAULT_COURSES) seen.set(course.id, course.name)
	}
	return [...seen].map(([id, name]) => ({ id, name }))
}

function safeJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}

/** Null when courses are off or the stored value cannot be read. */
export function readCourseSettings(value: unknown) {
	const parsed = courseSettingsSchema.safeParse(value)
	if (!parsed.success || !parsed.data.enabled || !parsed.data.courses.length)
		return null
	return parsed.data
}

/** Kitchen name when one was set, otherwise the guest-facing name. */
export function kitchenLineName(
	guestName: string,
	kitchenName: string | null | undefined,
	locale = 'en',
	defaultLocale = 'en',
): string {
	const kitchen = getLocalizedMenuValue(kitchenName, locale, defaultLocale)
	return kitchen || guestName
}

export const KITCHEN_HIGHLIGHT_ICON = {
	allergy: 'alert-triangle',
	attention: 'circle-alert',
	long_prep: 'clock-3',
} as const

/**
 * Header colour token for an order type. Always pair it with the written
 * type: the colour is a second cue. Drive-through is its own type even though
 * the wire fulfillment stays takeaway for older screens.
 */
export function kitchenOrderType(ticket: {
	fulfillment: string
	driveThrough?: boolean
}): 'dine_in' | 'takeaway' | 'delivery' | 'drive_through' {
	if (ticket.driveThrough) return 'drive_through'
	if (ticket.fulfillment === 'dine_in') return 'dine_in'
	if (ticket.fulfillment === 'delivery') return 'delivery'
	return 'takeaway'
}

export type CourseFields = {
	courseId?: string | null
	courseName?: string | null
	coursePosition?: number | null
	courseHeld?: boolean | null
	courseFiredAt?: number | null
	sentAt?: number | null
}

/**
 * Dine-in courses: the earliest course fires on send, later ones stay held.
 * A dish added to a course that already fired goes out at once.
 * Lines without a course are unchanged.
 */
export function holdLaterCourses<T extends CourseFields>(
	lines: T[],
	now: number,
): T[] {
	if (!lines.some((line) => line.courseId)) return lines
	const position = new Map<string, number>()
	for (const line of lines) {
		if (!line.courseId) continue
		const at = line.coursePosition ?? 0
		const previous = position.get(line.courseId)
		if (previous === undefined || at < previous) position.set(line.courseId, at)
	}
	const ordered = [...position.entries()].sort((a, b) => a[1] - b[1])
	const fired = new Set<string>()
	const first = ordered[0]?.[0]
	if (first) fired.add(first)
	for (const line of lines) {
		if (line.courseId && line.courseHeld === false && line.courseFiredAt)
			fired.add(line.courseId)
	}
	return lines.map((line) => {
		if (!line.courseId) return line
		if (fired.has(line.courseId)) {
			return {
				...line,
				courseHeld: false,
				courseFiredAt: line.courseFiredAt ?? line.sentAt ?? now,
			}
		}
		return { ...line, courseHeld: true, courseFiredAt: null }
	})
}

/** Fires the earliest course that is still held. */
export function fireNextCourse<T extends CourseFields>(
	lines: T[],
	now: number,
): T[] {
	const held = lines.filter((line) => line.courseId && line.courseHeld)
	if (!held.length) return lines
	const next = [...held].sort(
		(a, b) => (a.coursePosition ?? 0) - (b.coursePosition ?? 0),
	)[0]!
	return lines.map((line) =>
		line.courseId === next.courseId && line.courseHeld
			? { ...line, courseHeld: false, courseFiredAt: now }
			: line,
	)
}

/**
 * Fires the next held course once the previous one has been ready for
 * `minutes`. `readyAt` is when that previous course became ready.
 */
export function autoFireDueCourses<T extends CourseFields>(
	lines: T[],
	readyAtByCourse: ReadonlyMap<string, number>,
	minutes: number | null | undefined,
	now: number,
): T[] {
	if (!minutes || minutes < 1) return lines
	const position = new Map<string, number>()
	for (const line of lines) {
		if (!line.courseId) continue
		const at = line.coursePosition ?? 0
		const previous = position.get(line.courseId)
		if (previous === undefined || at < previous) position.set(line.courseId, at)
	}
	const ordered = [...position.entries()].sort((a, b) => a[1] - b[1])
	const due = new Set<string>()
	for (let index = 1; index < ordered.length; index++) {
		const courseId = ordered[index]![0]
		const previousId = ordered[index - 1]![0]
		const readyAt = readyAtByCourse.get(previousId)
		const held = lines.some(
			(line) => line.courseId === courseId && line.courseHeld,
		)
		if (held && readyAt != null && now >= readyAt + minutes * 60_000)
			due.add(courseId)
	}
	if (!due.size) return lines
	return lines.map((line) =>
		line.courseId && due.has(line.courseId) && line.courseHeld
			? { ...line, courseHeld: false, courseFiredAt: now }
			: line,
	)
}

export type CourseGroup<T> = {
	courseId: string | null
	courseName: string | null
	position: number
	held: boolean
	lines: T[]
}

/** One group when no line has a course, so a kitchen without courses looks as today. */
export function groupLinesByCourse<
	T extends {
		courseId?: string | null
		courseName?: string | null
		coursePosition?: number | null
		held?: boolean | null
	},
>(lines: readonly T[]): CourseGroup<T>[] {
	if (!lines.some((line) => line.courseId)) {
		return [
			{
				courseId: null,
				courseName: null,
				position: 0,
				held: false,
				lines: [...lines],
			},
		]
	}
	const groups = new Map<string, CourseGroup<T>>()
	for (const line of lines) {
		const key = line.courseId ?? ''
		const existing = groups.get(key)
		if (existing) {
			existing.lines.push(line)
			existing.held = existing.held && Boolean(line.held)
			continue
		}
		groups.set(key, {
			courseId: line.courseId ?? null,
			courseName: line.courseName ?? null,
			position: line.coursePosition ?? 0,
			held: Boolean(line.held),
			lines: [line],
		})
	}
	return [...groups.values()].sort((a, b) => a.position - b.position)
}

/** A held course does not age. Fired lines age from when they were fired. */
export function kitchenWorkStarted(
	lines: readonly Pick<KdsLine, 'held' | 'firedAt'>[],
	ticketStarted: number,
): number {
	const working = lines.filter((line) => !line.held)
	if (!working.length) return Number.POSITIVE_INFINITY
	const fired = working
		.map((line) => line.firedAt)
		.filter((at): at is number => at != null)
	if (!fired.length) return ticketStarted
	return Math.max(ticketStarted, Math.min(...fired))
}
