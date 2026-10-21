import { currentBusinessDate, isValidTimeZone } from '@repo/reservations'
import { getTenantDb, rsvLocationSettings } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'

type TenantDb = Awaited<ReturnType<typeof getTenantDb>>

/**
 * The business date "now" falls on for a location, in the location's own time
 * zone and day-start minute. The UTC calendar date is wrong for most of the
 * evening west of UTC and for the early hours east of it.
 */
export async function getLocationBusinessDate(
	db: TenantDb,
	locationId: string,
	nowMs: number = Date.now(),
): Promise<string> {
	const settings = await db
		.select({
			timeZone: rsvLocationSettings.timeZone,
			dayStartMin: rsvLocationSettings.dayStartMin,
		})
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	const timeZone =
		settings?.timeZone && isValidTimeZone(settings.timeZone)
			? settings.timeZone
			: 'UTC'
	return currentBusinessDate(nowMs, timeZone, settings?.dayStartMin ?? 240)
}

export async function resolveBusinessDate(
	orgId: string,
	locationId: string,
	explicit?: string | null,
): Promise<string> {
	if (explicit) return explicit
	return getLocationBusinessDate(await getTenantDb(orgId), locationId)
}
