import { type AvailabilityStatus } from '@repo/common/menu-types'

export const BULK_EDIT_MAX_ROWS = 500

export type BulkTargetType = 'item' | 'option'

export type PriceChangeMode =
	| { kind: 'percent'; value: number }
	| { kind: 'amount'; value: number }
	| { kind: 'set'; value: number }

export type PriceEnding = '00' | '50' | '95' | '99'
export type PriceEndingDirection = 'up' | 'down' | 'nearest'

export type BulkItemOperation =
	| { type: 'price'; change: PriceChangeMode; ending?: { to: PriceEnding; direction: PriceEndingDirection } }
	| { type: 'availability'; status: AvailabilityStatus; unavailableUntil?: Date | null }
	| { type: 'apply_sales_tax'; enabled: boolean }
	| { type: 'dietary'; flag: 'vegetarian' | 'gluten_free' | 'alcohol'; enabled: boolean }
	| { type: 'popular'; enabled: boolean }
	| { type: 'upsell'; enabled: boolean }
	| { type: 'add_category'; categoryId: string }
	| { type: 'remove_category'; categoryId: string }
	| { type: 'add_modifier_group'; modifierGroupId: string }
	| { type: 'remove_modifier_group'; modifierGroupId: string }

export type BulkOptionOperation =
	| { type: 'price'; change: PriceChangeMode; ending?: { to: PriceEnding; direction: PriceEndingDirection } }
	| { type: 'availability'; status: AvailabilityStatus; unavailableUntil?: Date | null }
	| { type: 'dietary'; flag: 'vegetarian' | 'gluten_free' | 'alcohol'; enabled: boolean }

export type BulkItemRowInput = {
	id: string
	updatedAt: Date
	displayName: string
	price: number
	availabilityStatus: AvailabilityStatus
	unavailableUntil: Date | null
	applySalesTax: boolean
	isVegetarian: boolean
	isGlutenFree: boolean
	isAlcohol: boolean
	isPopular: boolean
	isUpsell: boolean
	categoryIds: string[]
	modifierGroupIds: string[]
}

export type BulkOptionRowInput = {
	id: string
	updatedAt: Date
	displayName: string
	price: number
	availabilityStatus: AvailabilityStatus
	unavailableUntil: Date | null
	isVegetarian: boolean
	isGlutenFree: boolean
	isAlcohol: boolean
}

export type BulkPlanRow<TBefore, TAfter> = {
	id: string
	before: TBefore
	after: TAfter
	skipped?: string
}

export function currencyMinorFactor(exponent: number) {
	return 10 ** exponent
}

export function roundMoney(value: number, exponent: number) {
	const factor = currencyMinorFactor(exponent)
	return Math.round(value * factor) / factor
}

function applyPriceChange(
	price: number,
	change: PriceChangeMode,
	exponent: number,
	ending?: { to: PriceEnding; direction: PriceEndingDirection },
): { price: number; error?: string } {
	let next = price
	if (change.kind === 'percent') {
		next = price * (1 + change.value / 100)
	} else if (change.kind === 'amount') {
		next = price + change.value
	} else {
		next = change.value
	}
	next = roundMoney(next, exponent)
	if (next < 0) return { price: next, error: 'price_below_zero' }

	if (ending && exponent === 2) {
		const suffix = Number.parseInt(ending.to, 10) / 100
		const whole = Math.floor(next)
		const frac = next - whole
		const targets = [
			whole + suffix,
			whole - 1 + suffix,
			whole + 1 + suffix,
		]
		const candidates = targets.filter((c) => c >= 0)
		if (candidates.length === 0) return { price: 0 }
		if (ending.direction === 'up') {
			const up = candidates.find((c) => c >= next) ?? candidates.at(-1)!
			next = roundMoney(up, exponent)
		} else if (ending.direction === 'down') {
			const down = [...candidates].reverse().find((c) => c <= next) ?? candidates[0]!
			next = roundMoney(down, exponent)
		} else {
			next = roundMoney(
				candidates.reduce((best, c) =>
					Math.abs(c - next) < Math.abs(best - next) ? c : best,
				),
				exponent,
			)
		}
	} else if (exponent === 0) {
		next = Math.round(next)
		if (next < 0) return { price: next, error: 'price_below_zero' }
	}

	if (next < 0) return { price: next, error: 'price_below_zero' }
	return { price: next }
}

