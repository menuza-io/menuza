import { type OnboardingProgressData } from '@repo/common/onboarding'
import { cn } from '@repo/ui'
import { SidebarInset, SidebarProvider } from '@repo/ui/sidebar'
import { type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useAIPanel } from '#app/components/ai/ai-panel-context.tsx'
import { AppSidebar } from '#app/components/app-sidebar.tsx'
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

	return (
		<div
			className="m-2 ml-0 hidden h-[calc(100svh-1rem)] w-[420px] shrink-0 self-start md:block"
			aria-hidden="true"
		/>
	)
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
	const isMailbox = /\/mailbox\/?$/.test(pathname)
	return (
		<>
			<SidebarProvider
				className={cn('min-h-0 flex-1', isMailbox && 'h-dvh max-h-dvh')}
				open={!isCollapsed}
				style={
					{
						'--sidebar-width': 'calc(var(--spacing) * 60)',
						'--header-height': 'calc(var(--spacing) * 12)',
					} as React.CSSProperties
				}
			>
				<AppSidebar
					variant="inset"
					onboardingProgress={onboardingProgress}
					trialStatus={trialStatus || undefined}
					extensionId={extensionId || undefined}
				/>
				{/* Main column: the inset (sidebar + header + page content). */}
				<SidebarInset
					role="main"
					className={cn('min-w-0', isMailbox && 'min-h-0')}
				>
					<SiteHeader isCollapsed={isCollapsed} />
					<div
						className={cn(
							'@container/main flex flex-1 flex-col gap-2 px-4 md:px-2',
							isMailbox && 'min-h-0',
						)}
					>
						{children}
					</div>
				</SidebarInset>
				<AIPanelDockSpacer />
			</SidebarProvider>
			<EpicProgress />
		</>
	)
}

// Export these hooks to be used in the layout
export { useNonce } from '@repo/common'
export { useOptionalTheme } from '#app/routes/resources+/theme-switch.tsx'
