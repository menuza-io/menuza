import { useEffect, useState } from 'react'
import { activateLocale } from '../i18n/lingui'
import { type AppLanguage } from '../i18n/site-locale'
import { useAppSnapshot } from './use-app'

/**
 * Keeps the Lingui catalog and the reservations locale in step with the
 * language the app resolved (device → organization → override). The first
 * paint already activates a catalog; later changes re-activate and the
 * `I18nProvider` re-renders on Lingui's change event.
 */
export function useAppLanguageSync(): AppLanguage {
	const { language, features } = useAppSnapshot()
	// Runs before children paint, so no frame renders an inactive catalog.
	useState(() => {
		activateLocale(language.code)
		return null
	})
	useEffect(() => {
		activateLocale(language.code)
	}, [language.code])
	useEffect(() => {
		features?.reservations.setLocale(language.code)
	}, [features, language.code])
	return language
}
