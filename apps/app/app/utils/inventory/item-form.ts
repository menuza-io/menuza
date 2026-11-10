import {
	type CreateItem,
	type InventoryBaseUnit,
	type ItemDetail,
	MAX_ENTRY_QUANTITY,
	STANDARD_UNIT_SPECS,
	standardUnitsFor,
	type UnitRef,
	type UnitSystem,
} from '@repo/inventory'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { z } from 'zod'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'
import {
	defaultEntryUnit,
	type ItemUnitLike,
	thousandthsInUnit,
} from './format.ts'
import {
	CUSTOM_CATEGORY_PREFIX,
	customCategory,
	isBuiltInCategory,
} from './labels.ts'

/**
 * The Add / Edit item form as pure functions: the Zod schema the form
 * validates with, and the builders that turn what was typed into the wire
 * payloads. Quantities are typed in a unit and sent as the region expects
 * (typed unit refs, base thousandths where the contract wants them).
 */

export const CUSTOM_CATEGORY_KEY = '__custom__'
export const PACK_COUNT_UNIT = 'pack'

/** What an item is measured in: the choice behind its base unit. */
export const MEASURED_IN = ['weight', 'volume', 'count'] as const
export type MeasuredIn = (typeof MEASURED_IN)[number]

const BASE_BY_MEASURED_IN: Record<MeasuredIn, InventoryBaseUnit> = {
	weight: 'g',
	volume: 'ml',
	count: 'piece',
}

export function baseUnitFor(measuredIn: MeasuredIn): InventoryBaseUnit {
	return BASE_BY_MEASURED_IN[measuredIn]
}

export function measuredInFor(baseUnit: InventoryBaseUnit): MeasuredIn {
	return baseUnit === 'g' ? 'weight' : baseUnit === 'ml' ? 'volume' : 'count'
}

/** The unit an item of this kind is shown and counted in until told otherwise. */
export function defaultMeasureUnit(
	measuredIn: MeasuredIn,
	system: UnitSystem,
): UnitRef {
	return defaultEntryUnit(baseUnitFor(measuredIn), null, [], system)
}

export type ItemFormValues = {
	name: string
	categoryKey: string
	customCategory: string
	measuredIn: MeasuredIn
	packName: string
	packSize: string
	packSizeUnit: string
	supplierId: string
	price: string
	pricedByWeight: boolean
	/** `pack`, a standard unit key, or `unit:<id>` for an existing named unit. */
	countUnit: string
	areaIds: string[]
	orderBelow: string
	fillUpTo: string
}

export function emptyItemFormValues(system: UnitSystem): ItemFormValues {
	const measuredIn: MeasuredIn = 'weight'
	const unit = defaultMeasureUnit(measuredIn, system)
	return {
		name: '',
		categoryKey: '',
		customCategory: '',
		measuredIn,
		packName: '',
		packSize: '',
		packSizeUnit: unit,
		supplierId: '',
		price: '',
		pricedByWeight: false,
		countUnit: unit,
		areaIds: [],
		orderBelow: '',
		fillUpTo: '',
	}
}

/** The form's category choice as the stored value. */
export function storedCategory(values: {
	categoryKey: string
	customCategory: string
}): string {
	return values.categoryKey === CUSTOM_CATEGORY_KEY
		? customCategory(values.customCategory)
		: values.categoryKey
}

export type ItemFormMessages = {
	nameRequired: string
	nameTooLong: string
	nameInvalid: string
	categoryRequired: string
	customCategoryRequired: string
	customCategoryTooLong: string
	packNameRequired: string
	packNameTooLong: string
	packSizeInvalid: string
	supplierRequired: string
	priceInvalid: string
	levelInvalid: string
	fillBelowOrder: string
}

const CONTROL_CHARS = /\p{Cc}/u

export type ItemFormOptions = {
	currency: string
	/** The unit the pack size is typed in decides how big it is. */
	mode: 'create' | 'edit'
}

function packBaseQuantity(
	size: string,
	unit: string,
	measuredIn: MeasuredIn,
): number | null {
	const amount = parseQuantityText(size)
	if (amount === null || amount <= 0) return null
	const base = baseUnitFor(measuredIn)
	const perUnit = thousandthsInUnit(unit, base)
	if (perUnit === null) return null
	const quantity = Math.round(amount * perUnit)
	return quantity >= 1 && quantity <= MAX_ENTRY_QUANTITY ? quantity : null
}

