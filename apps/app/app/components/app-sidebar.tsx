import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type OnboardingProgressData } from '@repo/common/onboarding'
import { useDirection } from '@repo/ui'
import { ArrowLeftIcon } from '@repo/ui/arrow-left-icon'
import { BuildingIcon } from '@repo/ui/building-icon'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@repo/ui/card'
import { CircleHelpIcon } from '@repo/ui/circle-help'
import { FoldersIcon } from '@repo/ui/folders-icon'
import { HomeIcon } from '@repo/ui/home-icon'
import { Icon } from '@repo/ui/icon'
import { Kbd } from '@repo/ui/kbd'
import { LaptopMinimalCheckIcon } from '@repo/ui/laptop-minimal-check-icon'
import { LockOpenIcon } from '@repo/ui/lock-open-icon'
import { Logo } from '@repo/ui/logo'
import { MessageSquareMoreIcon } from '@repo/ui/message-square-more'
import { SettingsGearIcon } from '@repo/ui/settings-gear-icon'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenuButton,
} from '@repo/ui/sidebar'
import { UserIcon } from '@repo/ui/user-icon'
import { UserRoundPlusIcon } from '@repo/ui/user-round-plus'
import { motion } from 'motion/react'
import React, { useEffect, useState } from 'react'
import { useLocation, useRouteLoaderData, Link } from 'react-router'
import { NavMain } from '#app/components/nav-main.tsx'
import { NavUser } from '#app/components/nav-user.tsx'
import { OnboardingChecklist } from '#app/components/onboarding-checklist.tsx'
import { TeamSwitcher } from '#app/components/team-switcher.tsx'
import { useGlobalHotkeys } from '#app/hooks/use-hotkeys.ts'

import { type loader as rootLoader } from '#app/root.tsx'
import { CommandMenu } from './command-menu'
import FeedbackModal from './core/feedback-modal'
import FavoriteNotes from './favorite-notes'
import { FeatureUpdates } from './feature-updates'
import { ChartPieIcon } from './icons/chart-pie-icon'
import { ExternalLinkIcon } from './icons/external-link-icon'
import { SendIcon } from './icons/send-icon'
import { UsersRoundIcon } from './icons/users-round-icon'
import { NavSecondary } from './nav-secondary'

// Upgrade Account Card Component
function UpgradeAccountCard({
	trialStatus,
	orgSlug,
	launchStatus,
}: {
	trialStatus: { isActive: boolean; daysRemaining: number }
	orgSlug: string
	launchStatus?: string
}) {
	if (trialStatus.isActive) return null
	if (trialStatus.daysRemaining < 0) return null
	// Hide upgrade card for PUBLIC_BETA and CLOSED_BETA
	if (launchStatus === 'PUBLIC_BETA' || launchStatus === 'CLOSED_BETA')
		return null

	// Extract for lingui compliance
	const daysRemaining = trialStatus.daysRemaining

	return (
		<Card className="bg-sidebar-accent dark:bg-sidebar-accent border-sidebar-border mx-2 mb-4 gap-1 border p-2 group-data-[collapsible=icon]:hidden">
			<CardHeader className="p-2">
				<CardDescription className="text-sidebar-foreground">
					<Trans>
						There are{' '}
						<span className="text-destructive font-bold dark:text-red-400">
							{daysRemaining} days
						</span>{' '}
						left in your trial. Get in touch with questions or feedback.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="-mt-4 flex flex-col gap-1 border-0 bg-transparent p-2 pb-0 shadow-none ring-0">
				<Button
					variant="secondary"
					size="sm"
					className="bg-sidebar-foreground text-sidebar hover:bg-sidebar-foreground/70 w-full"
					render={<Link to={`/${orgSlug}/settings/billing`} />}
				>
					<Trans>Upgrade</Trans>
				</Button>
				<Button
					variant="link"
					size="sm"
					className="text-sidebar-foreground hover:text-sidebar-foreground/80 w-full"
				>
					<Trans>Get in touch</Trans>
				</Button>
			</CardContent>
		</Card>
	)
}

