import { z } from 'zod'

/**
 * Terminal profiles (#373). A profile bundles every per-terminal setting a
 * manager can choose: the Station apps beside the till, sign-in and cash
 * drawer rules, the kitchen station a screen shows, the lock timeout, the menu
 * layout and the guest second screen.
 *
 * A terminal that has a profile inherits all of them and may override single
 * settings. The terminal row keeps the effective value of each setting (so the
 * code that already reads it keeps working) and a list of the keys it
 * overrides; changing a profile writes the new value to every terminal that
 * does not override that key. Settings only: no names, orders or guests.
 */

/** Same range the till's own "Lock after" menu offers. 0 means never. */
export const TERMINAL_IDLE_LOCK_SECONDS = [0, 30, 60, 120, 300, 600] as const
export const DEFAULT_TERMINAL_IDLE_LOCK_SECONDS = 120

export const TERMINAL_MENU_COLUMNS = ['auto', 2, 3, 4] as const
export const TERMINAL_MENU_DENSITIES = ['comfortable', 'compact'] as const

/** Longest idle-image address the second screen accepts. */
export const GUEST_DISPLAY_IMAGE_URL_MAX = 500

/**
 * An address for the second screen's idle image: https only (a till on https
 * cannot show anything else), no credentials, no script. Empty means none.
 */
export function parseGuestDisplayImageUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') return null
	const value = raw.trim()
	if (!value || value.length > GUEST_DISPLAY_IMAGE_URL_MAX) return null
	try {
		const url = new URL(value)
		if (url.protocol !== 'https:') return null
		if (url.username || url.password) return null
		return url.toString()
	} catch {
		return null
	}
}

const kitchenStationId = z
	.string()
	.regex(/^[a-zA-Z0-9_-]{1,40}$/)
	.nullable()

const guestDisplayImageUrl = z
	.string()
	.max(GUEST_DISPLAY_IMAGE_URL_MAX)
	.nullable()
	.refine((value) => value === null || parseGuestDisplayImageUrl(value), {
		message: 'invalid_image_url',
	})

/** Every setting a profile bundles, with the value a terminal starts with. */
export const terminalSettingsSchema = z.strictObject({
	signInRequired: z.boolean(),
	shiftsRequired: z.boolean(),
	/** Minutes after local midnight when the business day turns over (0-720). */
	dayStartMinutes: z.number().int().min(0).max(720),
	timeclockEnabled: z.boolean(),
	reservationsEnabled: z.boolean(),
	inventoryEnabled: z.boolean(),
	ordersEnabled: z.boolean(),
	idleLockSeconds: z
		.number()
		.int()
		.refine((s) => (TERMINAL_IDLE_LOCK_SECONDS as readonly number[]).includes(s)),
	/** The Kitchen station this screen shows; null lets the screen choose. */
	kdsStationId: kitchenStationId,
	menuColumns: z.union([
		z.literal('auto'),
		z.literal(2),
		z.literal(3),
		z.literal(4),
	]),
	menuDensity: z.enum(TERMINAL_MENU_DENSITIES),
	guestDisplayEnabled: z.boolean(),
	guestDisplayImageUrl,
})
export type TerminalSettings = z.infer<typeof terminalSettingsSchema>
export type TerminalSettingKey = keyof TerminalSettings

export const TERMINAL_SETTING_KEYS = Object.keys(
	terminalSettingsSchema.shape,
) as TerminalSettingKey[]

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
	signInRequired: false,
	shiftsRequired: false,
	dayStartMinutes: 240,
	timeclockEnabled: false,
	reservationsEnabled: false,
	inventoryEnabled: false,
	ordersEnabled: false,
	idleLockSeconds: DEFAULT_TERMINAL_IDLE_LOCK_SECONDS,
	kdsStationId: null,
	menuColumns: 'auto',
	menuDensity: 'comfortable',
	guestDisplayEnabled: false,
	guestDisplayImageUrl: null,
}

/** Settings that exist as their own column on the terminal row (legacy). */
export const TERMINAL_COLUMN_SETTING_KEYS = [
	'signInRequired',
	'shiftsRequired',
	'dayStartMinutes',
	'timeclockEnabled',
	'reservationsEnabled',
	'inventoryEnabled',
	'ordersEnabled',
] as const satisfies readonly TerminalSettingKey[]

/** The rest are kept together as JSON on the terminal row. */
export const TERMINAL_JSON_SETTING_KEYS = [
	'idleLockSeconds',
	'kdsStationId',
	'menuColumns',
	'menuDensity',
	'guestDisplayEnabled',
	'guestDisplayImageUrl',
] as const satisfies readonly TerminalSettingKey[]

export type TerminalJsonSettings = Pick<
	TerminalSettings,
	(typeof TERMINAL_JSON_SETTING_KEYS)[number]
>

const jsonSettingsSchema = terminalSettingsSchema
	.pick({
		idleLockSeconds: true,
		kdsStationId: true,
		menuColumns: true,
		menuDensity: true,
		guestDisplayEnabled: true,
		guestDisplayImageUrl: true,
	})
	.partial()

