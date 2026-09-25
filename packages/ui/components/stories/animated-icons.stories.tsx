import { type Meta, type StoryObj } from '@storybook/react'
import { useRef, useState } from 'react'
import { ArrowLeftIcon } from '../animated-icons/arrow-left-icon'
import { BuildingIcon } from '../animated-icons/building-icon'
import { CircleHelpIcon } from '../animated-icons/circle-help'
import { FileTextIcon } from '../animated-icons/file-text-icon'
import { FoldersIcon } from '../animated-icons/folders-icon'
import { GlobeIcon } from '../animated-icons/globe-icon'
import { HomeIcon, type HomeIconHandle } from '../animated-icons/home-icon'
import { ListTodoIcon } from '../animated-icons/list-todo'
import { LockOpenIcon } from '../animated-icons/lock-open-icon'
import { LogoutIcon } from '../animated-icons/logout-icon'
import { MessageSquareMoreIcon } from '../animated-icons/message-square-more'
import { MonitorCogIcon } from '../animated-icons/monitor-cog-icon'
import { SettingsGearIcon } from '../animated-icons/settings-gear-icon'
import { ShieldCheckIcon } from '../animated-icons/shield-check-icon'
import { SunMoonIcon } from '../animated-icons/sun-moon-icon'
import { UserIcon } from '../animated-icons/user-icon'
import { UserRoundPlusIcon } from '../animated-icons/user-round-plus'
import { Button } from '../ui/button'

const meta = {
	title: 'Components/Animated Icons',
	component: HomeIcon,

	tags: ['autodocs'],
	argTypes: {
		size: {
			control: 'number',
		},
	},
} satisfies Meta<typeof HomeIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => (
		<div className="flex items-center gap-4">
			<HomeIcon size={32} />
			<p className="text-muted-foreground text-sm">Hover over the icon</p>
		</div>
	),
}

export const Sizes: Story = {
	render: () => (
		<div className="flex items-center gap-8">
			<div className="flex flex-col items-center gap-2">
				<HomeIcon size={20} />
				<span className="text-muted-foreground text-xs">20px</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<HomeIcon size={28} />
				<span className="text-muted-foreground text-xs">28px (default)</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<HomeIcon size={36} />
				<span className="text-muted-foreground text-xs">36px</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<HomeIcon size={48} />
				<span className="text-muted-foreground text-xs">48px</span>
			</div>
		</div>
	),
}

export const ControlledAnimation: Story = {
	render: () => {
		const iconRef = useRef<HomeIconHandle>(null)

		return (
			<div className="flex flex-col items-center gap-4">
				<HomeIcon ref={iconRef} size={48} />
				<div className="flex gap-2">
					<Button size="sm" onClick={() => iconRef.current?.startAnimation()}>
						Start Animation
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => iconRef.current?.stopAnimation()}
					>
						Stop Animation
					</Button>
				</div>
			</div>
		)
	},
}

export const AllAnimatedIcons: Story = {
	render: () => {
		const animatedIcons = [
			{
				name: 'Arrow Left',
				component: ArrowLeftIcon,
				description: 'Navigation arrow with slide animation',
			},
			{
				name: 'Building',
				component: BuildingIcon,
				description: 'Building/organization icon',
			},
			{
				name: 'Circle Help',
				component: CircleHelpIcon,
				description: 'Help/question icon',
			},
			{
				name: 'File Text',
				component: FileTextIcon,
				description: 'Document icon',
			},
			{ name: 'Folders', component: FoldersIcon, description: 'Folders icon' },
			{
				name: 'Globe',
				component: GlobeIcon,
				description: 'Globe/world icon with rotation',
			},
			{
				name: 'Home',
				component: HomeIcon,
				description: 'Home icon with draw animation',
			},
			{
				name: 'List Todo',
				component: ListTodoIcon,
				description: 'Todo list icon',
			},
			{
				name: 'Lock Open',
				component: LockOpenIcon,
				description: 'Unlock icon',
			},
			{
				name: 'Logout',
				component: LogoutIcon,
				description: 'Logout icon with slide animation',
			},
			{
				name: 'Message Square More',
				component: MessageSquareMoreIcon,
				description: 'Message/chat icon',
			},
			{
				name: 'Monitor Cog',
				component: MonitorCogIcon,
				description: 'Website icon with rotating cog',
			},
			{
				name: 'Settings Gear',
				component: SettingsGearIcon,
				description: 'Settings icon with rotation',
			},
			{
				name: 'Shield Check',
				component: ShieldCheckIcon,
				description: 'Security/verification icon',
			},
			{
				name: 'Sun Moon',
				component: SunMoonIcon,
				description: 'Theme toggle icon',
			},
			{ name: 'User', component: UserIcon, description: 'User/profile icon' },
			{
				name: 'User Round Plus',
				component: UserRoundPlusIcon,
				description: 'Add user icon',
			},
		]

		return (
			<div className="max-w-6xl p-8">
				<h2 className="mb-2 text-2xl font-bold">
					All Animated Icons ({animatedIcons.length})
				</h2>
				<p className="text-muted-foreground mb-6 text-sm">
					Hover over any icon to see its animation
				</p>

				<div className="grid grid-cols-1 gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
					{animatedIcons.map(
						({ name, component: IconComponent, description }) => (
							<div
								key={name}
								className="border-border hover:bg-muted group flex flex-col items-center justify-center rounded-lg border p-4 transition-colors"
							>
								<IconComponent size={48} className="mb-3" />
								<span className="mb-1 text-center text-sm font-medium">
									{name}
								</span>
								<span className="text-muted-foreground text-center text-xs">
									{description}
								</span>
							</div>
						),
					)}
				</div>
			</div>
		)
	},
	parameters: {
		layout: 'fullscreen',
	},
}

