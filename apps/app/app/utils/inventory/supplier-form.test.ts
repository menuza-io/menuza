import {
	createSupplierSchema,
	supplierProductInputSchema,
	updateSupplierProductSchema,
	updateSupplierSchema,
} from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	buildCreateSupplierPayload,
	buildSupplierProductPayload,
	buildUpdateSupplierPayload,
	buildUpdateSupplierProductPayload,
	emptySupplierFormValues,
	packBaseQuantityOf,
	parseDeliveryDays,
	supplierFormSchema,
	type SupplierFormValues,
	supplierFormValues,
	type SupplierProductFormValues,
	toggleDeliveryDay,
	validateSupplierProduct,
} from './supplier-form.ts'

const MESSAGES = {
	nameRequired: 'name required',
	nameTooLong: 'name too long',
	textInvalid: 'text invalid',
	contactTooLong: 'contact too long',
	phoneTooLong: 'phone too long',
	emailInvalid: 'email invalid',
	daysInvalid: 'days invalid',
	cutoffTimeInvalid: 'cutoff time invalid',
	cutoffDaysInvalid: 'cutoff days invalid',
	cutoffNeedsBoth: 'cutoff needs both',
	minimumInvalid: 'minimum invalid',
	termsTooLong: 'terms too long',
	vatTooLong: 'vat too long',
	notesTooLong: 'notes too long',
}

const schema = supplierFormSchema(MESSAGES, { currency: 'SAR' })

function parse(overrides: Partial<SupplierFormValues> = {}) {
	return schema.safeParse({
		...emptySupplierFormValues(),
		name: 'Al Watania Poultry',
		...overrides,
	})
}

function issues(overrides: Partial<SupplierFormValues> = {}) {
	const result = parse(overrides)
	return result.success
		? {}
		: Object.fromEntries(
				result.error.issues.map((issue) => [issue.path[0], issue.message]),
			)
}

describe('supplier form validation', () => {
	it('only the name is required', () => {
		expect(parse().success).toBe(true)
		expect(issues({ name: '   ' })).toEqual({ name: 'name required' })
		expect(issues({ name: 'x'.repeat(81) })).toEqual({ name: 'name too long' })
		expect(issues({ name: 'Bad\u0007name' })).toEqual({ name: 'text invalid' })
	})

	it('checks the email only when there is one', () => {
		expect(parse({ email: '' }).success).toBe(true)
		expect(parse({ email: 'orders@watania.example' }).success).toBe(true)
		expect(issues({ email: 'orders@' })).toEqual({ email: 'email invalid' })
	})

	it('limits the free text fields', () => {
		expect(issues({ contactName: 'x'.repeat(81) })).toEqual({
			contactName: 'contact too long',
		})
		expect(issues({ phone: '1'.repeat(41) })).toEqual({
			phone: 'phone too long',
		})
		expect(issues({ paymentTerms: 'x'.repeat(81) })).toEqual({
			paymentTerms: 'terms too long',
		})
		expect(issues({ vatNumber: 'x'.repeat(41) })).toEqual({
			vatNumber: 'vat too long',
		})
		expect(issues({ notes: 'x'.repeat(501) })).toEqual({
			notes: 'notes too long',
		})
	})

	it('accepts only weekday numbers for delivery days', () => {
		expect(parse({ deliveryDays: '1,3,6' }).success).toBe(true)
		expect(issues({ deliveryDays: '1,7' })).toEqual({
			deliveryDays: 'days invalid',
		})
		expect(issues({ deliveryDays: 'mon' })).toEqual({
			deliveryDays: 'days invalid',
		})
	})

	it('needs both a cut-off time and its days, or neither', () => {
		expect(parse({ cutoffTime: '16:00', cutoffDaysBefore: '1' }).success).toBe(
			true,
		)
		expect(issues({ cutoffTime: '16:00' })).toEqual({
			cutoffDaysBefore: 'cutoff needs both',
		})
		expect(issues({ cutoffDaysBefore: '1' })).toEqual({
			cutoffTime: 'cutoff needs both',
		})
		expect(issues({ cutoffTime: '4pm', cutoffDaysBefore: '1' })).toEqual({
			cutoffTime: 'cutoff time invalid',
		})
		expect(issues({ cutoffTime: '16:00', cutoffDaysBefore: '15' })).toEqual({
			cutoffDaysBefore: 'cutoff days invalid',
		})
	})

	it('reads the minimum order as money', () => {
		expect(parse({ minimumOrder: '400' }).success).toBe(true)
		expect(parse({ minimumOrder: '٤٠٠٫٥٠' }).success).toBe(true)
		expect(issues({ minimumOrder: '4,50' })).toEqual({
			minimumOrder: 'minimum invalid',
		})
		expect(issues({ minimumOrder: '-1' })).toEqual({
			minimumOrder: 'minimum invalid',
		})
	})
})

