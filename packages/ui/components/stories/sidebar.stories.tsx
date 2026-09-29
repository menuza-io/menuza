import { type Meta, type StoryObj } from '@storybook/react'
import { Icon } from '../icon'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarTrigger,
} from '../ui/sidebar'

const meta = {
	title: 'Components/Sidebar',
	component: Sidebar,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => (
		<SidebarProvider>
			<Sidebar>
				<SidebarHeader>
					<div className="flex items-center gap-2 px-2">
						<div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
							<Icon name="command" className="size-4" />
						</div>
						<div className="flex flex-col gap-0.5 leading-none">
							<span className="font-semibold">Acme Inc</span>
							<span className="text-xs">Enterprise</span>
						</div>
					</div>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Menu</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="building" />
										<span>Home</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="mail" />
										<span>Inbox</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="calendar" />
										<span>Calendar</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="search" />
										<span>Search</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="settings" />
										<span>Settings</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton>
								<Icon name="user" />
								<span>Profile</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarFooter>
			</Sidebar>
			<SidebarInset>
				<header className="flex h-16 items-center gap-2 border-b px-4">
					<SidebarTrigger />
					<h1 className="text-lg">Dashboard</h1>
				</header>
				<div className="flex flex-1 flex-col gap-4 p-4">
					<div className="grid auto-rows-min gap-4 md:grid-cols-3">
						<div className="bg-muted/50 aspect-video rounded-xl" />
						<div className="bg-muted/50 aspect-video rounded-xl" />
						<div className="bg-muted/50 aspect-video rounded-xl" />
					</div>
					<div className="bg-muted/50 min-h-screen flex-1 rounded-xl md:min-h-min" />
				</div>
			</SidebarInset>
		</SidebarProvider>
	),
}

export const WithActiveItem: Story = {
	render: () => (
		<SidebarProvider>
			<Sidebar>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Navigation</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton isActive>
										<Icon name="building" />
										<span>Home</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="mail" />
										<span>Inbox</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
								<SidebarMenuItem>
									<SidebarMenuButton>
										<Icon name="settings" />
										<span>Settings</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
			</Sidebar>
			<SidebarInset>
				<header className="flex h-16 items-center gap-2 border-b px-4">
					<SidebarTrigger />
					<h1 className="text-lg">Content Area</h1>
				</header>
				<div className="p-4">
					<p className="text-muted-foreground text-sm">
						Click the menu icon to toggle the sidebar
					</p>
				</div>
			</SidebarInset>
		</SidebarProvider>
	),
}
