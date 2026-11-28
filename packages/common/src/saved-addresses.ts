import { z } from 'zod'

/**
 * Saved delivery addresses on the guest account (#113). Shared by tenant-api
 * (`/customer/addresses`), Sites (checkout picker, Profile) and the customer
 * app. The address and its point live in the guest's region only; a saved
 * address is never trusted for coverage or fees, it is re-quoted at checkout.
 */

export const SAVED_ADDRESS_LIMIT = 10
export const SAVED_ADDRESS_LABEL_MAX = 40
export const SAVED_ADDRESS_UNIT_MAX = 50
/** Gate code, buzzer, "ring twice": up to 280 characters. */
export const SAVED_ADDRESS_NOTES_MAX = 280

export const SAVED_ADDRESS_ERROR_CODES = [
	'address_not_found',
	'address_limit_reached',
	'invalid_quote_token',
] as const
export type SavedAddressErrorCode = (typeof SAVED_ADDRESS_ERROR_CODES)[number]

const idSchema = z.string().trim().min(1).max(128)
const labelSchema = z.string().trim().min(1).max(SAVED_ADDRESS_LABEL_MAX)
const notesSchema = z.string().trim().max(SAVED_ADDRESS_NOTES_MAX)

/**
 * `POST /customer/addresses`: the point comes from a successful geocode, so
 * the body names the signed delivery quote token (`dq1.…`) the quote returned,
 * never free text. `locationId` is the location the quote was made for.
 */
export const createSavedAddressSchema = z.strictObject({
	locationId: idSchema,
	quoteToken: z.string().min(16).max(4096),
	label: labelSchema,
	notes: notesSchema.optional(),
	/** Make it the default. The first address is always the default. */
	makeDefault: z.boolean().optional(),
})
export type CreateSavedAddressRequest = z.infer<typeof createSavedAddressSchema>

/**
 * `PATCH /customer/addresses/:id`: rename, edit the unit or notes, or make it
 * the default. The point never changes (a new place is a new address).
 */
export const updateSavedAddressSchema = z
	.strictObject({
		label: labelSchema.optional(),
		unit: z.string().trim().max(SAVED_ADDRESS_UNIT_MAX).nullable().optional(),
		notes: notesSchema.nullable().optional(),
		isDefault: z.literal(true).optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: 'Nothing to change',
	})
export type UpdateSavedAddressRequest = z.infer<typeof updateSavedAddressSchema>

/** What a client sees: no coordinates, the region keeps the point. */
export const savedAddressSchema = z.object({
	id: z.string(),
	label: z.string(),
	formatted: z.string(),
	line1: z.string(),
	unit: z.string().nullable(),
	city: z.string(),
	state: z.string().nullable(),
	postalCode: z.string().nullable(),
	country: z.string().nullable(),
	notes: z.string().nullable(),
	isDefault: z.boolean(),
	createdAt: z.number(),
})
export type SavedAddress = z.infer<typeof savedAddressSchema>

export const savedAddressListSchema = z.object({
	addresses: z.array(savedAddressSchema),
	limit: z.number(),
})
export type SavedAddressList = z.infer<typeof savedAddressListSchema>

/**
 * The quote request that re-quotes a saved address (`POST /delivery/quote`
 * with `addressId`): the same coverage, fee and signed token as a typed one.
 */
export const savedAddressQuoteFields = {
	addressId: idSchema,
} as const

/** Display name for the picker: the label first, then the street. */
export function savedAddressTitle(address: {
	label: string
	line1: string
	unit?: string | null
}): string {
	const street = address.unit
		? `${address.line1}, ${address.unit}`
		: address.line1
	return `${address.label}: ${street}`
}

/** The default first, then newest first. Pure, so every client orders alike. */
export function orderSavedAddresses<
	T extends { isDefault: boolean; createdAt: number },
>(addresses: readonly T[]): T[] {
	return [...addresses].sort((a, b) => {
		if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
		return b.createdAt - a.createdAt
	})
}
