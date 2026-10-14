import { z } from 'zod'

/**
 * What a paired tablet remembers: the device secret, the regional node it talks
 * to, and its last known configuration. The secret lives in `localStorage` like
 * every other tenant token (AGENTS.md); mitigations are the server-side ones:
 * it is bound to one scope, can only punch, and is revoked from the manager
 * screen at once. Every read and write is guarded: private windows and blocked
 * storage must leave the kiosk usable, just unpaired.
 */

const STORAGE_KEY = 'kiosk.device.v1'
const LOCALE_KEY = 'kiosk.locale.v1'

const storedDeviceSchema = z.object({
	deviceSecret: z.string().min(20),
	tenantApiUrl: z.string().url(),
	config: z.object({
		device: z.object({
			id: z.string(),
			name: z.string(),
			scopeId: z.string(),
			identifyMode: z.enum(['pin', 'pick_name']),
			showNextShifts: z.boolean(),
		}),
		scope: z.object({
			name: z.string().nullable(),
			timeZone: z.string().nullable(),
		}),
	}),
})
export type StoredKioskDevice = z.infer<typeof storedDeviceSchema>

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage
	} catch {
		return null
	}
}

export function loadKioskDevice(): StoredKioskDevice | null {
	try {
		const raw = storage()?.getItem(STORAGE_KEY)
		if (!raw) return null
		const parsed = storedDeviceSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

/** Returns false when the browser would not keep it (the kiosk then says so). */
export function saveKioskDevice(device: StoredKioskDevice): boolean {
	try {
		storage()?.setItem(STORAGE_KEY, JSON.stringify(device))
		return loadKioskDevice()?.deviceSecret === device.deviceSecret
	} catch {
		return false
	}
}

export function clearKioskDevice() {
	try {
		storage()?.removeItem(STORAGE_KEY)
	} catch {
		// nothing to do
	}
}

export const KIOSK_LOCALES = ['en', 'ar'] as const
export type KioskLocale = (typeof KIOSK_LOCALES)[number]

export function isKioskLocale(value: unknown): value is KioskLocale {
	return KIOSK_LOCALES.includes(value as KioskLocale)
}

export function loadKioskLocale(): KioskLocale | null {
	try {
		const value = storage()?.getItem(LOCALE_KEY)
		return isKioskLocale(value) ? value : null
	} catch {
		return null
	}
}

export function saveKioskLocale(locale: KioskLocale) {
	try {
		storage()?.setItem(LOCALE_KEY, locale)
	} catch {
		// the choice just will not be remembered
	}
}
