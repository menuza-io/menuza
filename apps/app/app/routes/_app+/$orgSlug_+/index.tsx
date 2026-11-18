import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	WorkspaceMetric,
	WorkspaceMetricGrid,
	WorkspacePage,
} from '@repo/ui/workspace'
import confetti from 'canvas-confetti'
import { useCallback, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { DashboardBlockContent } from '#app/components/dashboard/dashboard-block-content.tsx'
import { DashboardEditor } from '#app/components/dashboard/dashboard-editor.tsx'
import { DashboardSwitcher } from '#app/components/dashboard/dashboard-switcher.tsx'
import { HomePrompt } from '#app/components/home-prompt.tsx'
import { handleHomeAction } from '#app/utils/dashboards/actions.server.ts'
import {
	loadBlockPicker,
	loadBuiltInBlockData,
	loadContributorCount,
	loadReportBlockData,
} from '#app/utils/dashboards/block-data.server.ts'
import { loadBookingsTodayAccess } from '#app/utils/dashboards/bookings-today.server.ts'
import {
	defaultRestaurantHomeConfig,
	type BlockType,
	type DashboardBlock,
} from '#app/utils/dashboards/config.ts'
import {
	getHomeDashboard,
	listDashboardsForSwitcher,
} from '#app/utils/dashboards/queries.server.ts'
import { resolveReportBlock } from '#app/utils/dashboards/reports.ts'
import {
	canReadOrderTotals,
	loadHomeLocations,
} from '#app/utils/dashboards/today.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { setUserDefaultOrganization } from '#app/utils/organization/organizations.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
import { type Route } from './+types/index.ts'

const CELEBRATION_MS = 3000
/** The KPI row above the grid stands in for the stats block. */
const HOME_HIDDEN_BLOCK_TYPES: readonly BlockType[] = ['stats']

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const { createdAt, dataRegion, ...organization } =
		await requireUserOrganization(request, params.orgSlug, {
			id: true,
			name: true,
			slug: true,
			createdAt: true,
			dataRegion: true,
		})
	const [home, bookingsToday, locations] = await Promise.all([
		getHomeDashboard(userId, organization.id),
		loadBookingsTodayAccess({ userId, organizationId: organization.id }),
		loadHomeLocations(userId, organization.id),
		setUserDefaultOrganization(userId, organization.id),
	])
	// Until the viewer saves their own Home, they get the restaurant default:
	// Today, Needs attention, the setup checklist and (when they can see it)
	// Bookings today. A saved Home is never replaced, notes blocks and all.
	const salesGoalsDefault = await canReadOrderTotals(userId, organization.id)
	const config = home.id
		? home.config
		: defaultRestaurantHomeConfig({
				bookingsToday: bookingsToday.available,
				salesGoals: salesGoalsDefault,
			})
	const blocks = config.blocks
	// The KPI row stands in for a saved Home's stats block.
	const showsNotesKpis = blocks.some((block) => block.type === 'stats')
	const [blockData, reports, switcher, contributorCount] = await Promise.all([
		loadBuiltInBlockData({
			userId,
			organization: { id: organization.id, slug: organization.slug, createdAt },
			blocks,
			request,
		}),
		loadReportBlockData({
			organization: { ...organization, dataRegion },
			blocks,
		}),
		listDashboardsForSwitcher(userId, organization.id),
		showsNotesKpis ? loadContributorCount(organization.id) : 0,
	])
	const picker = await loadBlockPicker({
		userId,
		organization: { ...organization, dataRegion },
		blockData,
		bookingsToday,
		locations,
		grants: await resolveReportGrantsForRequest(
			request,
			userId,
			organization.id,
		),
	})

	return {
		organization,
		dashboard: {
			id: home.id,
			kind: 'home' as const,
			access: 'owner' as const,
			config,
		},
		blockData,
		contributorCount,
		showsNotesKpis,
		reports,
		picker,
		switcher,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	return handleHomeAction({ request, userId, organization })
}

/** Plays confetti for `?celebrate=true`, then drops the parameter. */
function useCelebration() {
	const [searchParams] = useSearchParams()
	const navigate = useNavigate()
	const startedRef = useRef(false)

	useEffect(() => {
		if (searchParams.get('celebrate') !== 'true' || startedRef.current) return
		startedRef.current = true

		const animationEnd = Date.now() + CELEBRATION_MS
		const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 }
		const interval = setInterval(() => {
			const timeLeft = animationEnd - Date.now()
			if (timeLeft <= 0) {
				clearInterval(interval)
				const nextSearchParams = new URLSearchParams(searchParams)
				nextSearchParams.delete('celebrate')
				void navigate(
					{ search: nextSearchParams.toString() },
					{ replace: true },
				)
				startedRef.current = false
				return
			}
			void confetti({
				...defaults,
				particleCount: 50 * (timeLeft / CELEBRATION_MS),
				origin: { x: 0.5, y: 0 },
			})
		}, 250)

		return () => clearInterval(interval)
	}, [searchParams, navigate])
}

