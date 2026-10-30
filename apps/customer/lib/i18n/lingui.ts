import './polyfills'

import { i18n, type Messages } from '@lingui/core'

import { messages as arMessages } from '../../locales/ar.po'
import { messages as deMessages } from '../../locales/de.po'
import { messages as enMessages } from '../../locales/en.po'
import { messages as esMessages } from '../../locales/es.po'
import { messages as frMessages } from '../../locales/fr.po'
import { messages as zhMessages } from '../../locales/zh.po'
import { normalizeLocale } from './site-locale'

/** Locales this build ships translations for (mirrors the app.config locale list). */
export const APP_LOCALES = ['en', 'ar', 'de', 'es', 'fr', 'zh'] as const

export type AppLocale = (typeof APP_LOCALES)[number]

const catalogs: Record<AppLocale, Messages> = {
	en: enMessages,
	ar: arMessages,
	de: deMessages,
	es: esMessages,
	fr: frMessages,
	zh: zhMessages,
}

/**
 * Activates the catalog for `code` and returns the locale that was activated.
 * An unknown or unsupported code falls back to English.
 */
export function activateLocale(code: string): AppLocale {
	const normalized = normalizeLocale(code)
	const locale: AppLocale = (APP_LOCALES as readonly string[]).includes(
		normalized,
	)
		? (normalized as AppLocale)
		: 'en'
	i18n.loadAndActivate({ locale, messages: catalogs[locale] })
	return locale
}

export { i18n }
