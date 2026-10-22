import { i18n } from '@lingui/core'
import { messages as ar } from './locales/ar.po'
import { messages as en } from './locales/en.po'

/**
 * The till's languages. Both catalogs are bundled (they are small), so switching
 * works with no network, like everything else on the till.
 */
export const POS_LOCALES = ['en', 'ar'] as const
export type PosLocale = (typeof POS_LOCALES)[number]

i18n.load({ en, ar })
i18n.activate('en')

/** The language a till uses: its own choice, else the restaurant's default when that is Arabic. */
export const effectiveLocale = (
	chosen: PosLocale | null,
	restaurantDefault: string | undefined,
): PosLocale =>
	chosen ?? (restaurantDefault?.toLowerCase().startsWith('ar') ? 'ar' : 'en')

/** Switches the interface language and the page direction (Arabic reads right to left). */
export function applyLocale(locale: PosLocale) {
	if (i18n.locale !== locale) i18n.activate(locale)
	document.documentElement.lang = locale
	document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
}

export { i18n }
