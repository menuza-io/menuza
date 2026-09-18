import { Trans } from '@lingui/macro'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { FileTextIcon } from '@repo/ui/file-text-icon'
import { Icon } from '@repo/ui/icon'
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@repo/ui/sidebar'
import { useRef } from 'react'
import { Form, Link } from 'react-router'

interface FavoriteNote {
	note: {
		id: string
		title: string
	}
}

interface FavoriteNotesProps {
	favoriteNotes: FavoriteNote[]
	orgSlug: string
}

export default function FavoriteNotes({
	favoriteNotes,
	orgSlug,
}: FavoriteNotesProps) {
	const { isMobile, setOpenMobile } = useSidebar()
	const iconRefs = useRef<{ [key: string]: any }>({})

	const handleMenuItemMouseEnter = (noteId: string) => {
		const iconRef = iconRefs.current[noteId]
		if (iconRef?.startAnimation) {
			iconRef.startAnimation()
		}
	}

	const handleMenuItemMouseLeave = (noteId: string) => {
		const iconRef = iconRefs.current[noteId]
		if (iconRef?.stopAnimation) {
			iconRef.stopAnimation()
		}
	}

	if (!favoriteNotes || favoriteNotes.length === 0) {
		return null
	}

	return (
		<SidebarGroup className="group-data-[collapsible=icon]:hidden">
			<SidebarGroupLabel className="flex items-center gap-2">
				<Icon name="star" className="h-4 w-4" />
				<Trans>Favorites</Trans>
			</SidebarGroupLabel>
			<SidebarMenu>
				{favoriteNotes.map((favorite) => (
					<SidebarMenuItem key={favorite.note.id}>
						<SidebarMenuButton
							onMouseEnter={() => handleMenuItemMouseEnter(favorite.note.id)}
							onMouseLeave={() => handleMenuItemMouseLeave(favorite.note.id)}
							render={
								<Link to={`/${orgSlug}/notes/${favorite.note.id}`}>
									<FileTextIcon
										ref={(ref: any) =>
											(iconRefs.current[favorite.note.id] = ref)
										}
										size={16}
									/>
									<span>{favorite.note.title}</span>
								</Link>
							}
						></SidebarMenuButton>
						<DropdownMenu>
							<DropdownMenuTrigger>
								<SidebarMenuAction showOnHover className="rounded-sm">
									<Icon name="more-horizontal" />
									<span className="sr-only">
										<Trans>More</Trans>
									</span>
								</SidebarMenuAction>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								className="w-32 rounded-lg"
								side={isMobile ? 'bottom' : 'right'}
								align={isMobile ? 'end' : 'start'}
							>
								<DropdownMenuItem
									className="gap-2"
									onClick={() => isMobile && setOpenMobile(false)}
								>
									<Link to={`/${orgSlug}/notes/${favorite.note.id}`}>
										<Icon name="folder" />
										<span>
											<Trans>Open</Trans>
										</span>
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem
									className="gap-2"
									onClick={() => isMobile && setOpenMobile(false)}
								>
									<Link to={`/${orgSlug}/notes/${favorite.note.id}/edit`}>
										<Icon name="pencil" />
										<span>
											<Trans>Edit</Trans>
										</span>
									</Link>
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem variant="destructive">
									<Form
										method="post"
										action={`/${orgSlug}/notes/${favorite.note.id}`}
									>
										<input
											type="hidden"
											name="intent"
											value="toggle-favorite"
										/>
										<input
											type="hidden"
											name="noteId"
											value={favorite.note.id}
										/>
										<button
											type="submit"
											className="text-destructive flex w-full items-center gap-2"
										>
											<Icon name="star-off" />
											<span>
												<Trans>Unstar</Trans>
											</span>
										</button>
									</Form>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</SidebarMenuItem>
				))}
			</SidebarMenu>
		</SidebarGroup>
	)
}
