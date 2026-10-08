/**
 * "+1" covers the whole North American Numbering Plan, which includes about
 * twenty Caribbean and Atlantic countries billed at international rates (the
 * usual targets of SMS pumping). These area codes belong to those countries.
 * US territories (Puerto Rico, USVI, Guam, ...) stay allowed.
 */
const NON_US_CA_NANP_AREA_CODES = new Set([
	'242', // Bahamas
	'246', // Barbados
	'264', // Anguilla
	'268', // Antigua and Barbuda
	'284', // British Virgin Islands
	'345', // Cayman Islands
	'441', // Bermuda
	'473', // Grenada
	'649', // Turks and Caicos
	'658', // Jamaica
	'664', // Montserrat
	'721', // Sint Maarten
	'758', // Saint Lucia
	'767', // Dominica
	'784', // Saint Vincent and the Grenadines
	'809', // Dominican Republic
	'829', // Dominican Republic
	'849', // Dominican Republic
	'868', // Trinidad and Tobago
	'869', // Saint Kitts and Nevis
	'876', // Jamaica
])

/** Premium-rate and non-geographic service codes nobody should be texted at. */
const BLOCKED_SERVICE_AREA_CODES = new Set(['900', '976'])

const NANP_E164 = /^\+1([2-9]\d{2})([2-9]\d{2})\d{4}$/u

/**
 * True for a valid E.164 number in the United States (including its
 * territories) or Canada. Use before sending any SMS or verification call.
 */
export function isUsOrCanadaNumber(e164: string) {
	const match = NANP_E164.exec(e164.trim())
	if (!match) return false
	const areaCode = match[1]!
	// N11 codes (211, 311, ... 911) are not real area codes.
	if (areaCode[1] === '1' && areaCode[2] === '1') return false
	return (
		!NON_US_CA_NANP_AREA_CODES.has(areaCode) &&
		!BLOCKED_SERVICE_AREA_CODES.has(areaCode)
	)
}