describe('supplier payloads', () => {
	function parsed(overrides: Partial<SupplierFormValues> = {}) {
		const result = parse(overrides)
		if (!result.success) throw new Error('form should be valid')
		return result.data
	}

	it('builds a create body the region accepts, empty text as null', () => {
		const payload = buildCreateSupplierPayload(
			parsed({
				contactName: ' Omar ',
				phone: '+966 55 000 0000',
				orderChannel: 'whatsapp',
				deliveryDays: '4,1',
				cutoffTime: '16:00',
				cutoffDaysBefore: '1',
				minimumOrder: '400',
				paymentTerms: '30 days',
				vatNumber: '300000000000003',
			}),
			{ clientId: 'sup-12345678', currency: 'SAR' },
		)
		expect(payload).toMatchObject({
			clientId: 'sup-12345678',
			name: 'Al Watania Poultry',
			contactName: 'Omar',
			phone: '+966 55 000 0000',
			email: null,
			orderChannel: 'whatsapp',
			deliveryDays: [1, 4],
			cutoffTime: '16:00',
			cutoffDaysBefore: 1,
			minimumOrderMinor: 40_000,
			currency: 'SAR',
			paymentTerms: '30 days',
			vatNumber: '300000000000003',
			notes: null,
		})
		expect(createSupplierSchema.safeParse(payload).success).toBe(true)
	})

	it('an edit sends the version and every field, so cleared fields are cleared', () => {
		const payload = buildUpdateSupplierPayload(
			parsed({ contactName: '', minimumOrder: '' }),
			{ version: 7, currency: 'SAR' },
		)
		expect(payload).toMatchObject({
			expectedVersion: 7,
			contactName: null,
			minimumOrderMinor: null,
			cutoffTime: null,
			cutoffDaysBefore: null,
		})
		expect(updateSupplierSchema.safeParse(payload).success).toBe(true)
	})

	it('fills the form back from a supplier', () => {
		const values = supplierFormValues(
			{
				id: 's1',
				name: 'Fresh Farms',
				contactName: null,
				phone: '123',
				email: 'a@b.co',
				orderChannel: 'email',
				deliveryDays: [3, 1],
				cutoffTime: '09:30',
				cutoffDaysBefore: 0,
				currency: 'SAR',
				paymentTerms: null,
				vatNumber: null,
				notes: null,
				archived: false,
				version: 2,
				productCount: 0,
				unpaidCount: 0,
				minimumOrderMinor: 40_000,
			},
			'SAR',
		)
		expect(values).toMatchObject({
			name: 'Fresh Farms',
			contactName: '',
			deliveryDays: '1,3',
			cutoffTime: '09:30',
			cutoffDaysBefore: '0',
			minimumOrder: '400.00',
			orderChannel: 'email',
		})
		// A supplier read without the cost grant has no minimum order to show.
		expect(
			supplierFormValues(
				{
					deliveryDays: [],
					minimumOrderMinor: undefined,
					cutoffDaysBefore: null,
					orderChannel: 'phone',
					name: 'x',
				} as never,
				'SAR',
			).minimumOrder,
		).toBe('')
	})
})

describe('delivery days', () => {
	it('toggles weekdays in order', () => {
		expect(toggleDeliveryDay('', 3)).toBe('3')
		expect(toggleDeliveryDay('3', 1)).toBe('1,3')
		expect(toggleDeliveryDay('1,3', 3)).toBe('1')
		expect(parseDeliveryDays('4,1,1,9,x')).toEqual([1, 4])
		expect(parseDeliveryDays('')).toEqual([])
	})
})

describe('supplier products', () => {
	const values = (
		overrides: Partial<SupplierProductFormValues> = {},
	): SupplierProductFormValues => ({
		packName: 'Box',
		packSize: '10',
		packSizeUnit: 'kg',
		price: '280',
		pricedByWeight: true,
		preferred: false,
		...overrides,
	})
	const context = {
		itemId: 'itm_1',
		baseUnit: 'g' as const,
		currency: 'SAR',
		editing: false,
	}

	it('turns a typed pack into base thousandths and a price in minor units', () => {
		expect(packBaseQuantityOf(values(), 'g')).toBe(10_000_000)
		expect(packBaseQuantityOf(values({ packSize: '1½' }), 'g')).toBe(1_500_000)
		expect(packBaseQuantityOf(values({ packSize: '0' }), 'g')).toBeNull()
		expect(packBaseQuantityOf(values({ packSizeUnit: 'l' }), 'g')).toBeNull()
		expect(packBaseQuantityOf(values(), null)).toBeNull()
		const payload = buildSupplierProductPayload(values(), context)
		expect(payload).toEqual({
			itemId: 'itm_1',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
			pricedByWeight: true,
			preferred: false,
		})
		expect(supplierProductInputSchema.safeParse(payload).success).toBe(true)
	})

	it('names what is missing', () => {
		expect(validateSupplierProduct(values(), context)).toEqual([])
		expect(
			validateSupplierProduct(
				values({ packName: ' ', packSize: '', price: 'x' }),
				{ ...context, itemId: null },
			).sort(),
		).toEqual(['item', 'packName', 'packSize', 'price'])
	})

	it('an existing pack keeps its size, so only the name and price are checked', () => {
		expect(
			validateSupplierProduct(values({ packSize: '' }), {
				...context,
				itemId: null,
				baseUnit: null,
				editing: true,
			}),
		).toEqual([])
		const payload = buildUpdateSupplierProductPayload(
			values({ preferred: true }),
			{ version: 3 },
			'SAR',
		)
		expect(payload).toEqual({
			expectedVersion: 3,
			packName: 'Box',
			priceMinor: 28_000,
			pricedByWeight: true,
			preferred: true,
		})
		expect(updateSupplierProductSchema.safeParse(payload).success).toBe(true)
		expect(
			buildUpdateSupplierProductPayload(
				values({ price: '' }),
				{ version: 3 },
				'SAR',
			),
		).toBeNull()
	})
})
