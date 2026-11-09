import {
	type createSupplierSchema,
	type InventoryBaseUnit,
	MAX_ENTRY_QUANTITY,
	SUPPLIER_ORDER_CHANNELS,
	type Supplier,
	type SupplierOrderChannel,
	type SupplierProduct,
	type supplierProductInputSchema,
	type updateSupplierProductSchema,
	type updateSupplierSchema,
	type UnitRef,
} from '@repo/inventory'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { z } from 'zod'
import {
	minorToMajorText,
	parseMoneyToMinor,
	parseWholeNumber,
} from '#app/utils/money-input.ts'
import { thousandthsInUnit } from './format.ts'

/**
 * The supplier sheet as pure functions: the Zod schema the form validates
 * with and the builders that turn what was typed into the wire payloads.
 * Exactly the contract's fields: name, contact person, phone, email, how they
 * take orders, delivery days, order cut-off, minimum order, payment terms and
 * VAT number (plus a free note).
 */

export const DELIVERY_DAY_NUMBERS = [0, 1, 2, 3, 4, 5, 6] as const

export type SupplierFormValues = {
	name: string
	contactName: string
	phone: string
	email: string
	orderChannel: SupplierOrderChannel
	/** Comma-joined weekday numbers, 0 = Sunday. */
	deliveryDays: string
	/** `HH:MM` or empty. */
	cutoffTime: string
	/** Whole days before delivery, or empty. */
	cutoffDaysBefore: string
	/** Major units, or empty. */
	minimumOrder: string
	paymentTerms: string
	vatNumber: string
	notes: string
}

export function emptySupplierFormValues(): SupplierFormValues {
	return {
		name: '',
		contactName: '',
		phone: '',
		email: '',
		orderChannel: 'phone',
		deliveryDays: '',
		cutoffTime: '',
		cutoffDaysBefore: '',
		minimumOrder: '',
		paymentTerms: '',
		vatNumber: '',
		notes: '',
	}
}

export function supplierFormValues(
	supplier: Supplier,
	currency: string,
): SupplierFormValues {
	return {
		name: supplier.name,
		contactName: supplier.contactName ?? '',
		phone: supplier.phone ?? '',
		email: supplier.email ?? '',
		orderChannel: supplier.orderChannel,
		deliveryDays: [...supplier.deliveryDays].sort((a, b) => a - b).join(','),
		cutoffTime: supplier.cutoffTime ?? '',
		cutoffDaysBefore:
			supplier.cutoffDaysBefore === null
				? ''
				: String(supplier.cutoffDaysBefore),
		minimumOrder:
			supplier.minimumOrderMinor === null ||
			supplier.minimumOrderMinor === undefined
				? ''
				: minorToMajorText(supplier.minimumOrderMinor, currency),
		paymentTerms: supplier.paymentTerms ?? '',
		vatNumber: supplier.vatNumber ?? '',
		notes: supplier.notes ?? '',
	}
}

export function parseDeliveryDays(joined: string): number[] {
	if (joined === '') return []
	return [
		...new Set(
			joined
				.split(',')
				.map((part) => Number(part))
				.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
		),
	].sort((a, b) => a - b)
}

/** Add or remove a weekday from the joined value. */
export function toggleDeliveryDay(joined: string, day: number): string {
	const days = new Set(parseDeliveryDays(joined))
	if (days.has(day)) days.delete(day)
	else days.add(day)
	return [...days].sort((a, b) => a - b).join(',')
}

export type SupplierFormMessages = {
	nameRequired: string
	nameTooLong: string
	textInvalid: string
	contactTooLong: string
	phoneTooLong: string
	emailInvalid: string
	daysInvalid: string
	cutoffTimeInvalid: string
	cutoffDaysInvalid: string
	cutoffNeedsBoth: string
	minimumInvalid: string
	termsTooLong: string
	vatTooLong: string
	notesTooLong: string
}

