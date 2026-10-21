import { randomUUID } from 'node:crypto'
import {
	type ReportDefinition,
	type ReportRecord,
	timeframeLoadWindow,
} from '@repo/reports'
import {
	rsvAuditLog,
	rsvExperiences,
	rsvLocationSettings,
	rsvPacingRules,
	rsvPayments,
	rsvReservations,
	rsvServices,
	rsvTurnTimes,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	and,
	between,
	eq,
	inArray,
	isNotNull,
	lte,
	type SQL,
} from 'drizzle-orm'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { formatMinutesToHHMM } from './rsv-day-feed-service.ts'
import {
	bookingCovers,
	computePacingSlots,
	configuredTurnMinutes,
	isBookedStatus,
	type TurnRule,
} from './rsv-report-shared.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * Report records for the Reservations subjects `bookings`,
 * `waitlist_entries` and `pacing_slots`. They read the regional tenant database only and apply
 * the token's location limit on every query.
 *
 * Records carry aggregate facts only. Nothing here selects a guest's name,
 * phone, email, notes, requests or allergy text, so a report row can never
 * hold contact data.
 *
 * Nothing here checks a feature flag or a role: the App mints a token that
 * lists these subjects only when the module is on and the person holds
 * `read:reservation_report:any`, and the route checks the token first.
 */

/** Most reservations one report reads; the most recent are kept. */
export const BOOKING_REPORT_MAX_ROWS = 20_000
/** Most waitlist entries one report reads; the most recent are kept. */
export const WAITLIST_REPORT_MAX_ROWS = 20_000

export type LoadedRecords = { records: ReportRecord[]; truncated: boolean }

export type RsvReportContext = {
	db: TenantDatabase
	orgId: string
	userId: string
	/** Locations the token covers; `null` is every location. */
	locationIds: readonly string[] | null
	/** The server's clock in epoch milliseconds. */
	now: number
}

const DAY_MS = 86_400_000

function shiftDate(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
		.toISOString()
		.slice(0, 10)
}

/** The business dates a loader must read to cover a timeframe in any zone. */
function loadDates(definition: ReportDefinition, now: number) {
	const window = timeframeLoadWindow(
		definition.timeframe.preset,
		new Date(now),
		definition.timeframe,
	)
	return {
		fromDate: window.start
			? shiftDate(window.start.toISOString().slice(0, 10), -1)
			: null,
		toDate: shiftDate(window.end.toISOString().slice(0, 10), 1),
	}
}

function locationWhere(
	ctx: RsvReportContext,
	column: Parameters<typeof inArray>[0],
): SQL | undefined {
	if (ctx.locationIds === null) return undefined
	if (ctx.locationIds.length === 0) return eq(column, '')
	return inJsonList(column, ctx.locationIds)
}

async function locationNames(ctx: RsvReportContext) {
	const context = await getReservationsContext(ctx.orgId, { now: ctx.now })
	return new Map((context?.locations ?? []).map((l) => [l.id, l.name]))
}

const COLLECTED_KINDS = new Set([
	'deposit_charge',
	'prepay_charge',
	'cancel_fee_charge',
	'no_show_fee_charge',
])

export function bookingRecord(
	row: typeof rsvReservations.$inferSelect,
	names: {
		location: string
		service: string
		experience: string
		currency: string
		collectedMinor: number
		refundedMinor: number
		/** The turn time the location's rules set for this party, if any. */
		configuredTurn: number | null
	},
): ReportRecord {
	const actualMinutes =
		row.seatedAt !== null && row.finishedAt !== null
			? Math.max(0, Math.round((row.finishedAt - row.seatedAt) / 60_000))
			: null
	return {
		startsAt: new Date(row.startAt),
		businessDate: row.businessDate,
		location: names.location,
		service: names.service,
		experience: names.experience,
		partySize: row.partySize,
		covers: bookingCovers(row),
		status: row.status,
		channel: row.channel,
		cancelledBy:
			row.status === 'cancelled' ? (row.cancelledBy ?? 'unknown') : null,
		slotTime: formatMinutesToHHMM(row.localStartMin),
		isBooked: isBookedStatus(row.status) ? 1 : 0,
		isNoShow: row.status === 'no_show' ? 1 : 0,
		isCancelled: row.status === 'cancelled' ? 1 : 0,
		isLateCancel: row.status === 'cancelled' && row.lateCancel ? 1 : 0,
		isFinished: row.status === 'finished' ? 1 : 0,
		bookingCount: 1,
		durationMinutes: row.durationMin,
		actualMinutes,
		configuredTurnMinutes: names.configuredTurn,
		turnVarianceMinutes:
			actualMinutes !== null && names.configuredTurn !== null
				? actualMinutes - names.configuredTurn
				: null,
		lateCancel: row.lateCancel,
		paymentStatus: row.paymentStatus,
		collectedMinor: names.collectedMinor,
		refundedMinor: names.refundedMinor,
		currency: names.currency,
		timeZone: row.timeZone,
	}
}

