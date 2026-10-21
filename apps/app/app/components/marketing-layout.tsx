import { type OnboardingProgressData } from '@repo/common/onboarding'
import { cn } from '@repo/ui'
import { SidebarInset, SidebarProvider } from '@repo/ui/sidebar'
import { type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useAIPanel } from '#app/components/ai/ai-panel-context.tsx'
import { AppSidebar } from '#app/components/app-sidebar.tsx'
import { CommandPaletteProvider } from '#app/components/command-palette-context.tsx'
import { SiteHeader } from '#app/components/site-header.tsx'
import { EpicProgress } from './progress-bar'

const PAGE_EDITOR_PATH = /\/website\/pages\/[^/]+$/

function useIsPageEditorRoute() {
	const location = useLocation()
	return PAGE_EDITOR_PATH.test(location.pathname)
}

function AIPanelDockSpacer() {
	const { isOpen, isExpanded } = useAIPanel()
	const isPageEditor = useIsPageEditorRoute()
	const showSpacer = isOpen && !isExpanded && !isPageEditor

	if (!showSpacer) return null

	return <div className="hidden w-105 shrink-0 md:block" aria-hidden="true" />
}

type MarketingLayoutProps = {
	children: ReactNode
	isCollapsed?: boolean
	onboardingProgress?: OnboardingProgressData | null
	trialStatus?: { isActive: boolean; daysRemaining: number } | null
	extensionId?: string | null
}

export function MarketingLayout({
	children,
	isCollapsed = false,
	onboardingProgress,
	trialStatus = null,
	extensionId = null,
}: MarketingLayoutProps) {
	const { pathname } = useLocation()
	const isConversation = /^\/[^/]+\/(?:mailbox|chat)\/?$/.test(pathname)
	return (
		<CommandPaletteProvider>
			<SidebarProvider
				className={cn('min-h-0 flex-1', isConversation && 'h-dvh max-h-dvh')}
				open={!isCollapsed}
				style={
					{
						'--sidebar-width': '15.75rem',
						'--header-height': '2.875rem',
					} as React.CSSProperties
				}
			>
				<AppSidebar
					variant="sidebar"
					onboardingProgress={onboardingProgress}
					trialStatus={trialStatus || undefined}
					extensionId={extensionId || undefined}
				/>
				{/* Main column: the inset (sidebar + header + page content). */}
				<SidebarInset
					role="main"
					className={cn(
						'min-w-0 overflow-x-clip',
						isConversation && 'min-h-0 overflow-hidden',
					)}
				>
					<SiteHeader isCollapsed={isCollapsed} />
					<div
						className={cn(
							'bg-card dark:bg-background @container/main flex flex-1 flex-col gap-2',
							// Chat and mailbox fill the viewport edge to edge; other pages get gutters.
							isConversation ? 'min-h-0' : 'px-4 pb-6 md:px-3 md:pb-6',
						)}
					>
						{children}
					</div>
				</SidebarInset>
				<AIPanelDockSpacer />
			</SidebarProvider>
			<EpicProgress />
		</CommandPaletteProvider>
	)
}

// Export these hooks to be used in the layout
export { useNonce } from '@repo/common'
export { useOptionalTheme } from '#app/routes/resources+/theme-switch.tsx'