const CONTROL_CHARS = /\p{Cc}/u
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** The schema the form validates with (client side; the region validates again). */
export function supplierFormSchema(
	messages: SupplierFormMessages,
	{ currency }: { currency: string },
) {
	const plain = (max: number, tooLong: string) =>
		z
			.string()
			.trim()
			.max(max, tooLong)
			.refine((value) => !CONTROL_CHARS.test(value), messages.textInvalid)
			.prefault('')
	return z
		.object({
			name: z
				.string()
				.trim()
				.min(1, messages.nameRequired)
				.max(80, messages.nameTooLong)
				.refine((value) => !CONTROL_CHARS.test(value), messages.textInvalid)
				.prefault(''),
			contactName: plain(80, messages.contactTooLong),
			phone: plain(40, messages.phoneTooLong),
			email: z
				.string()
				.trim()
				.max(200, messages.emailInvalid)
				.refine(
					(value) => value === '' || z.email().safeParse(value).success,
					messages.emailInvalid,
				)
				.prefault(''),
			orderChannel: z.enum(SUPPLIER_ORDER_CHANNELS),
			deliveryDays: z
				.string()
				.refine(
					(value) =>
						value === '' ||
						value.split(',').every((day) => /^[0-6]$/.test(day)),
					messages.daysInvalid,
				)
				.prefault(''),
			cutoffTime: z
				.string()
				.trim()
				.refine(
					(value) => value === '' || TIME.test(value),
					messages.cutoffTimeInvalid,
				)
				.prefault(''),
			cutoffDaysBefore: z.string().trim().prefault(''),
			minimumOrder: z.string().trim().prefault(''),
			paymentTerms: plain(80, messages.termsTooLong),
			vatNumber: plain(40, messages.vatTooLong),
			notes: z
				.string()
				.trim()
				.max(500, messages.notesTooLong)
				.refine((value) => !CONTROL_CHARS.test(value), messages.textInvalid)
				.prefault(''),
		})
		.superRefine((value, ctx) => {
			const issue = (path: string, message: string) =>
				ctx.addIssue({ code: 'custom', path: [path], message })
			if (
				value.cutoffDaysBefore !== '' &&
				parseWholeNumber(value.cutoffDaysBefore, { min: 0, max: 14 }) === null
			) {
				issue('cutoffDaysBefore', messages.cutoffDaysInvalid)
			}
			// The cut-off is a time and a number of days: one without the other means nothing.
			const timeSet = value.cutoffTime !== ''
			const daysSet = value.cutoffDaysBefore !== ''
			if (timeSet !== daysSet) {
				issue(
					timeSet ? 'cutoffDaysBefore' : 'cutoffTime',
					messages.cutoffNeedsBoth,
				)
			}
			if (
				value.minimumOrder !== '' &&
				parseMoneyToMinor(value.minimumOrder, { currency, min: 0 }) === null
			) {
				issue('minimumOrder', messages.minimumInvalid)
			}
		})
}

export type ParsedSupplierForm = z.infer<ReturnType<typeof supplierFormSchema>>

const nullable = (text: string): string | null => (text === '' ? null : text)

function supplierFields(values: ParsedSupplierForm, currency: string) {
	return {
		name: values.name,
		contactName: nullable(values.contactName),
		phone: nullable(values.phone),
		email: nullable(values.email),
		orderChannel: values.orderChannel,
		deliveryDays: parseDeliveryDays(values.deliveryDays),
		cutoffTime: nullable(values.cutoffTime),
		cutoffDaysBefore:
			values.cutoffDaysBefore === ''
				? null
				: parseWholeNumber(values.cutoffDaysBefore, { min: 0, max: 14 }),
		minimumOrderMinor:
			values.minimumOrder === ''
				? null
				: parseMoneyToMinor(values.minimumOrder, { currency, min: 0 }),
		currency,
		paymentTerms: nullable(values.paymentTerms),
		vatNumber: nullable(values.vatNumber),
		notes: nullable(values.notes),
	}
}

