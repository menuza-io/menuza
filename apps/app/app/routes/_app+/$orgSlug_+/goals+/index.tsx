import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import { WorkspacePage } from '@repo/ui/workspace'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { loadLocationGoalProgress } from '#app/utils/goals/sales-goals.server.ts'
import { type Route } from './+types/index.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
	})
	const month = new Date().toISOString().slice(0, 7)
	const progress = await loadLocationGoalProgress({
		organizationId: organization.id,
		month,
		actualByLocation: new Map(),
	})
	return { orgSlug: params.orgSlug, month, progress }
}

export default function GoalsPage() {
	const { _ } = useLingui()
	const { month, progress } = useLoaderData<typeof loader>()
	return (
		<WorkspacePage title={_(msg`Sales goals`)}>
			<p className="text-muted-foreground mb-4 text-sm">
				<Trans>
					Monthly targets for {month}. Set a goal per location under Settings.
				</Trans>
			</p>
			<ul className="space-y-3">
				{progress.map((row) => (
					<li
						key={row.locationId}
						className="border-border rounded-lg border p-4"
						data-testid={`goal-${row.locationId}`}
					>
						<div className="font-medium">{row.locationName}</div>
						{row.goalMinor === null ? (
							<p className="text-muted-foreground text-sm">
								<Trans>Set a monthly goal to track progress here.</Trans>
							</p>
						) : (
							<p className="text-sm">
								<Trans>
									Actual {(row.actualMinor / 100).toFixed(2)} / goal{' '}
									{(row.goalMinor / 100).toFixed(2)} {row.currency}
								</Trans>
							</p>
						)}
					</li>
				))}
			</ul>
		</WorkspacePage>
	)
}
