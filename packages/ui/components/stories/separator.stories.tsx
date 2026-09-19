import { type Meta, type StoryObj } from '@storybook/react'
import { Separator } from '../ui/separator'

const meta = {
	title: 'Components/Separator',
	component: Separator,

	tags: ['autodocs'],
	argTypes: {
		orientation: {
			control: 'select',
			options: ['horizontal', 'vertical'],
		},
	},
} satisfies Meta<typeof Separator>

export default meta
type Story = StoryObj<typeof meta>

export const Horizontal: Story = {
	args: {
		orientation: 'horizontal',
		className: 'w-[300px]',
	},
}

export const Vertical: Story = {
	render: () => (
		<div className="flex h-20 items-center space-x-4">
			<span>Item 1</span>
			<Separator orientation="vertical" />
			<span>Item 2</span>
			<Separator orientation="vertical" />
			<span>Item 3</span>
		</div>
	),
}

export const InContent: Story = {
	render: () => (
		<div className="w-[400px] space-y-4">
			<h2 className="text-lg">Section Title</h2>
			<p className="text-muted-foreground text-sm">
				This is some content above the separator.
			</p>
			<Separator />
			<p className="text-muted-foreground text-sm">
				This is some content below the separator.
			</p>
		</div>
	),
}

export const InNavigation: Story = {
	render: () => (
		<div className="w-[300px] space-y-1">
			<div className="hover:bg-accent cursor-pointer rounded-md p-2">
				Profile
			</div>
			<div className="hover:bg-accent cursor-pointer rounded-md p-2">
				Settings
			</div>
			<Separator className="my-2" />
			<div className="hover:bg-accent cursor-pointer rounded-md p-2">Help</div>
			<div className="hover:bg-accent text-destructive cursor-pointer rounded-md p-2">
				Logout
			</div>
		</div>
	),
}

export const WithText: Story = {
	render: () => (
		<div className="w-[400px]">
			<div className="relative">
				<Separator />
				<div className="absolute inset-0 flex items-center justify-center">
					<span className="bg-background text-muted-foreground px-2 text-xs">
						OR
					</span>
				</div>
			</div>
		</div>
	),
}

export const Card: Story = {
	render: () => (
		<div className="w-[350px] rounded-lg border p-6">
			<div className="space-y-1">
				<h3 className="font-semibold">Account Settings</h3>
				<p className="text-muted-foreground text-sm">
					Manage your account preferences
				</p>
			</div>
			<Separator className="my-4" />
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<span className="text-sm">Email notifications</span>
					<span className="text-muted-foreground text-sm">Enabled</span>
				</div>
				<div className="flex items-center justify-between">
					<span className="text-sm">Two-factor auth</span>
					<span className="text-muted-foreground text-sm">Disabled</span>
				</div>
			</div>
			<Separator className="my-4" />
			<div className="flex gap-2">
				<button className="flex-1 rounded-md border px-4 py-2 text-sm">
					Cancel
				</button>
				<button className="bg-primary text-primary-foreground flex-1 rounded-md px-4 py-2 text-sm">
					Save
				</button>
			</div>
		</div>
	),
}
