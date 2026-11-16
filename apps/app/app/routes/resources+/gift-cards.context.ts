import { giftCardContextSchema } from '@repo/common/gift-cards'
import { and, db, eq, Organization, OrganizationLocation } from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { getGiftCardFeatureState } from '#app/utils/gift-cards/access.server.ts'
import { loadGiftCardSettings } from '#app/utils/gift-cards/settings.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

const querySchema = z.object({
	orgId: z.string().min(1).max(64).regex(TENANT_ORG_ID_PATTERN),
})

/**
 * Internal machine-to-machine gift card context:
 * `GET /resources/gift-cards/context?orgId=<id>`, authenticated only with
 * `INTERNAL_COMMAND_TOKEN`. Returns the organization's folded `gift_cards.*`
 * flags, its settings (presets, bounds, designs, purchase limits), the card
 * currency and its locations' names and time zones. Never a card, a code, a
 * balance or a person: those stay in the region.
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
	if (!parsed.success) {
		return Response.json({ error: 'Invalid orgId' }, { status: 400 })
	}
	const { orgId } = parsed.data
	const [org] = await db
		.select({ id: Organization.id, dataRegion: Organization.dataRegion })
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)
	if (!org) {
		return Response.json({ error: 'Organization not found' }, { status: 404 })
	}
	const [features, settings, locations] = await Promise.all([
		getGiftCardFeatureState(org.id),
		loadGiftCardSettings(org.id),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timezone: OrganizationLocation.timezone,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, org.id))
			.limit(500),
	])
	const payload = giftCardContextSchema.parse({
		orgId: org.id,
		features,
		settings,
		currency: org.dataRegion === 'ksa' ? 'SAR' : 'USD',
		locations: locations.map((location) => ({
			id: location.id,
			name: location.name,
			timeZone: location.timezone,
		})),
	})
	return Response.json(payload, { headers: { 'Cache-Control': 'private, no-store' } })
}
