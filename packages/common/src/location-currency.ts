import { type LocationAddress } from './location-types.ts'

export type LocationCurrency = 'USD' | 'CAD' | 'SAR'

export const SUPPORTED_LOCATION_CURRENCIES: LocationCurrency[] = [
	'USD',
	'CAD',
	'SAR',
]

const CANADIAN_PROVINCES = new Set([
	'ON',
	'QC',
	'BC',
	'AB',
	'MB',
	'SK',
	'NS',
	'NB',
	'NL',
	'PE',
	'NT',
	'YT',
	'NU',
	'ONTARIO',
	'QUEBEC',
	'BRITISH COLUMBIA',
	'ALBERTA',
	'MANITOBA',
	'SASKATCHEWAN',
	'NOVA SCOTIA',
	'NEW BRUNSWICK',
	'NEWFOUNDLAND',
	'PRINCE EDWARD ISLAND',
	'NORTHWEST TERRITORIES',
	'YUKON',
	'NUNAVUT',
])

const CANADIAN_POSTAL_CODE_REGEX = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/

/**
 * Resolves the currency for a restaurant location based on its physical address.
 * Supports US Dollars, Canadian Dollars, and Saudi Riyals.
 * Defaults to 'USD'.
 */
export function getLocationCurrency(
	address: LocationAddress | string | null | undefined,
): LocationCurrency {
	if (!address) return 'USD'

	let parsed: Partial<LocationAddress> | null = null
	if (typeof address === 'string') {
		try {
			parsed = JSON.parse(address) as Partial<LocationAddress>
		} catch {
			return 'USD'
		}
	} else {
		parsed = address
	}

	if (!parsed) return 'USD'

	const country = (parsed.country || '').trim().toUpperCase()
	if (
		[
			'SA',
			'SAU',
			'SAUDI ARABIA',
			'المملكة العربية السعودية',
			'السعودية',
		].includes(country)
	) {
		return 'SAR'
	}
	if (
		country === 'CA' ||
		country === 'CAN' ||
		country === 'CANADA' ||
		country.includes('CANADA')
	) {
		return 'CAD'
	}

	// Secondary check: Canadian postal code (e.g. M5S 1X8)
	if (
		parsed.postalCode &&
		CANADIAN_POSTAL_CODE_REGEX.test(parsed.postalCode.trim())
	) {
		return 'CAD'
	}

	// Secondary check: Canadian province
	const state = (parsed.state || '').trim().toUpperCase()
	if (state && CANADIAN_PROVINCES.has(state)) {
		return 'CAD'
	}

	return 'USD'
}

/**
 * Formats a monetary amount using standard '$' representation across both
 * English and Arabic locales, avoiding browser CLDR insertions like '$US', 'US$', or 'CA$'.
 */
export function formatLocationPrice(
	amount: number,
	currency: LocationCurrency = 'USD',
	locale: string = 'en',
): string {
	const validAmount = Number.isFinite(amount) ? amount : 0
	if (currency === 'SAR') {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(validAmount)
	}
	const isNegative = validAmount < 0
	const absAmount = Math.abs(validAmount)

	const formattedNumber = absAmount.toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})

	const sign = isNegative ? '-' : ''
	return `${sign}$${formattedNumber}`
}