// Account Sidebar Component
function AccountSidebar({
	user,
	location,
	orgSlug,
	docsUrl,
	onFeedbackClick,
}: {
	user: any
	location: any
	orgSlug: string | undefined
	docsUrl?: string | null
	onFeedbackClick: () => void
}) {
	const { _ } = useLingui()
	const isProfileRoute = location.pathname === '/profile'
	const isSecurityRoute = location.pathname === '/security'
	const isOrganizationsRoute = location.pathname === '/organizations'

	const navMain = [
		{
			title: _(msg`Dashboard`),
			url: orgSlug ? `/${orgSlug}` : '/organizations',
			isActive: false,
			icon: ArrowLeftIcon,
		},
		{
			title: _(msg`Profile`),
			url: '/profile',
			isActive: isProfileRoute,
			icon: UserIcon,
		},
		{
			title: _(msg`Security`),
			url: '/security',
			isActive: isSecurityRoute,
			icon: LockOpenIcon,
		},
		{
			title: _(msg`Organizations`),
			url: '/organizations',
			isActive: isOrganizationsRoute,
			icon: BuildingIcon,
		},
	]

	const navSecondary = [
		...(docsUrl
			? [
					{
						title: _(msg`Get help`),
						url: docsUrl,
						icon: CircleHelpIcon,
						target: '_blank',
					},
				]
			: []),
		{
			title: _(msg`Give feedback`),
			icon: MessageSquareMoreIcon,
			onClick: onFeedbackClick,
		},
	]

	return (
		<>
			<SidebarContent>
				<NavMain items={navMain} />
				<div className="mt-auto">
					<NavSecondary items={navSecondary} />
				</div>
			</SidebarContent>
			<SidebarFooter>
				<NavUser user={user} />
			</SidebarFooter>
		</>
	)
}

