import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	WorkspaceHero,
	WorkspaceMetric,
	WorkspaceMetricGrid,
	WorkspacePage,
	formatWorkspaceDate,
	getWorkspaceGreeting,
	getWorkspaceHour,
} from '@repo/ui/workspace'
import confetti from 'canvas-confetti'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useRouteLoaderData, useSearchParams } from 'react-router'
import { DashboardBlockContent } from '#app/components/dashboard/dashboard-block-content.tsx'
import { DashboardEditor } from '#app/components/dashboard/dashboard-editor.tsx'
import { DashboardSwitcher } from '#app/components/dashboard/dashboard-switcher.tsx'
import { type loader as rootLoader } from '#app/root.tsx'
import { handleHomeAction } from '#app/utils/dashboards/actions.server.ts'
import {
	loadBlockPicker,
	loadBuiltInBlockData,
	loadContributorCount,
	loadReportBlockData,
} from '#app/utils/dashboards/block-data.server.ts'
import {
	defaultHomeConfig,
	type BlockType,
	type DashboardBlock,
} from '#app/utils/dashboards/config.ts'
import {
	getHomeDashboard,
	listDashboardsForSwitcher,
} from '#app/utils/dashboards/queries.server.ts'
import { resolveReportBlock } from '#app/utils/dashboards/reports.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { setUserDefaultOrganization } from '#app/utils/organization/organizations.server.ts'
import { type Route } from './+types/index.ts'

const CELEBRATION_MS = 3000
/** The KPI row above the grid stands in for the stats block. */
const HOME_HIDDEN_BLOCK_TYPES: readonly BlockType[] = ['stats']
/** What the KPI row reads, loaded whatever blocks the home has. */
const KPI_BLOCK_TYPES: readonly BlockType[] = ['stats']

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
	const [home] = await Promise.all([
		getHomeDashboard(userId, organization.id),
		setUserDefaultOrganization(userId, organization.id),
	])
	const blocks = home.config.blocks
	const [blockData, reports, switcher, contributorCount] = await Promise.all([
		loadBuiltInBlockData({
			userId,
			organization: { id: organization.id, createdAt },
			blocks,
			include: KPI_BLOCK_TYPES,
		}),
		loadReportBlockData({
			organization: { ...organization, dataRegion },
			blocks,
		}),
		listDashboardsForSwitcher(userId, organization.id),
		loadContributorCount(organization.id),
	])
	const picker = await loadBlockPicker({
		userId,
		organizationId: organization.id,
		blockData,
	})

	return {
		organization,
		dashboard: {
			id: home.id,
			kind: 'home' as const,
			access: 'owner' as const,
			config: home.config,
		},
		blockData,
		contributorCount,
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
		reports,
		picker,
		switcher,
	} = loaderData
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const userName = rootData?.user?.name || _(msg`User`)
	const notes = blockData.notes
	// The request's locale and time zone, so the server render matches the
	// browser's.
	const locale = rootData?.locale ?? 'en'
	const timeZone = rootData?.requestInfo.hints.timeZone
	const greeting = useMemo(() => {
		const part = getWorkspaceGreeting(getWorkspaceHour(new Date(), timeZone))
		if (part === 'morning') return _(msg`Good morning, ${userName}`)
		if (part === 'afternoon') return _(msg`Good afternoon, ${userName}`)
		return _(msg`Good evening, ${userName}`)
	}, [_, timeZone, userName])
	const todayLine = useMemo(
		() =>
			_(
				msg`${formatWorkspaceDate(new Date(), { locale, timeZone })} · Here's what's happening in ${organization.name}`,
			),
		[_, locale, organization.name, timeZone],
	)
	useCelebration()

	const renderBlock = useCallback(
		(block: DashboardBlock) => (
			<DashboardBlockContent
				block={block}
				data={blockData}
				reports={reports}
				savedReportOptions={picker.savedReports}
				bookingsToday={picker.bookingsToday}
				organization={organization}
			/>
		),
		[
			blockData,
			organization,
			picker.bookingsToday,
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

	return (
		<WorkspacePage>
			<WorkspaceHero title={greeting} meta={todayLine} />
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
						notes
							? _(msg`Last ${notes.daysShown} days`)
							: _(msg`No activity yet`)
					}
				/>
				<WorkspaceMetric
					label={_(msg`Trend`)}
					value={notes ? `${notes.trend >= 0 ? '+' : ''}${notes.trend}%` : '—'}
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
				resetConfig={defaultHomeConfig}
				hiddenBlockTypes={HOME_HIDDEN_BLOCK_TYPES}
			/>
		</WorkspacePage>
	)
}