export default function HomeDashboard({ loaderData }: Route.ComponentProps) {
	const { _ } = useLingui()
	const {
		organization,
		dashboard,
		blockData,
		contributorCount,
		showsNotesKpis,
		reports,
		picker,
		switcher,
	} = loaderData
	const notes = blockData.notes
	const daysShown = notes?.daysShown ?? 0
	useCelebration()

	const renderBlock = useCallback(
		(block: DashboardBlock) => (
			<DashboardBlockContent
				block={block}
				data={blockData}
				reports={reports}
				savedReportOptions={picker.savedReports}
				bookingsToday={picker.bookingsToday}
				today={picker.today}
				salesGoals={picker.salesGoals}
				locationStorageKey={picker.locationStorageKey}
				organization={organization}
			/>
		),
		[
			blockData,
			organization,
			picker.bookingsToday,
			picker.today,
			picker.locationStorageKey,
			picker.savedReports,
			reports,
		],
	)
	const blockTitle = useCallback(
		(block: DashboardBlock) =>
			block.type === 'report'
				? resolveReportBlock(block.config, {
						orgSlug: organization.slug,
						reports,
						savedReportOptions: picker.savedReports,
					}).title
				: null,
		[organization.slug, picker.savedReports, reports],
	)

	const bookingsTodayAvailable = picker.bookingsToday.available
	const salesGoalsAvailable = picker.salesGoals.available
	const resetConfig = useCallback(
		() =>
			defaultRestaurantHomeConfig({
				bookingsToday: bookingsTodayAvailable,
				salesGoals: salesGoalsAvailable,
			}),
		[bookingsTodayAvailable, salesGoalsAvailable],
	)

	return (
		<WorkspacePage>
			{/* No visible greeting; the page still needs its one heading. */}
			<h1 className="sr-only">{organization.name}</h1>
			<HomePrompt />
			{showsNotesKpis ? (
				<WorkspaceMetricGrid>
					<WorkspaceMetric
						label={_(msg`Total notes`)}
						value={notes?.total ?? 0}
						hint={_(msg`Across your organization`)}
					/>
					<WorkspaceMetric
						label={_(msg`Avg per day`)}
						value={notes?.avgPerDay ?? 0}
						hint={
							notes ? _(msg`Last ${daysShown} days`) : _(msg`No activity yet`)
						}
					/>
					<WorkspaceMetric
						label={_(msg`Trend`)}
						value={
							notes ? `${notes.trend >= 0 ? '+' : ''}${notes.trend}%` : '—'
						}
						tone={
							notes && notes.trend < 0
								? 'danger'
								: notes && notes.trend > 0
									? 'primary'
									: 'default'
						}
						hint={_(msg`Vs prior period`)}
					/>
					<WorkspaceMetric
						label={_(msg`Contributors`)}
						value={contributorCount}
						hint={_(msg`Across your organization`)}
					/>
				</WorkspaceMetricGrid>
			) : null}
			<DashboardEditor
				key={organization.id}
				title={
					<DashboardSwitcher
						orgSlug={organization.slug}
						current={{ id: null }}
						dashboards={switcher}
					/>
				}
				config={dashboard.config}
				blockData={blockData}
				picker={picker}
				renderBlock={renderBlock}
				blockTitle={blockTitle}
				resetConfig={resetConfig}
				hiddenBlockTypes={HOME_HIDDEN_BLOCK_TYPES}
			/>
		</WorkspacePage>
	)
}
