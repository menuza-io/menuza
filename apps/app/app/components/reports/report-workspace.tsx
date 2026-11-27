import { useLingui } from '@lingui/react/macro'
import { type ReportDefinition } from '@repo/reports'
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
		({
			subject,
			ref,
			definition,
		}: {
			subject: string
			ref: string
			definition?: ReportDefinition
		}) => {
			// A Deliveries by driver row opens that driver's deliveries for the same
			// period (#324): a link to the Deliveries list filtered by the row's driver.
			if (orgSlug && subject === 'driver_deliveries') {
				const query = new URLSearchParams({
					template: 'driver-deliveries-list',
					driver: ref,
				})
				if (definition) {
					query.set('preset', definition.timeframe.preset)
					if (definition.timeframe.start)
						query.set('start', definition.timeframe.start)
					if (definition.timeframe.end)
						query.set('end', definition.timeframe.end)
				}
				return [
					{
						label: t`Open deliveries`,
						href: `/${orgSlug}/reports/new?${query.toString()}`,
					},
				]
			}
			return orgSlug && subject === 'slow_sellers'
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
				: []
		},
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