/** `POST /suppliers` body. */
export function buildCreateSupplierPayload(
	values: ParsedSupplierForm,
	context: { clientId: string; currency: string },
): z.input<typeof createSupplierSchema> {
	return {
		clientId: context.clientId,
		...supplierFields(values, context.currency),
	}
}

/** `PATCH /suppliers/:id` body: every field, so what is cleared is cleared. */
export function buildUpdateSupplierPayload(
	values: ParsedSupplierForm,
	supplier: Pick<Supplier, 'version' | 'currency'>,
): z.input<typeof updateSupplierSchema> {
	return {
		expectedVersion: supplier.version,
		...supplierFields(values, supplier.currency),
	}
}

// ── Supplier products (what they sell, in which pack, at what price) ────────

export type SupplierProductFormValues = {
	packName: string
	/** How much one pack holds, typed in `packSizeUnit`. */
	packSize: string
	packSizeUnit: UnitRef
	/** The price of one pack in major units. */
	price: string
	pricedByWeight: boolean
	preferred: boolean
}

export type SupplierProductProblem = 'packName' | 'packSize' | 'price' | 'item'

const PACK_NAME_MAX = 80

export function validateSupplierProduct(
	values: SupplierProductFormValues,
	context: {
		itemId: string | null
		baseUnit: InventoryBaseUnit | null
		currency: string
		/** An existing product keeps its pack size. */
		editing: boolean
	},
): SupplierProductProblem[] {
	const problems: SupplierProductProblem[] = []
	if (!context.editing && !context.itemId) problems.push('item')
	const name = values.packName.trim()
	if (name === '' || name.length > PACK_NAME_MAX || CONTROL_CHARS.test(name)) {
		problems.push('packName')
	}
	if (
		!context.editing &&
		packBaseQuantityOf(values, context.baseUnit) === null
	) {
		problems.push('packSize')
	}
	if (
		parseMoneyToMinor(values.price, { currency: context.currency, min: 0 }) ===
		null
	) {
		problems.push('price')
	}
	return problems
}

/** Base thousandths in one pack, from the size typed in its unit. */
export function packBaseQuantityOf(
	values: Pick<SupplierProductFormValues, 'packSize' | 'packSizeUnit'>,
	baseUnit: InventoryBaseUnit | null,
): number | null {
	if (baseUnit === null) return null
	const amount = parseQuantityText(values.packSize)
	if (amount === null || amount <= 0) return null
	const perUnit = thousandthsInUnit(values.packSizeUnit, baseUnit)
	if (perUnit === null) return null
	const quantity = Math.round(amount * perUnit)
	return quantity >= 1 && quantity <= MAX_ENTRY_QUANTITY ? quantity : null
}

/** `POST /suppliers/:id/products` body, or null while something is wrong. */
export function buildSupplierProductPayload(
	values: SupplierProductFormValues,
	context: {
		itemId: string
		baseUnit: InventoryBaseUnit
		currency: string
	},
): z.input<typeof supplierProductInputSchema> | null {
	const packBaseQuantity = packBaseQuantityOf(values, context.baseUnit)
	const priceMinor = parseMoneyToMinor(values.price, {
		currency: context.currency,
		min: 0,
	})
	if (packBaseQuantity === null || priceMinor === null) return null
	return {
		itemId: context.itemId,
		packName: values.packName.trim(),
		packBaseQuantity,
		priceMinor,
		pricedByWeight: values.pricedByWeight,
		preferred: values.preferred,
	}
}

/** `PATCH /supplier-products/:id` body (name, price and the two flags; the pack size stays). */
export function buildUpdateSupplierProductPayload(
	values: SupplierProductFormValues,
	product: Pick<SupplierProduct, 'version'>,
	currency: string,
): z.input<typeof updateSupplierProductSchema> | null {
	const priceMinor = parseMoneyToMinor(values.price, { currency, min: 0 })
	if (priceMinor === null) return null
	return {
		expectedVersion: product.version,
		packName: values.packName.trim(),
		priceMinor,
		pricedByWeight: values.pricedByWeight,
		preferred: values.preferred,
	}
}
