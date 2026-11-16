import {
	OnlineOrderingSettingsSchema,
	type OnlineOrderingSettings,
	PrayerPauseSettingsSchema,
	type PrayerPauseSettings,
	PrepScheduleSchema,
	type PrepSchedule,
	SlotLimitSettingsSchema,
	type SlotLimitSettings,
} from './location-types.ts'
export { parsePrepSchedule } from './prep-schedule.ts'

function parseJson(raw: unknown): unknown {
	if (raw == null || raw === '') return null
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw)
		} catch {
			return undefined
		}
	}
	return raw
}

export function parseOnlineOrderingSettings(
	raw: unknown,
): OnlineOrderingSettings | null {
	const value = parseJson(raw)
	if (value === null) return null
	const parsed = OnlineOrderingSettingsSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}

export function parseSlotLimitSettings(raw: unknown): SlotLimitSettings | null {
	const value = parseJson(raw)
	if (value === null) return null
	const parsed = SlotLimitSettingsSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}

export function parseLocationPrepSchedule(raw: unknown): PrepSchedule | null {
	const value = parseJson(raw)
	if (value === null) return null
	const parsed = PrepScheduleSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}

export function parsePrayerPauseSettings(
	raw: unknown,
): PrayerPauseSettings | null {
	const value = parseJson(raw)
	if (value === null) return null
	const parsed = PrayerPauseSettingsSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}