function planItemOperation(
	row: BulkItemRowInput,
	operation: BulkItemOperation,
	currencyExponent: number,
): BulkPlanRow<BulkItemRowInput, BulkItemRowInput> {
	const after = { ...row, categoryIds: [...row.categoryIds], modifierGroupIds: [...row.modifierGroupIds] }

	if (operation.type === 'price') {
		const { price, error } = applyPriceChange(
			row.price,
			operation.change,
			currencyExponent,
			operation.ending,
		)
		if (error) return { id: row.id, before: row, after: row, skipped: error }
		after.price = price
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'availability') {
		after.availabilityStatus = operation.status
		after.unavailableUntil = operation.unavailableUntil ?? null
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'apply_sales_tax') {
		after.applySalesTax = operation.enabled
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'dietary') {
		if (operation.flag === 'vegetarian') after.isVegetarian = operation.enabled
		if (operation.flag === 'gluten_free') after.isGlutenFree = operation.enabled
		if (operation.flag === 'alcohol') after.isAlcohol = operation.enabled
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'popular') {
		after.isPopular = operation.enabled
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'upsell') {
		after.isUpsell = operation.enabled
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'add_category') {
		if (!after.categoryIds.includes(operation.categoryId)) {
			after.categoryIds.push(operation.categoryId)
		}
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'remove_category') {
		after.categoryIds = after.categoryIds.filter((id) => id !== operation.categoryId)
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'add_modifier_group') {
		if (!after.modifierGroupIds.includes(operation.modifierGroupId)) {
			after.modifierGroupIds.push(operation.modifierGroupId)
		}
		return { id: row.id, before: row, after }
	}

	after.modifierGroupIds = after.modifierGroupIds.filter(
		(id) => id !== operation.modifierGroupId,
	)
	return { id: row.id, before: row, after }
}

function planOptionOperation(
	row: BulkOptionRowInput,
	operation: BulkOptionOperation,
	currencyExponent: number,
): BulkPlanRow<BulkOptionRowInput, BulkOptionRowInput> {
	const after = { ...row }

	if (operation.type === 'price') {
		const { price, error } = applyPriceChange(
			row.price,
			operation.change,
			currencyExponent,
			operation.ending,
		)
		if (error) return { id: row.id, before: row, after: row, skipped: error }
		after.price = price
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'availability') {
		after.availabilityStatus = operation.status
		after.unavailableUntil = operation.unavailableUntil ?? null
		return { id: row.id, before: row, after }
	}

	if (operation.type === 'dietary') {
		if (operation.flag === 'vegetarian') after.isVegetarian = operation.enabled
		if (operation.flag === 'gluten_free') after.isGlutenFree = operation.enabled
		if (operation.flag === 'alcohol') after.isAlcohol = operation.enabled
		return { id: row.id, before: row, after }
	}

	return { id: row.id, before: row, after }
}

export function planBulkEditItem({
	rows,
	operation,
	currencyExponent,
}: {
	rows: BulkItemRowInput[]
	operation: BulkItemOperation
	currencyExponent: number
}) {
	if (rows.length > BULK_EDIT_MAX_ROWS) {
		throw new Error('too_many_rows')
	}
	return rows.map((row) => planItemOperation(row, operation, currencyExponent))
}

export function planBulkEditOption({
	rows,
	operation,
	currencyExponent,
}: {
	rows: BulkOptionRowInput[]
	operation: BulkOptionOperation
	currencyExponent: number
}) {
	if (rows.length > BULK_EDIT_MAX_ROWS) {
		throw new Error('too_many_rows')
	}
	return rows.map((row) => planOptionOperation(row, operation, currencyExponent))
}
