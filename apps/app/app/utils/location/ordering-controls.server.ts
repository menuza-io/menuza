import { auditService, AuditAction } from '@repo/audit'
import {
	type SpecialHour,
	type WeeklySchedule,
} from '@repo/common/location-types'
import { and, asc, db, desc, eq, OrganizationLocation } from '@repo/database'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	type LocationOrderingControl,
	type OrderingControlInput,
	publicOrderingControls,
	resolveControlUntil,
} from './ordering-pause.ts'

function parseJson<T>(value: string | null): T | null {
	if (!value) return null
	try {
		return JSON.parse(value) as T
	} catch {
		return null
	}
}

/** Active locations with their pause and busy state at `now`. */
export async function loadOrderingControls(
	organizationId: string,
	now: Date = new Date(),
): Promise<LocationOrderingControl[]> {
	const rows = await db
		.select({
			id: OrganizationLocation.id,
			name: OrganizationLocation.name,
			timezone: OrganizationLocation.timezone,
			prepTime: OrganizationLocation.prepTime,
			orderingPausedAt: OrganizationLocation.orderingPausedAt,
			orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
			busyExtraPrepMinutes: OrganizationLocation.busyExtraPrepMinutes,
			busyUntil: OrganizationLocation.busyUntil,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organizationId),
				eq(OrganizationLocation.isActive, true),
			),
		)
		.orderBy(
			desc(OrganizationLocation.isDefault),
			asc(OrganizationLocation.name),
		)
	return rows.map((row) => {
		const { orderingPause, busyMode } = publicOrderingControls(row, now)
		return {
			id: row.id,
			name: row.name,
			timezone: row.timezone || 'UTC',
			prepTime: row.prepTime,
			pausedAt: orderingPause
				? (row.orderingPausedAt?.toISOString() ?? null)
				: null,
			pausedUntil: orderingPause?.until ?? null,
			busyExtraPrepMinutes: busyMode?.extraPrepMinutes ?? 0,
			busyUntil: busyMode?.until ?? null,
		}
	})
}

export type ApplyOrderingControlResult =
	{ ok: true } | { ok: false; status: 404; error: 'location_not_found' }

/**
 * Pauses or resumes online ordering, or turns busy mode on or off, for one
 * location of the organization. The caller has already checked menu write
 * access. Purges the published site cache so Sites shows the change at once;
 * the region reads the order context live on every quote and order.
 */
export async function applyOrderingControl(input: {
	organization: { id: string; slug: string }
	userId: string
	control: OrderingControlInput
	request: Request
	now?: Date
}): Promise<ApplyOrderingControlResult> {
	const now = input.now ?? new Date()
	const { control, organization } = input
	const [location] = await db
		.select({
			id: OrganizationLocation.id,
			timezone: OrganizationLocation.timezone,
			onlineHours: OrganizationLocation.onlineHours,
			storeHours: OrganizationLocation.storeHours,
			specialHours: OrganizationLocation.specialHours,
		})
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.id, control.locationId),
			),
		)
		.limit(1)
	if (!location) {
		return { ok: false, status: 404, error: 'location_not_found' }
	}
	const hours = {
		timezone: location.timezone,
		onlineHours: parseJson<WeeklySchedule>(location.onlineHours),
		storeHours: parseJson<WeeklySchedule>(location.storeHours),
		specialHours: parseJson<SpecialHour[]>(location.specialHours),
	}

	let set: Partial<typeof OrganizationLocation.$inferInsert>
	let action: AuditAction
	let details: string
	let metadata: Record<string, unknown>
	switch (control.intent) {
		case 'pause': {
			const until = resolveControlUntil(control.duration, hours, now)
			set = { orderingPausedAt: now, orderingPausedUntil: until }
			action = AuditAction.LOCATION_ORDERING_PAUSED
			details = 'Online ordering paused'
			metadata = {
				duration: control.duration,
				until: until?.toISOString() ?? null,
			}
			break
		}
		case 'resume':
			set = { orderingPausedAt: null, orderingPausedUntil: null }
			action = AuditAction.LOCATION_ORDERING_RESUMED
			details = 'Online ordering resumed'
			metadata = {}
			break
		case 'busy': {
			const until = resolveControlUntil(control.duration, hours, now)
			set = { busyExtraPrepMinutes: control.minutes, busyUntil: until }
			action = AuditAction.LOCATION_BUSY_MODE_CHANGED
			details = `Busy mode on: +${control.minutes} minutes`
			metadata = {
				minutes: control.minutes,
				duration: control.duration,
				until: until?.toISOString() ?? null,
			}
			break
		}
		case 'busy_off':
			set = { busyExtraPrepMinutes: null, busyUntil: null }
			action = AuditAction.LOCATION_BUSY_MODE_CHANGED
			details = 'Busy mode off'
			metadata = { minutes: 0 }
			break
	}

	await db
		.update(OrganizationLocation)
		.set(set)
		.where(
			and(
				eq(OrganizationLocation.organizationId, organization.id),
				eq(OrganizationLocation.id, location.id),
			),
		)
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await auditService.log({
		action,
		userId: input.userId,
		organizationId: organization.id,
		details,
		metadata,
		request: input.request,
		resourceType: 'organization_location',
		resourceId: location.id,
	})
	return { ok: true }
}
