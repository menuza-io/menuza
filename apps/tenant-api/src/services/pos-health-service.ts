import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	lte,
	sql,
} from 'drizzle-orm'
import {
	HEALTH_DETAIL_DAYS,
	HEALTH_STRIP_DAYS,
	minuteBucket,
	presenceIntervals,
	utcDay,
	type Heartbeat,
	type Interval,
} from '@repo/common/device-health'
import {
	posDeviceHealthDaily,
	posDeviceHeartbeats,
	posDevices,
	posShifts,
	type PosDevice,
	type TenantDatabase,
} from '@repo/tenant-db'
import { forEachInChunks, inJsonList } from '../lib/chunked-in.ts'

const DAY = 24 * 60 * 60 * 1000
/** Daily summaries are kept this long (a year and a bit). */
const DAILY_RETENTION_DAYS = 400

/** Stores one heartbeat in the terminal's current minute (a repeat overwrites it). */
export async function recordHeartbeat(
	db: TenantDatabase,
	device: Pick<PosDevice, 'id'>,
	heartbeat: Heartbeat,
	now = Date.now(),
) {
	const values = {
		deviceId: device.id,
		minuteBucket: minuteBucket(now),
		appVersion: heartbeat.appVersion ?? null,
		browser: heartbeat.browser ?? null,
		batteryPct: heartbeat.batteryPct ?? null,
		charging: heartbeat.charging ?? null,
		storageUsedMb: heartbeat.storageUsedMb ?? null,
		storageQuotaMb: heartbeat.storageQuotaMb ?? null,
		pendingUploads: heartbeat.pendingUploads ?? null,
		lastUploadAt: heartbeat.lastUploadAt ?? null,
		printerState: heartbeat.printerState ?? null,
		drawerOpenedAt: heartbeat.drawerOpenedAt ?? null,
		drawerShiftId: heartbeat.drawerShiftId ?? null,
	}
	await db
		.insert(posDeviceHeartbeats)
		.values(values)
		.onConflictDoUpdate({
			target: [posDeviceHeartbeats.deviceId, posDeviceHeartbeats.minuteBucket],
			set: values,
		})
}

type SummaryDevice = {
	id: string
	label: string
	terminalCode: string
	locationId: string | null
	revokedAt: number | null
}

/** A removed terminal keeps its history this long, read-only. */
const REVOKED_HISTORY_MS = HEALTH_DETAIL_DAYS * DAY

async function firstSeenAt(
	db: TenantDatabase,
	deviceIds: string[],
): Promise<Map<string, number>> {
	const out = new Map<string, number>()
	if (deviceIds.length === 0) return out
	const minutes = await db
		.select({
			deviceId: posDeviceHeartbeats.deviceId,
			first: sql<number>`min(${posDeviceHeartbeats.minuteBucket})`,
		})
		.from(posDeviceHeartbeats)
		.where(inJsonList(posDeviceHeartbeats.deviceId, deviceIds))
		.groupBy(posDeviceHeartbeats.deviceId)
	for (const row of minutes) out.set(row.deviceId, Number(row.first))
	const days = await db
		.select({
			deviceId: posDeviceHealthDaily.deviceId,
			first: sql<number>`min(${posDeviceHealthDaily.firstAt})`,
		})
		.from(posDeviceHealthDaily)
		.where(inJsonList(posDeviceHealthDaily.deviceId, deviceIds))
		.groupBy(posDeviceHealthDaily.deviceId)
	for (const row of days) {
		const first = Number(row.first)
		const seen = out.get(row.deviceId)
		if (seen === undefined || first < seen) out.set(row.deviceId, first)
	}
	return out
}

/**
 * Every terminal's last week as merged check-in intervals (the App turns them
 * into outages with the location's opening hours). Removed terminals appear
 * for 30 days after they were removed.
 */
