import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isImpersonating, userHasOrganizationPermission } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { ORDER_PROBLEMS_FLAG } from '@repo/common/order-problems'
import { Button } from '@repo/ui/button'
import { PageTitle } from '@repo/ui/page-title'
import {
	data,
	Link,
	type LoaderFunctionArgs,
	useLoaderData,
} from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ProblemsInbox } from '#app/components/orders/order-problems.tsx'
import { useOrdersClient } from '#app/hooks/use-orders-client.ts'
import { requireMenuRead } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'

/**
 * Orders, Problems (#191): the guest reports of every location the member
 * reaches, with the order beside each and the one-tap answers. A report holds
 * guest words and photos, so they are read by the browser straight from the
 * region with the orders token; App only hands over the credentials. Answering
 * needs the orders write permission; refunding an online payment also needs the
 * refund permission. A 404 while `ordering.problem_reports` is off.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgSlug = params.orgSlug || ''
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
	})
	if (
		(await getFeatureFlag(ORDER_PROBLEMS_FLAG, {
			organizationId: organization.id,
		})) !== true
	) {
		throw data({ error: 'Not found' }, { status: 404 })
	}
	const userId = await requireMenuRead(request, organization.id)
	const canWrite = await userHasOrganizationPermission(
		userId,
		organization.id,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	const canRefund =
		!(await isImpersonating(request)) &&
		(await userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_ORDER_REFUND_ANY,
		))
	return data(
		{ orgSlug, canWrite, canRefund },
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export default function OrderProblemsRoute() {
	const { orgSlug, canWrite, canRefund } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const request = useOrdersClient(orgSlug)
	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 py-8 md:px-6 lg:px-8">
			<div className="flex items-start justify-between gap-4">
				<PageTitle
					title={_(msg`Order problems`)}
					description={_(
						msg`Reports from guests about an order. Answer with a refund, a credit or a reply.`,
					)}
				/>
				<Button
					variant="outline"
					nativeButton={false}
					render={<Link to={`/${orgSlug}/orders`} />}
				>
					<Trans>Back to orders</Trans>
				</Button>
			</div>
			<ProblemsInbox
				orgSlug={orgSlug}
				canWrite={canWrite}
				canRefund={canRefund}
				request={request}
			/>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
