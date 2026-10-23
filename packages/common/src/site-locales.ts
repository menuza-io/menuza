/**
 * Public org site content locales (independent of admin app Lingui locales).
 */

export const SITE_CONTENT_LOCALES = [
	'en',
	'ar',
	'es',
	'fr',
	'de',
	'zh',
] as const

export type SiteContentLocale = (typeof SITE_CONTENT_LOCALES)[number]

export const SITE_CONTENT_LOCALE_LABELS: Record<SiteContentLocale, string> = {
	en: 'English',
	ar: 'Arabic',
	es: 'Spanish',
	fr: 'French',
	de: 'German',
	zh: 'Chinese',
}

const SITE_CONTENT_LOCALE_NATIVE_LABELS: Record<SiteContentLocale, string> = {
	en: 'English',
	ar: 'العربية',
	es: 'Español',
	fr: 'Français',
	de: 'Deutsch',
	zh: '中文',
}

export const RTL_SITE_LOCALES = new Set<SiteContentLocale>(['ar'])

export type SiteLocalesConfig = {
	locales: SiteContentLocale[]
	defaultLocale: SiteContentLocale
}

export const DEFAULT_SITE_LOCALES: SiteLocalesConfig = {
	locales: ['en'],
	defaultLocale: 'en',
}

/** Locale-keyed copy, e.g. { en: "Hello", ar: "مرحبا" } */
export type LocalizedString = Partial<Record<SiteContentLocale, string>> &
	Record<string, string | undefined>

export function isSiteContentLocale(
	value: unknown,
): value is SiteContentLocale {
	return (
		typeof value === 'string' &&
		(SITE_CONTENT_LOCALES as readonly string[]).includes(value)
	)
}

export function getSiteLocaleLabel(locale: string): string {
	if (isSiteContentLocale(locale)) return SITE_CONTENT_LOCALE_LABELS[locale]
	return locale
}

/** Native language names stay the same regardless of the active UI locale. */
export function getSiteLocaleNativeLabel(locale: string): string {
	if (isSiteContentLocale(locale))
		return SITE_CONTENT_LOCALE_NATIVE_LABELS[locale]
	return locale
}

export function getSiteLocaleDirection(locale: string): 'ltr' | 'rtl' {
	return isSiteContentLocale(locale) && RTL_SITE_LOCALES.has(locale)
		? 'rtl'
		: 'ltr'
}

export function parseSiteLocalesConfig(
	localesRaw: string | null | undefined,
	defaultLocaleRaw: string | null | undefined,
): SiteLocalesConfig {
	let locales: SiteContentLocale[] = [...DEFAULT_SITE_LOCALES.locales]

	if (localesRaw) {
		try {
			const parsed: unknown = JSON.parse(localesRaw)
			if (Array.isArray(parsed)) {
				const filtered = parsed.filter(isSiteContentLocale)
				if (filtered.length > 0) {
					locales = Array.from(new Set(filtered))
				}
			}
		} catch {
			/* keep default */
		}
	}

	const defaultLocale = isSiteContentLocale(defaultLocaleRaw)
		? defaultLocaleRaw
		: DEFAULT_SITE_LOCALES.defaultLocale

	if (!locales.includes(defaultLocale)) {
		locales = [defaultLocale, ...locales]
	}

	return { locales, defaultLocale }
}

export function serializeSiteLocales(locales: SiteContentLocale[]): string {
	const unique = Array.from(new Set(locales.filter(isSiteContentLocale)))
	return JSON.stringify(unique.length > 0 ? unique : ['en'])
}

/**
 * Parse a localized string field. Accepts legacy plain strings and JSON maps.
 */
