/** Content locales shared with the organization Sites app (`packages/common/src/site-locales.ts`). */
export const CONTENT_LOCALES = ['en', 'ar', 'es', 'fr', 'de', 'zh'] as const

export type ContentLocale = (typeof CONTENT_LOCALES)[number]

export const LOCALE_LABELS: Readonly<Record<string, string>> = {
	en: 'English',
	ar: 'Arabic',
	es: 'Spanish',
	fr: 'French',
	de: 'German',
	zh: 'Chinese',
}

/** Matches `RTL_SITE_LOCALES` on the web side. */
export const RTL_LOCALES: ReadonlySet<string> = new Set(['ar'])

function hasOwn(record: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key)
}

/** First non-empty `-` piece; the whole string when there is none (`"-"`). */
function languagePart(tag: string): string {
	return tag.split('-').find((part) => part !== '') ?? tag
}

/** `"ar-SA"` → `"ar"`, `"EN"` → `"en"`, `""` → `"en"`. */
export function normalizeLocale(code: string): string {
	const trimmed = code.trim().toLowerCase()
	if (trimmed === '') return 'en'
	return languagePart(trimmed)
}

export function isSupportedLocale(code: string): boolean {
	return (CONTENT_LOCALES as readonly string[]).includes(normalizeLocale(code))
}

/** English name of a content locale, or the code itself when unknown. */
export function localeLabel(code: string): string {
	const normalized = normalizeLocale(code)
	return hasOwn(LOCALE_LABELS, normalized)
		? (LOCALE_LABELS[normalized] ?? code)
		: code
}

export function isRtlLocale(code: string): boolean {
	return RTL_LOCALES.has(normalizeLocale(code))
}

/**
 * Mirrors `negotiateSiteLocale()`: for each preference in order, an exact
 * match first, then its language only. `null` when nothing matches.
 */
export function matchLocale(
	preferred: readonly string[],
	supported: readonly string[],
): string | null {
	const candidates = supported.map(normalizeLocale)
	for (const preference of preferred) {
		const exact = preference.trim().toLowerCase()
		if (exact === '') continue
		const base = languagePart(exact)
		const match =
			candidates.find((candidate) => candidate === exact) ??
			candidates.find((candidate) => candidate === base)
		if (match !== undefined) return match
	}
	return null
}

/**
 * Mirrors `negotiateSiteLocale()`: exact match, then language only, then the
 * default locale, then the first supported locale, then `en`.
 */
export function negotiateLocale(
	preferred: readonly string[],
	supported: readonly string[],
	defaultLocale: string,
): string {
	const match = matchLocale(preferred, supported)
	if (match !== null) return match
	const candidates = supported.map(normalizeLocale)
	const fallback = normalizeLocale(defaultLocale)
	if (candidates.includes(fallback)) return fallback
	return candidates[0] ?? 'en'
}

/** The locale fields of the `GET /resources/sites` organization payload. */
export interface OrganizationLocales {
	readonly locales?: readonly string[] | null
	readonly defaultLocale?: string | null
	readonly locale?: string | null
}

export function resolvedOrganizationLocales(
	organization: OrganizationLocales,
): string[] {
	const values = (organization.locales ?? []).filter((value) => value !== '')
	return values.length === 0 ? ['en'] : values
}

export function resolvedOrganizationDefaultLocale(
	organization: OrganizationLocales,
): string {
	return organization.defaultLocale ? organization.defaultLocale : 'en'
}

/** The locale the organization negotiated for this device, else its default. */
export function resolvedOrganizationLocale(
	organization: OrganizationLocales,
): string {
	return organization.locale
		? organization.locale
		: resolvedOrganizationDefaultLocale(organization)
}

/** The language the app UI renders in. */
export interface AppLanguage {
	readonly code: string
	readonly isRtl: boolean
	readonly displayName: string
}

export function createAppLanguage(code = 'en'): AppLanguage {
	const normalized = normalizeLocale(code)
	return {
		code: normalized,
		isRtl: isRtlLocale(normalized),
		displayName: localeLabel(normalized),
	}
}

export interface ResolveAppLanguageInput {
	readonly organization: OrganizationLocales | null | undefined
	readonly deviceLanguages: readonly string[]
	/** Locales this build has translations for; empty means every content locale. */
	readonly appLocales: readonly string[]
	readonly override?: string | null
}

/**
 * Resolution order:
 * 1. an explicit customer override (Profile, Language), negotiated against the
 *    app locales with `en` as the default,
 * 2. the device's preferred languages, when the app has that translation,
 * 3. the locale the organization negotiated for this device (`locale` in the
 *    `/resources/sites` payload), then its default locale, so a KSA tenant
 *    still gets Arabic on a phone set to a language the app does not ship,
 * 4. English.
 */
export function resolveAppLanguage({
	organization,
	deviceLanguages,
	appLocales,
	override,
}: ResolveAppLanguageInput): AppLanguage {
	const supported = appLocales.length === 0 ? CONTENT_LOCALES : appLocales
	const translated = supported.map(normalizeLocale)

	if (override) {
		return createAppLanguage(negotiateLocale([override], supported, 'en'))
	}

	const deviceMatch = matchLocale(deviceLanguages, translated)
	if (deviceMatch !== null) return createAppLanguage(deviceMatch)

	if (organization) {
		return createAppLanguage(
			negotiateLocale(
				[
					resolvedOrganizationLocale(organization),
					resolvedOrganizationDefaultLocale(organization),
				],
				translated,
				'en',
			),
		)
	}

	return createAppLanguage('en')
}

/**
 * The content locales a build ships translations for, in content-locale
 * order; `['en']` when none of the shipped catalogs is a content locale.
 */
export function availableAppLocales(shipped: readonly string[]): string[] {
	const unique = new Set(
		shipped
			.map(normalizeLocale)
			.filter((code) => (CONTENT_LOCALES as readonly string[]).includes(code)),
	)
	return unique.size === 0
		? ['en']
		: CONTENT_LOCALES.filter((code) => unique.has(code))
}
