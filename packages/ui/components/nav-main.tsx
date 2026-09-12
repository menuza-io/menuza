import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { Icon } from './icon'
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuItem,
} from './ui/dropdown-menu'
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	useSidebar,
} from './ui/sidebar'

export function NavMain({
	items,
}: {
	items: {
		title: string
		url: string
		icon?: React.ComponentType<any>
		isActive: boolean
		items?: {
			title: string
			url: string
			isActive: boolean
		}[]
	}[]
}) {
	const [openItems, setOpenItems] = useState<Set<string>>(() => {
		const activeItems = items
			.filter((item) => item.isActive && item.items && item.items.length > 0)
			.map((item) => item.title)
		return new Set(activeItems)
	})
	const iconRefs = useRef<{ [key: string]: any }>({})
	const { state, isMobile } = useSidebar()

	useEffect(() => {
		const activeItems = items
			.filter((item) => item.isActive && item.items && item.items.length > 0)
			.map((item) => item.title)
		setOpenItems((prev) => {
			const newSet = new Set(prev)
			activeItems.forEach((title) => newSet.add(title))
			return newSet
		})
	}, [items])

	const toggleItem = (title: string) => {
		setOpenItems((prev) => {
			const newSet = new Set(prev)
			if (newSet.has(title)) {
				newSet.delete(title)
			} else {
				newSet.add(title)
			}
			return newSet
		})
	}

	const handleMenuItemMouseEnter = (title: string) => {
		const iconRef = iconRefs.current[title]
		if (iconRef?.startAnimation) {
			iconRef.startAnimation()
		}
	}

	const handleMenuItemMouseLeave = (title: string) => {
		const iconRef = iconRefs.current[title]
		if (iconRef?.stopAnimation) {
			iconRef.stopAnimation()
		}
	}

	return (
		<SidebarGroup>
			<SidebarGroupContent className="flex flex-col">
				<SidebarMenu>
					{items.map((item) => {
						const hasSubItems = item.items && item.items.length > 0
						const isOpen = openItems.has(item.title)
						const isSidebarCollapsed = state === 'collapsed' && !isMobile

						return (
							<SidebarMenuItem key={item.title}>
								{hasSubItems ? (
									isSidebarCollapsed ? (
										<DropdownMenu>
											<DropdownMenuTrigger
												render={
													<SidebarMenuButton
														tooltip={item.title}
														isActive={item.isActive}
														onMouseEnter={() =>
															handleMenuItemMouseEnter(item.title)
														}
														onMouseLeave={() =>
															handleMenuItemMouseLeave(item.title)
														}
													>
														<div className="flex min-w-0 items-center gap-2">
															{item.icon && (
																<item.icon
																	ref={(ref: any) =>
																		(iconRefs.current[item.title] = ref)
																	}
																	size={16}
																/>
															)}
															<span>{item.title}</span>
														</div>
													</SidebarMenuButton>
												}
											></DropdownMenuTrigger>
											<DropdownMenuContent side="right" align="start">
												{item.items?.map((subItem) => (
													<DropdownMenuItem
														key={subItem.title}
														render={
															<Link to={subItem.url}>{subItem.title}</Link>
														}
													></DropdownMenuItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>
									) : (
										<>
											<SidebarMenuButton
												onClick={() => toggleItem(item.title)}
												tooltip={item.title}
												isActive={item.isActive}
												aria-expanded={isOpen}
												className="w-full justify-between"
												onMouseEnter={() =>
													handleMenuItemMouseEnter(item.title)
												}
												onMouseLeave={() =>
													handleMenuItemMouseLeave(item.title)
												}
											>
												<div className="flex min-w-0 items-center gap-2">
													{item.icon && (
														<span className="flex shrink-0 items-center justify-center group-data-[collapsible=icon]:size-4">
															<item.icon
																ref={(ref: any) =>
																	(iconRefs.current[item.title] = ref)
																}
																size={16}
															/>
														</span>
													)}
													<span>{item.title}</span>
												</div>
												<Icon
													name={isOpen ? 'chevron-down' : 'chevron-right'}
													className="h-4 w-4 rtl:rotate-180"
												/>
											</SidebarMenuButton>
											{isOpen && (
												<SidebarMenuSub>
													{item.items?.map((subItem) => (
														<SidebarMenuSubItem key={subItem.title}>
															<SidebarMenuSubButton
																render={
																	<Link to={subItem.url}>
																		<span>{subItem.title}</span>
																	</Link>
																}
																isActive={subItem.isActive}
															></SidebarMenuSubButton>
														</SidebarMenuSubItem>
													))}
												</SidebarMenuSub>
											)}
										</>
									)
								) : (
									<SidebarMenuButton
										render={
											<Link to={item.url} className="flex items-center">
												{item.icon && (
													<span className="flex shrink-0 items-center justify-center group-data-[collapsible=icon]:size-4">
														<item.icon
															ref={(ref: any) =>
																(iconRefs.current[item.title] = ref)
															}
															size={16}
															className={
																item.icon.displayName === 'ArrowLeftIcon'
																	? 'rtl:rotate-180'
																	: ''
															}
														/>
													</span>
												)}
												<span>{item.title}</span>
											</Link>
										}
										isActive={item.isActive}
										onMouseEnter={() => handleMenuItemMouseEnter(item.title)}
										onMouseLeave={() => handleMenuItemMouseLeave(item.title)}
									></SidebarMenuButton>
								)}
							</SidebarMenuItem>
						)
					})}
				</SidebarMenu>
			</SidebarGroupContent>
		</SidebarGroup>
	)
}
