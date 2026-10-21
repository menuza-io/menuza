import { DEFAULT_SITE_LOCALES, getLocaleHref } from '@repo/common/site-locales'

export { getLocaleHref }

export function siteLocaleHref(
	path: string,
	targetLocale?: string | null,
	currentLocale?: string | null,
	defaultLocale: string = 'en',
) {
	return getLocaleHref(path, targetLocale, currentLocale, defaultLocale)
}

export function browserLocaleHref(path: string): string {
	if (typeof document === 'undefined') return path
	const locale = browserLocale()
	const defaultLocale =
		document.documentElement.dataset.defaultLocale ||
		DEFAULT_SITE_LOCALES.defaultLocale
	return getLocaleHref(path, locale, locale, defaultLocale)
}

/**
 * The language of the page the visitor is on (the Sites locale resolution put
 * it on `<html lang>`), else the organization default, else the platform one.
 */
export function browserLocale(): string {
	if (typeof document === 'undefined') return DEFAULT_SITE_LOCALES.defaultLocale
	return (
		document.documentElement.lang ||
		document.documentElement.dataset.defaultLocale ||
		DEFAULT_SITE_LOCALES.defaultLocale
	)
}
