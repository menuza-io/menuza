import { getPageTitle } from '@repo/config/brand'
import { and, db, eq, Organization } from '@repo/database'
import {
	data,
	type LoaderFunctionArgs,
	type MetaFunction,
	useLoaderData,
} from 'react-router'
import {
	type KioskRegion,
	KioskTerminal,
} from '#app/components/staffing/kiosk-terminal.tsx'
import { getStaffingFlags } from '#app/utils/staffing/access.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

export const meta: MetaFunction = () => [
	{ title: getPageTitle('Time clock') },
	{ name: 'robots', content: 'noindex, nofollow' },
]

/**
 * Public shell for a shared time clock tablet. App serves only the page and
 * public organization metadata; PINs, names, and punches go from the tablet
 * straight to the organization's regional tenant-api. An unknown slug still
 * renders, because an already-paired tablet carries its own organization id
 * and must keep working if the slug is renamed.
 */
export async function loader({ params }: LoaderFunctionArgs) {
	const slug = params.orgSlug ?? ''
	const [organization] = slug
		? await db
				.select({
					id: Organization.id,
					name: Organization.name,
					dataRegion: Organization.dataRegion,
				})
				.from(Organization)
				.where(and(eq(Organization.slug, slug), eq(Organization.active, true)))
				.limit(1)
		: []
	let pairable = false
	if (organization) {
		const flags = await getStaffingFlags(organization.id)
		pairable = flags.enabled && flags.timeclock
	}
	return data(
		{
			organization:
				organization && pairable
					? {
							id: organization.id,
							name: organization.name,
							region: (organization.dataRegion === 'ksa'
								? 'ksa'
								: 'us') as KioskRegion,
						}
					: null,
			tenantApiUrls: {
				us: resolveRegionalTenantApiUrls('us').tenantApiUrl,
				ksa: resolveRegionalTenantApiUrls('ksa').tenantApiUrl,
			} satisfies Record<KioskRegion, string>,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

export default function KioskPage() {
	const { organization, tenantApiUrls } = useLoaderData<typeof loader>()
	return (
		<KioskTerminal organization={organization} tenantApiUrls={tenantApiUrls} />
	)
}
