import { isSiteContentLocale } from '@repo/common/site-locales'
import {
	checkLocalizedMap,
	resolveGuestLocale,
	resolveLocalizedText,
	type LocalizedMap,
} from '@repo/reservations'
import { badRequest } from './http.ts'
import { getReservationsContext } from './reservations-context.ts'

/**
 * Languages come from the organization's Website settings (`locales` and
 * `defaultLocale` in the reservations context). Nothing here names a language.
 */
export type LocaleOrg = {
	locales: readonly string[]
	defaultLocale: string
}

/**
 * Language of a public request: the explicit `?locale=` first, then the
 * `Accept-Language` preferences in order; the first one the organization enables
 * wins, otherwise the organization default.
 */
export function resolveRequestLocale(
	explicit: string | null | undefined,
	acceptLanguage: string | null | undefined,
	org: LocaleOrg,
): string {
	const candidates = [
		explicit?.trim(),
		...(acceptLanguage ?? '')
			.split(',')
			.map((part) => part.split(';')[0]?.trim()),
	].filter((value): value is string => Boolean(value))
	for (const candidate of candidates) {
		const resolved = resolveGuestLocale(candidate, org.locales, '')
		if (resolved) return resolved
	}
	return org.defaultLocale
}

/** The guest's language when enabled, else the organization default. */
export function guestLocaleFor(
	value: string | null | undefined,
	org: LocaleOrg,
): string {
	return resolveGuestLocale(value, org.locales, org.defaultLocale)
}

/**
 * Operator-authored text for a guest: requested language, organization default,
 * then the canonical column (never another language's text).
 */
export function pickText(
	map: LocalizedMap | null | undefined,
	locale: string | null | undefined,
	org: LocaleOrg,
	canonical?: string | null,
): string | null {
	return resolveLocalizedText(map, locale, org.defaultLocale, canonical)
}

/**
 * The organization's languages from the control-plane context, or null when the
 * context is unavailable (then only the platform's language list can be checked).
 */
export async function loadLocaleOrg(orgId: string): Promise<LocaleOrg | null> {
	const ctx = await getReservationsContext(orgId)
	return ctx
		? {
				locales: ctx.organization.locales,
				defaultLocale: ctx.organization.defaultLocale,
			}
		: null
}

/**
 * Validates an operator-typed locale map against the organization's enabled
 * languages (Website settings). Only languages in the platform list are ever
 * accepted; with a known organization the keys must be enabled and, for
 * guest-facing names, the default-language entry must be present.
 */
export function assertLocalizedMap(
	map: Record<string, string> | null | undefined,
	org: LocaleOrg | null,
	field: string,
	options: { requireDefault?: boolean } = {},
): LocalizedMap {
	const cleaned = checkLocalizedMap(
		map,
		org ?? { locales: Object.keys(map ?? {}), defaultLocale: '' },
		org ? options : {},
	)
	if (!cleaned.ok) {
		throw badRequest(cleaned.issue, undefined, { fields: [field] })
	}
	for (const key of Object.keys(cleaned.map)) {
		if (!isSiteContentLocale(key)) {
			throw badRequest('locale_not_enabled', undefined, { fields: [field] })
		}
	}
	return cleaned.map
}

/**
 * A name map plus its canonical column: the canonical `name` is the
 * default-language text, so a map that omits the default entry gets it from the
 * canonical value. Returns undefined when no map was sent.
 */
export function normalizeNameMap(
	map: Record<string, string> | null | undefined,
	org: LocaleOrg | null,
	canonical: string | null | undefined,
	field = 'nameI18n',
): LocalizedMap | undefined {
	if (!map) return undefined
	const checked = assertLocalizedMap(map, org, field)
	const text = canonical?.trim()
	if (org && text && !checked[org.defaultLocale]) {
		return { ...checked, [org.defaultLocale]: text }
	}
	return checked
}

export function localeOrgOf(
	context: { organization: LocaleOrg } | null | undefined,
): LocaleOrg | null {
	return context
		? {
				locales: context.organization.locales,
				defaultLocale: context.organization.defaultLocale,
			}
		: null
}
