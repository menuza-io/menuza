import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { type DashboardShareAccess } from '#app/utils/dashboards/config.ts'
import { type SwitcherDashboards } from '#app/utils/dashboards/queries.server.ts'
import { DashboardNameDialog } from './dashboard-name-dialog.tsx'

const ACCESS_LABELS: Record<DashboardShareAccess, MessageDescriptor> = {
	view: msg`View only`,
	edit: msg`Can edit`,
}

function SwitcherLink({
	to,
	current,
	children,
}: {
	to: string
	current: boolean
	children: ReactNode
}) {
	return (
		<DropdownMenuItem
			render={<Link to={to} aria-current={current ? 'page' : undefined} />}
		>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
			{current ? <Icon name="check" className="text-primary size-4" /> : null}
		</DropdownMenuItem>
	)
}

/**
 * Names the open dashboard and switches between Home, the user's own
 * dashboards and those shared with them in this organization. "New dashboard"
 * creates one and opens it.
 */
export function DashboardSwitcher({
	orgSlug,
	current,
	dashboards,
}: {
	orgSlug: string
	/** The open dashboard; Home has no id. */
	current: { id: null } | { id: string; name: string }
	dashboards: SwitcherDashboards
}) {
	const { _ } = useLingui()
	const [creating, setCreating] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const homeName = _(msg`Home`)
	const currentName = current.id === null ? homeName : current.name

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					ref={triggerRef}
					render={
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="max-w-full min-w-0"
						/>
					}
				>
					<Icon name="layout-grid" className="text-muted-foreground" />
					<span className="truncate">{currentName}</span>
					<Icon name="chevron-down" className="text-muted-foreground" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-auto max-w-80 min-w-64">
					<DropdownMenuGroup>
						<DropdownMenuLabel>
							<Trans>Home</Trans>
						</DropdownMenuLabel>
						<SwitcherLink to={`/${orgSlug}`} current={current.id === null}>
							<span className="truncate">{homeName}</span>
						</SwitcherLink>
					</DropdownMenuGroup>
					{dashboards.mine.length > 0 ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuLabel>
									<Trans>My dashboards</Trans>
								</DropdownMenuLabel>
								{dashboards.mine.map((dashboard) => (
									<SwitcherLink
										key={dashboard.id}
										to={`/${orgSlug}/dashboards/${dashboard.id}`}
										current={dashboard.id === current.id}
									>
										<span className="truncate">{dashboard.name}</span>
									</SwitcherLink>
								))}
							</DropdownMenuGroup>
						</>
					) : null}
					{dashboards.sharedWithMe.length > 0 ? (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuGroup>
								<DropdownMenuLabel>
									<Trans>Shared with me</Trans>
								</DropdownMenuLabel>
								{dashboards.sharedWithMe.map((dashboard) => {
									const { ownerName } = dashboard
									const access = _(ACCESS_LABELS[dashboard.access])
									return (
										<SwitcherLink
											key={dashboard.id}
											to={`/${orgSlug}/dashboards/${dashboard.id}`}
											current={dashboard.id === current.id}
										>
											<span className="truncate">{dashboard.name}</span>
											<span className="text-muted-foreground truncate text-xs">
												{_(msg`${ownerName} · ${access}`)}
											</span>
										</SwitcherLink>
									)
								})}
							</DropdownMenuGroup>
						</>
					) : null}
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setCreating(true)}>
						<Icon name="plus" />
						<Trans>New dashboard</Trans>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<DashboardNameDialog
				open={creating}
				onOpenChange={setCreating}
				finalFocus={triggerRef}
				action={`/${orgSlug}/dashboards`}
				intent="create"
				title={<Trans>New dashboard</Trans>}
				description={
					<Trans>Name your dashboard. You can add blocks to it next.</Trans>
				}
				submitLabel={<Trans>Create dashboard</Trans>}
			/>
		</>
	)
}
