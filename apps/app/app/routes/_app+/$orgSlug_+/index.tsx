import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { PageTitle } from '@repo/ui/page-title'
import confetti from 'canvas-confetti'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useNavigate, useRouteLoaderData, useSearchParams } from 'react-router'
import { DashboardBlockContent } from '#app/components/dashboard/dashboard-block-content.tsx'
import { DashboardGrid } from '#app/components/dashboard/dashboard-grid.tsx'
import { DashboardHeader } from '#app/components/dashboard/dashboard-header.tsx'
import { type loader as rootLoader } from '#app/root.tsx'
import { loadBuiltInBlockData } from '#app/utils/dashboards/block-data.server.ts'
import { type DashboardBlock } from '#app/utils/dashboards/config.ts'
import { getHomeDashboard } from '#app/utils/dashboards/queries.server.ts'
import { hiddenBlockIds } from '#app/utils/dashboards/visibility.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { setUserDefaultOrganization } from '#app/utils/organization/organizations.server.ts'
import { type Route } from './+types/index.ts'

const CELEBRATION_MS = 3000

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const { createdAt, ...organization } = await requireUserOrganization(
		request,
		params.orgSlug,
		{ id: true, name: true, slug: true, createdAt: true },
	)
	const [home] = await Promise.all([
		getHomeDashboard(userId, organization.id),
		setUserDefaultOrganization(userId, organization.id),
	])
	const blockData = await loadBuiltInBlockData({
		userId,
		organization: { id: organization.id, createdAt },
		blocks: home.config.blocks,
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
	}
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
	const { organization, dashboard, blockData } = loaderData
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const userName = rootData?.user?.name || _(msg`User`)
	useCelebration()

	const { blocks, layouts } = dashboard.config
	const hidden = useMemo(
		() => hiddenBlockIds(blocks, blockData),
		[blocks, blockData],
	)
	const renderBlock = useCallback(
		(block: DashboardBlock) => (
			<DashboardBlockContent
				block={block}
				data={blockData}
				organization={organization}
			/>
		),
		[blockData, organization],
	)

	return (
		<div className="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 py-8 md:px-6 lg:px-8">
			<PageTitle
				title={_(msg`Welcome ${userName}!`)}
				description={_(msg`Your organization dashboard`)}
			/>
			<DashboardHeader name={<Trans>Home</Trans>} />
			<DashboardGrid
				blocks={blocks}
				layouts={layouts}
				hiddenBlockIds={hidden}
				renderBlock={renderBlock}
			/>
		</div>
	)
}
