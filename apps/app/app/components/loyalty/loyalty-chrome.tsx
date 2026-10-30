import { msg } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import { type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { type LoyaltyNavAccess } from '#app/utils/loyalty/nav.ts'

type LoyaltyRouteKey = 'overview' | 'program' | 'rewards' | 'activity'

/**
 * The Loyalty page chrome: one PageHeader, one underline section tab bar,
 * then the screen. Sections without a grant are hidden.
 */
export function LoyaltyChrome({
	orgSlug,
	nav,
	children,
}: {
	orgSlug: string
	nav: LoyaltyNavAccess
	children: ReactNode
}) {
	const { _ } = useLingui()
	const location = useLocation()

	const base = `/${orgSlug}/loyalty`
	const path = location.pathname.startsWith(`${base}/`)
		? location.pathname.slice(base.length + 1).split('/')[0]
		: ''
	const routeKey: LoyaltyRouteKey =
		path === 'program' || path === 'rewards' || path === 'activity'
			? path
			: 'overview'

	const sections: Array<{
		id: LoyaltyRouteKey
		label: string
		href: string
		visible: boolean
	}> = [
		{
			id: 'overview',
			label: _(msg`Overview`),
			href: `${base}/overview`,
			visible: nav.overview,
		},
		{
			id: 'program',
			label: _(msg`Program`),
			href: `${base}/program`,
			visible: nav.program,
		},
		{
			id: 'rewards',
			label: _(msg`Rewards`),
			href: `${base}/rewards`,
			visible: nav.rewards,
		},
		{
			id: 'activity',
			label: _(msg`Activity`),
			href: `${base}/activity`,
			visible: nav.activity,
		},
	]
	const tabs = sections
		.filter((section) => section.visible)
		.map((section) => ({
			label: section.label,
			href: section.href,
			isActive: section.id === routeKey,
		}))

	const headers: Record<
		LoyaltyRouteKey,
		{ title: string; description: string }
	> = {
		overview: {
			title: _(msg`Loyalty`),
			description: _(
				msg`How the program is doing: customers, points and redemptions.`,
			),
		},
		program: {
			title: _(msg`Loyalty program`),
			description: _(
				msg`What customers earn, the terms shown in their wallet, and whether the program is running.`,
			),
		},
		rewards: {
			title: _(msg`Loyalty rewards`),
			description: _(msg`What customers can spend their points on.`),
		},
		activity: {
			title: _(msg`Loyalty activity`),
			description: _(
				msg`Every point movement, plus the queue of redemptions and sales waiting for review.`,
			),
		},
	}
	const header = headers[routeKey]

	return (
		<WorkspacePage>
			<div className="flex flex-col gap-6" data-testid="loyalty-chrome">
				<PageHeader title={header.title} description={header.description} />
				<WorkspaceTabBar
					label={_(msg`Loyalty sections`)}
					className="print:hidden"
					tabs={tabs}
				/>
				{children}
			</div>
		</WorkspacePage>
	)
}