// Organization Sidebar Component
function OrganizationSidebar({
	user,
	location,
	onboardingProgress,
	orgSlug,
	organizationId,
	homePageId,
	favoriteNotes,
	setHasVisibleFeatureUpdates,
	trialStatus,
	rootData,
	onFeedbackClick,
	extensionId,
	docsUrl,
	commandOpen,
	setCommandOpen,
}: {
	user: any
	location: any
	onboardingProgress: OnboardingProgressData | null | undefined
	orgSlug: string | undefined
	organizationId: string | undefined
	homePageId: string | null
	favoriteNotes: any
	setHasVisibleFeatureUpdates: (value: boolean) => void
	trialStatus?: { isActive: boolean; daysRemaining: number }
	rootData: any
	onFeedbackClick: () => void
	extensionId?: string
	docsUrl?: string | null
	commandOpen: boolean
	setCommandOpen: (open: boolean) => void
}) {
	const { _ } = useLingui()
	const goToHomepageLabel = _(msg`Go to homepage`)
	const searchNotesLabel = _(msg`Search notes`)
	const [isExtensionInstalled, setIsExtensionInstalled] = useState(false)

	useEffect(() => {
		if (!extensionId) return

		// Type assertion for Chrome extension API
		const chromeWindow = window as any
		if (chromeWindow?.chrome?.runtime?.sendMessage) {
			try {
				chromeWindow.chrome.runtime.sendMessage(
					extensionId,
					{ type: 'PING' },
					() => {
						if (chromeWindow.chrome?.runtime?.lastError) {
							setIsExtensionInstalled(false)
						} else {
							setIsExtensionInstalled(true)
						}
					},
				)
			} catch {
				setIsExtensionInstalled(false)
			}
		}
	}, [extensionId])
	const navMain = [
		{
			title: _(msg`Dashboard`),
			url: `/${orgSlug}`,
			isActive: location.pathname === `/${orgSlug}`,
			icon: HomeIcon,
		},
		{
			title: _(msg`Reports`),
			url: `/${orgSlug}/reports`,
			isActive: location.pathname.includes(`/${orgSlug}/reports`),
			icon: ChartPieIcon,
		},
		{
			title: _(msg`Notes`),
			url: `/${orgSlug}/notes`,
			isActive: location.pathname.includes(`/${orgSlug}/notes`),
			icon: FoldersIcon,
		},
		{
			title: _(msg`Customers`),
			url: `/${orgSlug}/customers`,
			isActive: location.pathname.includes(`/${orgSlug}/customers`),
			icon: UsersRoundIcon,
		},
		{
			title: _(msg`Marketing`),
			url: `/${orgSlug}/marketing`,
			isActive: location.pathname.includes(`/${orgSlug}/marketing`),
			icon: SendIcon,
			items: [
				{
					title: _(msg`Overview`),
					url: `/${orgSlug}/marketing`,
					isActive:
						location.pathname === `/${orgSlug}/marketing` ||
						location.pathname === `/${orgSlug}/marketing/`,
				},
				{
					title: _(msg`Broadcasts`),
					url: `/${orgSlug}/marketing/campaigns`,
					isActive: location.pathname.includes(
						`/${orgSlug}/marketing/campaigns`,
					),
				},
				{
					title: _(msg`Automations`),
					url: `/${orgSlug}/marketing/automations`,
					isActive: location.pathname.includes(
						`/${orgSlug}/marketing/automations`,
					),
				},
			],
		},
		{
			title: _(msg`Website`),
			url: `/${orgSlug}/website`,
			isActive: location.pathname.includes(`/${orgSlug}/website`),
			icon: LaptopMinimalCheckIcon,
			items: [
				{
					title: _(msg`General Settings`),
					url: `/${orgSlug}/website`,
					isActive: location.pathname === `/${orgSlug}/website`,
				},
				{
					title: _(msg`Pages`),
					url: `/${orgSlug}/website/pages`,
					isActive: location.pathname.includes(`/${orgSlug}/website/pages`),
				},
				{
					title: _(msg`Forms`),
					url: `/${orgSlug}/website/forms`,
					isActive: location.pathname.includes(`/${orgSlug}/website/forms`),
				},
				{
					title: _(msg`Analytics`),
					url: `/${orgSlug}/website/analytics`,
					isActive: location.pathname.includes(`/${orgSlug}/website/analytics`),
				},
				...(homePageId
					? [
							{
								title: _(msg`Branding`),
								url: `/${orgSlug}/website/pages/${homePageId}?panel=branding`,
								isActive:
									location.pathname.includes(`/${orgSlug}/website/pages/`) &&
									location.search.includes('panel=branding'),
							},
						]
					: []),
				{
					title: _(msg`Announcements`),
					url: `/${orgSlug}/website/announcements`,
					isActive: location.pathname.includes(
						`/${orgSlug}/website/announcements`,
					),
				},
				{
					title: _(msg`Redirects`),
					url: `/${orgSlug}/website/redirects`,
					isActive: location.pathname.includes(`/${orgSlug}/website/redirects`),
				},
			],
		},
		{
			title: _(msg`Settings`),
			url: `/${orgSlug}/settings`,
			isActive:
				location.pathname.includes(`/${orgSlug}/settings`) ||
				location.pathname.includes(`/${orgSlug}/mcp`),
			icon: SettingsGearIcon,
			items: [
				{
					title: _(msg`General`),
					url: `/${orgSlug}/settings`,
					isActive: location.pathname === `/${orgSlug}/settings`,
				},
				{
					title: _(msg`Members`),
					url: `/${orgSlug}/settings/members`,
					isActive: location.pathname === `/${orgSlug}/settings/members`,
				},
				{
					title: _(msg`Integrations`),
					url: `/${orgSlug}/settings/integrations`,
					isActive: location.pathname === `/${orgSlug}/settings/integrations`,
				},
				{
					title: _(msg`Shop`),
					url: `/${orgSlug}/settings/shop`,
					isActive: location.pathname === `/${orgSlug}/settings/shop`,
				},
				{
					title: _(msg`MCP Server`),
					url: `/${orgSlug}/mcp`,
					isActive: location.pathname.includes(`/${orgSlug}/mcp`),
				},
				{
					title: _(msg`Notifications`),
					url: `/${orgSlug}/settings/notifications`,
					isActive: location.pathname === `/${orgSlug}/settings/notifications`,
				},
				// Hide billing for PUBLIC_BETA and CLOSED_BETA
				...(rootData?.launchStatus !== 'PUBLIC_BETA' &&
				rootData?.launchStatus !== 'CLOSED_BETA'
					? [
							{
								title: _(msg`Billing`),
								url: `/${orgSlug}/settings/billing`,
								isActive: location.pathname === `/${orgSlug}/settings/billing`,
							},
						]
					: []),
			],
		},
	]

	const navSecondary = [
		...(!isExtensionInstalled &&
		extensionId &&
		extensionId !== 'your-extension-id'
			? [
					{
						title: _(msg`Get chrome extension`),
						url: `https://chrome.google.com/webstore/detail/${extensionId}`,
						icon: ExternalLinkIcon,
						target: '_blank',
					},
				]
			: []),
		{
			title: _(msg`Add members`),
			url: `/${orgSlug}/settings/members`,
			icon: UserRoundPlusIcon,
		},
		...(docsUrl
			? [
					{
						title: _(msg`Get help`),
						url: docsUrl,
						icon: CircleHelpIcon,
						target: '_blank',
					},
				]
			: []),
		{
			title: _(msg`Give feedback`),
			icon: MessageSquareMoreIcon,
			onClick: onFeedbackClick,
		},
	]

	return (
		<>
			<SidebarHeader className="gap-2 px-2 pb-2">
				<Link
					to="/"
					aria-label={goToHomepageLabel}
					className="flex w-full justify-start"
				>
					<Logo
						className="h-10 gap-1 px-1 text-base transition-[gap] duration-200 ease-out group-data-[collapsible=icon]:gap-0 motion-reduce:transition-none"
						aria-hidden="true"
					/>
				</Link>
				<SidebarMenuButton
					variant="outline"
					tooltip={searchNotesLabel}
					className="text-muted-foreground bg-background relative rounded-xl border text-left font-normal shadow-xs group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:bg-transparent"
					onClick={() => setCommandOpen(true)}
					aria-haspopup="dialog"
					aria-expanded={commandOpen}
					aria-label={searchNotesLabel}
				>
					<Icon name="search" className="h-4 w-4 shrink-0" />
					<span className="min-w-0 flex-1 truncate text-xs group-data-[collapsible=icon]:hidden">
						<Trans>Search notes...</Trans>
					</span>
					<Kbd className="absolute top-[0.3rem] right-[0.3rem] group-data-[collapsible=icon]:hidden">
						<span className="text-xs">⌘</span>K
					</Kbd>
				</SidebarMenuButton>
				<TeamSwitcher />
			</SidebarHeader>

			<SidebarContent>
				{/* Onboarding Checklist */}
				{onboardingProgress &&
					!onboardingProgress.isCompleted &&
					onboardingProgress.isVisible &&
					orgSlug &&
					organizationId && (
						<OnboardingChecklist
							progress={onboardingProgress}
							orgSlug={orgSlug}
							organizationId={organizationId}
							variant="sidebar"
						/>
					)}

				<NavMain items={navMain} />

				{/* Favorite Notes */}
				{favoriteNotes && orgSlug && (
					<FavoriteNotes favoriteNotes={favoriteNotes} orgSlug={orgSlug} />
				)}

				<div className="mt-auto">
					{/* Upgrade Account Card */}
					{trialStatus && orgSlug && (
						<UpgradeAccountCard
							trialStatus={trialStatus}
							orgSlug={orgSlug}
							launchStatus={rootData?.launchStatus}
						/>
					)}
					{/* Feature Updates */}
					{!trialStatus && (
						<FeatureUpdates onVisibilityChange={setHasVisibleFeatureUpdates} />
					)}
					{/* NavSecondary */}
					<NavSecondary items={navSecondary} />
				</div>
			</SidebarContent>

			<SidebarFooter>
				<NavUser
					user={user}
					userPreference={rootData?.requestInfo?.userPrefs?.theme}
				/>
			</SidebarFooter>
		</>
	)
}

