import { Trans } from '@lingui/macro'
import { Card, CardHeader, CardTitle } from '@repo/ui/card'
import { Skeleton } from '@repo/ui/skeleton'
import { LeadershipCard } from '#app/components/leadership-card.tsx'
import { OnboardingChecklist } from '#app/components/onboarding-checklist.tsx'
import { type BuiltInBlockData } from '#app/utils/dashboards/block-data.server.ts'
import { type DashboardBlock } from '#app/utils/dashboards/config.ts'
import { NotesChartBlock } from './blocks/notes-chart-block.tsx'
import { StatsBlock } from './blocks/stats-block.tsx'

export type DashboardBlockOrganization = { id: string; slug: string }

/** A block that was just added has no data until the page data reloads. */
function BlockLoading() {
	return <Skeleton aria-hidden="true" className="h-full rounded-xl" />
}

export function DashboardBlockContent({
	block,
	data,
	organization,
}: {
	block: DashboardBlock
	data: BuiltInBlockData
	organization: DashboardBlockOrganization
}) {
	switch (block.type) {
		case 'stats':
			return data.notes ? <StatsBlock notes={data.notes} /> : <BlockLoading />
		case 'notes-chart':
			return data.notes ? (
				<NotesChartBlock notes={data.notes} />
			) : (
				<BlockLoading />
			)
		case 'onboarding':
			return data.onboarding ? (
				<OnboardingChecklist
					progress={data.onboarding}
					orgSlug={organization.slug}
					organizationId={organization.id}
					variant="dashboard"
				/>
			) : (
				<BlockLoading />
			)
		case 'leaderboard':
			return data.leaderboard ? (
				<LeadershipCard leaders={data.leaderboard} />
			) : (
				<BlockLoading />
			)
		case 'report':
			return (
				<Card className="h-full">
					<CardHeader>
						<CardTitle>
							<Trans>Report</Trans>
						</CardTitle>
					</CardHeader>
				</Card>
			)
	}
}
