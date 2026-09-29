import { type Meta, type StoryObj } from '@storybook/react'
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from '../ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'

const meta = {
	title: 'Components/Tabs',
	component: Tabs,

	tags: ['autodocs'],
} satisfies Meta<typeof Tabs>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => (
		<Tabs defaultValue="tab1" className="w-[400px]">
			<TabsList>
				<TabsTrigger value="tab1">Tab 1</TabsTrigger>
				<TabsTrigger value="tab2">Tab 2</TabsTrigger>
				<TabsTrigger value="tab3">Tab 3</TabsTrigger>
			</TabsList>
			<TabsContent value="tab1">
				<p>Content for tab 1</p>
			</TabsContent>
			<TabsContent value="tab2">
				<p>Content for tab 2</p>
			</TabsContent>
			<TabsContent value="tab3">
				<p>Content for tab 3</p>
			</TabsContent>
		</Tabs>
	),
}

export const WithCard: Story = {
	render: () => (
		<Tabs defaultValue="account" className="w-[400px]">
			<TabsList>
				<TabsTrigger value="account">Account</TabsTrigger>
				<TabsTrigger value="password">Password</TabsTrigger>
			</TabsList>
			<TabsContent value="account">
				<Card>
					<CardContent>
						<CardHeader>
							<CardTitle>Account</CardTitle>
							<CardDescription>
								Make changes to your account here.
							</CardDescription>
						</CardHeader>
						<div className="space-y-2 p-6 pt-0">
							<div className="space-y-1">
								<label className="text-sm font-medium">Name</label>
								<input className="flex h-9 w-full rounded-md border px-3 py-1" />
							</div>
							<div className="space-y-1">
								<label className="text-sm font-medium">Username</label>
								<input className="flex h-9 w-full rounded-md border px-3 py-1" />
							</div>
						</div>
					</CardContent>
				</Card>
			</TabsContent>
			<TabsContent value="password">
				<Card>
					<CardContent>
						<CardHeader>
							<CardTitle>Password</CardTitle>
							<CardDescription>Change your password here.</CardDescription>
						</CardHeader>
						<div className="space-y-2 p-6 pt-0">
							<div className="space-y-1">
								<label className="text-sm font-medium">Current password</label>
								<input
									type="password"
									className="flex h-9 w-full rounded-md border px-3 py-1"
								/>
							</div>
							<div className="space-y-1">
								<label className="text-sm font-medium">New password</label>
								<input
									type="password"
									className="flex h-9 w-full rounded-md border px-3 py-1"
								/>
							</div>
						</div>
					</CardContent>
				</Card>
			</TabsContent>
		</Tabs>
	),
}

export const WithIcons: Story = {
	render: () => (
		<Tabs defaultValue="overview" className="w-[500px]">
			<TabsList>
				<TabsTrigger value="overview">📊 Overview</TabsTrigger>
				<TabsTrigger value="analytics">📈 Analytics</TabsTrigger>
				<TabsTrigger value="reports">📋 Reports</TabsTrigger>
				<TabsTrigger value="notifications">🔔 Notifications</TabsTrigger>
			</TabsList>
			<TabsContent value="overview" className="space-y-4">
				<h3 className="text-lg">Overview</h3>
				<p className="text-muted-foreground text-sm">
					View your overview and key metrics here.
				</p>
			</TabsContent>
			<TabsContent value="analytics" className="space-y-4">
				<h3 className="text-lg">Analytics</h3>
				<p className="text-muted-foreground text-sm">
					Analyze your data and trends.
				</p>
			</TabsContent>
			<TabsContent value="reports" className="space-y-4">
				<h3 className="text-lg">Reports</h3>
				<p className="text-muted-foreground text-sm">
					Generate and view reports.
				</p>
			</TabsContent>
			<TabsContent value="notifications" className="space-y-4">
				<h3 className="text-lg">Notifications</h3>
				<p className="text-muted-foreground text-sm">
					Manage your notification preferences.
				</p>
			</TabsContent>
		</Tabs>
	),
}

export const Disabled: Story = {
	render: () => (
		<Tabs defaultValue="available" className="w-[400px]">
			<TabsList>
				<TabsTrigger value="available">Available</TabsTrigger>
				<TabsTrigger value="disabled" disabled>
					Disabled
				</TabsTrigger>
				<TabsTrigger value="also-available">Also Available</TabsTrigger>
			</TabsList>
			<TabsContent value="available">
				<p>This tab is available.</p>
			</TabsContent>
			<TabsContent value="disabled">
				<p>This content is not accessible.</p>
			</TabsContent>
			<TabsContent value="also-available">
				<p>This tab is also available.</p>
			</TabsContent>
		</Tabs>
	),
}

export const FullWidth: Story = {
	render: () => (
		<Tabs defaultValue="all" className="w-full">
			<TabsList className="w-full">
				<TabsTrigger value="all" className="flex-1">
					All
				</TabsTrigger>
				<TabsTrigger value="active" className="flex-1">
					Active
				</TabsTrigger>
				<TabsTrigger value="completed" className="flex-1">
					Completed
				</TabsTrigger>
			</TabsList>
			<TabsContent value="all">
				<p>Showing all items.</p>
			</TabsContent>
			<TabsContent value="active">
				<p>Showing active items.</p>
			</TabsContent>
			<TabsContent value="completed">
				<p>Showing completed items.</p>
			</TabsContent>
		</Tabs>
	),
}
