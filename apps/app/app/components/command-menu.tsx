import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandShortcut,
	Command,
} from '@repo/ui/command'
import { Icon, type IconName } from '@repo/ui/icon'
import { useEffect, useState, useCallback } from 'react'
import { useRouteLoaderData, useFetcher, useNavigate } from 'react-router'
import { type loader as rootLoader } from '#app/root.tsx'
import {
	HIDDEN_STAFFING_NAV,
	type StaffingNavAccess,
} from '#app/utils/staffing/nav.ts'

interface Note {
	id: string
	title: string
	content: string
	createdAt: string
	updatedAt: string
	createdByName: string
}

interface NavigationCommand {
	label: MessageDescriptor
	url: string
	icon: IconName
}

/**
 * The sidebar's main sections as palette entries, behind the same permission
 * checks as `visibleNavMain` in `app-sidebar.tsx`. Keep the two in step.
 */
export function getNavigationCommands({
	orgSlug,
	permissions,
	staffingNav,
}: {
	orgSlug: string
	permissions: ReadonlyArray<{ action: string; entity: string }>
	staffingNav: StaffingNavAccess
}): NavigationCommand[] {
	const can = (action: string, entity: string) =>
		permissions.some(
			(permission) =>
				permission.action === action && permission.entity === entity,
		)
	const canReadWebsite = can('read', 'website')
	const canReadPhoneAgent = can('read', 'phone_agent')
	const canReadPhoneCalls = can('read', 'phone_call')
	const staffUrl = (
		[
			['team', staffingNav.team],
			['timeclock', staffingNav.timeclock],
			['schedule', staffingNav.schedule],
			['labor', staffingNav.labor],
			['hiring', staffingNav.hiring],
		] as const
	).find(([, allowed]) => allowed)?.[0]

	const commands: Array<NavigationCommand | false> = [
		{ label: msg`Dashboard`, url: `/${orgSlug}`, icon: 'layout-grid' },
		{ label: msg`Reports`, url: `/${orgSlug}/reports`, icon: 'trending-up' },
		{ label: msg`Notes`, url: `/${orgSlug}/notes`, icon: 'folder' },
		{ label: msg`Media library`, url: `/${orgSlug}/media`, icon: 'image' },
		{ label: msg`Customers`, url: `/${orgSlug}/customers`, icon: 'users' },
		{ label: msg`Chat`, url: `/${orgSlug}/chat`, icon: 'message-circle' },
		(canReadWebsite || canReadPhoneCalls) && {
			label: msg`Mailbox`,
			url: `/${orgSlug}/mailbox`,
			icon: 'mail',
		},
		(can('read', 'campaign') || can('read', 'automation')) && {
			label: msg`Marketing`,
			url: `/${orgSlug}/marketing`,
			icon: 'send',
		},
		(canReadPhoneAgent || canReadPhoneCalls) && {
			label: msg`Phone agent`,
			// People who can only see calls land on Calls, not Setup.
			url: canReadPhoneAgent
				? `/${orgSlug}/phone-agent`
				: `/${orgSlug}/phone-agent/calls`,
			icon: 'phone',
		},
		staffingNav.visible && {
			label: msg`Staff`,
			url: staffUrl ? `/${orgSlug}/staff/${staffUrl}` : `/${orgSlug}/staff`,
			icon: 'person',
		},
		(canReadWebsite || can('read', 'announcement')) && {
			label: msg`Website`,
			url: canReadWebsite
				? `/${orgSlug}/website`
				: `/${orgSlug}/website/announcements`,
			icon: 'monitor',
		},
	]
	return commands.filter((command) => command !== false)
}

interface CommandMenuProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function CommandMenu({ open, onOpenChange }: CommandMenuProps) {
	const [notes, setNotes] = useState<Note[]>([])
	const [loading, setLoading] = useState(false)
	const [query, setQuery] = useState('')
	const [hasTrackedUsage, setHasTrackedUsage] = useState(false)
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const fetcher = useFetcher()
	const { _ } = useLingui()
	const navigate = useNavigate()

	const orgSlug =
		rootData?.userOrganizations?.currentOrganization?.organization.slug
	const organizationId =
		rootData?.userOrganizations?.currentOrganization?.organization.id
	const navigationCommands = orgSlug
		? getNavigationCommands({
				orgSlug,
				permissions:
					rootData?.userOrganizations?.currentOrganization?.organizationRole
						?.permissions ?? [],
				staffingNav: rootData?.staffingNav ?? HIDDEN_STAFFING_NAV,
			})
		: []

