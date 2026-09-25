import { type Meta, type StoryObj } from '@storybook/react'
import { Button } from '../ui/button'
import {
	Frame,
	FramePanel,
	FrameHeader,
	FrameTitle,
	FrameDescription,
	FrameAction,
	FrameFooter,
} from '../frame'

const meta = {
	title: 'Components/Frame',
	component: Frame,
	tags: ['autodocs'],
} satisfies Meta<typeof Frame>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle>Section header</FrameTitle>
				<FrameDescription>Brief description about the section</FrameDescription>
			</FrameHeader>
			<FramePanel>
				<h2 className="text-sm">Section title</h2>
				<p className="text-muted-foreground text-sm">Section description</p>
			</FramePanel>
			<FrameFooter>
				<p className="text-muted-foreground text-sm">Footer</p>
			</FrameFooter>
		</Frame>
	),
}

export const SeparatedPanels: Story = {
	render: () => (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle>Section header</FrameTitle>
				<FrameDescription>Brief description about the section</FrameDescription>
			</FrameHeader>
			<FramePanel>
				<h2 className="text-sm">Separated panel</h2>
				<p className="text-muted-foreground text-sm">Section description</p>
			</FramePanel>
			<FramePanel>
				<h2 className="text-sm">Separated panel</h2>
				<p className="text-muted-foreground text-sm">Section description</p>
			</FramePanel>
		</Frame>
	),
}

export const StackedPanels: Story = {
	render: () => (
		<Frame className="w-full" stackedPanels>
			<FrameHeader>
				<FrameTitle>Section header</FrameTitle>
				<FrameDescription>Brief description about the section</FrameDescription>
			</FrameHeader>
			<FramePanel>
				<h2 className="text-sm">Stacked panel</h2>
				<p className="text-muted-foreground text-sm">Section description</p>
			</FramePanel>
			<FramePanel>
				<h2 className="text-sm">Stacked panel</h2>
				<p className="text-muted-foreground text-sm">Section description</p>
			</FramePanel>
		</Frame>
	),
}

export const WithAction: Story = {
	render: () => (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle>Settings Panel</FrameTitle>
				<FrameDescription>Configure your application settings</FrameDescription>
				<FrameAction>
					<Button variant="outline" size="sm">
						Edit
					</Button>
				</FrameAction>
			</FrameHeader>
			<FramePanel>
				<h2 className="text-sm">Panel with header action</h2>
				<p className="text-muted-foreground text-sm">
					This panel has an action button in the header
				</p>
			</FramePanel>
		</Frame>
	),
}

export const ComplexExample: Story = {
	render: () => (
		<Frame className="w-full" stackedPanels>
			<FrameHeader>
				<FrameTitle>User Dashboard</FrameTitle>
				<FrameDescription>Manage your account and preferences</FrameDescription>
				<FrameAction>
					<Button variant="ghost" size="sm">
						Settings
					</Button>
				</FrameAction>
			</FrameHeader>
			<FramePanel>
				<h2 className="text-sm">Profile Information</h2>
				<div className="mt-2 space-y-1 text-sm">
					<p>
						<span className="font-medium">Name:</span> John Doe
					</p>
					<p>
						<span className="font-medium">Email:</span> john@example.com
					</p>
				</div>
			</FramePanel>
			<FramePanel>
				<h2 className="text-sm">Account Settings</h2>
				<div className="mt-2 space-y-2 text-sm">
					<div className="flex items-center justify-between">
						<span>Two-factor authentication</span>
						<span className="text-muted-foreground">Enabled</span>
					</div>
					<div className="flex items-center justify-between">
						<span>Email notifications</span>
						<span className="text-muted-foreground">Disabled</span>
					</div>
				</div>
			</FramePanel>
			<FrameFooter>
				<div className="flex justify-end gap-2">
					<Button variant="outline" size="sm">
						Cancel
					</Button>
					<Button size="sm">Save Changes</Button>
				</div>
			</FrameFooter>
		</Frame>
	),
}
