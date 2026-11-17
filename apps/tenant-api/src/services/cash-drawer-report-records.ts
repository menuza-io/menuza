import { posRefundTaxCents } from '@repo/common/pos-fiscal'
import { parsePosLocationStationSettings } from '@repo/common/pos-orders'
import { posSalesSummary } from '@repo/common/pos-reports'
import {
	type ReportDefinition,
	type ReportRecord,
	resolveTimeframeRange,
} from '@repo/reports'
import {
	posCashMovements,
	posDevices,
	posOrders,
	posPayments,
	posShifts,
	rsvLocationSettings,
	type PosCashMovementRow,
	type PosOrderRow,
	type PosPaymentRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { isValidTimeZone } from '@repo/zoned-time'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { fetchOrderContext } from './order-service.ts'
import { type LoadedRecords } from './report-records.ts'
import {
	SALES_REPORT_MAX_ROWS,
	type SalesReportContext,
} from './sales-report-records.ts'

/**
 * Cash drawer variance and cash movement log report loaders (#380).
 *
 * Expected cash is calculated identically to `pos-shift-service.ts` via
 * `posSalesSummary` so the Z report, App shift view, and cash variance report
 * never disagree. Amounts are always per-currency (reports split by currency)
 * and cashier/staff names are populated only when `includeStaffNames` is true
 * (and separately enforced by `analytics.ts` against `SALES_STAFF_FIELD_PERMISSION`).
 */

export type CashDrawerReportContext = SalesReportContext & {
	includeStaffNames: boolean
}

type LocationMeta = {
	name: string
	currency: string
	timeZone: string
	varianceFlagCents: number
}

const DEFAULT_VARIANCE_FLAG_CENTS = 500

function inWindow(
	expression: SQL,
	definition: ReportDefinition,
	now: Date,
): SQL[] {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		now,
		definition.timeframe,
	)
	const endMs = range.end.getTime()
	const conditions: SQL[] = [sql`${expression} <= ${endMs}`]
	if (range.start) {
		conditions.push(sql`${expression} >= ${range.start.getTime()}`)
	}
	return conditions
}

function locationAllowed(
	locationId: string | null,
	allowed: readonly string[] | null,
): boolean {
	if (allowed === null) return true
	if (allowed.length === 0) return false
	return locationId !== null && allowed.includes(locationId)
}

async function loadLocationMeta(
	ctx: SalesReportContext,
	locationIdHint: string,
): Promise<{
	defaultCurrency: string
	locations: Map<string, LocationMeta>
}> {
	const locations = new Map<string, LocationMeta>()
	let defaultCurrency = 'USD'
	try {
		const orderContext = await fetchOrderContext(
			ctx.orgId,
			locationIdHint,
			null,
		)
		const menu = orderContext.ok ? orderContext.data.menu : null
		if (menu?.organization?.currency) {
			defaultCurrency = menu.organization.currency.toUpperCase()
		}
		for (const loc of menu?.locations ?? []) {
			const station = parsePosLocationStationSettings(loc.stationSettings)
			locations.set(loc.id, {
				name: loc.name,
				currency: (loc.currency || defaultCurrency).toUpperCase(),
				timeZone: isValidTimeZone(loc.timezone) ? loc.timezone : '',
				varianceFlagCents:
					station.cashVarianceFlagCents ?? DEFAULT_VARIANCE_FLAG_CENTS,
			})
		}
	} catch {
		// Fall back to tenant tables below when App order context cannot be reached.
	}

	const missingZoneIds = [...locations.entries()]
		.filter(([, meta]) => !meta.timeZone)
		.map(([id]) => id)
	if (missingZoneIds.length > 0 || locations.size === 0) {
		const rsvRows = await ctx.db
			.select({
				locationId: rsvLocationSettings.locationId,
				timeZone: rsvLocationSettings.timeZone,
			})
			.from(rsvLocationSettings)
		for (const row of rsvRows) {
			if (!isValidTimeZone(row.timeZone)) continue
			const existing = locations.get(row.locationId)
			if (existing) {
				if (!existing.timeZone) existing.timeZone = row.timeZone
			} else {
				locations.set(row.locationId, {
					name: '',
					currency: defaultCurrency,
					timeZone: row.timeZone,
					varianceFlagCents: DEFAULT_VARIANCE_FLAG_CENTS,
				})
			}
		}
	}
	return { defaultCurrency, locations }
}

