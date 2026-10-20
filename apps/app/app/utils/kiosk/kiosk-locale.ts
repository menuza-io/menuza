import { i18n } from '@lingui/core'
import { getDirection } from '@repo/i18n'
import { loadCatalog } from '#app/modules/lingui/lingui.ts'
import {
	isKioskLocale,
	loadKioskLocale,
	saveKioskLocale,
	type KioskLocale,
} from './kiosk-device.ts'

/**
 * The kiosk picks its own language, independent of whoever last used this
 * browser as a manager. The choice is remembered on the tablet. Both catalogs
 * are fetched up front (see `preloadKioskCatalogs`) so switching works with no
 * connection once the page has loaded once.
 */

/** Saved choice, else the page's language when it is one we have, else English. */
export function initialKioskLocale(pageLanguage: string | null): KioskLocale {
	const saved = loadKioskLocale()
	if (saved) return saved
	const base = pageLanguage?.toLowerCase().split('-')[0]
	return isKioskLocale(base) ? base : 'en'
}

/** Applies a language to the catalog and to `<html lang dir>`. */
export async function activateKioskLocale(locale: KioskLocale): Promise<void> {
	if (i18n.locale !== locale) await loadCatalog(locale)
	if (typeof document !== 'undefined') {
		document.documentElement.lang = locale
		document.documentElement.dir = getDirection(locale)
	}
	saveKioskLocale(locale)
}

/** Pulls the other catalog into the cache without switching to it. */
export async function preloadKioskCatalogs(): Promise<void> {
	// Same dynamic-import shape as `loadCatalog`, so the bundler emits (and the
	// service worker can cache) a chunk per language.
	await Promise.allSettled(
		(['en', 'ar'] as const).map(
			(locale) => import(`../../locales/${locale}.po`),
		),
	)
}
