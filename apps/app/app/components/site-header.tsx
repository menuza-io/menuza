import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { Kbd } from '@repo/ui/kbd'
import { SidebarTrigger } from '@repo/ui/sidebar'
import { useFetcher } from 'react-router'
import { useAIPanelHotkey } from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIToggle } from '#app/components/ai/global-ai-panel.tsx'
import { useCommandPalette } from '#app/components/command-palette-context.tsx'
import { WorkspaceBreadcrumb } from '#app/components/workspace-breadcrumb.tsx'
import { WorkspaceHeaderActions } from '#app/components/workspace-header-actions.tsx'
import NotificationBell from './ui/notification-bell'

export function SiteHeader({ isCollapsed }: { isCollapsed: boolean }) {
	const sidebar = useFetcher()
	const { open: commandOpen, setOpen } = useCommandPalette()
	const { _ } = useLingui()

	useAIPanelHotkey()

	return (
		<header
			role="banner"
			className="bg-card relative flex h-(--header-height) w-full shrink-0 items-center gap-2 border-b px-3 md:px-4"
		>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<SidebarTrigger
					onClick={() => {
						const formData = new FormData()
						formData.append('isCollapsed', isCollapsed ? 'false' : 'true')
						void sidebar.submit(formData, {
							method: 'POST',
							action: '/resources/sidebar-state',
						})
					}}
					className="-ml-1 size-7"
					type="submit"
				/>
				<WorkspaceBreadcrumb className="hidden sm:flex" />
			</div>

			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={commandOpen}
					className="text-muted-foreground hover:text-foreground hover:border-border-strong bg-muted/70 me-1 hidden h-7 w-52 items-center gap-2 rounded-md border px-2 text-left text-[13px] transition-colors md:flex lg:w-60"
				>
					<Icon name="search" className="size-3.5 shrink-0" />
					<span className="min-w-0 flex-1 truncate">
						<Trans>Search or jump to…</Trans>
					</span>
					<Kbd className="hidden lg:inline-flex">F</Kbd>
				</button>
				<button
					type="button"
					onClick={() => setOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={commandOpen}
					className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-8 items-center justify-center rounded-md md:hidden"
					aria-label={_(msg`Open command menu`)}
				>
					<Icon name="search" className="size-4" />
				</button>
				<GlobalAIToggle />
				<NotificationBell />
				<WorkspaceHeaderActions />
			</div>
		</header>
	)
}