/**
 * The JSON settings a terminal has stored explicitly, one valid field at a
 * time. A terminal that never had one set (no profile, never edited) has none,
 * and the till then keeps its own local choice instead of being told a default.
 */
export function explicitTerminalJsonSettings(
	raw: unknown,
): Partial<TerminalJsonSettings> {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return {}
		}
	}
	if (!value || typeof value !== 'object') return {}
	const out: Record<string, unknown> = {}
	for (const key of TERMINAL_JSON_SETTING_KEYS) {
		const candidate = (value as Record<string, unknown>)[key]
		if (candidate === undefined) continue
		const parsed = jsonSettingsSchema.shape[key].safeParse(candidate)
		if (parsed.success && parsed.data !== undefined) out[key] = parsed.data
	}
	return out as Partial<TerminalJsonSettings>
}

/**
 * Reads the JSON half of a terminal's settings with the default for every
 * field it has not stored, so an old row never breaks a terminal.
 */
export function parseTerminalJsonSettings(raw: unknown): TerminalJsonSettings {
	return {
		...pickJson(DEFAULT_TERMINAL_SETTINGS),
		...explicitTerminalJsonSettings(raw),
	}
}

function pickJson(settings: TerminalSettings): TerminalJsonSettings {
	return {
		idleLockSeconds: settings.idleLockSeconds,
		kdsStationId: settings.kdsStationId,
		menuColumns: settings.menuColumns,
		menuDensity: settings.menuDensity,
		guestDisplayEnabled: settings.guestDisplayEnabled,
		guestDisplayImageUrl: settings.guestDisplayImageUrl,
	}
}

export const TERMINAL_PROFILE_NAME_MAX = 60
export const TERMINAL_PROFILES_MAX = 50

const profileName = z.string().trim().min(1).max(TERMINAL_PROFILE_NAME_MAX)

export const terminalProfileInputSchema = z.strictObject({
	name: profileName,
	settings: terminalSettingsSchema,
})
export type TerminalProfileInput = z.infer<typeof terminalProfileInputSchema>

export const terminalProfileUpdateSchema = z.strictObject({
	name: profileName,
	settings: terminalSettingsSchema,
	/** The version the editor started from; a newer one is 409 `stale_version`. */
	expectedVersion: z.number().int().min(1),
})

/**
 * What a terminal row can carry beyond its own identity. `profileId: null`
 * detaches the terminal (it keeps the values it has).
 */
export const terminalProfileAssignmentSchema = z.strictObject({
	profileId: z.string().min(1).max(100).nullable(),
})

/** One profile as the operator API returns it. */
export type TerminalProfileView = {
	id: string
	name: string
	settings: TerminalSettings
	version: number
	/** Terminals that inherit this profile (removed ones are not counted). */
	terminalCount: number
	/** Pairing codes waiting to be used that name this profile. */
	pendingCodeCount: number
	updatedAt: number
}

/** Keys on which `current` and `profile` differ. */
export function differingKeys(
	profile: TerminalSettings,
	current: TerminalSettings,
): TerminalSettingKey[] {
	return TERMINAL_SETTING_KEYS.filter((key) => profile[key] !== current[key])
}

/** Reads the list of overridden keys, dropping anything unknown. */
export function parseOverrides(raw: unknown): TerminalSettingKey[] {
	let value: unknown = raw
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw)
		} catch {
			return []
		}
	}
	if (!Array.isArray(value)) return []
	const known = new Set<string>(TERMINAL_SETTING_KEYS)
	return TERMINAL_SETTING_KEYS.filter(
		(key) => value.includes(key) && known.has(key),
	)
}

/**
 * The overrides a terminal has after `patch` is applied: a key whose new value
 * differs from the profile's is overridden, one set back to the profile's value
 * is not. Keys the patch does not mention keep their state.
 */
export function overridesAfter(
	profile: TerminalSettings,
	overrides: readonly TerminalSettingKey[],
	patch: Partial<TerminalSettings>,
): TerminalSettingKey[] {
	const next = new Set(overrides)
	for (const key of TERMINAL_SETTING_KEYS) {
		const value = patch[key]
		if (value === undefined) continue
		if (value === profile[key]) next.delete(key)
		else next.add(key)
	}
	return TERMINAL_SETTING_KEYS.filter((key) => next.has(key))
}

/**
 * What a profile change writes to one terminal: the profile's value for every
 * key the terminal does not override and does not already have.
 */
export function inheritedPatch(
	profile: TerminalSettings,
	/** What the terminal has stored; a setting it never stored counts as different. */
	current: Partial<TerminalSettings>,
	overrides: readonly TerminalSettingKey[],
): Partial<TerminalSettings> {
	const skip = new Set(overrides)
	const patch: Record<string, unknown> = {}
	for (const key of TERMINAL_SETTING_KEYS) {
		if (skip.has(key)) continue
		if (profile[key] !== current[key]) patch[key] = profile[key]
	}
	return patch as Partial<TerminalSettings>
}
