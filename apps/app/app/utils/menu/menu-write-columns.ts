import {
	serializeOrderTypePrices,
	type OrderTypePrices,
} from '@repo/common/menu-pricing'
import { dietaryColumnsFromInput } from '@repo/common/menu-types'

/**
 * Dietary tags (#335) and order-type prices (#412) columns for a dish or option
 * save. The tag list is the source when the form sends it; an older form that
 * sends only the two flags keeps the record's other tags (read lazily). Order
 * type prices are written only when the form sends the field, so an older
 * form never clears them.
 */
export async function dietaryAndOrderTypeColumns(
	data: {
		dietaryTags?: string[]
		isVegetarian: boolean
		isGlutenFree: boolean
		orderTypePrices?: OrderTypePrices | null
	},
	readCurrentTags: () => Promise<string | null | undefined> = async () => null,
) {
	const dietary = dietaryColumnsFromInput(
		data,
		data.dietaryTags ? null : await readCurrentTags(),
	)
	return {
		...dietary,
		...(data.orderTypePrices !== undefined
			? { orderTypePrices: serializeOrderTypePrices(data.orderTypePrices) }
			: {}),
	}
}

/** Form keys whose values are JSON (parsed before Zod). */
export const MENU_JSON_FORM_KEYS = ['dietaryTags', 'orderTypePrices'] as const

export function parseMenuJsonFormValue(value: FormDataEntryValue): unknown {
	if (typeof value !== 'string' || !value.trim()) return undefined
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}
