import { useLingui } from '@lingui/react'
import { getDirection } from '@repo/i18n'
import { useCallback, useEffect, useState } from 'react'
import { type KioskLocale } from '#app/utils/kiosk/kiosk-device.ts'
import {
	activateKioskLocale,
	initialKioskLocale,
	preloadKioskCatalogs,
} from '#app/utils/kiosk/kiosk-locale.ts'

/**
 * The kiosk's language: remembered on the tablet, switchable with one tap, and
 * independent of whoever last signed in on this browser. Both catalogs are
 * fetched once up front so switching works offline later.
 */
export function useKioskLocale() {
	const { i18n } = useLingui()
	const [locale, setLocale] = useState<KioskLocale>('en')

	useEffect(() => {
		const initial = initialKioskLocale(document.documentElement.lang)
		void activateKioskLocale(initial).then(() => setLocale(initial))
		void preloadKioskCatalogs()
	}, [])

	// Stay aligned if something else switches the catalog.
	useEffect(() => {
		if (i18n.locale === 'ar' || i18n.locale === 'en') setLocale(i18n.locale)
	}, [i18n.locale])

	// The page shell is rendered for the signed-in app's language. Whenever our
	// language settles, make `<html lang dir>` agree with it.
	useEffect(() => {
		document.documentElement.lang = locale
		document.documentElement.dir = getDirection(locale)
	}, [locale])

	const change = useCallback(async (next: KioskLocale) => {
		await activateKioskLocale(next)
		setLocale(next)
	}, [])

	return [locale, change] as const
}