export function parseLocalizedString(
	raw: string | null | undefined,
	fallbackLocale: string = 'en',
): LocalizedString {
	if (!raw) return {}

	const trimmed = raw.trim()
	if (!trimmed) return {}

	if (trimmed.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				const result: LocalizedString = {}
				for (const [key, value] of Object.entries(parsed)) {
					if (typeof value === 'string' && value.trim()) {
						result[key] = value
					}
				}
				return result
			}
		} catch {
			/* treat as plain string */
		}
	}

	return { [fallbackLocale]: raw }
}

export function serializeLocalizedString(map: LocalizedString): string {
	const cleaned: Record<string, string> = {}
	for (const [key, value] of Object.entries(map)) {
		const trimmed = value?.trim()
		if (trimmed) cleaned[key] = trimmed
	}
	return JSON.stringify(cleaned)
}

/**
 * Resolve visitor-facing copy: exact locale → language base → default → first value.
 */
export function pickLocalized(
	map: LocalizedString | string | null | undefined,
	locale: string | null | undefined,
	defaultLocale: string,
): string {
	const normalized =
		typeof map === 'string'
			? parseLocalizedString(map, defaultLocale)
			: (map ?? {})

	const candidates = [
		locale,
		locale?.split('-')[0],
		defaultLocale,
		defaultLocale.split('-')[0],
	].filter(Boolean) as string[]

	for (const candidate of candidates) {
		const value = normalized[candidate]?.trim()
		if (value) return value
	}

	for (const value of Object.values(normalized)) {
		const trimmed = value?.trim()
		if (trimmed) return trimmed
	}

	return ''
}

/**
 * Read a locale value for form editing without trimming.
 * Preserves leading/trailing spaces while the user is typing.
 */
export function getLocalizedEditableValue(
	map: LocalizedString | string | null | undefined,
	locale: string | null | undefined,
	defaultLocale: string,
): string {
	if (map == null) return ''

	let normalized: LocalizedString = {}

	if (typeof map === 'string') {
		const trimmed = map.trim()
		if (!trimmed) return map
		if (!trimmed.startsWith('{')) return map

		try {
			const parsed: unknown = JSON.parse(trimmed)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return map
			}
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === 'string') {
					normalized[key] = value
				}
			}
		} catch {
			return map
		}
	} else {
		normalized = map
	}

	const candidates = [
		locale,
		locale?.split('-')[0],
		defaultLocale,
		defaultLocale.split('-')[0],
	].filter(Boolean) as string[]

	for (const candidate of candidates) {
		const value = normalized[candidate]
		if (typeof value === 'string') return value
	}

	for (const value of Object.values(normalized)) {
		if (typeof value === 'string') return value
	}

	return ''
}

/**
 * Pick the best supported locale from an Accept-Language / preference list.
 */
export function negotiateSiteLocale(
	preferred: string | string[] | null | undefined,
	supported: SiteContentLocale[],
	defaultLocale: SiteContentLocale,
): SiteContentLocale {
	const prefs = Array.isArray(preferred)
		? preferred
		: preferred
			? [preferred]
			: []

	for (const pref of prefs) {
		const exact = pref.toLowerCase()
		const base = exact.split('-')[0] ?? exact
		const match =
			supported.find((locale) => locale === exact) ??
			supported.find((locale) => locale === base)
		if (match) return match
	}

	return supported.includes(defaultLocale)
		? defaultLocale
		: (supported[0] ?? 'en')
}

/** Page slugs that collide with locale prefixes, e.g. `ar`, `zh`. */
export function isReservedSiteLocaleSlug(slug: string): boolean {
	return isSiteContentLocale(slug.trim().toLowerCase())
}

function splitPathAndSuffix(path: string): {
	pathname: string
	suffix: string
} {
	const queryIndex = path.indexOf('?')
	const hashIndex = path.indexOf('#')
	const cutCandidates = [queryIndex, hashIndex].filter((index) => index >= 0)
	const cut = cutCandidates.length > 0 ? Math.min(...cutCandidates) : -1
	if (cut < 0) return { pathname: path, suffix: '' }
	return { pathname: path.slice(0, cut), suffix: path.slice(cut) }
}

