import {
	MENU_CHANNELS,
	menuChannelsSchema,
	parseMenuChannels,
	serializeMenuChannels,
	serializeOptionalMenuChannels,
	type MenuChannel,
} from '@repo/common/menu-channels'
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

/**
 * Parses `channels` from a menu, category, or item form submission (#220).
 * Missing field keeps existing channels on update and defaults to all channels
 * on create. Invalid payloads fail closed with `{ ok: false }`.
 */
export function parseChannelsFormData(
	formData: FormData,
):
	| { ok: true; provided: false; channels: MenuChannel[]; serialized: string }
	| { ok: true; provided: true; channels: MenuChannel[]; serialized: string }
	| { ok: false } {
	if (!formData.has('channels')) {
		return {
			ok: true,
			provided: false,
			channels: [...MENU_CHANNELS],
			serialized: serializeMenuChannels(MENU_CHANNELS),
		}
	}
	const raw = formData.get('channels')
	if (typeof raw !== 'string') return { ok: false }
	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(raw)
	} catch {
		return { ok: false }
	}
	const parsed = menuChannelsSchema.safeParse(parsedJson)
	if (!parsed.success) return { ok: false }
	const normalized = parseMenuChannels(parsed.data)
	return {
		ok: true,
		provided: true,
		channels: normalized,
		serialized: serializeMenuChannels(normalized),
	}
}

/**
 * Narrows a location override's channels against the parent entity's channels
 * (#220). Overrides may only turn off channels that are on at the base level;
 * when all base channels remain enabled, returns `null` (inherit).
 */
export function narrowOverrideChannels(
	baseChannels: readonly MenuChannel[],
	rawOverrideChannels: unknown,
): string | null {
	if (rawOverrideChannels === null || rawOverrideChannels === undefined) {
		return null
	}
	const parsed = menuChannelsSchema.safeParse(rawOverrideChannels)
	if (!parsed.success) return null
	const narrowed = baseChannels.filter((ch) => parsed.data.includes(ch))
	const sameAsBase =
		narrowed.length === baseChannels.length &&
		baseChannels.every((ch, index) => narrowed[index] === ch)
	return sameAsBase ? null : serializeOptionalMenuChannels(narrowed)
}
