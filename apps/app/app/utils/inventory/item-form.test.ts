import { createItemSchema, type ItemDetail } from '@repo/inventory'
import { describe, expect, it } from 'vitest'
import {
	buildCreateItemPayload,
	buildUpdatePayloads,
	countUnitChoices,
	CUSTOM_CATEGORY_KEY,
	defaultMeasureUnit,
	emptyItemFormValues,
	itemFormSchema,
	itemFormValuesFromDetail,
	type ParsedItemForm,
	storedCategory,
} from './item-form.ts'

const MESSAGES = {
	nameRequired: 'name required',
	nameTooLong: 'name too long',
	nameInvalid: 'name invalid',
	categoryRequired: 'category required',
	customCategoryRequired: 'custom category required',
	customCategoryTooLong: 'custom category too long',
	packNameRequired: 'pack name required',
	packNameTooLong: 'pack name too long',
	packSizeInvalid: 'pack size invalid',
	supplierRequired: 'supplier required',
	priceInvalid: 'price invalid',
	levelInvalid: 'level invalid',
	fillBelowOrder: 'fill below order',
}

const schema = itemFormSchema(MESSAGES, { currency: 'SAR', mode: 'create' })

const VALID: ParsedItemForm = {
	name: 'Chicken thighs',
	categoryKey: 'meat',
	customCategory: '',
	measuredIn: 'weight',
	packName: '',
	packSize: '',
	packSizeUnit: 'kg',
	supplierId: '',
	price: '',
	pricedByWeight: false,
	countUnit: 'kg',
	areaIds: '',
	orderBelow: '',
	fillUpTo: '',
}

function messagesFor(input: Partial<ParsedItemForm>) {
	const result = schema.safeParse({ ...VALID, ...input })
	return result.success
		? []
		: result.error.issues.map(
				(issue) => `${issue.path.join('.')}: ${issue.message}`,
			)
}

const CONTEXT = {
	clientId: 'i-12345678',
	locationId: 'main',
	currency: 'SAR',
	system: 'metric' as const,
	canManagePurchasing: true,
}

describe('item form validation', () => {
	it('needs only a name and a category', () => {
		expect(messagesFor({})).toEqual([])
		expect(messagesFor({ name: '   ' })).toEqual(['name: name required'])
		expect(messagesFor({ categoryKey: '' })).toEqual([
			'categoryKey: category required',
		])
	})

	it('refuses a long or control-character name', () => {
		expect(messagesFor({ name: 'x'.repeat(81) })).toEqual([
			'name: name too long',
		])
		expect(messagesFor({ name: 'bad\u0007name' })).toEqual([
			'name: name invalid',
		])
	})

	it('asks for the category text when the owner types their own', () => {
		expect(messagesFor({ categoryKey: CUSTOM_CATEGORY_KEY })).toEqual([
			'customCategory: custom category required',
		])
		expect(
			messagesFor({
				categoryKey: CUSTOM_CATEGORY_KEY,
				customCategory: 'Spices',
			}),
		).toEqual([])
	})

	it('needs both a pack name and a size, or neither', () => {
		expect(messagesFor({ packName: 'Box' })).toEqual([
			'packSize: pack size invalid',
		])
		expect(messagesFor({ packSize: '10' })).toEqual([
			'packName: pack name required',
		])
		expect(messagesFor({ packName: 'Box', packSize: '10' })).toEqual([])
		expect(messagesFor({ packName: 'Box', packSize: '0' })).toEqual([
			'packSize: pack size invalid',
		])
	})

	it('needs a supplier with a price, and a price with a supplier', () => {
		const pack = { packName: 'Box', packSize: '10' }
		expect(messagesFor({ ...pack, supplierId: 's1' })).toEqual([
			'price: price invalid',
		])
		expect(messagesFor({ ...pack, supplierId: 's1', price: '280' })).toEqual([])
		expect(messagesFor({ ...pack, supplierId: 's1', price: '28.555' })).toEqual(
			['price: price invalid'],
		)
		expect(messagesFor({ ...pack, price: '280' })).toEqual([
			'supplierId: supplier required',
		])
	})

	it('checks the levels', () => {
		expect(messagesFor({ orderBelow: '8', fillUpTo: '30' })).toEqual([])
		expect(messagesFor({ orderBelow: 'lots' })).toEqual([
			'orderBelow: level invalid',
		])
		expect(messagesFor({ orderBelow: '30', fillUpTo: '8' })).toEqual([
			'fillUpTo: fill below order',
		])
	})

	it('skips pack and price checks when editing', () => {
		const edit = itemFormSchema(MESSAGES, { currency: 'SAR', mode: 'edit' })
		expect(edit.safeParse({ ...VALID, packName: 'Box' }).success).toBe(true)
	})
})

