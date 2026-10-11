import { z } from 'zod'

const id = z.string().trim().min(1).max(64)

export const currencySchema = z.string().regex(/^[A-Z]{3}$/)

/** 10,000.00 an hour in any supported currency; anything above is a typo. */
export const MAX_RATE_CENTS = 1_000_000

export const staffRatesInputSchema = z.object({
	rates: z
		.array(
			z.object({
				locationId: id,
				positionId: id,
				/** `null` clears the rate. */
				rateCents: z.number().int().min(0).max(MAX_RATE_CENTS).nullable(),
			}),
		)
		.min(1)
		.max(50),
})
export type StaffRatesInput = z.infer<typeof staffRatesInputSchema>

export function laborCents(paidMinutes: number, rateCents: number) {
	return Math.round((paidMinutes * rateCents) / 60)
}

/** Labor as a percent of sales, or null when there are no sales to compare. */
export function laborPercent(labor: number | null, sales: number | null) {
	if (labor === null || sales === null || sales <= 0) return null
	return (labor / sales) * 100
}

/**
 * Totals amounts only when they share one currency. A mix yields no total
 * rather than a number that adds riyals to dollars.
 */
export function singleCurrencyTotal(
	amounts: readonly { cents: number; currency: string }[],
) {
	const currencies = new Set(amounts.map((amount) => amount.currency))
	if (currencies.size > 1) {
		return { currency: null, cents: null, mixed: true } as const
	}
	return {
		currency: amounts[0]?.currency ?? null,
		cents: amounts.reduce((sum, amount) => sum + amount.cents, 0),
		mixed: false,
	} as const
}
