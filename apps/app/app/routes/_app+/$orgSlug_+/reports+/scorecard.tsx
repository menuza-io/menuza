import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { requireUserId } from '@repo/auth'
import {
	buildLocationScorecard,
	rankLocations,
} from '@repo/common/location-scorecard'
import { WorkspacePage } from '@repo/ui/workspace'
import { useLoaderData } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/scorecard.ts'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	const entries = buildLocationScorecard([])
	const ranked = rankLocations(entries, (a, b) => b.salesMinor - a.salesMinor)
	return { orgSlug: params.orgSlug, ranked, organizationId: organization.id }
}

export default function ScorecardPage() {
	const { _ } = useLingui()
	const { ranked } = useLoaderData<typeof loader>()
	return (
		<WorkspacePage title={_(msg`Location scorecard`)}>
			<p className="text-muted-foreground mb-4 text-sm">
				<Trans>
					Ranks locations by sales, cancellations, ratings, and missed orders.
				</Trans>
			</p>
			{ranked.length === 0 ? (
				<p>
					<Trans>Not enough data for this period yet.</Trans>
				</p>
			) : (
				<ol className="space-y-2">
					{ranked.map((row, index) => (
						<li
							key={row.locationId}
							data-testid={`scorecard-${row.locationId}`}
						>
							<Trans>
								#{index + 1} {row.locationId}{' '}
								{row.enoughData
									? `${(row.salesMinor / 100).toFixed(0)} sales`
									: 'not enough data'}
							</Trans>
						</li>
					))}
				</ol>
			)}
		</WorkspacePage>
	)
}
