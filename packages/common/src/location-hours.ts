import { z } from 'zod'

/** Sunday = 0 … Saturday = 6 (US convention). */
export const dayOfWeekSchema = z.union([
	z.literal(0),
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
	z.literal(5),
	z.literal(6),
])

export type DayOfWeek = z.infer<typeof dayOfWeekSchema>

export const shiftSchema = z.object({
	open: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm (24-hour)'),
	close: z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:mm (24-hour)'),
})

export type Shift = z.infer<typeof shiftSchema>

const weeklyHoursShape = {
	0: z.array(shiftSchema),
	1: z.array(shiftSchema),
	2: z.array(shiftSchema),
	3: z.array(shiftSchema),
	4: z.array(shiftSchema),
	5: z.array(shiftSchema),
	6: z.array(shiftSchema),
} as const

export const weeklyHoursSchema = z.object(weeklyHoursShape)

export type WeeklyHours = z.infer<typeof weeklyHoursSchema>

export const specialHoursEntrySchema = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	calendars: z.array(z.enum(['store', 'online'])).min(1),
	closed: z.boolean().optional(),
	shifts: z.array(shiftSchema).optional(),
	recurrence: z
		.enum(['none', 'gregorian_annual', 'hijri_annual'])
		.optional()
		.default('none'),
})

export type SpecialHoursEntry = z.infer<typeof specialHoursEntrySchema>

export const locationHoursBundleSchema = z.object({
	store: weeklyHoursSchema,
	online: weeklyHoursSchema,
	special: z.array(specialHoursEntrySchema).optional(),
})

export type LocationHoursBundle = z.infer<typeof locationHoursBundleSchema>

export function emptyWeeklyHours(): WeeklyHours {
	return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }
}

export function emptyLocationHoursBundle(): LocationHoursBundle {
	return {
		store: emptyWeeklyHours(),
		online: emptyWeeklyHours(),
		special: [],
	}
}

function timeToMinutes(value: string): number {
	const parts = value.split(':').map(Number)
	const hours = parts[0] ?? 0
	const minutes = parts[1] ?? 0
	return hours * 60 + minutes
}

function shiftsOverlap(a: Shift, b: Shift): boolean {
	const aOpen = timeToMinutes(a.open)
	const aClose = timeToMinutes(a.close)
	const bOpen = timeToMinutes(b.open)
	const bClose = timeToMinutes(b.close)
	if (aClose <= aOpen || bClose <= bOpen) return true
	return aOpen < bClose && bOpen < aClose
}

export function validateWeeklyHoursNoOverlap(
	weekly: WeeklyHours,
): string | null {
	for (const day of [0, 1, 2, 3, 4, 5, 6] as const) {
		const shifts = weekly[day]
		for (let i = 0; i < shifts.length; i++) {
			const shift = shifts[i]
			if (!shift) continue
			const open = timeToMinutes(shift.open)
			const close = timeToMinutes(shift.close)
			if (close <= open) {
				return `Day ${day}: close must be after open`
			}
			for (let j = i + 1; j < shifts.length; j++) {
				const other = shifts[j]
				if (!other) continue
				if (shiftsOverlap(shift, other)) {
					return `Day ${day}: shifts overlap`
				}
			}
		}
	}
	return null
}

export function validateLocationHoursBundle(
	bundle: LocationHoursBundle,
): string | null {
	const storeError = validateWeeklyHoursNoOverlap(bundle.store)
	if (storeError) return `Store hours: ${storeError}`
	const onlineError = validateWeeklyHoursNoOverlap(bundle.online)
	if (onlineError) return `Online hours: ${onlineError}`
	return null
}

export function parseLocationHoursJson(
	raw: string | null | undefined,
): LocationHoursBundle {
	if (!raw?.trim()) return emptyLocationHoursBundle()
	try {
		const parsed = JSON.parse(raw) as unknown
		const result = locationHoursBundleSchema.safeParse(parsed)
		if (result.success) return result.data
	} catch {
		// legacy or invalid
	}
	return emptyLocationHoursBundle()
}

export function serializeLocationHoursBundle(bundle: LocationHoursBundle) {
	return JSON.stringify(bundle)
}
