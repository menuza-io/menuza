import { z } from 'zod'

/**
 * Operator-authored, guest-facing copy is a locale map (`{ en: 'Patio', ar: '...' }`)
 * whose languages come from the organization's Website settings. This module is
 * pure: the enabled languages and the default are always passed in, never
 * hard-coded here (the same list the Menu and Drops editors use).
 */

export type LocalizedMap = Record<string, string>

export const LOCALE_KEY_PATTERN = /^[a-z]{2,3}$/

/** Map schema: language-code keys, trimmed values, empty values dropped. */
export function localizedTextSchema(maxLength: number) {
	return z
		.record(
			z.string().regex(LOCALE_KEY_PATTERN),
			z.string().trim().max(maxLength),
		)
		.transform((map) => dropEmptyLocalizedValues(map))
}

export function dropEmptyLocalizedValues(
	map: Record<string, string | null | undefined>,
): LocalizedMap {
	const out: LocalizedMap = {}
	for (const [key, value] of Object.entries(map)) {
		const trimmed = value?.trim()
		if (trimmed) out[key] = trimmed
	}
	return out
}

export type LocalesConfig = {
	locales: readonly string[]
	defaultLocale: string
}

export type LocalizedMapIssue = 'locale_not_enabled' | 'default_locale_required'

/**
 * Checks a map against the organization's enabled languages. A language that is
 * not enabled is refused; the default-language entry is required when
 * `requireDefault` is set (guest-facing names), optional otherwise.
 */
export function checkLocalizedMap(
	map: Record<string, string> | null | undefined,
	config: LocalesConfig,
	options: { requireDefault?: boolean } = {},
): { ok: true; map: LocalizedMap } | { ok: false; issue: LocalizedMapIssue } {
	const cleaned = dropEmptyLocalizedValues(map ?? {})
	const enabled = new Set([...config.locales, config.defaultLocale])
	for (const key of Object.keys(cleaned)) {
		if (!enabled.has(key)) return { ok: false, issue: 'locale_not_enabled' }
	}
	if (options.requireDefault && !cleaned[config.defaultLocale]) {
		return { ok: false, issue: 'default_locale_required' }
	}
	return { ok: true, map: cleaned }
}

/** Drops languages the organization no longer enables (used when carrying old rows forward). */
export function pruneLocalizedMap(
	map: Record<string, string> | null | undefined,
	config: LocalesConfig,
): LocalizedMap {
	const enabled = new Set([...config.locales, config.defaultLocale])
	const out: LocalizedMap = {}
	for (const [key, value] of Object.entries(
		dropEmptyLocalizedValues(map ?? {}),
	)) {
		if (enabled.has(key)) out[key] = value
	}
	return out
}

/**
 * Language for a guest-facing message or page: the guest's own language when
 * the organization enables it (`ar-SA` matches `ar`), otherwise the default.
 */
export function resolveGuestLocale(
	value: unknown,
	locales: readonly string[],
	defaultLocale: string,
): string {
	if (typeof value === 'string') {
		const lower = value.trim().toLowerCase().replace(/_/g, '-')
		const base = lower.split('-')[0] ?? lower
		for (const candidate of [lower, base]) {
			if (candidate && locales.includes(candidate)) return candidate
		}
	}
	return defaultLocale
}

/**
 * Operator text for a guest: requested language, language base, organization
 * default, canonical column, then null. Never borrows another language.
 */
export function resolveLocalizedText(
	map: Record<string, string | undefined> | null | undefined,
	locale: string | null | undefined,
	defaultLocale: string,
	canonical?: string | null,
): string | null {
	if (map) {
		for (const candidate of [
			locale,
			locale?.split('-')[0],
			defaultLocale,
			defaultLocale.split('-')[0],
		]) {
			const value = candidate ? map[candidate]?.trim() : undefined
			if (value) return value
		}
	}
	const fallback = canonical?.trim()
	if (fallback) return fallback
	return null
}
