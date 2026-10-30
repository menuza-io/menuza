import * as SecureStore from 'expo-secure-store'
import { makeSiteAddress, type SiteAddress } from '../support/site-address'

/**
 * Non-sensitive preferences: the site this install is connected to and the
 * customer's language choice. They sit in the secure store only because the
 * app has no other persistent key-value storage; tokens are stored apart.
 */
export type PreferencesStorage = {
	loadSiteAddress(): Promise<SiteAddress | null>
	saveSiteAddress(address: SiteAddress | null): Promise<void>
	loadLanguageOverride(): Promise<string | null>
	saveLanguageOverride(code: string | null): Promise<void>
}

const SITE_KEY = 'customer.site'
const LANGUAGE_KEY = 'customer.language'
export const PREFERENCE_KEYS: readonly string[] = [SITE_KEY, LANGUAGE_KEY]

function parseSiteAddress(raw: string | null): SiteAddress | null {
	if (!raw) return null
	try {
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object') return null
		const fields = value as Record<string, unknown>
		const text = (key: string) =>
			typeof fields[key] === 'string' ? (fields[key] as string) : null
		const address = makeSiteAddress({
			slug: text('slug'),
			host: text('host'),
			origin: text('origin'),
		})
		return address.slug || address.host ? address : null
	} catch {
		return null
	}
}

async function read(key: string): Promise<string | null> {
	try {
		return await SecureStore.getItemAsync(key)
	} catch {
		return null
	}
}

async function write(key: string, value: string | null): Promise<void> {
	try {
		if (value === null) await SecureStore.deleteItemAsync(key)
		else await SecureStore.setItemAsync(key, value)
	} catch {
		// A preference that cannot be written is asked for again next launch.
	}
}

export function createSecurePreferences(): PreferencesStorage {
	return {
		async loadSiteAddress() {
			return parseSiteAddress(await read(SITE_KEY))
		},
		async saveSiteAddress(address) {
			await write(SITE_KEY, address ? JSON.stringify(address) : null)
		},
		async loadLanguageOverride() {
			const value = (await read(LANGUAGE_KEY))?.trim()
			return value ? value : null
		},
		async saveLanguageOverride(code) {
			await write(LANGUAGE_KEY, code?.trim() ? code.trim() : null)
		},
	}
}

export function createMemoryPreferences(
	initial: { site?: SiteAddress | null; language?: string | null } = {},
): PreferencesStorage & {
	readonly site: SiteAddress | null
	readonly language: string | null
} {
	let site = initial.site ?? null
	let language = initial.language ?? null
	return {
		get site() {
			return site
		},
		get language() {
			return language
		},
		async loadSiteAddress() {
			return site
		},
		async saveSiteAddress(address) {
			site = address
		},
		async loadLanguageOverride() {
			return language
		},
		async saveLanguageOverride(code) {
			language = code
		},
	}
}
