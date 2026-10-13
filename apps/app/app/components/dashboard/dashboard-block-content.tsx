import { Trans } from '@lingui/macro'
import { Card, CardHeader, CardTitle } from '@repo/ui/card'
import { LeadershipCard } from '#app/components/leadership-card.tsx'
import { OnboardingChecklist } from '#app/components/onboarding-checklist.tsx'
import { type BuiltInBlockData } from '#app/utils/dashboards/block-data.server.ts'
import { type DashboardBlock } from '#app/utils/dashboards/config.ts'
import { NotesChartBlock } from './blocks/notes-chart-block.tsx'
import { StatsBlock } from './blocks/stats-block.tsx'

export type DashboardBlockOrganization = { id: string; slug: string }

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
			return data.notes ? <StatsBlock notes={data.notes} /> : null
		case 'notes-chart':
			return data.notes ? <NotesChartBlock notes={data.notes} /> : null
		case 'onboarding':
			return data.onboarding ? (
				<OnboardingChecklist
					progress={data.onboarding}
					orgSlug={organization.slug}
					organizationId={organization.id}
					variant="dashboard"
				/>
			) : null
		case 'leaderboard':
			return <LeadershipCard leaders={data.leaderboard ?? []} />
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
