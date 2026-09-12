import { ReportWorkspace } from '@repo/reports/ui'
import { cn } from '@repo/ui'
import { type ComponentProps } from 'react'
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

	return (
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
	)
}
