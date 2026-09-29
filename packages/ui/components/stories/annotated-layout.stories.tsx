import { type Meta, type StoryObj } from '@storybook/react'
import { AnnotatedLayout, AnnotatedSection } from '../annotated-layout'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

const meta = {
	title: 'Components/AnnotatedLayout',
	component: AnnotatedLayout,
	parameters: {
		layout: 'padded',
	},
	tags: ['autodocs'],
} satisfies Meta<typeof AnnotatedLayout>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	args: {
		children: null,
	},
	render: () => (
		<AnnotatedLayout>
			<AnnotatedSection
				title="Personal Information"
				description="Update your personal details here."
			>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="name">Name</Label>
						<Input id="name" placeholder="Enter your name" />
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="email">Email</Label>
						<Input id="email" type="email" placeholder="Enter your email" />
					</div>
				</div>
			</AnnotatedSection>
			<AnnotatedSection
				title="Security"
				description="Manage your security settings and password."
			>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="current-password">Current Password</Label>
						<Input id="current-password" type="password" />
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="new-password">New Password</Label>
						<Input id="new-password" type="password" />
					</div>
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	),
}

export const WithActions: Story = {
	args: {
		children: null,
	},
	render: () => (
		<AnnotatedLayout>
			<AnnotatedSection
				title="Profile Settings"
				description="Customize your profile information."
			>
				<div className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="username">Username</Label>
						<Input id="username" placeholder="Enter username" />
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="bio">Bio</Label>
						<Input id="bio" placeholder="Tell us about yourself" />
					</div>
					<div className="flex justify-end gap-2">
						<Button variant="outline">Cancel</Button>
						<Button>Save Changes</Button>
					</div>
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	),
}

export const ContentOnly: Story = {
	args: {
		children: null,
	},
	render: () => (
		<AnnotatedLayout>
			<AnnotatedSection>
				<div className="bg-card rounded-xl border p-6">
					<h2 className="text-base">Full-width card section</h2>
					<p className="text-muted-foreground mt-1 text-sm">
						When cards carry their own headers, sections span the full measure —
						no empty third column.
					</p>
				</div>
			</AnnotatedSection>
		</AnnotatedLayout>
	),
}
