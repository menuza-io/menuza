import { getLocationCurrency } from '@repo/common/location-currency'
import { onlineOpenWindows } from '@repo/common/ordering-hours'
import {
	ORDERING_HISTORY_MAX_RANGE_MS,
	orderingHistorySchema,
} from '@repo/common/ordering-history'
import { and, db, eq, Organization, OrganizationLocation } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { loadPauseHistory } from '#app/utils/location/ordering-pause-history.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
	from: z.coerce.number().int().positive(),
	to: z.coerce.number().int().positive(),
})

function parseJson(value: string | null): unknown {
	if (!value) return undefined
	try {
		return JSON.parse(value) as unknown
	} catch {
		return undefined
	}
}

/**
 * Internal machine-to-machine online ordering history endpoint:
 * `GET /resources/report/ordering-history?orgId=<id>&from=<ms>&to=<ms>`
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN`. Gives the regional
 * tenant-api, per location, the scheduled online hours, the staff pauses (an
 * open one ends at `to`) and the closures taken at short notice, as time
 * windows (#176, #405). The region joins them with sales and sold-out history
 * it holds itself; only windows leave the control plane and only totals come
 * back. Times only: no guest data. Pauses that ran out by themselves are
 * closed at their own end before they are read.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (
		!parsed.success ||
		parsed.data.to <= parsed.data.from ||
		parsed.data.to - parsed.data.from > ORDERING_HISTORY_MAX_RANGE_MS
	) {
		return Response.json({ error: 'Invalid query' }, { status: 400 })
	}
	const { orgId, from, to } = parsed.data
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)
	if (!organization) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}
	const [locations, history] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timezone: OrganizationLocation.timezone,
				address: OrganizationLocation.address,
				isActive: OrganizationLocation.isActive,
				storeHours: OrganizationLocation.storeHours,
				onlineHours: OrganizationLocation.onlineHours,
				specialHours: OrganizationLocation.specialHours,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, orgId))
			.limit(500),
		loadPauseHistory(orgId, { from: new Date(from), to: new Date(to) }),
	])
	const payload = orderingHistorySchema.parse({
		orgId,
		locations: locations.map((location) => {
			const mine = history.filter((row) => row.locationId === location.id)
			const clip = (row: (typeof mine)[number]) => ({
				from: Math.max(from, row.startedAt.getTime()),
				to: Math.min(to, row.endedAt ? row.endedAt.getTime() : to),
			})
			return {
				id: location.id,
				name: location.name,
				timezone: location.timezone || 'UTC',
				currency: getLocationCurrency(location.address),
				openWindows: onlineOpenWindows(
					{
						timeZone: location.timezone || 'UTC',
						isActive: location.isActive,
						storeHours: parseJson(location.storeHours),
						onlineHours: parseJson(location.onlineHours),
						specialHours: parseJson(location.specialHours),
					},
					{ from, to },
				),
				pauses: mine
					.filter((row) => row.kind === 'pause')
					.map(clip)
					.filter((window) => window.to > window.from),
				closures: mine
					.filter((row) => row.kind === 'closure')
					.map(clip)
					.filter((window) => window.to > window.from),
			}
		}),
	})
	return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
