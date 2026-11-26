import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageTitle } from '@repo/ui/page-title'
import {
	data,
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'
import { CateringPanel } from '#app/components/orders/catering-panel.tsx'
import { getCateringFeatures } from '#app/utils/catering/catering-context.server.ts'
import { loadCateringTabData } from '#app/utils/catering/catering-loader.server.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { ordersHref } from '#app/utils/orders/orders-link.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

/**
 * Orders, Catering (#124): catering orders and quote requests. The shell
 * (permissions, flags, the member's locations and the catering dishes) loads
 * here; the orders and quotes load in the browser from the regional API with
 * the orders token, so a guest's name, notes and address never transit this
 * server. Answers 404 while `catering.enabled` is off.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		name: true,
		slug: true,
		dataRegion: true,
		siteDefaultLocale: true,
		siteLocales: true,
		customDomain: true,
		siteIconKey: true,
	})
	const userId = await requireMenuRead(request, organization.id)
	const features = await getCateringFeatures(organization.id)
	if (!features.enabled) throw new Response('Not found', { status: 404 })
	const canWrite = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	const { locations, dishes } = await loadCateringTabData({
		organization,
		userId,
	})
	return data(
		{
			orgSlug,
			canWrite,
			quotesEnabled: features.quotes,
			locations,
			dishes,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export default function OrdersCatering() {
	const { orgSlug, canWrite, quotesEnabled, locations, dishes } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 py-8 md:px-6 lg:px-8">
			<div className="flex items-start justify-between gap-4">
				<PageTitle
					title={_(msg`Catering`)}
					description={_(
						msg`Catering orders with their event dates, and quote requests to price and send.`,
					)}
				/>
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link to={ordersHref(orgSlug)} />}
				>
					<Icon name="arrow-left" className="size-4 rtl:rotate-180" />
					<Trans>All orders</Trans>
				</Button>
			</div>
			<CateringPanel
				orgSlug={orgSlug}
				canWrite={canWrite}
				quotesEnabled={quotesEnabled}
				locations={locations}
				dishes={dishes}
			/>
		</div>
	)
}