	// Track command menu usage for onboarding (only once per session)
	useEffect(() => {
		if (open && !hasTrackedUsage && organizationId) {
			setHasTrackedUsage(true)
			void fetcher.submit(
				{ stepKey: 'explore_command_menu', organizationId },
				{ method: 'POST', action: '/api/onboarding/complete-step' },
			)
		}
	}, [open, hasTrackedUsage, organizationId, fetcher])

	const searchNotes = useCallback(
		async (searchQuery: string) => {
			if (!orgSlug) return

			setLoading(true)
			try {
				const params = new URLSearchParams({
					orgSlug,
					...(searchQuery && { q: searchQuery }),
				})
				const response = await fetch(`/resources/search-notes?${params}`)
				if (response.ok) {
					const data = (await response.json()) as { notes: Note[] }
					setNotes(data.notes)
				}
			} catch (error) {
				console.error('Failed to search notes:', error)
				setNotes([])
			} finally {
				setLoading(false)
			}
		},
		[orgSlug],
	)

	// Debounce search
	useEffect(() => {
		if (!open) return

		const timeoutId = setTimeout(() => {
			void searchNotes(query)
		}, 300)

		return () => clearTimeout(timeoutId)
	}, [open, query, searchNotes])

	return (
		<CommandDialog
			open={open}
			onOpenChange={onOpenChange}
			className="rounded-lg border shadow-md md:min-w-[650px]"
		>
			<Command>
				<CommandInput
					placeholder={_(t`Search or jump to…`)}
					value={query}
					onValueChange={setQuery}
				/>
				<CommandList className="md:min-h-[400px]">
					<CommandEmpty>
						{loading ? (
							<Trans>Searching…</Trans>
						) : (
							<Trans>No results found.</Trans>
						)}
					</CommandEmpty>

					{navigationCommands.length > 0 && (
						<CommandGroup heading={_(t`Go to`)}>
							{navigationCommands.map((command) => (
								<CommandItem
									key={command.url}
									onSelect={() => {
										void navigate(command.url)
										onOpenChange(false)
									}}
								>
									<Icon name={command.icon} />
									<span>{_(command.label)}</span>
								</CommandItem>
							))}
						</CommandGroup>
					)}

					<CommandGroup heading={_(t`Actions`)}>
						<CommandItem
							onSelect={() => {
								void navigate(`/${orgSlug}/notes/new`)
								onOpenChange(false)
							}}
						>
							<Icon name="plus" />
							<Trans>Create new note</Trans>
						</CommandItem>
						<CommandItem
							onSelect={() => {
								void navigate(`/${orgSlug}/settings/members`)
								onOpenChange(false)
							}}
						>
							<Icon name="user-plus" />
							<Trans>Invite new members</Trans>
						</CommandItem>
					</CommandGroup>

					{notes.length > 0 && (
						<CommandGroup heading={_(t`Notes`)}>
							{notes.map((note) => {
								const createdByName = note.createdByName
								return (
									<CommandItem
										key={note.id}
										onSelect={() => {
											void navigate(`/${orgSlug}/notes/${note.id}`)
											onOpenChange(false)
										}}
									>
										<Icon name="file-text" />
										<div className="flex flex-col items-start">
											<span className="font-medium">{note.title}</span>
											<span className="text-muted-foreground text-xs">
												<Trans>by {createdByName}</Trans>
											</span>
										</div>
									</CommandItem>
								)
							})}
						</CommandGroup>
					)}
					<CommandGroup heading={_(t`Settings`)}>
						<CommandItem
							onSelect={() => {
								void navigate('/profile')
								onOpenChange(false)
							}}
						>
							<Icon name="user" />
							<span>
								<Trans>Account settings</Trans>
							</span>
							<CommandShortcut>P</CommandShortcut>
						</CommandItem>
						<CommandItem
							onSelect={() => {
								void navigate(`/${orgSlug}/settings/billing`)
								onOpenChange(false)
							}}
						>
							<Icon name="credit-card" />
							<span>
								<Trans>Billing</Trans>
							</span>
							<CommandShortcut>B</CommandShortcut>
						</CommandItem>
						<CommandItem
							onSelect={() => {
								void navigate(`/${orgSlug}/settings`)
								onOpenChange(false)
							}}
						>
							<Icon name="settings" />
							<span>
								<Trans>Settings</Trans>
							</span>
							<CommandShortcut>S</CommandShortcut>
						</CommandItem>
					</CommandGroup>
				</CommandList>
			</Command>
		</CommandDialog>
	)
}