/** The schema the form validates with (client side; the region validates again). */
export function itemFormSchema(
	messages: ItemFormMessages,
	{ currency, mode }: ItemFormOptions,
) {
	return z
		.object({
			name: z
				.string()
				.trim()
				.min(1, messages.nameRequired)
				.max(80, messages.nameTooLong)
				.refine((value) => !CONTROL_CHARS.test(value), messages.nameInvalid)
				.prefault(''),
			categoryKey: z.string().min(1, messages.categoryRequired).prefault(''),
			customCategory: z
				.string()
				.trim()
				.max(40, messages.customCategoryTooLong)
				.prefault(''),
			measuredIn: z.enum(MEASURED_IN),
			packName: z
				.string()
				.trim()
				.max(40, messages.packNameTooLong)
				.prefault(''),
			packSize: z.string().trim().prefault(''),
			packSizeUnit: z.string().prefault(''),
			supplierId: z.string().prefault(''),
			price: z.string().trim().prefault(''),
			pricedByWeight: z.boolean().prefault(false),
			countUnit: z.string().min(1).prefault(''),
			areaIds: z.string().prefault(''),
			orderBelow: z.string().trim().prefault(''),
			fillUpTo: z.string().trim().prefault(''),
		})
		.superRefine((value, ctx) => {
			const issue = (path: string, message: string) =>
				ctx.addIssue({ code: 'custom', path: [path], message })

			if (
				value.categoryKey === CUSTOM_CATEGORY_KEY &&
				value.customCategory === ''
			) {
				issue('customCategory', messages.customCategoryRequired)
			}

			if (mode === 'create') {
				const hasPack = value.packName !== '' || value.packSize !== ''
				if (hasPack) {
					if (value.packName === '')
						issue('packName', messages.packNameRequired)
					if (
						packBaseQuantity(
							value.packSize,
							value.packSizeUnit,
							value.measuredIn,
						) === null
					) {
						issue('packSize', messages.packSizeInvalid)
					}
				}
				if (value.supplierId !== '' && !hasPack) {
					issue('packName', messages.packNameRequired)
				}
				if (value.supplierId !== '') {
					if (parseMoneyToMinor(value.price, { currency, min: 0 }) === null) {
						issue('price', messages.priceInvalid)
					}
				} else if (value.price !== '') {
					issue('supplierId', messages.supplierRequired)
				}
			}

			const below =
				value.orderBelow === '' ? null : parseQuantityText(value.orderBelow)
			const fill =
				value.fillUpTo === '' ? null : parseQuantityText(value.fillUpTo)
			if (value.orderBelow !== '' && below === null) {
				issue('orderBelow', messages.levelInvalid)
			}
			if (value.fillUpTo !== '' && fill === null) {
				issue('fillUpTo', messages.levelInvalid)
			}
			if (below !== null && fill !== null && fill < below) {
				issue('fillUpTo', messages.fillBelowOrder)
			}
		})
}

export type ParsedItemForm = {
	name: string
	categoryKey: string
	customCategory: string
	measuredIn: MeasuredIn
	packName: string
	packSize: string
	packSizeUnit: string
	supplierId: string
	price: string
	pricedByWeight: boolean
	countUnit: string
	areaIds: string
	orderBelow: string
	fillUpTo: string
}

export function splitAreaIds(joined: string): string[] {
	return joined === '' ? [] : joined.split(',').filter(Boolean)
}

/** A typed level (in the count unit) as base thousandths, or null when empty. */
export function levelQuantity(
	text: string,
	unit: UnitRef,
	baseUnit: InventoryBaseUnit,
	units: readonly ItemUnitLike[],
): number | null {
	if (text === '') return null
	const amount = parseQuantityText(text)
	const perUnit = thousandthsInUnit(unit, baseUnit, units)
	if (amount === null || perUnit === null) return null
	return Math.min(MAX_ENTRY_QUANTITY, Math.round(amount * perUnit))
}

/** `POST /items` body from a validated form. */
export function buildCreateItemPayload(
	values: ParsedItemForm,
	context: {
		clientId: string
		locationId: string
		currency: string
		system: UnitSystem
		/** Whether the member may attach a supplier and price. */
		canManagePurchasing: boolean
	},
): CreateItem {
	const baseUnit = baseUnitFor(values.measuredIn)
	const hasPack = values.packName !== '' && values.packSize !== ''
	const packQuantity = hasPack
		? packBaseQuantity(values.packSize, values.packSizeUnit, values.measuredIn)
		: null
	const units =
		hasPack && packQuantity !== null
			? [{ name: values.packName, baseQuantity: packQuantity }]
			: undefined

	// Counted by the pack unit it was just defined with, or a unit of the base.
	const countsByPack =
		values.countUnit === PACK_COUNT_UNIT && units !== undefined
	const measureUnit: UnitRef =
		values.countUnit !== PACK_COUNT_UNIT &&
		thousandthsInUnit(values.countUnit, baseUnit) !== null
			? values.countUnit
			: defaultMeasureUnit(values.measuredIn, context.system)
	const placeCountUnit = countsByPack ? 'new:0' : measureUnit

	const perUnit = countsByPack
		? packQuantity
		: thousandthsInUnit(measureUnit, baseUnit)
	const levelUnitQuantity = (text: string): number | null => {
		if (text === '' || perUnit === null) return null
		const amount = parseQuantityText(text)
		return amount === null
			? null
			: Math.min(MAX_ENTRY_QUANTITY, Math.round(amount * perUnit))
	}

	const priceMinor =
		values.supplierId !== ''
			? parseMoneyToMinor(values.price, {
					currency: context.currency,
					min: 0,
				})
			: null

	return {
		clientId: context.clientId,
		name: values.name,
		category: storedCategory(values),
		kind: 'bought',
		baseUnit,
		...(units ? { units } : {}),
		place: {
			locationId: context.locationId,
			countUnit: placeCountUnit,
			areaIds: splitAreaIds(values.areaIds),
			orderBelowQuantity: levelUnitQuantity(values.orderBelow),
			fillUpToQuantity: levelUnitQuantity(values.fillUpTo),
		},
		...(context.canManagePurchasing &&
		units &&
		packQuantity !== null &&
		values.supplierId !== '' &&
		priceMinor !== null
			? {
					supplierProduct: {
						supplierId: values.supplierId,
						packName: values.packName,
						packBaseQuantity: packQuantity,
						priceMinor,
						currency: context.currency,
						pricedByWeight: values.pricedByWeight,
					},
				}
			: {}),
	}
}

