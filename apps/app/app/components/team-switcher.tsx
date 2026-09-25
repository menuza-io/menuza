'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	DropdownMenuGroup,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@repo/ui/sidebar'
import { useCallback, useMemo } from 'react'
import { Link, useFetcher, useSubmit } from 'react-router'
import { useHotkeys } from '#app/hooks/use-hotkeys.ts'
import {
	useLocationsData,
	useSelectedLocation,
	getLocationDisplayName,
} from '#app/utils/location/locations.ts'
import { useUserOrganizations } from '#app/utils/organization/organizations.ts'

// Chrome and Firefox reserve Cmd/Ctrl+1-9 for tab switching and pages cannot
// override it, so organization switching uses Alt instead.
const SHORTCUT_MODIFIER = 'alt'
const MAX_SHORTCUTS = 9

type OrganizationSummary = {
	name: string
	image?: { objectKey: string; altText?: string | null } | null
}

function OrganizationAvatar({
	organization,
	className,
}: {
	organization: OrganizationSummary
	className?: string
}) {
	return (
		<Avatar
			className={cn(
				'size-7 shrink-0 rounded-[4px] group-data-[collapsible=icon]:border-0 after:rounded-[4px]',
				className,
			)}
		>
			{organization.image?.objectKey ? (
				<AvatarImage
					src={`/resources/images?objectKey=${organization.image.objectKey}`}
					alt={organization.image.altText || `${organization.name} logo`}
					className="rounded-md object-cover"
				/>
			) : null}
			<AvatarFallback className="bg-sidebar-accent text-sidebar-foreground rounded-[4px] text-xs font-medium">
				{organization.name.slice(0, 2).toUpperCase()}
			</AvatarFallback>
		</Avatar>
	)
}

