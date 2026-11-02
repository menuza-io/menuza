import { z } from 'zod'

/**
 * Guest-facing discount copy in the organization's website languages
 * (`{ en: 'Lunch deal', ar: '...' }`). The definition keeps `name` and
 * `description` as the default-language text; these maps carry every
 * language, the default included.
 */

export const DISCOUNT_LOCALE_KEY_PATTERN = /^[a-z]{2,3}$/

export function discountLocalizedTextSchema(maxLength: number) {
	return z
		.record(
			z.string().regex(DISCOUNT_LOCALE_KEY_PATTERN),
			z.string().trim().max(maxLength),
		)
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
	for (const candidate of candidates) {
		if (!candidate) continue
		const value = map?.[candidate.toLowerCase()]?.trim()
		if (value) return value
	}
	return canonical
}
