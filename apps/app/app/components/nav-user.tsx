import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { BuildingIcon } from '@repo/ui/building-icon'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { LanguagesIcon } from '@repo/ui/languages-icon'
import { LogoutIcon } from '@repo/ui/logout-icon'
import { SettingsGearIcon } from '@repo/ui/settings-gear-icon'
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@repo/ui/sidebar'
import { SunMoonIcon } from '@repo/ui/sun-moon-icon'
import { UserIcon } from '@repo/ui/user-icon'
import { useRef } from 'react'
import {
	Link,
	useFetcher,
	useRouteLoaderData,
	useSearchParams,
	useSubmit,
} from 'react-router'

import { type loader } from '#app/root.tsx'
import { useOptimisticThemeMode } from '#app/routes/resources+/theme-switch.tsx'
import { UserAvatar } from './user-avatar'

export function NavUser({
	user,
	userPreference,
}: {
	user: {
		name: string
		email: string
		avatar: string
		roles?: Array<{ name: string }> | undefined
	}
	userPreference?: 'light' | 'dark' | 'system' | null
}) {
	const { isMobile, toggleSidebar } = useSidebar()
	const iconRefs = useRef<{ [key: string]: any }>({})
	const themeFetcher = useFetcher()
	const submit = useSubmit()

	// Check if user has admin role
	const isAdmin = user.roles?.some((role) => role.name === 'admin') ?? false

	const getInitials = (name: string) => {
		const parts = name
			.trim()
			.split(/\s+/)
			.filter((part) => part.length > 0)
		if (parts.length >= 2) {
			return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
		}
		return name.slice(0, 2).toUpperCase()
	}

	// Generate admin URL by replacing app. with admin.
	const getAdminUrl = () => {
		if (typeof window === 'undefined') return ''

		const { protocol, hostname, port } = window.location
		const adminHostname = hostname.startsWith('app.')
			? hostname.replace('app.', 'admin.')
			: `admin.${hostname}`

		return `${protocol}//${adminHostname}${port ? `:${port}` : ''}`
	}

	// Theme switching logic
	const optimisticMode = useOptimisticThemeMode()
	const mode = optimisticMode ?? userPreference ?? 'system'

	const { _ } = useLingui()

	const themeOptions = [
		{ value: 'light', icon: 'sun', label: _(msg`Light mode`) },
		{ value: 'dark', icon: 'moon', label: _(msg`Dark mode`) },
		{ value: 'system', icon: 'laptop', label: _(msg`System theme`) },
	] as const

	// Language switching
	const rootData = useRouteLoaderData<typeof loader>('root')
	const [searchParams] = useSearchParams()
	// Extract base language code (e.g., 'ar' from 'ar-SA')
	const currentLocale = (rootData?.locale ?? 'en').split(/[-_]/)[0] ?? 'en'

	const languageOptions = [
		{ value: 'en', label: _(msg`English`), nativeName: 'English' },
		{ value: 'ar', label: _(msg`Arabic`), nativeName: 'العربية' },
	] as const

	const handleLanguageChange = (newLocale: string) => {
		const newSearchParams = new URLSearchParams(searchParams)
		newSearchParams.set('lng', newLocale)
		window.location.search = newSearchParams.toString()
	}

	const handleMenuItemMouseEnter = (iconKey: string) => {
		const iconRef = iconRefs.current[iconKey]
		if (iconRef?.startAnimation) {
			iconRef.startAnimation()
		}
	}

	const handleMenuItemMouseLeave = (iconKey: string) => {
		const iconRef = iconRefs.current[iconKey]
		if (iconRef?.stopAnimation) {
			iconRef.stopAnimation()
		}
	}

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<SidebarMenuButton
								size="lg"
								className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground bg-background rounded-full border"
							>
								<UserAvatar
									user={{
										name: getInitials(user.name),
										email: user.email,
										image: user.avatar,
									}}
									className="h-8 w-8"
									alt={user.name}
								/>
								<div className="grid flex-1 text-sm leading-tight ltr:text-left rtl:text-right">
									<span className="truncate font-medium">{user.name}</span>
									<span className="text-muted-foreground truncate text-xs">
										{user.email}
									</span>
								</div>
								<Icon name="ellipsis-vertical" className="ml-auto size-4" />
							</SidebarMenuButton>
						}
					></DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-(--radix-dropdown-menu-trigger-width) min-w-40 rounded-lg"
						side={isMobile ? 'bottom' : 'top'}
						align="start"
						sideOffset={4}
						style={{ width: 'var(--anchor-width)' }}
					>
						<DropdownMenuItem
							onClick={() => isMobile && toggleSidebar()}
							className="gap-2"
							onMouseEnter={() => handleMenuItemMouseEnter('account')}
							onMouseLeave={() => handleMenuItemMouseLeave('account')}
							render={
								<Link to="/profile">
									<UserIcon
										ref={(ref: any) => (iconRefs.current['account'] = ref)}
										size={16}
									/>
									<Trans>Account</Trans>
								</Link>
							}
						></DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => isMobile && toggleSidebar()}
							className="gap-2"
							onMouseEnter={() => handleMenuItemMouseEnter('organizations')}
							onMouseLeave={() => handleMenuItemMouseLeave('organizations')}
							render={
								<Link to="/organizations">
									<BuildingIcon
										ref={(ref: any) =>
											(iconRefs.current['organizations'] = ref)
										}
										size={16}
									/>
									<Trans>Restaurants</Trans>
								</Link>
							}
						></DropdownMenuItem>
						{isAdmin && (
							<DropdownMenuItem
								className="gap-2"
								onMouseEnter={() => handleMenuItemMouseEnter('admin')}
								onMouseLeave={() => handleMenuItemMouseLeave('admin')}
								render={
									<Link to={getAdminUrl()} target="_blank">
										<SettingsGearIcon
											ref={(ref: any) => (iconRefs.current['admin'] = ref)}
											size={16}
										/>
										<Trans>Super Admin</Trans>
									</Link>
								}
							></DropdownMenuItem>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuSub>
							<DropdownMenuSubTrigger
								className="gap-2"
								onMouseEnter={() => handleMenuItemMouseEnter('theme')}
								onMouseLeave={() => handleMenuItemMouseLeave('theme')}
							>
								<SunMoonIcon
									size={16}
									ref={(ref: any) => (iconRefs.current['theme'] = ref)}
								/>
								<Trans>Theme</Trans>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{themeOptions.map((option) => (
									<DropdownMenuItem
										key={option.value}
										className="gap-2"
										onClick={(e) => {
											e.preventDefault()
											const formData = new FormData()
											formData.append('theme', option.value)
											void themeFetcher.submit(formData, {
												method: 'POST',
												action: '/resources/theme-switch',
											})
										}}
									>
										<Icon name={option.icon as any} className="size-4" />
										<span
											className={mode === option.value ? 'font-medium' : ''}
										>
											{option.label}
										</span>
										{mode === option.value && (
											<Icon name="check" className="ml-auto size-4" />
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger
								className="gap-2"
								onMouseEnter={() => handleMenuItemMouseEnter('language')}
								onMouseLeave={() => handleMenuItemMouseLeave('language')}
							>
								<LanguagesIcon
									size={16}
									ref={(ref: any) => (iconRefs.current['language'] = ref)}
								/>
								<Trans>Language</Trans>
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{languageOptions.map((option) => (
									<DropdownMenuItem
										key={option.value}
										className="gap-2"
										onClick={(e) => {
											e.preventDefault()
											handleLanguageChange(option.value)
										}}
									>
										<span
											className={
												currentLocale === option.value ? 'font-medium' : ''
											}
										>
											{option.nativeName}
										</span>
										{currentLocale === option.value && (
											<Icon name="check" className="ml-auto size-4" />
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="gap-2"
							onMouseEnter={() => handleMenuItemMouseEnter('logout')}
							onMouseLeave={() => handleMenuItemMouseLeave('logout')}
							onClick={() =>
								submit(new FormData(), { method: 'POST', action: '/logout' })
							}
							render={
								<button className="w-full ltr:text-left rtl:text-right">
									<LogoutIcon
										ref={(ref: any) => (iconRefs.current['logout'] = ref)}
										size={16}
									/>
									<Trans>Log out</Trans>
								</button>
							}
						></DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
