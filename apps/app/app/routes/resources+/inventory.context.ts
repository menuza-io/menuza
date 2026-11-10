import { db, eq, and, Organization, OrganizationLocation } from '@repo/database'
import { inventoryContextSchema } from '@repo/inventory'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getInventoryFeatureState } from '#app/utils/inventory/access.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

/**
 * Internal machine-to-machine inventory context endpoint:
 * `GET /resources/inventory/context?orgId=<id>`
 *
 * Authenticated exclusively via `INTERNAL_COMMAND_TOKEN`
 * (`requireInternalCommandAuth`). Returns the organization's folded
 * `inventory.*` flags plus what the control plane knows about the
 * organization's money and days (`inventoryContextSchema`): each location's
 * time zone and tax settings and a currency hint. Stock, counts and suppliers
 * never leave the region. The regional tenant-api reads this path and keeps a
 * copy (`inv_location_settings`).
 *
 * Currency: the control plane has no per-location currency yet, so
 * `locations[].currency` is null and `organization.currency` is only the data
 * region's usual currency (a hint the region uses to label a quantity-only
 * delivery; it never overrides a location's own currency, which the first
 * priced delivery sets). A future per-location currency column plugs into
 * `locationCurrency` below.
 */

/** The data region's usual currency: a hint, never a location's currency. */
function regionCurrencyHint(dataRegion: string): string {
	return dataRegion === 'ksa' ? 'SAR' : 'USD'
}

/** A location's own currency when the control plane has one (none yet). */
function locationCurrency(_location: { id: string }): string | null {
	return null
}
export async function loader({ request }: LoaderFunctionArgs) {
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		// Machine-to-machine endpoint: the 401 from internal auth is the answer.
		if (error instanceof Response && error.status === 401) return error
		throw error
	}

	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid orgId' }, { status: 400 })
	}
	const { orgId } = parsed.data

	const [org] = await db
		.select({
			id: Organization.id,
			dataRegion: Organization.dataRegion,
			staffingTimeZone: Organization.staffingTimeZone,
		})
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)

	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}

	const [features, locations] = await Promise.all([
		getInventoryFeatureState(org.id),
		db
			.select({
				id: OrganizationLocation.id,
				timezone: OrganizationLocation.timezone,
				taxRate: OrganizationLocation.taxRate,
				taxInclusive: OrganizationLocation.taxInclusive,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, org.id))
			.limit(500),
	])
	const payload = inventoryContextSchema.parse({
		orgId: org.id,
		features,
		organization: {
			currency: regionCurrencyHint(org.dataRegion),
			timeZone: org.staffingTimeZone,
		},
		locations: locations.map((location) => ({
			id: location.id,
			currency: locationCurrency(location),
			timeZone: location.timezone,
			taxInclusive: location.taxInclusive,
			taxRatePercent: Math.min(100, Math.max(0, location.taxRate || 0)),
		})),
	})

	return Response.json(payload, {
		headers: {
			'Cache-Control': 'private, no-store',
		},
	})
}