export async function loadBookingRecords(
	ctx: RsvReportContext,
	definition: ReportDefinition,
	maxRows = BOOKING_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const dates = loadDates(definition, ctx.now)
	const where = and(
		dates.fromDate
			? between(rsvReservations.businessDate, dates.fromDate, dates.toDate)
			: lte(rsvReservations.businessDate, dates.toDate),
		locationWhere(ctx, rsvReservations.locationId),
	)
	const rows = await ctx.db
		.select()
		.from(rsvReservations)
		.where(where)
		.orderBy(rsvReservations.startAt)
		.limit(maxRows + 1)
	const truncated = rows.length > maxRows
	const kept = truncated ? rows.slice(0, maxRows) : rows
	if (kept.length === 0) return { records: [], truncated }

	const [services, experiences, settings, names, turnRules] = await Promise.all(
		[
			ctx.db
				.select({ id: rsvServices.id, name: rsvServices.name })
				.from(rsvServices),
			ctx.db
				.select({
					id: rsvExperiences.id,
					slug: rsvExperiences.slug,
					nameI18n: rsvExperiences.nameI18n,
				})
				.from(rsvExperiences),
			ctx.db
				.select({
					locationId: rsvLocationSettings.locationId,
					currency: rsvLocationSettings.currency,
				})
				.from(rsvLocationSettings),
			locationNames(ctx),
			loadTurnRules(ctx),
		],
	)
	const serviceName = new Map(services.map((s) => [s.id, s.name]))
	const experienceName = new Map(
		experiences.map((e) => [
			e.id,
			Object.values(e.nameI18n ?? {}).find(Boolean) ?? e.slug,
		]),
	)
	const currencyOf = new Map(settings.map((s) => [s.locationId, s.currency]))

	const money = new Map<
		string,
		{ collected: number; refunded: number; currency: string | null }
	>()
	const payments = await ctx.db
		.select({
			reservationId: rsvPayments.reservationId,
			kind: rsvPayments.kind,
			amountMinor: rsvPayments.amountMinor,
			currency: rsvPayments.currency,
		})
		.from(rsvPayments)
		.innerJoin(
			rsvReservations,
			eq(rsvReservations.id, rsvPayments.reservationId),
		)
		.where(and(where, eq(rsvPayments.status, 'succeeded')))
	for (const payment of payments) {
		const entry = money.get(payment.reservationId) ?? {
			collected: 0,
			refunded: 0,
			currency: null,
		}
		if (COLLECTED_KINDS.has(payment.kind))
			entry.collected += payment.amountMinor
		else if (payment.kind === 'refund') entry.refunded += payment.amountMinor
		entry.currency = payment.currency
		money.set(payment.reservationId, entry)
	}

	const records = kept.map((row) => {
		const paid = money.get(row.id)
		return bookingRecord(row, {
			location: names.get(row.locationId) ?? row.locationId,
			service: row.serviceId ? (serviceName.get(row.serviceId) ?? '') : '',
			experience: row.experienceId
				? (experienceName.get(row.experienceId) ?? '')
				: '',
			currency: paid?.currency ?? currencyOf.get(row.locationId) ?? 'USD',
			collectedMinor: paid?.collected ?? 0,
			refundedMinor: paid?.refunded ?? 0,
			configuredTurn: configuredTurnMinutes(
				turnRules.get(row.locationId) ?? [],
				row.partySize,
				row.serviceId,
				row.businessDate,
			),
		})
	})
	return { records, truncated }
}

/** Turn-time rules by location, read once per run. */
async function loadTurnRules(ctx: RsvReportContext) {
	const rows = await ctx.db
		.select({
			locationId: rsvTurnTimes.locationId,
			serviceId: rsvTurnTimes.serviceId,
			partyMin: rsvTurnTimes.partyMin,
			partyMax: rsvTurnTimes.partyMax,
			minutes: rsvTurnTimes.minutes,
			daysMask: rsvTurnTimes.daysMask,
		})
		.from(rsvTurnTimes)
	const byLocation = new Map<string, TurnRule[]>()
	for (const { locationId, ...rule } of rows) {
		byLocation.set(locationId, [...(byLocation.get(locationId) ?? []), rule])
	}
	return byLocation
}

export function pacingSlotRecord(
	slot: ReturnType<typeof computePacingSlots>[number],
	names: { location: string; service: string },
): ReportRecord {
	return {
		startsAt: new Date(slot.startAt ?? 0),
		businessDate: slot.businessDate,
		location: names.location,
		service: names.service,
		slotTime: formatMinutesToHHMM(slot.localStartMin),
		bookings: slot.bookings,
		covers: slot.covers,
		maxCovers: slot.maxCovers,
		maxParties: slot.maxParties,
		overLimit: slot.overLimit,
		slotCount: 1,
		overLimitSlots: slot.overLimit ? 1 : 0,
		timeZone: slot.timeZone ?? 'UTC',
	}
}

/**
 * One record per date, service and start time with the bookings and covers in
 * it against the service's pacing limits. Built from the reservation rows with
 * the same slot math as every other pacing figure (`computePacingSlots`).
 */
