import { SidebarTrigger } from '@repo/ui/sidebar'
import { useFetcher } from 'react-router'
import { useAIPanelHotkey } from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIToggle } from '#app/components/ai/global-ai-panel.tsx'
import NotificationBell from './ui/notification-bell'

export function SiteHeader({ isCollapsed }: { isCollapsed: boolean }) {
	const sidebar = useFetcher()

	useAIPanelHotkey()

	return (
		<>
			<header
				role="banner"
				className="relative flex h-(--header-height) w-full shrink-0 items-center justify-between border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)"
			>
				<div className="flex items-center px-4">
					<SidebarTrigger
						onClick={() => {
							const formData = new FormData()
							formData.append('isCollapsed', isCollapsed ? 'false' : 'true')
							void sidebar.submit(formData, {
								method: 'POST',
								action: '/resources/sidebar-state',
							})
						}}
						className="-ml-1"
						type="submit"
					/>
				</div>
				<div className="flex shrink-0 items-center gap-2 px-2 pr-4 md:pr-6">
					<GlobalAIToggle />
					<NotificationBell />
				</div>
			</header>
		</>
	)
}
