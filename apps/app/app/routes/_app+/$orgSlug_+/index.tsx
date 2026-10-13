import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { PageTitle } from '@repo/ui/page-title'
import confetti from 'canvas-confetti'
import { useCallback, useEffect, useRef } from 'react'
import { useNavigate, useRouteLoaderData, useSearchParams } from 'react-router'
import { DashboardBlockContent } from '#app/components/dashboard/dashboard-block-content.tsx'
import { DashboardEditor } from '#app/components/dashboard/dashboard-editor.tsx'
import { type loader as rootLoader } from '#app/root.tsx'
import { handleHomeAction } from '#app/utils/dashboards/actions.server.ts'
import {
	loadBlockPicker,
	loadBuiltInBlockData,
} from '#app/utils/dashboards/block-data.server.ts'
import {
	defaultHomeConfig,
	type DashboardBlock,
} from '#app/utils/dashboards/config.ts'
import { getHomeDashboard } from '#app/utils/dashboards/queries.server.ts'
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
		picker,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})
	return handleHomeAction({ request, userId, organizationId: organization.id })
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
	const { organization, dashboard, blockData, picker } = loaderData
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const userName = rootData?.user?.name || _(msg`User`)
	useCelebration()

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
			<DashboardEditor
				// Unsaved edits belong to the Home of one organization.
				key={organization.id}
				name={<Trans>Home</Trans>}
				config={dashboard.config}
				blockData={blockData}
				picker={picker}
				renderBlock={renderBlock}
				resetConfig={defaultHomeConfig}
			/>
		</div>
	)
}
