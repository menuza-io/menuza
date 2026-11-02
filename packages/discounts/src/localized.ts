import { z } from 'zod'

/**
 * Guest-facing discount copy in the organization's website languages
 * (`{ en: 'Lunch deal', ar: '...' }`). The definition keeps `name` and
 * `description` as the default-language text; these maps carry every
 * language, the default included.
 */

/** `ar`, or a regional tag such as `zh-cn` (keys are stored lower-cased). */
export const DISCOUNT_LOCALE_KEY_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/

/** Most languages one map holds; a website offers a handful. */
export const DISCOUNT_MAX_LOCALES = 20

export function discountLocalizedTextSchema(maxLength: number) {
	return z
		.record(
			z
				.string()
				.transform((key) => key.toLowerCase())
				.pipe(z.string().regex(DISCOUNT_LOCALE_KEY_PATTERN)),
			z.string().trim().max(maxLength),
		)
		.refine((map) => Object.keys(map).length <= DISCOUNT_MAX_LOCALES, {
			message: 'Too many languages',
		})
		.transform((map) => {
			const out: Record<string, string> = {}
			for (const [key, value] of Object.entries(map)) {
				if (value) out[key] = value
			}
			return out
		})
}

export type DiscountLocalizedText = Record<string, string>

/**
 * Text for a guest: their language, its base (`ar-SA` → `ar`), the default
 * language, then the canonical text. Never another language.
 */
export function localizedDiscountText(
	map: Readonly<Record<string, string | undefined>> | null | undefined,
	canonical: string,
	locale: string | null | undefined,
	defaultLocale?: string | null,
): string {
	const candidates = [
		locale,
		locale?.split('-')[0],
		defaultLocale,
		defaultLocale?.split('-')[0],
	]
	if (!map) return canonical
	const lowered = new Map(
		Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]),
	)
	for (const candidate of candidates) {
		if (!candidate) continue
		const value = lowered.get(candidate.toLowerCase())?.trim()
		if (value) return value
	}
	return canonical
}

/**
 * Keeps one source of truth for the default language: the map's default
 * entry is always `name` (and `description`), whatever else changed. Every
 * writer calls this, so a receipt, the site and the editor never disagree.
 */
export function withCanonicalDiscountCopy<
	T extends {
		name: string
		description: string | null
		nameI18n?: DiscountLocalizedText
		descriptionI18n?: DiscountLocalizedText
	},
>(definition: T, defaultLocale: string): T {
	const locale = defaultLocale.toLowerCase()
	const align = (
		map: DiscountLocalizedText | undefined,
		text: string | null,
	): DiscountLocalizedText | undefined => {
		const others = Object.fromEntries(
			Object.entries(map ?? {}).filter(([key]) => key !== locale),
		)
		const next = text ? { ...others, [locale]: text } : others
		return Object.keys(next).length > 0 ? next : undefined
	}
	const nameI18n = align(definition.nameI18n, definition.name)
	const descriptionI18n = align(
		definition.descriptionI18n,
		definition.description,
	)
	const {
		nameI18n: ignoredName,
		descriptionI18n: ignoredDescription,
		...rest
	} = definition
	return {
		...rest,
		...(nameI18n ? { nameI18n } : {}),
		...(descriptionI18n ? { descriptionI18n } : {}),
	} as T
}