function stripLocalePrefix(pathname: string, locale: string): string {
	if (pathname === `/${locale}`) return '/'
	const prefix = `/${locale}/`
	if (pathname.startsWith(prefix)) {
		return `/${pathname.slice(prefix.length)}`
	}
	return pathname
}

function stripKnownLocalePrefix(pathname: string): string {
	const first = pathname.split('/').filter(Boolean)[0]
	if (first && isSiteContentLocale(first)) {
		return stripLocalePrefix(pathname, first)
	}
	return pathname
}

function normalizePathname(pathname: string): string {
	if (!pathname || pathname === '/') return '/'
	return pathname.length > 1 && pathname.endsWith('/')
		? pathname.slice(0, -1)
		: pathname
}

/**
 * Build a locale-aware internal href.
 * Default locale is unprefixed. Any catalog locale prefix on `path` is stripped first
 * so `/ar/about` + English default becomes `/about`, never `/ar/ar/about`.
 */
export function getLocaleHref(
	path: string,
	targetLocale?: string | null,
	_currentLocale?: string | null,
	defaultLocale: string = 'en',
): string {
	if (!path.startsWith('/') || path.startsWith('//')) return path

	const { pathname: rawPathname, suffix } = splitPathAndSuffix(path)
	const pathname = normalizePathname(stripKnownLocalePrefix(rawPathname))
	const locale = targetLocale || defaultLocale

	if (!locale || locale === defaultLocale) {
		return `${pathname}${suffix}`
	}

	const base = pathname === '/' ? '' : pathname
	return `/${locale}${base}${suffix}`
}

function searchParamsFrom(search: string): URLSearchParams {
	const raw = search.startsWith('?') ? search.slice(1) : search
	const params = new URLSearchParams(raw)
	params.delete('lng')
	return params
}

function withSearch(pathname: string, params: URLSearchParams): string {
	const qs = params.toString()
	return qs ? `${pathname}?${qs}` : pathname
}

export type SiteLocaleRequestResult =
	| { kind: 'redirect'; location: string }
	| { kind: 'rewrite'; pathname: string; search: string; locale: string }
	| { kind: 'ok'; locale: string }
	| { kind: 'not_found' }

/**
 * Decide how a public Sites request should handle locale.
 * Path prefix is canonical. `?lng=` 301s onto the prefix form.
 */
export function resolveSiteLocaleRequest(input: {
	pathname: string
	search?: string
	enabledLocales: string[]
	defaultLocale: string
}): SiteLocaleRequestResult {
	const { pathname, enabledLocales, defaultLocale } = input
	const params = searchParamsFrom(input.search ?? '')
	const enabled = new Set(enabledLocales)
	const segments = pathname.split('/').filter(Boolean)
	const first = segments[0]
	const rest = segments.length > 1 ? `/${segments.slice(1).join('/')}` : '/'
	const restPath = normalizePathname(rest)

	if (first && isSiteContentLocale(first)) {
		if (!enabled.has(first)) {
			return { kind: 'not_found' }
		}
		if (first === defaultLocale) {
			return { kind: 'redirect', location: withSearch(restPath, params) }
		}
		return {
			kind: 'rewrite',
			pathname: restPath,
			search: params.toString() ? `?${params.toString()}` : '',
			locale: first,
		}
	}

	const lngParam = new URLSearchParams(
		(input.search ?? '').startsWith('?')
			? (input.search ?? '').slice(1)
			: (input.search ?? ''),
	).get('lng')

	if (lngParam && isSiteContentLocale(lngParam) && enabled.has(lngParam)) {
		const target = getLocaleHref(pathname, lngParam, null, defaultLocale)
		const location = withSearch(target, params)
		const current = withSearch(pathname, searchParamsFrom(input.search ?? ''))
		if (location !== current) {
			return { kind: 'redirect', location }
		}
	}

	return { kind: 'ok', locale: defaultLocale }
}
