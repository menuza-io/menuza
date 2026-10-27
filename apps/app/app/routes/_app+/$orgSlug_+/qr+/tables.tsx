import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { and, asc, db, eq, OrganizationLocation } from '@repo/database'
import { Button } from '@repo/ui/button'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { TablesManager } from '#app/components/qr/tables-manager.tsx'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { getPrintShopFeatures } from '#app/utils/print/access.server.ts'
import { requireQrOrderingAccess } from '#app/utils/qr/access.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireQrOrderingAccess(request, params.orgSlug)
	const organizationId = access.organization.id
	const [locations, printShop, canDesignPrints] = await Promise.all([
		db
			.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
				),
			)
			.orderBy(asc(OrganizationLocation.name)),
		getPrintShopFeatures(organizationId),
		userHasOrganizationPermission(
			access.userId,
			organizationId,
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
		),
	])
	return {
		orgSlug: access.organization.slug,
		canWrite: access.canWrite,
		dineIn: access.features.dineIn,
		floorPlanAvailable: access.floorPlanAvailable,
		locations,
		printHref:
			printShop.enabled && canDesignPrints
				? `/${access.organization.slug}/marketing/print/new`
				: null,
	}
}

export default function QrTablesRoute() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`QR tables`)}
				description={
					data.dineIn
						? _(
								msg`Guests scan the code on their table to order rounds and pay once when they leave.`,
							)
						: _(
								msg`Set up your tables now. Ordering at the table turns on when it is enabled for your organization.`,
							)
				}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/qr/settings`} />}
					>
						{_(msg`Settings`)}
					</Button>
				}
			/>
			{data.locations.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{_(msg`Add a location before you add tables.`)}
				</p>
			) : (
				<TablesManager
					orgSlug={data.orgSlug}
					locations={data.locations}
					canWrite={data.canWrite}
					floorPlanAvailable={data.floorPlanAvailable}
					printHref={data.printHref}
				/>
			)}
		</div>
	)
}
