import { type AccountingDayFacts } from '@repo/reports'
import { localParts } from '@repo/staffing'
import { z } from 'zod'

/**
 * Provider lines of the accounting export (#189), pure: client and server both
 * merge them with a location's day. The payout and its fees come from the payout
 * report's own data (#168).
 */

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export type ProviderPayout = {
	arrivalDate: string
	currency: string
	amountCents: number
	status: string
	/** Processing and platform fees deducted from this payout. */
	feeCents: number
}

export const PROVIDER_LOCATION_ID = 'provider'

/** `YYYY-MM-DD` of an instant in a zone. */
function dateIn(iso: string, timeZone: string): string {
	const p = localParts(Date.parse(iso), timeZone)
	return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * The provider's own day: payouts that arrive on a date (in the reporting
 * zone) and the fees taken from them. Failed and cancelled payouts moved no
 * money. These are the payout report's figures, summed per day and currency.
 */
export function providerDayFacts(input: {
	payouts: readonly ProviderPayout[]
	from: string
	to: string
	timeZone: string
	today: string
}): AccountingDayFacts[] {
	const by = new Map<string, AccountingDayFacts>()
	for (const payout of input.payouts) {
		if (payout.status === 'failed' || payout.status === 'canceled') continue
		const date = dateIn(payout.arrivalDate, input.timeZone)
		if (date < input.from || date > input.to) continue
		const currency = payout.currency.toUpperCase()
		const key = `${date}|${currency}`
		const day =
			by.get(key) ??
			({
				locationId: PROVIDER_LOCATION_ID,
				locationName: 'Payment provider',
				businessDate: date,
				currency,
				closed: date < input.today,
				categories: [],
				grossMinor: 0,
				serviceFeesMinor: 0,
				discountsMinor: 0,
				loyaltyMinor: 0,
				cashDiscountsMinor: 0,
				refundsNetMinor: 0,
				taxByRate: [],
				tipsMinor: 0,
				giftCardsSoldMinor: 0,
				tenders: [],
				processingFeesMinor: 0,
				payoutMinor: 0,
			} satisfies AccountingDayFacts)
		day.payoutMinor += payout.amountCents
		day.processingFeesMinor += payout.feeCents
		by.set(key, day)
	}
	return [...by.values()]
}

export function mergeAccountingDays(
	regional: readonly AccountingDayFacts[],
	provider: readonly AccountingDayFacts[],
): AccountingDayFacts[] {
	return [...regional, ...provider].sort(
		(a, b) =>
			a.businessDate.localeCompare(b.businessDate) ||
			a.locationName.localeCompare(b.locationName) ||
			a.currency.localeCompare(b.currency),
	)
}

const minorField = z.number().int()
/** The region's answer (`POST /internal/reports/accounting`), parsed before use. */
export const accountingDaysSchema = z.object({
	days: z.array(
		z.object({
			locationId: z.string(),
			locationName: z.string(),
			businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			currency: z.string(),
			closed: z.boolean(),
			zatca: z.boolean().optional(),
			categories: z.array(
				z.object({ key: z.string(), label: z.string(), minor: minorField }),
			),
			grossMinor: minorField,
			serviceFeesMinor: minorField,
			discountsMinor: minorField,
			loyaltyMinor: minorField,
			cashDiscountsMinor: minorField,
			refundsNetMinor: minorField,
			taxByRate: z.array(z.object({ rateBp: minorField, minor: minorField })),
			tipsMinor: minorField,
			giftCardsSoldMinor: minorField,
			tenders: z.array(z.object({ tender: z.string(), minor: minorField })),
			processingFeesMinor: minorField,
			payoutMinor: minorField,
		}),
	),
})