export async function loadPacingSlotRecords(
	ctx: RsvReportContext,
	definition: ReportDefinition,
	maxRows = BOOKING_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const dates = loadDates(definition, ctx.now)
	const rows = await ctx.db
		.select({
			locationId: rsvReservations.locationId,
			businessDate: rsvReservations.businessDate,
			localStartMin: rsvReservations.localStartMin,
			serviceId: rsvReservations.serviceId,
			partySize: rsvReservations.partySize,
			coversActual: rsvReservations.coversActual,
			status: rsvReservations.status,
			startAt: rsvReservations.startAt,
			timeZone: rsvReservations.timeZone,
		})
		.from(rsvReservations)
		.where(
			and(
				dates.fromDate
					? between(rsvReservations.businessDate, dates.fromDate, dates.toDate)
					: lte(rsvReservations.businessDate, dates.toDate),
				locationWhere(ctx, rsvReservations.locationId),
			),
		)
		.orderBy(rsvReservations.startAt)
		.limit(maxRows + 1)
	const truncated = rows.length > maxRows
	const kept = truncated ? rows.slice(0, maxRows) : rows
	if (kept.length === 0) return { records: [], truncated }

	const [services, rules, names] = await Promise.all([
		ctx.db
			.select({ id: rsvServices.id, name: rsvServices.name })
			.from(rsvServices),
		ctx.db
			.select({
				serviceId: rsvPacingRules.serviceId,
				channel: rsvPacingRules.channel,
				fromMin: rsvPacingRules.fromMin,
				toMin: rsvPacingRules.toMin,
				maxCovers: rsvPacingRules.maxCovers,
				maxParties: rsvPacingRules.maxParties,
			})
			.from(rsvPacingRules),
		locationNames(ctx),
	])
	const serviceName = new Map(services.map((s) => [s.id, s.name]))
	const records = computePacingSlots(kept, rules).map((slot) =>
		pacingSlotRecord(slot, {
			location: names.get(slot.locationId ?? '') ?? slot.locationId ?? '',
			service: slot.serviceId ? (serviceName.get(slot.serviceId) ?? '') : '',
		}),
	)
	return { records, truncated }
}

export function waitlistRecord(
	row: typeof rsvWaitlistEntries.$inferSelect,
	extra: { location: string; timeZone: string; seatedAt: number | null },
): ReportRecord {
	return {
		joinedAt: new Date(row.joinedAt),
		businessDate: row.businessDate,
		location: extra.location,
		partySize: row.partySize,
		channel: row.channel,
		status: row.status,
		quotedMinutes: row.quotedMin,
		actualMinutes:
			row.status === 'seated' && extra.seatedAt !== null
				? Math.max(0, Math.round((extra.seatedAt - row.joinedAt) / 60_000))
				: null,
		timeZone: extra.timeZone,
	}
}

export async function loadWaitlistRecords(
	ctx: RsvReportContext,
	definition: ReportDefinition,
	maxRows = WAITLIST_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const dates = loadDates(definition, ctx.now)
	const rows = await ctx.db
		.select({
			entry: rsvWaitlistEntries,
			seatedAt: rsvReservations.seatedAt,
		})
		.from(rsvWaitlistEntries)
		.leftJoin(
			rsvReservations,
			and(
				eq(rsvReservations.id, rsvWaitlistEntries.reservationId),
				isNotNull(rsvReservations.seatedAt),
			),
		)
		.where(
			and(
				dates.fromDate
					? between(
							rsvWaitlistEntries.businessDate,
							dates.fromDate,
							dates.toDate,
						)
					: lte(rsvWaitlistEntries.businessDate, dates.toDate),
				locationWhere(ctx, rsvWaitlistEntries.locationId),
			),
		)
		.orderBy(rsvWaitlistEntries.joinedAt)
		.limit(maxRows + 1)
	const truncated = rows.length > maxRows
	const kept = truncated ? rows.slice(0, maxRows) : rows
	if (kept.length === 0) return { records: [], truncated }

	const [settings, names] = await Promise.all([
		ctx.db
			.select({
				locationId: rsvLocationSettings.locationId,
				timeZone: rsvLocationSettings.timeZone,
			})
			.from(rsvLocationSettings),
		locationNames(ctx),
	])
	const zoneOf = new Map(settings.map((s) => [s.locationId, s.timeZone]))
	const records = kept.map((row) =>
		waitlistRecord(row.entry, {
			location: names.get(row.entry.locationId) ?? row.entry.locationId,
			timeZone: zoneOf.get(row.entry.locationId) ?? 'UTC',
			seatedAt: row.seatedAt,
		}),
	)
	return { records, truncated }
}

/**
 * One audit row per report run, written before the answer leaves. It names the
 * subject and counts, never a guest's name, contact or note.
 */
export async function auditRsvReportRun(
	ctx: RsvReportContext,
	input: { subject: string; rows: number },
) {
	await ctx.db.insert(rsvAuditLog).values({
		id: `aud_${randomUUID()}`,
		at: ctx.now,
		actorKind: 'operator',
		actorId: ctx.userId,
		locationId: null,
		action: 'report.run',
		entityType: 'report',
		entityId: input.subject,
		changes: { subject: input.subject, rows: input.rows },
	})
}