async function loadDeviceCurrencies(
	db: TenantDatabase,
	deviceIds: readonly string[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>()
	if (deviceIds.length === 0) return map
	const rows = await queryInChunks([...new Set(deviceIds)], (chunk) =>
		db
			.select({
				deviceId: posOrders.deviceId,
				currency: posOrders.currency,
			})
			.from(posOrders)
			.where(inArray(posOrders.deviceId, chunk))
			.orderBy(desc(posOrders.rungUpAt)),
	)
	for (const row of rows) {
		if (!map.has(row.deviceId) && row.currency) {
			map.set(row.deviceId, row.currency.toUpperCase())
		}
	}
	return map
}

const major = (minor: number) => minor / 100

export async function loadCashDrawerShiftRecords(
	ctx: CashDrawerReportContext,
	definition: ReportDefinition,
	maxRows = SALES_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	if (ctx.locationIds !== null && ctx.locationIds.length === 0) {
		return { records: [], truncated: false }
	}
	const shiftTime = sql`coalesce(${posShifts.closedAt}, ${posShifts.openedAt})`
	const rawRows = await ctx.db
		.select({
			shift: posShifts,
			terminalCode: posDevices.terminalCode,
			terminalLabel: posDevices.label,
			locationId: posDevices.locationId,
		})
		.from(posShifts)
		.leftJoin(posDevices, eq(posDevices.id, posShifts.deviceId))
		.where(and(...inWindow(shiftTime, definition, ctx.now)))
		.orderBy(desc(shiftTime))
		.limit(maxRows + 1)

	const scoped = rawRows.filter((row) =>
		locationAllowed(row.locationId ?? null, ctx.locationIds),
	)
	const truncated = scoped.length > maxRows
	const rows = truncated ? scoped.slice(0, maxRows) : scoped
	if (rows.length === 0) return { records: [], truncated }

	const shiftIds = rows.map((r) => r.shift.id)
	const deviceIds = rows.map((r) => r.shift.deviceId)

	const locationIdHint = rows.find((r) => r.locationId)?.locationId ?? 'default'

	const movementsPromise = queryInChunks(shiftIds, (chunk) =>
		ctx.db
			.select()
			.from(posCashMovements)
			.where(inArray(posCashMovements.shiftId, chunk)),
	)
	const moneyRowsPromise = queryInChunks(shiftIds, (chunk) =>
		ctx.db
			.select()
			.from(posPayments)
			.where(inArray(posPayments.shiftId, chunk)),
	)
	const [
		{ defaultCurrency, locations },
		movements,
		moneyRows,
		deviceCurrencies,
	] = await Promise.all([
		loadLocationMeta(ctx, locationIdHint),
		movementsPromise,
		moneyRowsPromise,
		loadDeviceCurrencies(ctx.db, deviceIds),
	])

	const refundOrderIds = [
		...new Set(
			moneyRows.filter((m) => m.kind === 'refund').map((m) => m.orderId),
		),
	]
	const ordersById = new Map<string, PosOrderRow>()
	if (refundOrderIds.length > 0) {
		const orderRows = await queryInChunks(refundOrderIds, (chunk) =>
			ctx.db.select().from(posOrders).where(inArray(posOrders.id, chunk)),
		)
		for (const o of orderRows) ordersById.set(o.id, o)
	}

	const movementsByShift = new Map<string, PosCashMovementRow[]>()
	for (const m of movements) {
		const list = movementsByShift.get(m.shiftId) ?? []
		list.push(m)
		movementsByShift.set(m.shiftId, list)
	}
	const moneyByShift = new Map<string, PosPaymentRow[]>()
	for (const p of moneyRows) {
		if (!p.shiftId) continue
		const list = moneyByShift.get(p.shiftId) ?? []
		list.push(p)
		moneyByShift.set(p.shiftId, list)
	}

	const records: ReportRecord[] = rows.map(
		({ shift, terminalCode, terminalLabel, locationId }) => {
			const shiftMovements = movementsByShift.get(shift.id) ?? []
			const shiftMoney = moneyByShift.get(shift.id) ?? []
			const summary = posSalesSummary({
				orders: [],
				payments: shiftMoney
					.filter((p) => p.kind === 'payment')
					.map((p) => ({ method: p.method, amountCents: p.amountCents })),
				refunds: shiftMoney
					.filter((r) => r.kind === 'refund')
					.map((r) => {
						const order = ordersById.get(r.orderId)
						return {
							method: r.method,
							amountCents: r.amountCents,
							taxCents: order ? posRefundTaxCents(order, r.amountCents) : 0,
						}
					}),
				openingFloatCents: shift.openingFloatCents,
				movements: shiftMovements.map((m) => ({
					kind: m.kind,
					amountCents: m.amountCents,
				})),
			})
			const useStoredExpected =
				shift.status === 'closed' &&
				shift.expectedCashCents !== null &&
				shiftMoney.length === 0 &&
				shiftMovements.length === 0
			const expectedCents = useStoredExpected
				? shift.expectedCashCents!
				: summary.cash.expectedCents
			const meta = locationId ? locations.get(locationId) : undefined
			const flagThreshold =
				meta?.varianceFlagCents ?? DEFAULT_VARIANCE_FLAG_CENTS
			const isClosed =
				shift.status === 'closed' && shift.countedCashCents !== null
			const varianceCents = isClosed
				? shift.countedCashCents! - expectedCents
				: 0
			const varianceFlagged = isClosed
				? Math.abs(varianceCents) > flagThreshold
				: false
			const currency =
				meta?.currency ??
				deviceCurrencies.get(shift.deviceId) ??
				defaultCurrency
			const terminal = terminalLabel
				? terminalCode
					? `${terminalLabel} (${terminalCode})`
					: terminalLabel
				: (terminalCode ?? shift.deviceId)

			return {
				closedAt: new Date(shift.closedAt ?? shift.openedAt),
				openedAt: new Date(shift.openedAt),
				businessDate: shift.businessDate,
				location: meta?.name ?? '',
				locationId: locationId ?? '',
				locationTimeZone: meta?.timeZone ?? '',
				terminal,
				status: shift.status,
				...(ctx.includeStaffNames
					? {
							cashierName:
								shift.openedByStaffName ||
								shift.closedByStaffName ||
								'Unassigned',
							closedByName: shift.closedByStaffName ?? '',
							remoteCloserName: shift.closedRemotelyByName ?? '',
						}
					: {}),
				closedRemotely: Boolean(shift.closedRemotelyById),
				remoteCloseReason: shift.remoteCloseReason ?? '',
				openingFloat: major(shift.openingFloatCents),
				expectedCash: major(expectedCents),
				countedCash: isClosed ? major(shift.countedCashCents!) : 0,
				variance: major(varianceCents),
				varianceFlagged,
				currency,
			}
		},
	)

	return { records, truncated }
}

export async function loadCashDrawerMovementRecords(
	ctx: CashDrawerReportContext,
	definition: ReportDefinition,
	maxRows = SALES_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	if (ctx.locationIds !== null && ctx.locationIds.length === 0) {
		return { records: [], truncated: false }
	}
	const rawRows = await ctx.db
		.select({
			movement: posCashMovements,
			shiftBusinessDate: posShifts.businessDate,
			shiftDeviceId: posShifts.deviceId,
			terminalCode: posDevices.terminalCode,
			terminalLabel: posDevices.label,
			locationId: posDevices.locationId,
		})
		.from(posCashMovements)
		.innerJoin(posShifts, eq(posShifts.id, posCashMovements.shiftId))
		.leftJoin(posDevices, eq(posDevices.id, posShifts.deviceId))
		.where(and(...inWindow(sql`${posCashMovements.at}`, definition, ctx.now)))
		.orderBy(desc(posCashMovements.at))
		.limit(maxRows + 1)

	const scoped = rawRows.filter((row) =>
		locationAllowed(row.locationId ?? null, ctx.locationIds),
	)
	const truncated = scoped.length > maxRows
	const rows = truncated ? scoped.slice(0, maxRows) : scoped
	if (rows.length === 0) return { records: [], truncated }

	const deviceIds = rows.map((r) => r.shiftDeviceId)
	const locationIdHint = rows.find((r) => r.locationId)?.locationId ?? 'default'
	const [{ defaultCurrency, locations }, deviceCurrencies] = await Promise.all([
		loadLocationMeta(ctx, locationIdHint),
		loadDeviceCurrencies(ctx.db, deviceIds),
	])

	const records: ReportRecord[] = rows.map(
		({
			movement,
			shiftBusinessDate,
			shiftDeviceId,
			terminalCode,
			terminalLabel,
			locationId,
		}) => {
			const meta = locationId ? locations.get(locationId) : undefined
			const currency =
				meta?.currency ?? deviceCurrencies.get(shiftDeviceId) ?? defaultCurrency
			const terminal = terminalLabel
				? terminalCode
					? `${terminalLabel} (${terminalCode})`
					: terminalLabel
				: (terminalCode ?? shiftDeviceId)

			return {
				occurredAt: new Date(movement.at),
				businessDate: shiftBusinessDate,
				location: meta?.name ?? '',
				locationId: locationId ?? '',
				locationTimeZone: meta?.timeZone ?? '',
				terminal,
				shiftId: movement.shiftId,
				kind: movement.kind,
				amount: major(movement.amountCents),
				signedAmount:
					movement.kind === 'pay_in'
						? major(movement.amountCents)
						: -major(movement.amountCents),
				note: movement.note,
				...(ctx.includeStaffNames
					? {
							staffName: movement.staffName ?? '',
							approvedByName: movement.approvedByStaffName ?? '',
						}
					: {}),
				currency,
			}
		},
	)

	return { records, truncated }
}
