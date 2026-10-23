import { i18n } from '@lingui/core'
import { type PosLocale } from './lib/locale.ts'
import { messages as ar } from './locales/ar.po'
import { messages as en } from './locales/en.po'

/**
 * The till's languages. Both catalogs are bundled (they are small), so switching
 * works with no network, like everything else on the till.
 */
export { POS_LOCALES, effectiveLocale, type PosLocale } from './lib/locale.ts'

i18n.load({ en, ar })
i18n.activate('en')

/** Switches the interface language and the page direction (Arabic reads right to left). */
export function applyLocale(locale: PosLocale) {
	if (i18n.locale !== locale) i18n.activate(locale)
	document.documentElement.lang = locale
	document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
}

export { i18n }
