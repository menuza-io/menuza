import { auditService, AuditAction } from '@repo/audit'
import {
	type StationControlsRequest,
	stationControlsRequestSchema,
	type StationControlsResult,
	stationControlsResultSchema,
} from '@repo/common/pos-station-controls'
import { and, db, eq, Organization, OrganizationLocation } from '@repo/database'
import { type ActionFunctionArgs } from 'react-router'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import {
	applyOrderingControl,
	loadOrderingControls,
} from '#app/utils/location/ordering-controls.server.ts'
import { applyMenuAvailability } from '#app/utils/menu/location-availability.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function answer(result: StationControlsResult) {
	return Response.json(stationControlsResultSchema.parse(result), {
		headers: NO_STORE,
	})
}

function failure(status: number, error: string) {
	return Response.json({ error }, { status, headers: NO_STORE })
}

const toMs = (iso: string | null) => (iso === null ? null : Date.parse(iso))

async function pauseAt(organizationId: string, locationId: string) {
	const location = (await loadOrderingControls(organizationId)).find(
		(entry) => entry.id === locationId,
	)
	if (!location?.pausedAt) return null
	return {
		pausedAt: toMs(location.pausedAt),
		until: toMs(location.pausedUntil),
	}
}

/**
 * `POST /resources/pos/station-controls`: Station's manager controls, asked
 * for by the regional tenant-api after it checked the terminal, its location,
 * the person's sign-in and their till role (`/pos/online-orders/controls`).
 *
 * Authenticated with `INTERNAL_COMMAND_TOKEN` only. The request is ids, a
 * duration and a boolean (`stationControlsRequestSchema`, strict): no names,
 * phones or emails cross from the region.
 *
 * - `state`: the location's pause now.
 * - `pause` / `resume`: the App's own writer (`applyOrderingControl`): same
 *   presets and end-time math, site cache purge and activity log as the
 *   Orders page. Only the terminal's location changes.
 * - `availability`: the same writer inventory's auto sold out uses, by hand:
 *   this location's override (or the dish itself without locations). Logged
 *   in the activity log; the site cache is purged so Sites and QR show it at
 *   once and Station at its next menu refresh.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const parsed = stationControlsRequestSchema.safeParse(
		await request.json().catch(() => null),
	)
	if (!parsed.success) return failure(400, 'invalid_request')
	const input: StationControlsRequest = parsed.data

	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, input.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true },
	})
	if (!organization) return failure(404, 'org_not_found')
	const location = await db.query.OrganizationLocation.findFirst({
		where: and(
			eq(OrganizationLocation.id, input.locationId),
			eq(OrganizationLocation.organizationId, organization.id),
			// A deactivated location takes no pause or sold-out marks.
			eq(OrganizationLocation.isActive, true),
		),
		columns: { id: true },
	})
	if (!location) return failure(404, 'location_not_found')

	switch (input.kind) {
		case 'state':
			break
		case 'pause':
		case 'resume': {
			const result = await applyOrderingControl({
				organization,
				userId: null,
				source: { kind: 'station', ...input.actor },
				control:
					input.kind === 'pause'
						? {
								intent: 'pause',
								locationId: location.id,
								duration: input.duration,
							}
						: { intent: 'resume', locationId: location.id },
				request,
			})
			if (!result.ok) return failure(result.status, result.error)
			break
		}
		case 'availability': {
			const changed = await applyMenuAvailability({
				organizationId: organization.id,
				locationId: location.id,
				change: {
					entityType: input.entityType,
					entityId: input.entityId,
					available: input.available,
				},
				by: 'hand',
			})
			if (changed) {
				await purgeOrganizationSiteCache(organization.id, organization.slug)
				await auditService.log({
					action: AuditAction.MENU_ITEM_UPDATED,
					userId: null,
					organizationId: organization.id,
					resourceType:
						input.entityType === 'item' ? 'menu_item' : 'menu_option',
					resourceId: input.entityId,
					details: input.available
						? 'Back on the menu at a location (from Station)'
						: 'Marked sold out at a location (from Station)',
					metadata: {
						locationId: location.id,
						available: input.available,
						source: { kind: 'station', ...input.actor },
					},
					request,
				})
			}
			return answer({
				pause: await pauseAt(organization.id, location.id),
				changed,
			})
		}
	}
	return answer({ pause: await pauseAt(organization.id, location.id) })
}
