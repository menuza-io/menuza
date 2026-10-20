import { type EmulatorContext } from '../context'
import { isRecord, type Json } from '../util'
import { invalidRequest } from './errors'

export type Allocation = {
	id: string
	amount: number
	reference?: string
	commission: { amount: number; percentage: number }
}

function wholeNumber(value: unknown) {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * `amount_allocations` rules the platform fee override depends on: every id is
 * a known sub-entity with payments enabled, amounts add up to the payment
 * amount, and commission never exceeds its allocation.
 */
export async function normalizeAllocations(
	ctx: EmulatorContext,
	raw: unknown,
	total: number,
): Promise<Allocation[]> {
	if (raw === undefined || raw === null) return []
	if (!Array.isArray(raw) || raw.length === 0) {
		throw invalidRequest('amount_allocations_invalid')
	}
	const codes = new Set<string>()
	const out: Allocation[] = []
	let sum = 0
	for (const entry of raw) {
		if (
			!isRecord(entry) ||
			typeof entry.id !== 'string' ||
			!wholeNumber(entry.amount)
		) {
			codes.add('amount_allocations_invalid')
			continue
		}
		const commission = isRecord(entry.commission) ? entry.commission : {}
		const commissionAmount =
			commission.amount === undefined ? 0 : commission.amount
		if (!wholeNumber(commissionAmount)) {
			codes.add('amount_allocations_commission_invalid')
			continue
		}
		if ((commissionAmount as number) > (entry.amount as number)) {
			codes.add('amount_allocations_commission_invalid')
		}
		const entity = await ctx.store.getObject('checkout', entry.id)
		if (
			!entity ||
			entity.type !== 'entity' ||
			!entity.json.capabilities?.payments?.enabled
		) {
			codes.add('amount_allocations_id_invalid')
		}
		sum += entry.amount as number
		out.push({
			id: entry.id,
			amount: entry.amount as number,
			...(typeof entry.reference === 'string'
				? { reference: entry.reference }
				: {}),
			commission: {
				amount: commissionAmount as number,
				percentage:
					(entry.amount as number) > 0
						? Math.round(
								((commissionAmount as number) / (entry.amount as number)) *
									10000,
							) / 100
						: 0,
			},
		})
	}
	if (sum !== total) codes.add('amount_allocations_amount_invalid')
	if (codes.size > 0) throw invalidRequest(...codes)
	return out
}

export function reverseAllocations(
	allocations: Allocation[],
	reversed: Record<string, { amount: number; commission: number }>,
	refundAmount: number,
	paymentAmount: number,
	final: boolean,
): Array<{ id: string; amount: number; commission: { amount: number } }> {
	if (allocations.length === 0) return []
	return allocations.map((allocation) => {
		const done = reversed[allocation.id] ?? { amount: 0, commission: 0 }
		const amountLeft = allocation.amount - done.amount
		const commissionLeft = allocation.commission.amount - done.commission
		const amount = final
			? amountLeft
			: Math.min(
					amountLeft,
					Math.round((allocation.amount * refundAmount) / paymentAmount),
				)
		const commission = final
			? commissionLeft
			: Math.min(
					commissionLeft,
					Math.round(
						(allocation.commission.amount * refundAmount) / paymentAmount,
					),
				)
		return { id: allocation.id, amount, commission: { amount: commission } }
	})
}

/** Caller-supplied reversal: must stay inside what was allocated and refunded. */
export function validateReversal(
	requested: unknown,
	allocations: Allocation[],
	reversed: Record<string, { amount: number; commission: number }>,
	refundAmount: number,
): Array<{ id: string; amount: number; commission: { amount: number } }> {
	if (!Array.isArray(requested) || requested.length === 0) {
		throw invalidRequest('amount_allocations_invalid')
	}
	const out: Array<{
		id: string
		amount: number
		commission: { amount: number }
	}> = []
	let sum = 0
	for (const entry of requested as Json[]) {
		const allocation = allocations.find((item) => item.id === entry?.id)
		const amount = entry?.amount
		const commission = entry?.commission?.amount ?? 0
		if (!allocation || !wholeNumber(amount) || !wholeNumber(commission)) {
			throw invalidRequest('amount_allocations_id_invalid')
		}
		const done = reversed[allocation.id] ?? { amount: 0, commission: 0 }
		if (amount > allocation.amount - done.amount) {
			throw invalidRequest('amount_allocations_amount_invalid')
		}
		if (
			commission > amount ||
			commission > allocation.commission.amount - done.commission
		) {
			throw invalidRequest('amount_allocations_commission_invalid')
		}
		sum += amount
		out.push({ id: allocation.id, amount, commission: { amount: commission } })
	}
	if (sum !== refundAmount)
		throw invalidRequest('amount_allocations_amount_invalid')
	return out
}