export async function healthSummary(db: TenantDatabase, now = Date.now()) {
	const devices = (await db
		.select({
			id: posDevices.id,
			label: posDevices.label,
			terminalCode: posDevices.terminalCode,
			locationId: posDevices.locationId,
			revokedAt: posDevices.revokedAt,
		})
		.from(posDevices)
		.orderBy(asc(posDevices.createdAt))) as SummaryDevice[]
	const shown = devices.filter(
		(d) => d.revokedAt === null || now - d.revokedAt < REVOKED_HISTORY_MS,
	)
	const fromMs = now - HEALTH_STRIP_DAYS * DAY
	const ids = shown.map((d) => d.id)
	const rows = ids.length
		? await db
				.select({
					deviceId: posDeviceHeartbeats.deviceId,
					bucket: posDeviceHeartbeats.minuteBucket,
				})
				.from(posDeviceHeartbeats)
				.where(
					and(
						inJsonList(posDeviceHeartbeats.deviceId, ids),
						gte(posDeviceHeartbeats.minuteBucket, minuteBucket(fromMs)),
					),
				)
				.orderBy(asc(posDeviceHeartbeats.minuteBucket))
		: []
	const buckets = new Map<string, number[]>()
	for (const row of rows) {
		const list = buckets.get(row.deviceId) ?? []
		list.push(row.bucket)
		buckets.set(row.deviceId, list)
	}
	const seen = await firstSeenAt(db, ids)
	return {
		now,
		fromMs,
		devices: shown.map((device) => ({
			...device,
			firstSeenAt: seen.get(device.id) ?? null,
			presence: presenceIntervals(buckets.get(device.id) ?? []) as Interval[],
		})),
	}
}

/** One terminal: the week's check-ins, the last heartbeat, older days and its last shift. */
export async function deviceHealth(
	db: TenantDatabase,
	deviceId: string,
	now = Date.now(),
) {
	const [device] = await db
		.select({
			id: posDevices.id,
			label: posDevices.label,
			terminalCode: posDevices.terminalCode,
			locationId: posDevices.locationId,
			revokedAt: posDevices.revokedAt,
		})
		.from(posDevices)
		.where(eq(posDevices.id, deviceId))
		.limit(1)
	if (!device) return null
	if (device.revokedAt !== null && now - device.revokedAt >= REVOKED_HISTORY_MS)
		return null
	const fromMs = now - HEALTH_STRIP_DAYS * DAY
	const [week, latestRows, daily, shifts, seen] = await Promise.all([
		db
			.select({ bucket: posDeviceHeartbeats.minuteBucket })
			.from(posDeviceHeartbeats)
			.where(
				and(
					eq(posDeviceHeartbeats.deviceId, deviceId),
					gte(posDeviceHeartbeats.minuteBucket, minuteBucket(fromMs)),
				),
			)
			.orderBy(asc(posDeviceHeartbeats.minuteBucket)),
		db
			.select()
			.from(posDeviceHeartbeats)
			.where(eq(posDeviceHeartbeats.deviceId, deviceId))
			.orderBy(desc(posDeviceHeartbeats.minuteBucket))
			.limit(1),
		db
			.select()
			.from(posDeviceHealthDaily)
			.where(eq(posDeviceHealthDaily.deviceId, deviceId))
			.orderBy(desc(posDeviceHealthDaily.day))
			.limit(90),
		db
			.select({ id: posShifts.id, openedAt: posShifts.openedAt })
			.from(posShifts)
			.where(eq(posShifts.deviceId, deviceId))
			.orderBy(desc(posShifts.openedAt))
			.limit(1),
		firstSeenAt(db, [deviceId]),
	])
	const latest = latestRows[0] ?? null
	return {
		now,
		fromMs,
		device,
		firstSeenAt: seen.get(deviceId) ?? null,
		presence: presenceIntervals(week.map((row) => row.bucket)) as Interval[],
		latest: latest
			? {
					at: latest.minuteBucket,
					appVersion: latest.appVersion,
					browser: latest.browser,
					batteryPct: latest.batteryPct,
					charging: latest.charging,
					storageUsedMb: latest.storageUsedMb,
					storageQuotaMb: latest.storageQuotaMb,
					pendingUploads: latest.pendingUploads,
					lastUploadAt: latest.lastUploadAt,
					// Only what the till really reported.
					printerState: latest.printerState,
					drawerOpenedAt: latest.drawerOpenedAt,
					drawerShiftId: latest.drawerShiftId,
				}
			: null,
		/** The cash drawer shift this terminal opened last (an id and a time). */
		lastShiftOpened: shifts[0]
			? { id: shifts[0].id, openedAt: shifts[0].openedAt }
			: null,
		daily: daily.map((row) => ({
			day: row.day,
			heartbeats: row.heartbeats,
			firstAt: row.firstAt,
			lastAt: row.lastAt,
			appVersion: row.appVersion,
		})),
	}
}