describe('item form payloads', () => {
	it('builds a minimal valid create payload', () => {
		const payload = buildCreateItemPayload(VALID, CONTEXT)
		expect(createItemSchema.safeParse(payload).success).toBe(true)
		expect(payload).toMatchObject({
			name: 'Chicken thighs',
			category: 'meat',
			kind: 'bought',
			baseUnit: 'g',
			place: {
				locationId: 'main',
				countUnit: 'kg',
				areaIds: [],
				orderBelowQuantity: null,
				fillUpToQuantity: null,
			},
		})
		expect(payload.units).toBeUndefined()
		expect(payload.supplierProduct).toBeUndefined()
	})

	it('turns a pack into a named unit, a count unit and a supplier product', () => {
		const payload = buildCreateItemPayload(
			{
				...VALID,
				packName: 'Box',
				packSize: '10',
				supplierId: 's1',
				price: '280',
				pricedByWeight: true,
				countUnit: 'pack',
				areaIds: 'a1,a2',
				orderBelow: '2',
				fillUpTo: '6',
			},
			CONTEXT,
		)
		expect(createItemSchema.safeParse(payload).success).toBe(true)
		expect(payload.units).toEqual([{ name: 'Box', baseQuantity: 10_000_000 }])
		expect(payload.place).toMatchObject({
			countUnit: 'new:0',
			areaIds: ['a1', 'a2'],
			// two boxes of 10 kg, six boxes of 10 kg
			orderBelowQuantity: 20_000_000,
			fillUpToQuantity: 60_000_000,
		})
		expect(payload.supplierProduct).toEqual({
			supplierId: 's1',
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
			currency: 'SAR',
			pricedByWeight: true,
		})
	})

	it('leaves the supplier product out without the purchasing grant', () => {
		const payload = buildCreateItemPayload(
			{
				...VALID,
				packName: 'Box',
				packSize: '10',
				supplierId: 's1',
				price: '280',
			},
			{ ...CONTEXT, canManagePurchasing: false },
		)
		expect(payload.supplierProduct).toBeUndefined()
		expect(payload.units).toHaveLength(1)
	})

	it('counts by a unit of the base, falling back when the choice does not fit', () => {
		const volume = buildCreateItemPayload(
			{ ...VALID, measuredIn: 'volume', countUnit: 'kg', packSizeUnit: 'l' },
			CONTEXT,
		)
		expect(volume.baseUnit).toBe('ml')
		expect(volume.place?.countUnit).toBe('l')
		const byPackWithoutPack = buildCreateItemPayload(
			{ ...VALID, countUnit: 'pack' },
			CONTEXT,
		)
		expect(byPackWithoutPack.place?.countUnit).toBe('kg')
	})

	it('stores a typed category as custom text', () => {
		expect(storedCategory({ categoryKey: 'meat', customCategory: '' })).toBe(
			'meat',
		)
		expect(
			storedCategory({
				categoryKey: CUSTOM_CATEGORY_KEY,
				customCategory: ' Spices ',
			}),
		).toBe('custom:Spices')
	})

	it('starts empty in the default unit of the system', () => {
		expect(emptyItemFormValues('metric').countUnit).toBe('kg')
		expect(emptyItemFormValues('us').countUnit).toBe('lb')
		expect(defaultMeasureUnit('count', 'us')).toBe('piece')
	})
})

const DETAIL = {
	id: 'itm_1',
	name: 'Chicken thighs',
	category: 'custom:Spices',
	kind: 'bought',
	baseUnit: 'g',
	archived: false,
	version: 3,
	onHand: 6_000_000,
	countUnit: 'unit:box',
	units: [
		{
			id: 'box',
			name: 'Box',
			baseQuantity: 10_000_000,
			used: true,
			archived: false,
		},
	],
	areaIds: ['a1'],
	orderBelowQuantity: 20_000_000,
	fillUpToQuantity: 60_000_000,
	status: 'ok',
	lastCountedAt: null,
	notes: null,
	places: [
		{
			locationId: 'main',
			countUnit: 'unit:box',
			areaIds: ['a1'],
			orderBelowQuantity: 20_000_000,
			fillUpToQuantity: 60_000_000,
			version: 5,
		},
	],
	onHandByLocation: [{ locationId: 'main', onHand: 6_000_000 }],
	suppliers: [],
	hasMovements: true,
} as unknown as ItemDetail

describe('editing an item', () => {
	it('fills the form from the item, levels in the count unit', () => {
		const values = itemFormValuesFromDetail(DETAIL, 'main', 'metric')
		expect(values).toMatchObject({
			name: 'Chicken thighs',
			categoryKey: CUSTOM_CATEGORY_KEY,
			customCategory: 'Spices',
			measuredIn: 'weight',
			countUnit: 'unit:box',
			areaIds: ['a1'],
			orderBelow: '2',
			fillUpTo: '6',
		})
	})

	it('offers the standard units and the item packs for counting', () => {
		expect(countUnitChoices('g', DETAIL.units, 'metric')).toEqual([
			'g',
			'kg',
			'unit:box',
		])
	})

	it('builds the item and place updates with their versions', () => {
		const values = itemFormValuesFromDetail(DETAIL, 'main', 'metric')
		const payloads = buildUpdatePayloads(
			{
				...values,
				areaIds: values.areaIds.join(','),
				name: 'Chicken breast',
				measuredIn: 'volume',
			},
			DETAIL,
			{ version: 5 },
			'metric',
		)
		expect(payloads.item).toEqual({
			expectedVersion: 3,
			name: 'Chicken breast',
			category: 'custom:Spices',
		})
		// The base unit cannot change once stock has moved.
		expect(payloads.item).not.toHaveProperty('baseUnit')
		expect(payloads.place).toMatchObject({
			expectedVersion: 5,
			countUnit: 'unit:box',
			areaIds: ['a1'],
			orderBelowQuantity: 20_000_000,
			fillUpToQuantity: 60_000_000,
		})
	})
})
