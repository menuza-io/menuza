import { z } from 'zod'

export const utensilsSettingsSchema = z.strictObject({
	/** When true, pickup and delivery checkout asks the guest. */
	enabled: z.boolean(),
	/** Default checkbox state when the guest does not change it. */
	defaultRequested: z.boolean(),
})

export type UtensilsSettings = z.infer<typeof utensilsSettingsSchema>

export const DEFAULT_UTENSILS_SETTINGS: UtensilsSettings = {
	enabled: false,
	defaultRequested: false,
}

export function parseUtensilsSettings(raw: unknown): UtensilsSettings {
	if (raw == null) return { ...DEFAULT_UTENSILS_SETTINGS }
	let candidate: unknown = raw
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return { ...DEFAULT_UTENSILS_SETTINGS }
		}
	}
	const parsed = utensilsSettingsSchema.safeParse(candidate)
	return parsed.success ? parsed.data : { ...DEFAULT_UTENSILS_SETTINGS }
}

/** Folds posted checkbox: ignored when the location does not ask. */
export function foldUtensilsRequested(
	settings: UtensilsSettings,
	fulfillment: 'pickup' | 'delivery' | 'dine_in',
	posted: boolean | null | undefined,
): boolean | null {
	if (fulfillment === 'dine_in') return null
	if (!settings.enabled) return null
	if (typeof posted === 'boolean') return posted
	return settings.defaultRequested
}
