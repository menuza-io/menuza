import { useLingui } from '@lingui/react/macro'
import { ReportRowActionsContext, ReportWorkspace } from '@repo/reports/ui'
import { cn } from '@repo/ui'
import { type ComponentProps, useCallback } from 'react'
import { useParams } from 'react-router'
import {
	useAIPanel,
	useAIPanelHotkey,
} from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIToggle } from '#app/components/ai/global-ai-panel.tsx'
import { useMinWidthMediaQuery } from '#app/utils/navigation-guards.ts'

type ReportWorkspaceProps = Omit<
	ComponentProps<typeof ReportWorkspace>,
	'headerExtras' | 'contentClassName'
>

/** Adds the App's global AI workspace affordances to the shared report builder. */
export function AppReportWorkspace(props: ReportWorkspaceProps) {
	useAIPanelHotkey()
	const { isOpen, isExpanded } = useAIPanel()
	const isLg = useMinWidthMediaQuery(1024)
	const { orgSlug } = useParams()
	const { t } = useLingui()
	// Links from a Slow sellers row (#261): open the dish, mark it unavailable
	// (its availability is set in the dish's editor) and start a promotion. Links
	// only: nothing changes until the person does it on the page they open.
	const rowActions = useCallback(
		({ subject, ref }: { subject: string; ref: string }) =>
			orgSlug && subject === 'slow_sellers'
				? [
						{
							label: t`Open dish`,
							href: `/${orgSlug}/menu/items/${encodeURIComponent(ref)}`,
						},
						{
							label: t`Mark unavailable`,
							href: `/${orgSlug}/menu/items/${encodeURIComponent(ref)}#availability`,
						},
						{
							label: t`Start a promotion`,
							href: `/${orgSlug}/discounts/new`,
						},
					]
				: [],
		[orgSlug, t],
	)

	return (
		<ReportRowActionsContext.Provider value={rowActions}>
			<ReportWorkspace
				{...props}
				headerExtras={<GlobalAIToggle />}
				contentClassName={cn(
					'transition-[padding] duration-[180ms] [transition-timing-function:cubic-bezier(0.19,1,0.22,1)]',
					// Reserve the AI panel width plus a 1rem visual gutter so the canvas
					// never appears to run into the docked chat surface.
					isOpen && !isExpanded && isLg && 'pr-[27.25rem]',
				)}
			/>
		</ReportRowActionsContext.Provider>
	)
}
