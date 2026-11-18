import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { UNSUPPORTED_HEALTH_CHECKS } from '@repo/common/location-health'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage } from '@repo/ui/workspace'
import { useLoaderData } from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	HealthSummaryBadge,
	LocationHealthCard,
} from '#app/components/status/location-status-view.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { loadLocationStatus } from '#app/utils/status/location-status.server.ts'

/**
 * Status (#332): can each restaurant take orders right now? Read from data the
 * App already has when the page loads; a member limited to some locations sees
 * only those.
 */
export async function loader({
	request,
	params,
}: {
	request: Request
	params: { orgSlug?: string }
}) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const userId = await requireAnyUserWithOrganizationPermission(
		request,
		organization.id,
		[ORG_PERMISSIONS.READ_SETTINGS_ANY, ORG_PERMISSIONS.READ_MENU_ANY],
	)
	const status = await loadLocationStatus({
		userId,
		organizationId: organization.id,
	})
	return {
		orgSlug: organization.slug,
		status,
		unsupported: UNSUPPORTED_HEALTH_CHECKS.map((check) => check.id),
	}
}

export default function StatusRoute() {
	const { _ } = useLingui()
	const { orgSlug, status } = useLoaderData<typeof loader>()

	return (
		<WorkspacePage>
			<PageHeader
				title={_(t`Status`)}
				description={_(
					t`Can each location take orders right now? What is wrong is listed with a link to fix it.`,
				)}
			/>
			{!status || status.locations.length === 0 ? (
				<EmptyState
					title={_(t`No locations to check`)}
					description={_(
						t`Add a location, or ask an admin for access to one, to see its status.`,
					)}
				/>
			) : (
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center gap-3">
						<HealthSummaryBadge summary={status.summary} />
						<span className="text-muted-foreground text-sm">
							{plural(status.locations.length, {
								one: '# location checked. The worst one decides the summary.',
								other:
									'# locations checked. The worst one decides the summary.',
							})}
						</span>
					</div>
					<ul className="grid gap-3 lg:grid-cols-2">
						{status.locations.map((health) => (
							<li key={health.locationId}>
								<LocationHealthCard
									health={health as never}
									orgSlug={orgSlug}
								/>
							</li>
						))}
					</ul>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Checked when this page opened. Kitchen screens and printers are
							not part of this check yet.
						</Trans>
					</p>
				</div>
			)}
		</WorkspacePage>
	)
}