export function AppSidebar({
	onboardingProgress,
	trialStatus,
	extensionId,
	...props
}: React.ComponentProps<typeof Sidebar> & {
	onboardingProgress?: OnboardingProgressData | null
	trialStatus?: { isActive: boolean; daysRemaining: number }
	extensionId?: string
}) {
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const location = useLocation()
	const [, setHasVisibleFeatureUpdates] = React.useState(true)
	const [isFeedbackModalOpen, setIsFeedbackModalOpen] = React.useState(false)
	const [commandOpen, setCommandOpen] = React.useState(false)
	const direction = useDirection()

	useGlobalHotkeys(setCommandOpen)

	const orgSlug =
		rootData?.userOrganizations?.currentOrganization?.organization.slug
	const organizationId =
		rootData?.userOrganizations?.currentOrganization?.organization.id
	const homePageId = rootData?.homePageId ?? null

	// Check if we're on profile or organizations routes
	const isProfileRoute = location.pathname === '/profile'
	const isSecurityRoute = location.pathname === '/security'
	const isOrganizationsRoute = location.pathname === '/organizations'
	const isAccountRoute =
		isProfileRoute || isSecurityRoute || isOrganizationsRoute

	const userData = rootData?.user
		? {
				name: rootData.user.name || rootData.user.username || 'User',
				email: rootData.user.username,
				avatar: rootData.user.image
					? `/resources/images?objectKey=${rootData.user.image.objectKey}`
					: '/avatars/user.jpg',
				roles: rootData.user.roles,
			}
		: {
				name: 'Guest',
				email: '',
				avatar: '/avatars/user.jpg',
				roles: [],
			}

	return (
		<>
			<Sidebar
				side={direction === 'rtl' ? 'right' : 'left'}
				collapsible="icon"
				{...props}
				className="overflow-hidden"
			>
				<FeedbackModal
					isOpen={isFeedbackModalOpen}
					onOpenChange={setIsFeedbackModalOpen}
				/>
				<div className="relative h-full">
					{/* Account Sidebar */}
					<motion.div
						initial={{
							x: isAccountRoute ? 0 : -300,
							opacity: isAccountRoute ? 1 : 0,
						}}
						animate={{
							x: isAccountRoute ? 0 : -300,
							opacity: isAccountRoute ? 1 : 0,
						}}
						transition={{
							duration: 0.4,
							ease: [0.4, 0, 0.2, 1],
							opacity: { duration: 0.3 },
						}}
						className="absolute inset-0 flex h-full flex-col"
						style={{ pointerEvents: isAccountRoute ? 'auto' : 'none' }}
						inert={!isAccountRoute ? true : undefined}
					>
						<AccountSidebar
							user={userData}
							location={location}
							orgSlug={orgSlug}
							docsUrl={rootData?.docsUrl}
							onFeedbackClick={() => setIsFeedbackModalOpen(true)}
						/>
					</motion.div>

					{/* Organization Sidebar */}
					<motion.div
						initial={{
							x: !isAccountRoute ? 0 : 300,
							opacity: !isAccountRoute ? 1 : 0,
						}}
						animate={{
							x: !isAccountRoute ? 0 : 300,
							opacity: !isAccountRoute ? 1 : 0,
						}}
						transition={{
							duration: 0.4,
							ease: [0.4, 0, 0.2, 1],
							opacity: { duration: 0.3 },
						}}
						className="absolute inset-0 flex h-full flex-col"
						style={{ pointerEvents: !isAccountRoute ? 'auto' : 'none' }}
						inert={isAccountRoute ? true : undefined}
					>
						<OrganizationSidebar
							user={userData}
							location={location}
							onboardingProgress={onboardingProgress}
							orgSlug={orgSlug}
							organizationId={organizationId}
							homePageId={homePageId}
							favoriteNotes={rootData?.favoriteNotes}
							setHasVisibleFeatureUpdates={setHasVisibleFeatureUpdates}
							trialStatus={trialStatus}
							rootData={rootData}
							onFeedbackClick={() => setIsFeedbackModalOpen(true)}
							extensionId={extensionId}
							docsUrl={rootData?.docsUrl}
							commandOpen={commandOpen}
							setCommandOpen={setCommandOpen}
						/>
					</motion.div>
				</div>
			</Sidebar>
			<CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
		</>
	)
}
