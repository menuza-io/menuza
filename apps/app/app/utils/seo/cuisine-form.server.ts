import {
	parsePriceRange,
	parseStoredCuisines,
	type PriceRangeLevel,
	validateCuisines,
} from '@repo/common/cuisines'
import { parseLocalizedString } from '@repo/common/site-locales'

/**
 * Reads `cuisines` (repeated keys) and `priceRange` (`1`-`4`, empty for not
 * set) from a settings form (#182). Unknown keys, more than three, or a price
 * level out of range are refused; nothing is stored as free text.
 */
export function parseCuisineForm(
	formData: FormData,
):
	| { ok: true; cuisines: string | null; priceRange: PriceRangeLevel | null }
	| {
			ok: false
			error: 'unknown_cuisine' | 'too_many_cuisines' | 'invalid_price_range'
	  } {
	const raw = formData.getAll('cuisines').map(String)
	const cuisines = validateCuisines(raw)
	if (!cuisines.ok) return { ok: false, error: cuisines.error }
	const price = String(formData.get('priceRange') ?? '').trim()
	const priceRange = price ? parsePriceRange(price) : null
	if (price && priceRange === null) {
		return { ok: false, error: 'invalid_price_range' }
	}
	return {
		ok: true,
		cuisines: cuisines.keys.length ? JSON.stringify(cuisines.keys) : null,
		priceRange,
	}
}

/** Stored cuisines for a form's initial state. */
export function storedCuisineKeys(value: unknown): string[] {
	return parseStoredCuisines(value) ?? []
}

/** Localized JSON text as a plain `{ locale: text }` record, for forms. */
export function localizedRecord(
	value: string | null | undefined,
	defaultLocale: string,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [locale, text] of Object.entries(
		parseLocalizedString(value, defaultLocale),
	)) {
		if (typeof text === 'string') out[locale] = text
	}
	return out
}

/** The organization's currency, as the public menu reports it. */
export function organizationCurrency(dataRegion: string | null | undefined) {
	return dataRegion === 'ksa' ? 'SAR' : 'USD'
}
