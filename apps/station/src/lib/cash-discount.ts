import { t } from '@lingui/macro'
import {
	CASH_DISCOUNT_ADJUSTMENT_ID,
	cashDiscountCents,
	readCashDiscountBp,
} from '@repo/common/cash-discount'
import { lineTotalCents, type Adjustment, type CartLine } from './pricing.ts'
import { type MenuLocation } from './types.ts'

/**
 * The cash-payment discount at the till (#375). The location's rate comes with
 * its register settings (`stationSettings.cashDiscountBp`); the App sends it
 * only where the organization's data region allows one, so a till in another
 * region never sees a rate. It is applied when the cashier takes the whole bill
 * in cash, in one payment, and it is its own adjustment line: a percentage of
 * what the bill costs after its other discounts. The region checks it again on
 * upload and flags a sale where it does not hold.
 */

/** The rate to offer at this location, in basis points, or null when there is none. */
export function cashDiscountRate(
	location: Pick<MenuLocation, 'stationSettings'> | null | undefined,
): number | null {
	return readCashDiscountBp(location?.stationSettings?.cashDiscountBp)
}

/** "3%" or "3.5%": the rate as the receipt line says it. */
export function cashDiscountPercentText(percentBp: number): string {
	const percent = percentBp / 100
	return Number.isInteger(percent) ? `${percent}%` : `${percent.toFixed(2)}%`
}

/**
 * The adjustment to add for paying `lines` entirely in cash, or null when it
 * would take nothing off. `others` are the adjustments already on the bill.
 * The label is written in the till's language now, like a manual discount's.
 */
export function cashDiscountAdjustment(input: {
	lines: readonly CartLine[]
	others: readonly Adjustment[]
	percentBp: number | null | undefined
}): Adjustment | null {
	const percentBp = readCashDiscountBp(input.percentBp)
	if (percentBp === null) return null
	const subtotalCents = input.lines.reduce(
		(sum, line) => sum + lineTotalCents(line),
		0,
	)
	const amountCents = cashDiscountCents({
		subtotalCents,
		otherAdjustmentCents: input.others
			.filter((row) => row.kind !== 'cash_discount')
			.reduce((sum, row) => sum + row.amountCents, 0),
		percentBp,
	})
	if (amountCents < 1) return null
	const rate = cashDiscountPercentText(percentBp)
	return {
		id: CASH_DISCOUNT_ADJUSTMENT_ID,
		kind: 'cash_discount',
		label: t`Cash discount (${rate})`,
		amountCents,
	}
}

/** The adjustments without a cash discount: what a bill carries before any payment. */
export const withoutCashDiscount = (
	adjustments: readonly Adjustment[],
): Adjustment[] => adjustments.filter((row) => row.kind !== 'cash_discount')
