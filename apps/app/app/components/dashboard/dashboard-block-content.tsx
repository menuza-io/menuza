import { type ReactNode } from 'react'
import { Skeleton } from '@repo/ui/skeleton'
import { LaunchChecklistView } from '#app/components/launch/launch-checklist.tsx'
import { LeadershipCard } from '#app/components/leadership-card.tsx'
import { OnboardingChecklist } from '#app/components/onboarding-checklist.tsx'
import { type BuiltInBlockData } from '#app/utils/dashboards/block-data.server.ts'
import { type BookingsTodayAccess } from '#app/utils/dashboards/bookings-today.ts'
import { type DashboardBlock } from '#app/utils/dashboards/config.ts'
import {
	type ReportBlockData,
	type SavedReportOption,
} from '#app/utils/dashboards/reports.ts'
import { type TodayAccess } from '#app/utils/dashboards/today.ts'
import { AttentionBlock } from './blocks/attention-block.tsx'
import { BookingsTodayBlock } from './blocks/bookings-today-block.tsx'
import { NotesChartBlock } from './blocks/notes-chart-block.tsx'
import { ReportBlock } from './blocks/report-block.tsx'
import { StatsBlock } from './blocks/stats-block.tsx'
import { SalesGoalsBlock } from './blocks/sales-goals-block.tsx'
import { TodayBlock } from './blocks/today-block.tsx'
import { type SalesGoalsAccess } from '#app/utils/goals/goals.ts'
import { TileFreshness } from './tile-freshness.tsx'

export type DashboardBlockOrganization = {
	id: string
	slug: string
	timeZone?: string
}

function BlockWithFreshness({
	children,
	fetchedAt,
	timeZone,
}: {
	children: ReactNode
	fetchedAt: number
	timeZone: string
}) {
	return (
		<div className="flex h-full min-h-0 flex-col gap-1">
			<div className="min-h-0 flex-1">{children}</div>
			<TileFreshness updatedAt={fetchedAt} timeZone={timeZone} />
		</div>
	)
}

/** A block that was just added has no data until the page data reloads. */
function BlockLoading() {
	return <Skeleton aria-hidden="true" className="h-full rounded-xl" />
}

export function DashboardBlockContent({
	block,
	data,
	reports,
	savedReportOptions,
	bookingsToday,
	today,
	salesGoals,
	locationStorageKey = '',
	organization,
	editable,
}: {
	block: DashboardBlock
	data: BuiltInBlockData
	reports: ReportBlockData | null
	savedReportOptions?: readonly SavedReportOption[]
	bookingsToday?: BookingsTodayAccess
	today?: TodayAccess
	salesGoals?: SalesGoalsAccess
	/** Where the home location picker is remembered. */
	locationStorageKey?: string
	organization: DashboardBlockOrganization
	/** Whether the viewer can change the dashboard's blocks. */
	editable?: boolean
}) {
	const timeZone = organization.timeZone ?? 'UTC'
	const wrap = (node: ReactNode) => (
		<BlockWithFreshness fetchedAt={data.fetchedAt} timeZone={timeZone}>
			{node}
		</BlockWithFreshness>
	)
	switch (block.type) {
		case 'stats':
			return data.notes ? (
				wrap(<StatsBlock notes={data.notes} />)
			) : (
				<BlockLoading />
			)
		case 'notes-chart':
			return data.notes ? (
				wrap(<NotesChartBlock notes={data.notes} />)
			) : (
				<BlockLoading />
			)
		case 'onboarding':
			if (data.launch) {
				return wrap(
					<LaunchChecklistView
						checklist={data.launch.checklist}
						orgSlug={organization.slug}
						organizationId={organization.id}
						locationStorageKey={locationStorageKey}
						canTellGuests={data.launch.canTellGuests}
						compact
					/>,
				)
			}
			return data.onboarding ? (
				wrap(
					<OnboardingChecklist
						progress={data.onboarding}
						orgSlug={organization.slug}
						organizationId={organization.id}
						variant="dashboard"
					/>,
				)
			) : (
				<BlockLoading />
			)
		case 'leaderboard':
			return data.leaderboard ? (
				wrap(<LeadershipCard leaders={data.leaderboard} />)
			) : (
				<BlockLoading />
			)
		case 'bookings-today':
			return bookingsToday?.available
				? wrap(
						<BookingsTodayBlock
							orgSlug={organization.slug}
							locations={bookingsToday.locations}
						/>,
					)
				: null
		case 'today':
			return today?.available
				? wrap(
						<TodayBlock
							orgSlug={organization.slug}
							access={today}
							locationStorageKey={locationStorageKey}
						/>,
					)
				: null
		case 'sales-goals':
			return salesGoals?.available
				? wrap(
						<SalesGoalsBlock orgSlug={organization.slug} access={salesGoals} />,
					)
				: null
		case 'attention':
			return data.attention ? (
				wrap(
					<AttentionBlock
						orgSlug={organization.slug}
						data={data.attention}
						locationStorageKey={locationStorageKey}
					/>,
				)
			) : (
				<BlockLoading />
			)
		case 'report':
			return wrap(
				<ReportBlock
					config={block.config}
					orgSlug={organization.slug}
					reports={reports}
					savedReportOptions={savedReportOptions}
					editable={editable}
				/>,
			)
	}
}