export function TeamSwitcher() {
	const { _ } = useLingui()
	const submit = useSubmit()
	const locationFetcher = useFetcher<{ success: boolean; locationId: string }>()
	const { isMobile, toggleSidebar } = useSidebar()

	const userOrganizations = useUserOrganizations() || {
		organizations: [],
		currentOrganization: null,
	}

	const { organizations, currentOrganization } = userOrganizations

	const activeTeam = currentOrganization?.organization

	const handleOrganizationSelect = useCallback(
		(organizationId: string) => {
			void submit(
				{ organizationId },
				{
					method: 'post',
					action: '/organizations/set-default',
				},
			)
		},
		[submit],
	)

	// Alt+1..9 jumps straight to an organization without opening the menu.
	const switchShortcuts = useMemo(
		() =>
			organizations.slice(0, MAX_SHORTCUTS).map((userOrg, index) => ({
				key: `${SHORTCUT_MODIFIER}+${index + 1}`,
				action: () => handleOrganizationSelect(userOrg.organization.id),
				description: `Switch to ${userOrg.organization.name}`,
			})),
		[organizations, handleOrganizationSelect],
	)
	useHotkeys(switchShortcuts)

	const { locations, selectedLocationId } = useLocationsData()
	const selectedLocation = useSelectedLocation()

	const optimisticLocationId =
		(locationFetcher.formData?.get('locationId') as string | undefined) ??
		selectedLocationId

	const effectiveLocation =
		optimisticLocationId === 'all'
			? null
			: locations.find((l) => l.id === optimisticLocationId) || selectedLocation

	const selectedLocationTitle = effectiveLocation
		? getLocationDisplayName(effectiveLocation.name)
		: _(msg`All locations`)

	const handleLocationSelect = useCallback(
		(locationId: string) => {
			if (!activeTeam) return
			void locationFetcher.submit(
				{ orgSlug: activeTeam.slug, locationId },
				{
					method: 'post',
					action: '/resources/location-selection',
				},
			)
		},
		[locationFetcher, activeTeam],
	)

	if (!activeTeam) {
		return null
	}

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<SidebarMenuButton
								size="lg"
								tooltip={activeTeam.name}
								className="group/org bg-background h-12 gap-3 rounded-[8px] border px-2 shadow-xs group-data-[collapsible=icon]:ml-0.5 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
							>
								<OrganizationAvatar organization={activeTeam} />
								<div className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden ltr:text-left rtl:text-right">
									<span className="text-sidebar-foreground truncate text-sm leading-5 font-medium">
										{activeTeam.name}
									</span>
									<span className="text-sidebar-foreground/60 truncate text-xs leading-4">
										{selectedLocationTitle}
									</span>
								</div>
								<Icon
									name="chevron-down"
									className="text-sidebar-foreground/50 size-4 shrink-0 transition-transform duration-200 ease-out group-data-popup-open/org:rotate-180 group-data-[collapsible=icon]:hidden motion-reduce:transition-none"
								/>
							</SidebarMenuButton>
						}
					></DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-full min-w-56 rounded-lg"
						align="start"
						side="bottom"
						sideOffset={4}
						style={{ width: 'var(--anchor-width)' }}
					>
						{/* Locations Section */}
						<DropdownMenuGroup>
							<DropdownMenuLabel>
								<Trans>Locations</Trans>
							</DropdownMenuLabel>
							<DropdownMenuItem
								onClick={() => {
									handleLocationSelect('all')
									if (isMobile) toggleSidebar()
								}}
								className="gap-2 rounded-[8px] px-1.5 py-1.5"
							>
								<span className="flex size-6 shrink-0 items-center justify-center">
									<Icon
										name="building"
										className="text-muted-foreground size-4"
									/>
								</span>
								<span className="min-w-0 flex-1 truncate font-medium">
									<Trans>All locations</Trans>
								</span>
								{optimisticLocationId === 'all' || !effectiveLocation ? (
									<Icon
										name="check"
										className="text-primary size-4 shrink-0"
										title={_(msg`Current location`)}
									/>
								) : null}
							</DropdownMenuItem>
							{locations.map((loc) => {
								const isCurrent = loc.id === optimisticLocationId
								const locName = getLocationDisplayName(loc.name)
								return (
									<DropdownMenuItem
										key={loc.id}
										onClick={() => {
											handleLocationSelect(loc.id)
											if (isMobile) toggleSidebar()
										}}
										className="gap-2 rounded-[8px] px-1.5 py-1.5"
									>
										<span className="flex size-6 shrink-0 items-center justify-center">
											<span
												aria-hidden="true"
												className={cn(
													'size-2 rounded-full',
													loc.isActive
														? 'bg-emerald-500'
														: 'bg-muted-foreground/60',
												)}
											/>
										</span>
										<span className="min-w-0 flex-1 truncate">{locName}</span>
										{isCurrent ? (
											<Icon
												name="check"
												className="text-primary size-4 shrink-0"
												title={_(msg`Current location`)}
											/>
										) : null}
									</DropdownMenuItem>
								)
							})}
							<DropdownMenuItem
								className="gap-2 px-1.5 py-0.5"
								onClick={() => isMobile && toggleSidebar()}
								render={
									<Link
										to={`/${activeTeam.slug}/settings/locations`}
										className="flex items-center gap-2"
									>
										<span className="flex size-6 shrink-0 items-center justify-center">
											<Icon
												name="gear"
												className="text-muted-foreground size-4"
											/>
										</span>
										<Trans>Manage locations</Trans>
									</Link>
								}
							/>
						</DropdownMenuGroup>
						<DropdownMenuSeparator />

						{/* Restaurants Section */}
						<DropdownMenuGroup>
							<DropdownMenuLabel>
								<Trans>Restaurants</Trans>
							</DropdownMenuLabel>
							{organizations.map((userOrg, index) => {
								const isCurrent = userOrg.organization.id === activeTeam.id
								return (
									<DropdownMenuItem
										key={userOrg.organization.id}
										onClick={() => {
											handleOrganizationSelect(userOrg.organization.id)
											if (isMobile) toggleSidebar()
										}}
										className="gap-2 rounded-[8px] px-1.5 py-1.5"
									>
										<OrganizationAvatar
											organization={userOrg.organization}
											className="size-6"
										/>
										<span className="min-w-0 flex-1 truncate">
											{userOrg.organization.name}
										</span>
										{isCurrent ? (
											<Icon
												name="check"
												className="text-primary size-4 shrink-0"
												title={_(msg`Current restaurant`)}
											/>
										) : null}
										{index < MAX_SHORTCUTS ? (
											<span className="text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground shrink-0 text-xs tabular-nums">
												⌥{index + 1}
											</span>
										) : null}
									</DropdownMenuItem>
								)
							})}
							<DropdownMenuItem
								className="gap-2 px-1.5 py-0.5"
								onClick={() => isMobile && toggleSidebar()}
								render={
									<Link
										to={`/${activeTeam.slug}/settings/members`}
										className="flex items-center gap-2"
									>
										<span className="flex size-6 shrink-0 items-center justify-center">
											<Icon
												name="user-plus"
												className="text-muted-foreground size-4"
											/>
										</span>
										<Trans>Invite members</Trans>
									</Link>
								}
							></DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="gap-2 px-1.5 py-0.5"
								render={
									<Link
										to="/organizations/create"
										className="flex items-center gap-2"
									>
										<span className="flex size-6 shrink-0 items-center justify-center">
											<Icon
												name="plus"
												className="text-muted-foreground size-4"
											/>
										</span>
										<Trans>Add restaurant</Trans>
									</Link>
								}
							></DropdownMenuItem>
						</DropdownMenuGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