/** The two calls an edit makes: the item itself and where it is kept. */
export function buildUpdatePayloads(
	values: ParsedItemForm,
	item: Pick<ItemDetail, 'version' | 'baseUnit' | 'units' | 'hasMovements'>,
	place: { version: number } | null,
	system: UnitSystem,
): {
	item: Record<string, unknown>
	place: Record<string, unknown> | null
} {
	const baseUnit = item.hasMovements
		? item.baseUnit
		: baseUnitFor(values.measuredIn)
	const countUnit =
		thousandthsInUnit(values.countUnit, baseUnit, item.units) !== null
			? values.countUnit
			: defaultMeasureUnit(measuredInFor(baseUnit), system)
	return {
		item: {
			expectedVersion: item.version,
			name: values.name,
			category: storedCategory(values),
			...(baseUnit !== item.baseUnit ? { baseUnit } : {}),
		},
		place: place
			? {
					expectedVersion: place.version,
					countUnit,
					areaIds: splitAreaIds(values.areaIds),
					orderBelowQuantity: levelQuantity(
						values.orderBelow,
						countUnit,
						baseUnit,
						item.units,
					),
					fillUpToQuantity: levelQuantity(
						values.fillUpTo,
						countUnit,
						baseUnit,
						item.units,
					),
				}
			: null,
	}
}

export function levelText(
	quantity: number | null,
	unit: UnitRef,
	baseUnit: InventoryBaseUnit,
	units: readonly ItemUnitLike[],
): string {
	if (quantity === null) return ''
	const perUnit = thousandthsInUnit(unit, baseUnit, units)
	if (perUnit === null) return ''
	return String(Math.round((quantity / perUnit) * 1000) / 1000)
}

/** The form's starting values for an existing item at a location. */
export function itemFormValuesFromDetail(
	item: ItemDetail,
	locationId: string,
	system: UnitSystem,
): ItemFormValues {
	const place = item.places.find(
		(candidate) => candidate.locationId === locationId,
	)
	const countUnit =
		place?.countUnit ??
		item.countUnit ??
		defaultMeasureUnit(measuredInFor(item.baseUnit), system)
	const builtIn = isBuiltInCategory(item.category)
	return {
		name: item.name,
		categoryKey: builtIn ? item.category : CUSTOM_CATEGORY_KEY,
		customCategory: builtIn
			? ''
			: item.category.startsWith(CUSTOM_CATEGORY_PREFIX)
				? item.category.slice(CUSTOM_CATEGORY_PREFIX.length)
				: item.category,
		measuredIn: measuredInFor(item.baseUnit),
		packName: '',
		packSize: '',
		packSizeUnit: defaultMeasureUnit(measuredInFor(item.baseUnit), system),
		supplierId: '',
		price: '',
		pricedByWeight: false,
		countUnit,
		areaIds: place?.areaIds ?? item.areaIds,
		orderBelow: levelText(
			place?.orderBelowQuantity ?? item.orderBelowQuantity,
			countUnit,
			item.baseUnit,
			item.units,
		),
		fillUpTo: levelText(
			place?.fillUpToQuantity ?? item.fillUpToQuantity,
			countUnit,
			item.baseUnit,
			item.units,
		),
	}
}

/** The units an item can be counted in: standard units of its base, then its own packs. */
export function countUnitChoices(
	baseUnit: InventoryBaseUnit,
	units: readonly ItemUnitLike[],
	system: UnitSystem,
): UnitRef[] {
	return [
		...standardUnitsFor(baseUnit, system).filter(
			(unit) => STANDARD_UNIT_SPECS[unit].base === baseUnit,
		),
		...units.filter((unit) => !unit.archived).map((unit) => `unit:${unit.id}`),
	]
}
