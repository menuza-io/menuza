import { t } from '@lingui/macro'
import { posRefundTaxCents } from '@repo/common/pos-fiscal'
import { posSalesSummary, type PosSalesSummary } from '@repo/common/pos-reports'
import {
	db,
	type CashMovement,
	type PosOrder,
	type Shift,
	type StaffRef,
} from './db.ts'
import { DEFAULT_DAY_START_MINUTES, localDate } from './orders.ts'

/**
 * Cash drawer shifts on this terminal. One shift is open at a time; every sale,
 * payment and refund taken while it is open carries its id. Closing asks for a
 * blind count (the person counting is not shown the expected figure first),
 * then shows over or short and the shift's Z report.
 */

export const MAX_MOVEMENTS = 200

/** The open shift, if any. Call inside a transaction over `db.shifts` to stamp sales consistently. */
export const openShift = (): Promise<Shift | undefined> =>
	db.shifts.where('status').equals('open').first()

const touched = (shift: Shift): Partial<Shift> => ({
	revision: shift.revision + 1,
	sync: 'pending',
	attempts: 0,
	nextAttemptAt: 0,
	lastError: null,
	heldReason: null,
})

export async function startShift(input: {
	openingFloatCents: number
	by: StaffRef | null
	origin?: string
	timeZone?: string
	dayStartMinutes?: number
}): Promise<Shift> {
	if (
		!Number.isInteger(input.openingFloatCents) ||
		input.openingFloatCents < 0
	) {
		throw new Error(t`Enter the cash in the drawer to start with.`)
	}
	const now = Date.now()
	return db.transaction('rw', db.shifts, async () => {
		if (await openShift())
			throw new Error(t`A shift is already open on this terminal.`)
		const shift: Shift = {
			id: crypto.randomUUID(),
			status: 'open',
			businessDate: localDate(
				new Date(now),
				input.timeZone,
				input.dayStartMinutes ?? DEFAULT_DAY_START_MINUTES,
			),
			openedAt: now,
			openedBy: input.by,
			openingFloatCents: input.openingFloatCents,
			movements: [],
			closedAt: null,
			closedBy: null,
			countedCashCents: null,
			expectedCashCents: null,
			revision: 1,
			sync: 'pending',
			attempts: 0,
			nextAttemptAt: 0,
			lastError: null,
			origin: input.origin,
		}
		await db.shifts.add(shift)
		return shift
	})
}

/** Records cash put into or taken out of the drawer (change brought in, a supplier paid from the till). */
export async function addCashMovement(
	shiftId: string,
	input: Omit<CashMovement, 'id' | 'at'>,
): Promise<Shift> {
	const note = input.note.trim()
	if (!note) throw new Error(t`Say what the cash is for.`)
	if (!Number.isInteger(input.amountCents) || input.amountCents <= 0)
		throw new Error(t`Enter an amount.`)
	return db.transaction('rw', db.shifts, async () => {
		const shift = await db.shifts.get(shiftId)
		if (!shift || shift.status !== 'open')
			throw new Error(t`This shift is closed.`)
		if (shift.movements.length >= MAX_MOVEMENTS)
			throw new Error(
				t`This shift has too many cash movements. Close it and open a new one.`,
			)
		const saved: Shift = {
			...shift,
			movements: [
				...shift.movements,
				{
					...input,
					note: note.slice(0, 200),
					id: crypto.randomUUID(),
					at: Date.now(),
				},
			],
			...touched(shift),
		}
		await db.shifts.put(saved)
		return saved
	})
}

/** Everything this shift took, from the orders on this terminal. */
export async function summarizeShift(shift: Shift): Promise<PosSalesSummary> {
	const orders = await db.orders.toArray()
	return summarize(shift, orders)
}

export function summarize(
	shift: Pick<Shift, 'id' | 'openingFloatCents' | 'movements'>,
	orders: PosOrder[],
): PosSalesSummary {
	const rungUp = orders.filter(
		(o) => o.shiftId === shift.id && !o.transferredTo,
	)
	const payments = orders.flatMap((o) =>
		o.payments.filter((p) => p.shiftId === shift.id),
	)
	const refunds = orders.flatMap((o) =>
		(o.refunds ?? [])
			.filter((r) => r.shiftId === shift.id)
			.map((r) => ({
				method: r.method,
				amountCents: r.amountCents,
				taxCents: posRefundTaxCents(o.totals, r.amountCents),
			})),
	)
	return posSalesSummary({
		orders: rungUp.map((o) => ({
			status: o.status,
			totals: o.totals,
			lineVoids: o.lineVoids ?? [],
		})),
		payments: payments.map((p) => ({
			method: p.method,
			amountCents: p.amountCents,
		})),
		refunds,
		openingFloatCents: shift.openingFloatCents,
		movements: shift.movements,
	})
}

/**
 * Closes the shift with the cash the person counted. The expected figure is
 * worked out here, at the moment of closing, and kept with the count.
 */
export async function closeShift(
	shiftId: string,
	input: { countedCashCents: number; by: StaffRef | null },
): Promise<Shift> {
	if (!Number.isInteger(input.countedCashCents) || input.countedCashCents < 0) {
		throw new Error(t`Enter the cash you counted.`)
	}
	return db.transaction('rw', db.shifts, db.orders, async () => {
		const shift = await db.shifts.get(shiftId)
		if (!shift || shift.status !== 'open')
			throw new Error(t`This shift is already closed.`)
		const summary = summarize(shift, await db.orders.toArray())
		const saved: Shift = {
			...shift,
			status: 'closed',
			closedAt: Date.now(),
			closedBy: input.by,
			countedCashCents: input.countedCashCents,
			expectedCashCents: summary.cash.expectedCents,
			...touched(shift),
		}
		await db.shifts.put(saved)
		return saved
	})
}

export const recentShifts = (limit = 10): Promise<Shift[]> =>
	db.shifts.orderBy('openedAt').reverse().limit(limit).toArray()

const staffOrNull = (who: StaffRef | null) =>
	who ? { id: who.id, name: who.name } : null

/** Wire format (`posShiftRequestSchema` in `@repo/common/pos-orders`). */
export function toWireShift(shift: Shift) {
	return {
		id: shift.id,
		revision: shift.revision,
		status: shift.status,
		businessDate: shift.businessDate,
		openedAt: new Date(shift.openedAt).toISOString(),
		openedBy: staffOrNull(shift.openedBy),
		openingFloatCents: shift.openingFloatCents,
		movements: shift.movements.map((m) => ({
			id: m.id,
			kind: m.kind,
			amountCents: m.amountCents,
			note: m.note,
			at: new Date(m.at).toISOString(),
			by: staffOrNull(m.by),
			approvedBy: staffOrNull(m.approvedBy),
		})),
		closedAt: shift.closedAt ? new Date(shift.closedAt).toISOString() : null,
		closedBy: staffOrNull(shift.closedBy),
		countedCashCents: shift.countedCashCents,
		expectedCashCents: shift.expectedCashCents,
	}
}

/** Shifts the server refused for good. They stay here, shown for attention. */
export const rejectedShifts = (): Promise<Shift[]> =>
	db.shifts.where('sync').equals('rejected').toArray()

/** Puts refused shifts back in the queue (after an update or a manager's fix). */
export async function requeueRejectedShifts(): Promise<number> {
	return db.shifts
		.where('sync')
		.equals('rejected')
		.modify({ sync: 'pending', nextAttemptAt: 0, lastError: null })
}
