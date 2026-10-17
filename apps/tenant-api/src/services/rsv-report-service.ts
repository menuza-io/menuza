import { randomUUID } from 'node:crypto'
import {
	rsvAuditLog,
	rsvPacingRules,
	rsvReservations,
	rsvServices,
	rsvTurnTimes,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, between, eq } from 'drizzle-orm'
import { formatMinutesToHHMM } from './rsv-day-feed-service.ts'

/**
 * Aggregates behind `/operator/reservations/reports/*`. Every figure is a
 * count, a sum or an average over reservations and waitlist entries of one
 * location and a business-date range. The queries select no guest column, so a
 * report body cannot carry a name, phone, email, note or allergy text.
 */

export const REPORT_KINDS = [
	'summary',
	'no-shows',
	'cancellations',
	'turn-times',
	'waitlist',
	'pacing',
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/** Longest range one run covers; keeps a run's memory bounded. */
export const REPORT_MAX_DAYS = 366

/** Statuses that never occupied a table, so they are not "bookings" in counts. */
const NOT_BOOKED = new Set(['cancelled', 'declined', 'expired'])

export type ReportRange = {
	locationId: string
	from: string
	to: string
	serviceId: string | null
}

type BookingRow = {
	id: string
	businessDate: string
	localStartMin: number
	serviceId: string | null
	partySize: number
	coversActual: number | null
	status: string
	channel: string
	durationMin: number
	seatedAt: number | null
	finishedAt: number | null
	cancelledAt: number | null
	cancelledBy: string | null
	lateCancel: boolean
}

const round1 = (value: number) => Math.round(value * 10) / 10

export function rangeDays(from: string, to: string): number {
	return (
		Math.round(
			(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
				86_400_000,
		) + 1
	)
}

async function loadBookings(db: TenantDatabase, range: ReportRange) {
	const rows = await db
		.select({
			id: rsvReservations.id,
			businessDate: rsvReservations.businessDate,
			localStartMin: rsvReservations.localStartMin,
			serviceId: rsvReservations.serviceId,
			partySize: rsvReservations.partySize,
			coversActual: rsvReservations.coversActual,
			status: rsvReservations.status,
			channel: rsvReservations.channel,
			durationMin: rsvReservations.durationMin,
			seatedAt: rsvReservations.seatedAt,
			finishedAt: rsvReservations.finishedAt,
			cancelledAt: rsvReservations.cancelledAt,
			cancelledBy: rsvReservations.cancelledBy,
			lateCancel: rsvReservations.lateCancel,
		})
		.from(rsvReservations)
		.where(
			and(
				eq(rsvReservations.locationId, range.locationId),
				between(rsvReservations.businessDate, range.from, range.to),
				range.serviceId
					? eq(rsvReservations.serviceId, range.serviceId)
					: undefined,
			),
		)
		.orderBy(rsvReservations.businessDate, rsvReservations.localStartMin)
	return rows satisfies BookingRow[]
}

/** Services of one location, for the report's service filter. */
export async function listReportServices(
	db: TenantDatabase,
	locationId: string,
) {
	const rows = await db
		.select({ id: rsvServices.id, name: rsvServices.name })
		.from(rsvServices)
		.where(eq(rsvServices.locationId, locationId))
	return rows.sort((a, b) => a.name.localeCompare(b.name))
}

async function serviceNames(db: TenantDatabase, locationId: string) {
	const rows = await db
		.select({ id: rsvServices.id, name: rsvServices.name })
		.from(rsvServices)
		.where(eq(rsvServices.locationId, locationId))
	return new Map(rows.map((row) => [row.id, row.name]))
}

function tally<T>(
	rows: readonly T[],
	key: (row: T) => string | number,
	covers: (row: T) => number,
) {
	const map = new Map<string | number, { parties: number; covers: number }>()
	for (const row of rows) {
		const k = key(row)
		const entry = map.get(k) ?? { parties: 0, covers: 0 }
		entry.parties += 1
		entry.covers += covers(row)
		map.set(k, entry)
	}
	return map
}

const coversOf = (row: BookingRow) => row.coversActual ?? row.partySize

export async function buildSummaryReport(
	db: TenantDatabase,
	range: ReportRange,
) {
	const [rows, names] = await Promise.all([
		loadBookings(db, range),
		serviceNames(db, range.locationId),
	])
	const booked = rows.filter((row) => !NOT_BOOKED.has(row.status))
	const byService = [...tally(booked, (row) => row.serviceId ?? '', coversOf)]
		.map(([serviceId, value]) => ({
			serviceId: serviceId === '' ? null : String(serviceId),
			name: serviceId === '' ? null : (names.get(String(serviceId)) ?? null),
			...value,
		}))
		.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
	const bySource = [...tally(booked, (row) => row.channel, coversOf)]
		.map(([channel, value]) => ({ channel: String(channel), ...value }))
		.sort((a, b) => a.channel.localeCompare(b.channel))
	const byPartySize = [...tally(booked, (row) => row.partySize, coversOf)]
		.map(([partySize, value]) => ({ partySize: Number(partySize), ...value }))
		.sort((a, b) => a.partySize - b.partySize)
	const byStatus = [...tally(rows, (row) => row.status, coversOf)]
		.map(([status, value]) => ({ status: String(status), ...value }))
		.sort((a, b) => a.status.localeCompare(b.status))
	return {
		totals: {
			parties: booked.length,
			covers: booked.reduce((sum, row) => sum + coversOf(row), 0),
		},
		byService,
		bySource,
		byPartySize,
		byStatus,
	}
}

export async function buildNoShowsReport(
	db: TenantDatabase,
	range: ReportRange,
) {
	const [rows, names] = await Promise.all([
		loadBookings(db, range),
		serviceNames(db, range.locationId),
	])
	const noShows = rows.filter((row) => row.status === 'no_show')
	const attempted = rows.filter((row) => !NOT_BOOKED.has(row.status))
	return {
		total: noShows.length,
		covers: noShows.reduce((sum, row) => sum + row.partySize, 0),
		rate:
			attempted.length === 0
				? 0
				: round1((noShows.length / attempted.length) * 100),
		byService: [
			...tally(
				noShows,
				(row) => row.serviceId ?? '',
				(r) => r.partySize,
			),
		].map(([serviceId, value]) => ({
			serviceId: serviceId === '' ? null : String(serviceId),
			name: serviceId === '' ? null : (names.get(String(serviceId)) ?? null),
			...value,
		})),
		byPartySize: [
			...tally(
				noShows,
				(row) => row.partySize,
				(r) => r.partySize,
			),
		]
			.map(([partySize, value]) => ({ partySize: Number(partySize), ...value }))
			.sort((a, b) => a.partySize - b.partySize),
		rows: noShows.map((row) => ({
			reservationId: row.id,
			businessDate: row.businessDate,
			time: formatMinutesToHHMM(row.localStartMin),
			serviceId: row.serviceId,
			service: row.serviceId ? (names.get(row.serviceId) ?? null) : null,
			partySize: row.partySize,
			channel: row.channel,
		})),
	}
}

export async function buildCancellationsReport(
	db: TenantDatabase,
	range: ReportRange,
) {
	const [rows, names] = await Promise.all([
		loadBookings(db, range),
		serviceNames(db, range.locationId),
	])
	const cancelled = rows.filter((row) => row.status === 'cancelled')
	const late = cancelled.filter((row) => row.lateCancel)
	return {
		total: cancelled.length,
		late: late.length,
		regular: cancelled.length - late.length,
		covers: cancelled.reduce((sum, row) => sum + row.partySize, 0),
		byCancelledBy: [
			...tally(
				cancelled,
				(row) => row.cancelledBy ?? 'unknown',
				(r) => r.partySize,
			),
		]
			.map(([by, value]) => ({ cancelledBy: String(by), ...value }))
			.sort((a, b) => a.cancelledBy.localeCompare(b.cancelledBy)),
		rows: cancelled.map((row) => ({
			reservationId: row.id,
			businessDate: row.businessDate,
			time: formatMinutesToHHMM(row.localStartMin),
			serviceId: row.serviceId,
			service: row.serviceId ? (names.get(row.serviceId) ?? null) : null,
			partySize: row.partySize,
			channel: row.channel,
			cancelledBy: row.cancelledBy,
			late: row.lateCancel,
			cancelledAt: row.cancelledAt,
		})),
	}
}

type TurnRule = {
	serviceId: string | null
	partyMin: number
	partyMax: number
	minutes: number
	daysMask: number | null
}

/** The configured turn time for a party size: a service rule beats a general one. */
export function configuredTurnMinutes(
	rules: readonly TurnRule[],
	partySize: number,
	serviceId: string | null,
	businessDate: string,
): number | null {
	const weekday = new Date(`${businessDate}T12:00:00Z`).getUTCDay()
	const fits = rules.filter(
		(rule) =>
			partySize >= rule.partyMin &&
			partySize <= rule.partyMax &&
			(rule.daysMask === null || (rule.daysMask & (1 << weekday)) !== 0),
	)
	const pick =
		fits.find(
			(rule) => rule.serviceId !== null && rule.serviceId === serviceId,
		) ?? fits.find((rule) => rule.serviceId === null)
	return pick?.minutes ?? null
}

export async function buildTurnTimesReport(
	db: TenantDatabase,
	range: ReportRange,
) {
	const [rows, rules] = await Promise.all([
		loadBookings(db, range),
		db
			.select({
				serviceId: rsvTurnTimes.serviceId,
				partyMin: rsvTurnTimes.partyMin,
				partyMax: rsvTurnTimes.partyMax,
				minutes: rsvTurnTimes.minutes,
				daysMask: rsvTurnTimes.daysMask,
			})
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.locationId, range.locationId)),
	])
	const measured = rows.filter(
		(row) =>
			row.status === 'finished' &&
			row.seatedAt !== null &&
			row.finishedAt !== null &&
			row.finishedAt >= row.seatedAt,
	)
	const buckets = new Map<
		number,
		{ rows: BookingRow[]; configured: Map<number, number> }
	>()
	for (const row of measured) {
		const bucket = buckets.get(row.partySize) ?? {
			rows: [],
			configured: new Map<number, number>(),
		}
		bucket.rows.push(row)
		const configured = configuredTurnMinutes(
			rules,
			row.partySize,
			row.serviceId,
			row.businessDate,
		)
		if (configured !== null) {
			bucket.configured.set(
				configured,
				(bucket.configured.get(configured) ?? 0) + 1,
			)
		}
		buckets.set(row.partySize, bucket)
	}
	const byPartySize = [...buckets.entries()]
		.map(([partySize, bucket]) => {
			const actual = bucket.rows.map(
				(row) => (row.finishedAt! - row.seatedAt!) / 60_000,
			)
			const actualAvg = actual.reduce((a, b) => a + b, 0) / actual.length
			const configured =
				[...bucket.configured.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
				null
			const bookedAvg =
				bucket.rows.reduce((sum, row) => sum + row.durationMin, 0) /
				bucket.rows.length
			return {
				partySize,
				count: bucket.rows.length,
				actualAvgMin: round1(actualAvg),
				configuredMin: configured,
				bookedAvgMin: round1(bookedAvg),
				varianceMin:
					configured === null ? null : round1(actualAvg - configured),
			}
		})
		.sort((a, b) => a.partySize - b.partySize)
	return {
		total: measured.length,
		actualAvgMin:
			measured.length === 0
				? 0
				: round1(
						measured.reduce(
							(sum, row) => sum + (row.finishedAt! - row.seatedAt!) / 60_000,
							0,
						) / measured.length,
					),
		byPartySize,
		configured: rules
			.map((rule) => ({
				serviceId: rule.serviceId,
				partyMin: rule.partyMin,
				partyMax: rule.partyMax,
				minutes: rule.minutes,
			}))
			.sort((a, b) => a.partyMin - b.partyMin),
	}
}

export async function buildWaitlistReport(
	db: TenantDatabase,
	range: ReportRange,
) {
	const rows = await db
		.select({
			id: rsvWaitlistEntries.id,
			businessDate: rsvWaitlistEntries.businessDate,
			joinedAt: rsvWaitlistEntries.joinedAt,
			partySize: rsvWaitlistEntries.partySize,
			channel: rsvWaitlistEntries.channel,
			status: rsvWaitlistEntries.status,
			quotedMin: rsvWaitlistEntries.quotedMin,
			seatedAt: rsvReservations.seatedAt,
		})
		.from(rsvWaitlistEntries)
		.leftJoin(
			rsvReservations,
			eq(rsvReservations.id, rsvWaitlistEntries.reservationId),
		)
		.where(
			and(
				eq(rsvWaitlistEntries.locationId, range.locationId),
				between(rsvWaitlistEntries.businessDate, range.from, range.to),
			),
		)
		.orderBy(rsvWaitlistEntries.joinedAt)
	const entries = rows.map((row) => ({
		entryId: row.id,
		businessDate: row.businessDate,
		joinedAt: row.joinedAt,
		partySize: row.partySize,
		channel: row.channel,
		outcome: row.status,
		quotedMin: row.quotedMin,
		actualMin:
			row.status === 'seated' && row.seatedAt !== null
				? Math.max(0, Math.round((row.seatedAt - row.joinedAt) / 60_000))
				: null,
	}))
	const quoted = entries.filter((e) => e.quotedMin !== null)
	const actual = entries.filter((e) => e.actualMin !== null)
	const avg = (values: number[]) =>
		values.length === 0
			? null
			: round1(values.reduce((a, b) => a + b, 0) / values.length)
	return {
		total: entries.length,
		byOutcome: [
			...tally(
				entries,
				(e) => e.outcome,
				(e) => e.partySize,
			),
		]
			.map(([outcome, value]) => ({ outcome: String(outcome), ...value }))
			.sort((a, b) => a.outcome.localeCompare(b.outcome)),
		quotedAvgMin: avg(quoted.map((e) => e.quotedMin!)),
		actualAvgMin: avg(actual.map((e) => e.actualMin!)),
		rows: entries,
	}
}

export async function buildPacingReport(
	db: TenantDatabase,
	range: ReportRange,
) {
	const [rows, names, services] = await Promise.all([
		loadBookings(db, range),
		serviceNames(db, range.locationId),
		db
			.select({ id: rsvServices.id })
			.from(rsvServices)
			.where(eq(rsvServices.locationId, range.locationId)),
	])
	const rules = (await db.select().from(rsvPacingRules)).filter((rule) =>
		services.some((service) => service.id === rule.serviceId),
	)
	const booked = rows.filter((row) => !NOT_BOOKED.has(row.status))
	const slots = new Map<
		string,
		{
			businessDate: string
			serviceId: string | null
			localStartMin: number
			bookings: number
			covers: number
		}
	>()
	for (const row of booked) {
		const key = `${row.businessDate}|${row.serviceId ?? ''}|${row.localStartMin}`
		const slot = slots.get(key) ?? {
			businessDate: row.businessDate,
			serviceId: row.serviceId,
			localStartMin: row.localStartMin,
			bookings: 0,
			covers: 0,
		}
		slot.bookings += 1
		slot.covers += coversOf(row)
		slots.set(key, slot)
	}
	const limitFor = (serviceId: string | null, minute: number) => {
		const matching = rules.filter(
			(rule) =>
				rule.serviceId === serviceId &&
				rule.channel === 'all' &&
				(rule.fromMin === null || minute >= rule.fromMin) &&
				(rule.toMin === null || minute < rule.toMin),
		)
		return {
			maxCovers:
				matching.find((rule) => rule.maxCovers !== null)?.maxCovers ?? null,
			maxParties:
				matching.find((rule) => rule.maxParties !== null)?.maxParties ?? null,
		}
	}
	const slotRows = [...slots.values()]
		.sort(
			(a, b) =>
				a.businessDate.localeCompare(b.businessDate) ||
				a.localStartMin - b.localStartMin,
		)
		.map((slot) => {
			const limit = limitFor(slot.serviceId, slot.localStartMin)
			return {
				businessDate: slot.businessDate,
				time: formatMinutesToHHMM(slot.localStartMin),
				localStartMin: slot.localStartMin,
				serviceId: slot.serviceId,
				service: slot.serviceId ? (names.get(slot.serviceId) ?? null) : null,
				bookings: slot.bookings,
				covers: slot.covers,
				...limit,
				overLimit:
					(limit.maxCovers !== null && slot.covers > limit.maxCovers) ||
					(limit.maxParties !== null && slot.bookings > limit.maxParties),
			}
		})
	const byService = [
		...tally(booked, (row) => row.serviceId ?? '', coversOf),
	].map(([serviceId, value]) => ({
		serviceId: serviceId === '' ? null : String(serviceId),
		name: serviceId === '' ? null : (names.get(String(serviceId)) ?? null),
		bookings: value.parties,
		covers: value.covers,
	}))
	return {
		totals: {
			bookings: booked.length,
			covers: booked.reduce((sum, row) => sum + coversOf(row), 0),
		},
		byService,
		slots: slotRows,
		limits: rules
			.filter((rule) => rule.channel === 'all')
			.map((rule) => ({
				serviceId: rule.serviceId,
				service: names.get(rule.serviceId) ?? null,
				fromMin: rule.fromMin,
				toMin: rule.toMin,
				bucketMin: rule.bucketMin,
				maxCovers: rule.maxCovers,
				maxParties: rule.maxParties,
			})),
	}
}

export async function buildReport(
	db: TenantDatabase,
	kind: ReportKind,
	range: ReportRange,
) {
	switch (kind) {
		case 'summary':
			return buildSummaryReport(db, range)
		case 'no-shows':
			return buildNoShowsReport(db, range)
		case 'cancellations':
			return buildCancellationsReport(db, range)
		case 'turn-times':
			return buildTurnTimesReport(db, range)
		case 'waitlist':
			return buildWaitlistReport(db, range)
		case 'pacing':
			return buildPacingReport(db, range)
	}
}

/**
 * Written before the answer leaves, so a run that cannot be recorded discloses
 * nothing. The row names the report, location and range; no guest data.
 */
export async function auditReportRun(
	db: TenantDatabase,
	input: { actorId: string; kind: ReportKind; range: ReportRange; now: number },
) {
	await db.insert(rsvAuditLog).values({
		id: `aud_${randomUUID()}`,
		at: input.now,
		actorKind: 'operator',
		actorId: input.actorId,
		locationId: input.range.locationId,
		action: 'report.run',
		entityType: 'report',
		entityId: input.kind,
		changes: {
			report: input.kind,
			from: input.range.from,
			to: input.range.to,
			serviceId: input.range.serviceId,
		},
	})
}
