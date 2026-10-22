import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { posRefundTaxCents } from '@repo/common/pos-fiscal'
import { type PosShiftRequest } from '@repo/common/pos-orders'
import { posSalesSummary, type PosSalesSummary } from '@repo/common/pos-reports'
import {
	posCashMovements,
	posDevices,
	posOrders,
	posPayments,
	posShifts,
	runTenantTransaction,
	type PosCashMovementRow,
	type PosDevice,
	type PosOrderRow,
	type PosPaymentRow,
	type PosShiftRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { chunkIds } from '../lib/chunked-in.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { type PosResult } from './pos-service.ts'

/**
 * Cash drawer shifts. A terminal opens a shift with a float, records pay-ins
 * and pay-outs, and closes it with a blind count; each revision is uploaded
 * like an order. Movements are append-only and a closed shift never changes.
 * Reports are worked out here from the payments the server holds, so a payment
 * that reaches the server after the close is still counted.
 */

const ok = <T>(value: T): PosResult<T> => ({ ok: true, value })
const fail = (status: 409 | 403, error: string, message: string) =>
	({ ok: false, status, error, message }) as const

export type ShiftUpsert = {
	kind: 'created' | 'updated' | 'replay'
	shift: PosShiftRow
	movements: PosCashMovementRow[]
}

export async function upsertShift(
	db: TenantDatabase,
	device: PosDevice,
	shift: PosShiftRequest,
	now = Date.now(),
): Promise<PosResult<ShiftUpsert>> {
	return retryOnSqliteBusy(() =>
		runTenantTransaction(db, async (tx): Promise<PosResult<ShiftUpsert>> => {
			const [existing] = await tx
				.select()
				.from(posShifts)
				.where(eq(posShifts.id, shift.id))
				.limit(1)
			const stored = existing
				? await tx
						.select()
						.from(posCashMovements)
						.where(eq(posCashMovements.shiftId, shift.id))
				: []
			if (existing) {
				if (existing.deviceId !== device.id) {
					return fail(
						409,
						'shift_conflict',
						'This shift belongs to another terminal.',
					)
				}
				if (existing.revision >= shift.revision) {
					return ok({ kind: 'replay', shift: existing, movements: stored })
				}
				if (existing.status === 'closed')
					return fail(409, 'shift_closed', 'This shift is already closed.')
				const incoming = new Map(shift.movements.map((m) => [m.id, m]))
				for (const m of stored) {
					const next = incoming.get(m.id)
					if (
						!next ||
						next.amountCents !== m.amountCents ||
						next.kind !== m.kind
					) {
						return fail(
							409,
							'movements_changed',
							'Recorded cash movements cannot be changed.',
						)
					}
				}
				if (
					existing.openingFloatCents !== shift.openingFloatCents ||
					existing.businessDate !== shift.businessDate
				) {
					return fail(
						409,
						'shift_changed',
						'A shift keeps its opening float and day.',
					)
				}
			}
			const values = {
				deviceId: device.id,
				businessDate: shift.businessDate,
				revision: shift.revision,
				status: shift.status,
				openedAt: Date.parse(shift.openedAt),
				openedByStaffId: shift.openedBy?.id ?? null,
				openedByStaffName: shift.openedBy?.name ?? null,
				openingFloatCents: shift.openingFloatCents,
				closedAt: shift.closedAt ? Date.parse(shift.closedAt) : null,
				closedByStaffId: shift.closedBy?.id ?? null,
				closedByStaffName: shift.closedBy?.name ?? null,
				countedCashCents: shift.countedCashCents,
				expectedCashCents: shift.expectedCashCents,
				updatedAt: now,
			}
			if (existing)
				await tx.update(posShifts).set(values).where(eq(posShifts.id, shift.id))
			else
				await tx
					.insert(posShifts)
					.values({ id: shift.id, receivedAt: now, ...values })
			const known = new Set(stored.map((m) => m.id))
			const fresh = shift.movements
				.filter((m) => !known.has(m.id))
				.map((m) => ({
					id: m.id,
					shiftId: shift.id,
					kind: m.kind,
					amountCents: m.amountCents,
					note: m.note,
					staffId: m.by?.id ?? null,
					staffName: m.by?.name ?? null,
					approvedByStaffId: m.approvedBy?.id ?? null,
					approvedByStaffName: m.approvedBy?.name ?? null,
					at: Date.parse(m.at),
					receivedAt: now,
				}))
			// 11 columns a row against Durable Object SQLite's 100 bound parameters.
			for (const chunk of chunkIds(fresh, 8))
				await tx.insert(posCashMovements).values(chunk)
			const [saved] = await tx
				.select()
				.from(posShifts)
				.where(eq(posShifts.id, shift.id))
				.limit(1)
			const movements = await tx
				.select()
				.from(posCashMovements)
				.where(eq(posCashMovements.shiftId, shift.id))
			return ok({
				kind: existing ? 'updated' : 'created',
				shift: saved!,
				movements,
			})
		}),
	)
}

const summaryOrder = (row: PosOrderRow) => ({
	status: row.status,
	totals: {
		taxCents: row.taxCents,
		tipCents: row.tipCents,
		totalCents: row.totalCents,
	},
	lineVoids: row.lineVoids as Array<{ quantity: number; unitCents: number }>,
})

/** Payments and refunds as the summary wants them; a refund's tax share comes from its order. */
function summaryMoney(
	money: PosPaymentRow[],
	ordersById: Map<string, PosOrderRow>,
) {
	const payments = money
		.filter((p) => p.kind === 'payment')
		.map((p) => ({ method: p.method, amountCents: p.amountCents }))
	const refunds = money
		.filter((p) => p.kind === 'refund')
		.map((r) => {
			const order = ordersById.get(r.orderId)
			return {
				method: r.method,
				amountCents: r.amountCents,
				taxCents: order ? posRefundTaxCents(order, r.amountCents) : 0,
			}
		})
	return { payments, refunds }
}

async function ordersByIds(db: TenantDatabase, ids: string[]) {
	const rows: PosOrderRow[] = []
	for (const chunk of chunkIds([...new Set(ids)])) {
		rows.push(
			...(await db
				.select()
				.from(posOrders)
				.where(inArray(posOrders.id, chunk))),
		)
	}
	return new Map(rows.map((r) => [r.id, r]))
}

export type ShiftReport = {
	shift: ReturnType<typeof serializeShift>
	summary: PosSalesSummary
	/** Counted cash minus what the server expects; null while the shift is open. */
	overShortCents: number | null
}

export const serializeShift = (
	row: PosShiftRow,
	movements: PosCashMovementRow[],
) => ({
	id: row.id,
	deviceId: row.deviceId,
	businessDate: row.businessDate,
	status: row.status,
	openedAt: row.openedAt,
	openedBy: row.openedByStaffId
		? { id: row.openedByStaffId, name: row.openedByStaffName ?? '' }
		: null,
	openingFloatCents: row.openingFloatCents,
	closedAt: row.closedAt,
	closedBy: row.closedByStaffId
		? { id: row.closedByStaffId, name: row.closedByStaffName ?? '' }
		: null,
	countedCashCents: row.countedCashCents,
	tillExpectedCashCents: row.expectedCashCents,
	movements: movements.map((m) => ({
		id: m.id,
		kind: m.kind,
		amountCents: m.amountCents,
		note: m.note,
		at: m.at,
		by: m.staffId ? { id: m.staffId, name: m.staffName ?? '' } : null,
		approvedBy: m.approvedByStaffId
			? { id: m.approvedByStaffId, name: m.approvedByStaffName ?? '' }
			: null,
	})),
})

/** One shift's Z report, from what the server holds now. */
export async function shiftReport(
	db: TenantDatabase,
	shiftId: string,
): Promise<ShiftReport | null> {
	const [shift] = await db
		.select()
		.from(posShifts)
		.where(eq(posShifts.id, shiftId))
		.limit(1)
	if (!shift) return null
	const movements = await db
		.select()
		.from(posCashMovements)
		.where(eq(posCashMovements.shiftId, shiftId))
		.orderBy(asc(posCashMovements.at))
	const rungUp = await db
		.select()
		.from(posOrders)
		.where(eq(posOrders.shiftId, shiftId))
	const money = await db
		.select()
		.from(posPayments)
		.where(eq(posPayments.shiftId, shiftId))
	const ordersById = await ordersByIds(
		db,
		money.map((m) => m.orderId),
	)
	const summary = posSalesSummary({
		orders: rungUp.map(summaryOrder),
		...summaryMoney(money, ordersById),
		openingFloatCents: shift.openingFloatCents,
		movements,
	})
	return {
		shift: serializeShift(shift, movements),
		summary,
		overShortCents:
			shift.countedCashCents === null
				? null
				: shift.countedCashCents - summary.cash.expectedCents,
	}
}

/** Recent shifts, newest first, each with its report. */
export async function listShifts(
	db: TenantDatabase,
	options: { limit: number; businessDate?: string },
) {
	const rows = await db
		.select({
			id: posShifts.id,
			terminalCode: posDevices.terminalCode,
			terminalLabel: posDevices.label,
		})
		.from(posShifts)
		.leftJoin(posDevices, eq(posDevices.id, posShifts.deviceId))
		.where(
			options.businessDate
				? eq(posShifts.businessDate, options.businessDate)
				: undefined,
		)
		.orderBy(desc(posShifts.openedAt))
		.limit(options.limit)
	const reports = []
	for (const row of rows) {
		const report = await shiftReport(db, row.id)
		if (report)
			reports.push({
				...report,
				terminal: { code: row.terminalCode, label: row.terminalLabel },
			})
	}
	return reports
}

/**
 * Everything sold on one business day, across terminals: the day's orders, and
 * the money that moved on them (whenever it moved).
 */
export async function dayReport(
	db: TenantDatabase,
	businessDate: string,
	locationId?: string,
) {
	const orders = await db
		.select()
		.from(posOrders)
		.where(
			locationId
				? and(
						eq(posOrders.businessDate, businessDate),
						eq(posOrders.locationId, locationId),
					)
				: eq(posOrders.businessDate, businessDate),
		)
	const ordersById = new Map(orders.map((o) => [o.id, o]))
	const money: PosPaymentRow[] = []
	for (const chunk of chunkIds(orders.map((o) => o.id))) {
		money.push(
			...(await db
				.select()
				.from(posPayments)
				.where(inArray(posPayments.orderId, chunk))),
		)
	}
	const devices = await db
		.select({
			id: posDevices.id,
			terminalCode: posDevices.terminalCode,
			label: posDevices.label,
			locationId: posDevices.locationId,
		})
		.from(posDevices)
	const byTerminal = devices
		.map((d) => {
			const mine = orders.filter((o) => o.deviceId === d.id)
			const ids = new Set(mine.map((o) => o.id))
			return {
				terminal: { code: d.terminalCode, label: d.label },
				summary: posSalesSummary({
					orders: mine.map(summaryOrder),
					...summaryMoney(
						money.filter((m) => ids.has(m.orderId)),
						ordersById,
					),
				}),
			}
		})
		.filter(
			(t) =>
				t.summary.orders.paid +
					t.summary.orders.refunded +
					t.summary.orders.cancelled +
					t.summary.orders.open >
				0,
		)
	// For one location: the shifts of terminals bound to it, and of unbound
	// terminals that sold there that day.
	const atLocation = locationId
		? new Set([
				...devices.filter((d) => d.locationId === locationId).map((d) => d.id),
				...orders.map((o) => o.deviceId),
			])
		: null
	const shifts = (await listShifts(db, { limit: 100, businessDate })).filter(
		(s) => !atLocation || atLocation.has(s.shift.deviceId),
	)
	return {
		businessDate,
		// Every order of one organization is in the restaurant's currency.
		currency: orders[0]?.currency ?? null,
		summary: posSalesSummary({
			orders: orders.map(summaryOrder),
			...summaryMoney(money, ordersById),
		}),
		byTerminal,
		shifts,
	}
}