export const InteractiveShowcase: Story = {
	render: () => {
		const [selectedIcon, setSelectedIcon] = useState<string>('Home')
		const iconRef = useRef<any>(null)

		const animatedIcons = [
			{ name: 'Arrow Left', component: ArrowLeftIcon },
			{ name: 'Building', component: BuildingIcon },
			{ name: 'Circle Help', component: CircleHelpIcon },
			{ name: 'File Text', component: FileTextIcon },
			{ name: 'Folders', component: FoldersIcon },
			{ name: 'Globe', component: GlobeIcon },
			{ name: 'Home', component: HomeIcon },
			{ name: 'Monitor Cog', component: MonitorCogIcon },
			{ name: 'List Todo', component: ListTodoIcon },
			{ name: 'Lock Open', component: LockOpenIcon },
			{ name: 'Logout', component: LogoutIcon },
			{ name: 'Message Square More', component: MessageSquareMoreIcon },
			{ name: 'Settings Gear', component: SettingsGearIcon },
			{ name: 'Shield Check', component: ShieldCheckIcon },
			{ name: 'Sun Moon', component: SunMoonIcon },
			{ name: 'User', component: UserIcon },
			{ name: 'User Round Plus', component: UserRoundPlusIcon },
		]

		const SelectedIconComponent =
			animatedIcons.find((icon) => icon.name === selectedIcon)?.component ||
			HomeIcon

		return (
			<div className="max-w-4xl p-8">
				<h2 className="mb-6 text-2xl font-bold">Interactive Animated Icons</h2>

				<div className="flex flex-col gap-8 md:flex-row">
					{/* Icon Selector */}
					<div className="flex-1">
						<h3 className="mb-4 text-lg">Select an Icon</h3>
						<div className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto pr-2">
							{animatedIcons.map(({ name }) => (
								<Button
									key={name}
									variant={selectedIcon === name ? 'default' : 'outline'}
									size="sm"
									onClick={() => setSelectedIcon(name)}
									className="justify-start"
								>
									{name}
								</Button>
							))}
						</div>
					</div>

					{/* Icon Display */}
					<div className="flex-1">
						<h3 className="mb-4 text-lg">Preview</h3>
						<div className="border-border bg-muted/50 flex flex-col items-center gap-6 rounded-lg border p-8">
							<SelectedIconComponent ref={iconRef} size={80} />
							<div className="text-center">
								<p className="mb-2 text-lg font-medium">{selectedIcon}</p>
								<p className="text-muted-foreground mb-4 text-sm">
									Hover to see animation
								</p>
							</div>
							<div className="flex gap-2">
								<Button
									size="sm"
									onClick={() => iconRef.current?.startAnimation()}
								>
									Animate
								</Button>
								<Button
									size="sm"
									variant="outline"
									onClick={() => iconRef.current?.stopAnimation()}
								>
									Reset
								</Button>
							</div>
						</div>
					</div>
				</div>
			</div>
		)
	},
	parameters: {
		layout: 'fullscreen',
	},
}

export const UsageExamples: Story = {
	render: () => (
		<div className="max-w-4xl space-y-8 p-8">
			<h2 className="mb-6 text-2xl font-bold">Usage Examples</h2>

			{/* Navigation */}
			<div className="space-y-4">
				<h3 className="text-lg">Navigation</h3>
				<div className="border-border flex items-center gap-4 rounded-lg border p-4">
					<ArrowLeftIcon size={24} />
					<span>Back to Dashboard</span>
				</div>
			</div>

			{/* Settings */}
			<div className="space-y-4">
				<h3 className="text-lg">Settings Menu</h3>
				<div className="border-border flex items-center gap-4 rounded-lg border p-4">
					<SettingsGearIcon size={24} />
					<span>Account Settings</span>
				</div>
			</div>

			{/* Theme Toggle */}
			<div className="space-y-4">
				<h3 className="text-lg">Theme Toggle</h3>
				<Button variant="outline" className="gap-2">
					<SunMoonIcon size={20} />
					Toggle Theme
				</Button>
			</div>

			{/* User Actions */}
			<div className="space-y-4">
				<h3 className="text-lg">User Actions</h3>
				<div className="flex gap-4">
					<Button variant="outline" className="gap-2">
						<UserIcon size={20} />
						Profile
					</Button>
					<Button variant="outline" className="gap-2">
						<UserRoundPlusIcon size={20} />
						Add User
					</Button>
					<Button variant="outline" className="gap-2">
						<LogoutIcon size={20} />
						Logout
					</Button>
				</div>
			</div>

			{/* Status Indicators */}
			<div className="space-y-4">
				<h3 className="text-lg">Status & Info</h3>
				<div className="flex gap-4">
					<div className="flex items-center gap-2 rounded-lg border border-green-500/50 bg-green-500/10 p-3">
						<ShieldCheckIcon size={20} />
						<span className="text-sm">Secured</span>
					</div>
					<div className="flex items-center gap-2 rounded-lg border border-blue-500/50 bg-blue-500/10 p-3">
						<CircleHelpIcon size={20} />
						<span className="text-sm">Need Help?</span>
					</div>
				</div>
			</div>
		</div>
	),
	parameters: {
		layout: 'fullscreen',
	},
}
