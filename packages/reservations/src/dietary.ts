/**
 * Coded dietary and allergen values a reservation can carry. These are
 * operational data: every holder of `read:reservation` may see them so the
 * host stand can flag an allergy at a glance. Free text (reservation dietary
 * notes, guest-profile notes) is NOT coded data and stays behind the guest
 * grant.
 */
export const RSV_DIETARY_CODES = [
	'vegetarian',
	'vegan',
	'gluten_free',
	'halal',
	'kosher',
	'nut_allergy',
	'peanut_allergy',
	'dairy_free',
	'shellfish_allergy',
	'egg_allergy',
	'soy_allergy',
	'fish_allergy',
	'sesame_allergy',
] as const

export type RsvDietaryCode = (typeof RSV_DIETARY_CODES)[number]

/** Codes that are an allergy (a safety matter) rather than a preference. */
export const RSV_ALLERGEN_CODES: readonly RsvDietaryCode[] = [
	'nut_allergy',
	'peanut_allergy',
	'shellfish_allergy',
	'egg_allergy',
	'soy_allergy',
	'fish_allergy',
	'sesame_allergy',
]

const CODE_SET = new Set<string>(RSV_DIETARY_CODES)

function normalizeToken(token: string): string {
	return token
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_')
}

/**
 * The coded values found in a stored dietary string such as
 * `nut_allergy, vegan` or `Nut Allergy; Gluten-Free`. Anything that is not an
 * exact known code or its label is free text and is dropped, so the result is
 * safe to send to a token without the guest grant. Order is kept, duplicates
 * removed.
 */
export function extractDietaryCodes(
	value: string | null | undefined,
): RsvDietaryCode[] {
	if (!value) return []
	const out: RsvDietaryCode[] = []
	for (const part of value.split(/[,;\n]/)) {
		const code = normalizeToken(part)
		if (CODE_SET.has(code) && !out.includes(code as RsvDietaryCode)) {
			out.push(code as RsvDietaryCode)
		}
	}
	return out
}
