import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	and,
	asc,
	db,
	eq,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'
import { buildEmailIdentity } from '#app/utils/email-sender/sender.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { orgSiteUrl } from '#app/utils/launch/launch.server.ts'
import { isGuestPhotosEnabledForOrganization } from '#app/utils/menu/guest-photos.server.ts'

const querySchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
})

export async function loader({ request }: LoaderFunctionArgs) {
	await requireInternalCommandAuth(request)
	const parsed = querySchema.safeParse(
		Object.fromEntries(new URL(request.url).searchParams),
	)
	if (!parsed.success) {
		return Response.json({ error: 'Invalid organization ID' }, { status: 400 })
	}

	const [organization] = await db
		.select({
			id: Organization.id,
			slug: Organization.slug,
			name: Organization.name,
			customDomain: Organization.customDomain,
			dataRegion: Organization.dataRegion,
			hasProvisionedDb: Organization.hasProvisionedDb,
			staffingTimeZone: Organization.staffingTimeZone,
		})
		.from(Organization)
		.where(
			and(
				eq(Organization.id, parsed.data.orgId),
				eq(Organization.active, true),
			),
		)
		.limit(1)

	if (!organization) {
		return Response.json(
			{ error: 'Organization not found' },
			{ status: 404, headers: { 'Cache-Control': 'private, no-store' } },
		)
	}
	// What the region needs to word and time a marketing text (#75, #159):
	// time zones (business data, never a guest's) for the 9:00 to 20:00 window,
	// the public site origin short links are made on, and the short-link flag.
	const locations = await db
		.select({ id: OrganizationLocation.id, timezone: OrganizationLocation.timezone })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
		.orderBy(asc(OrganizationLocation.createdAt))
	const shortLinks = await getFeatureFlag('marketing.short_links', {
		organizationId: organization.id,
	})
	// Business identity only (#103): the sender name, a verified reply-to and a
	// verified sending address, so the region sends as the organization.
	const { staffingTimeZone, ...publicOrganization } = organization
	return Response.json(
		{
			...publicOrganization,
			timeZone: locations[0]?.timezone ?? staffingTimeZone,
			locationTimeZones: Object.fromEntries(
				locations.map((location) => [location.id, location.timezone]),
			),
			siteOrigin: orgSiteUrl(organization),
			features: { shortLinks: shortLinks === true || shortLinks === 'true' },
			emailSender: await buildEmailIdentity(organization.id),
			guestPhotosEnabled:
				await isGuestPhotosEnabledForOrganization(organization),
		},
		{ status: 200, headers: { 'Cache-Control': 'private, no-store' } },
	)
}
