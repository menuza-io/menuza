import { type LegalRegion } from './types.ts'

const EU_COUNTRIES = new Set([
	'AT',
	'BE',
	'BG',
	'HR',
	'CY',
	'CZ',
	'DK',
	'EE',
	'FI',
	'FR',
	'DE',
	'GR',
	'HU',
	'IE',
	'IT',
	'LV',
	'LT',
	'LU',
	'MT',
	'NL',
	'PL',
	'PT',
	'RO',
	'SK',
	'SI',
	'ES',
	'SE',
	'IS',
	'LI',
	'NO',
	'CH',
])

/** The privacy regime an ISO 3166 country code falls under, or null. */
export function regionOfCountry(
	country: string | null | undefined,
): LegalRegion | null {
	const code = country?.trim().toUpperCase()
	if (!code) return null
	if (code === 'SA') return 'ksa'
	if (code === 'GB' || code === 'UK') return 'uk'
	if (code === 'US') return 'us'
	if (EU_COUNTRIES.has(code)) return 'eu'
	return 'other'
}

/** A guess from the site's main language when no country is known. */
function regionOfLocale(locale: string | null | undefined): LegalRegion | null {
	switch (locale) {
		case 'ar':
			return 'ksa'
		case 'de':
		case 'fr':
		case 'es':
			return 'eu'
		case 'zh':
			return 'other'
		default:
			return null
	}
}

/**
 * Which privacy rules a site is under: the country the operator gave, else
 * where its customer data lives (KSA), else the site's language, else US.
 */
export function legalRegionFor(input: {
	country?: string | null
	dataRegion?: string | null
	defaultLocale?: string | null
	address?: string | null
}): LegalRegion {
	const byCountry = regionOfCountry(input.country)
	if (byCountry) return byCountry
	if (input.dataRegion === 'ksa') return 'ksa'
	// A saudi, british or european address in the text is a good signal too.
	const address = (input.address ?? '').toLowerCase()
	if (/saudi|riyadh|jeddah|ksa/u.test(address)) return 'ksa'
	if (/united kingdom|\buk\b|england|scotland|wales/u.test(address)) return 'uk'
	return regionOfLocale(input.defaultLocale) ?? 'us'
}

export type ConsentMode = 'required' | 'notice' | 'off'

/**
 * The banner mode a site starts with: Required for the EU, UK and KSA (and
 * anywhere we cannot tell it is a US-style regime), Notice only for the US.
 */
export function defaultConsentMode(region: LegalRegion): ConsentMode {
	return region === 'us' ? 'notice' : 'required'
}