/**
 * Keeps minutes for 30 days: older ones are summarized per UTC day and
 * deleted. Summaries older than a year go too, and so does everything of a
 * terminal removed more than 30 days ago.
 */
export async function rollupDeviceHealth(db: TenantDatabase, now = Date.now()) {
	const cutoff = minuteBucket(now - HEALTH_DETAIL_DAYS * DAY)
	const old = await db
		.select({
			deviceId: posDeviceHeartbeats.deviceId,
			bucket: posDeviceHeartbeats.minuteBucket,
			appVersion: posDeviceHeartbeats.appVersion,
			batteryPct: posDeviceHeartbeats.batteryPct,
			pendingUploads: posDeviceHeartbeats.pendingUploads,
		})
		.from(posDeviceHeartbeats)
		.where(lt(posDeviceHeartbeats.minuteBucket, cutoff))
		.orderBy(asc(posDeviceHeartbeats.minuteBucket))
		.limit(50_000)
	if (old.length > 0) {
		const days = new Map<
			string,
			{
				deviceId: string
				day: string
				heartbeats: number
				firstAt: number
				lastAt: number
				appVersion: string | null
				minBatteryPct: number | null
				maxPendingUploads: number | null
			}
		>()
		for (const row of old) {
			const day = utcDay(row.bucket)
			const key = `${row.deviceId}|${day}`
			const entry = days.get(key)
			if (!entry) {
				days.set(key, {
					deviceId: row.deviceId,
					day,
					heartbeats: 1,
					firstAt: row.bucket,
					lastAt: row.bucket,
					appVersion: row.appVersion,
					minBatteryPct: row.batteryPct,
					maxPendingUploads: row.pendingUploads,
				})
				continue
			}
			entry.heartbeats += 1
			entry.lastAt = Math.max(entry.lastAt, row.bucket)
			entry.appVersion = row.appVersion ?? entry.appVersion
			if (row.batteryPct !== null)
				entry.minBatteryPct =
					entry.minBatteryPct === null
						? row.batteryPct
						: Math.min(entry.minBatteryPct, row.batteryPct)
			if (row.pendingUploads !== null)
				entry.maxPendingUploads = Math.max(
					entry.maxPendingUploads ?? 0,
					row.pendingUploads,
				)
		}
		for (const entry of days.values()) {
			await db
				.insert(posDeviceHealthDaily)
				.values(entry)
				.onConflictDoUpdate({
					target: [posDeviceHealthDaily.deviceId, posDeviceHealthDaily.day],
					set: {
						heartbeats: sql`${posDeviceHealthDaily.heartbeats} + ${entry.heartbeats}`,
						firstAt: sql`min(${posDeviceHealthDaily.firstAt}, ${entry.firstAt})`,
						lastAt: sql`max(${posDeviceHealthDaily.lastAt}, ${entry.lastAt})`,
						appVersion: entry.appVersion,
					},
				})
		}
		// Only what was summarized: a long backlog is taken in batches.
		await db
			.delete(posDeviceHeartbeats)
			.where(lte(posDeviceHeartbeats.minuteBucket, old[old.length - 1]!.bucket))
	}
	await db
		.delete(posDeviceHealthDaily)
		.where(
			lt(posDeviceHealthDaily.day, utcDay(now - DAILY_RETENTION_DAYS * DAY)),
		)
	// A terminal removed more than 30 days ago keeps nothing.
	const gone = await db
		.select({ id: posDevices.id })
		.from(posDevices)
		.where(
			and(
				isNotNull(posDevices.revokedAt),
				lt(posDevices.revokedAt, now - REVOKED_HISTORY_MS),
			),
		)
	if (gone.length > 0) {
		await forEachInChunks(
			gone.map((d) => d.id),
			async (ids) => {
				await db
					.delete(posDeviceHeartbeats)
					.where(inArray(posDeviceHeartbeats.deviceId, ids))
				await db
					.delete(posDeviceHealthDaily)
					.where(inArray(posDeviceHealthDaily.deviceId, ids))
			},
		)
	}
	return { summarized: old.length }
}
