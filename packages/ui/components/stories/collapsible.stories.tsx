import { type Meta, type StoryObj } from '@storybook/react'
import * as React from 'react'
import { Button } from '../ui/button'
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from '../ui/collapsible'

const meta = {
	title: 'Components/Collapsible',
	component: Collapsible,

	tags: ['autodocs'],
} satisfies Meta<typeof Collapsible>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => {
		const [isOpen, setIsOpen] = React.useState(false)

		return (
			<Collapsible
				open={isOpen}
				onOpenChange={setIsOpen}
				className="w-[350px] space-y-2"
			>
				<div className="flex items-center justify-between space-x-4">
					<h4 className="text-sm">@peduarte starred 3 repositories</h4>
					<CollapsibleTrigger
						render={
							<Button variant="ghost" size="sm">
								{isOpen ? '▲' : '▼'}
							</Button>
						}
					></CollapsibleTrigger>
				</div>
				<div className="rounded-md border px-4 py-2 text-sm">
					@radix-ui/primitives
				</div>
				<CollapsibleContent className="space-y-2">
					<div className="rounded-md border px-4 py-2 text-sm">
						@radix-ui/colors
					</div>
					<div className="rounded-md border px-4 py-2 text-sm">
						@stitches/react
					</div>
				</CollapsibleContent>
			</Collapsible>
		)
	},
}

export const WithCard: Story = {
	render: () => {
		const [isOpen, setIsOpen] = React.useState(true)

		return (
			<div className="w-[400px] space-y-4 rounded-lg border p-6">
				<Collapsible open={isOpen} onOpenChange={setIsOpen}>
					<div className="flex items-center justify-between">
						<h3 className="font-semibold">Advanced Settings</h3>
						<CollapsibleTrigger
							render={
								<Button variant="outline" size="sm">
									{isOpen ? 'Hide' : 'Show'}
								</Button>
							}
						></CollapsibleTrigger>
					</div>
					<CollapsibleContent className="space-y-4 pt-4">
						<div className="space-y-2">
							<label className="text-sm font-medium">API Key</label>
							<input
								type="text"
								className="h-9 w-full rounded-md border px-3"
								placeholder="Enter API key"
							/>
						</div>
						<div className="space-y-2">
							<label className="text-sm font-medium">Webhook URL</label>
							<input
								type="url"
								className="h-9 w-full rounded-md border px-3"
								placeholder="https://..."
							/>
						</div>
					</CollapsibleContent>
				</Collapsible>
			</div>
		)
	},
}

export const FAQ: Story = {
	render: () => {
		const [open1, setOpen1] = React.useState(false)
		const [open2, setOpen2] = React.useState(false)
		const [open3, setOpen3] = React.useState(false)

		return (
			<div className="w-[500px] space-y-2">
				<Collapsible open={open1} onOpenChange={setOpen1}>
					<CollapsibleTrigger className="hover:bg-accent flex w-full items-center justify-between rounded-lg border p-4 text-left">
						<span className="font-semibold">What is your refund policy?</span>
						<span>{open1 ? '−' : '+'}</span>
					</CollapsibleTrigger>
					<CollapsibleContent className="text-muted-foreground px-4 pt-2 pb-4 text-sm">
						We offer a 30-day money-back guarantee for all our products. If
						you're not satisfied, contact our support team for a full refund.
					</CollapsibleContent>
				</Collapsible>

				<Collapsible open={open2} onOpenChange={setOpen2}>
					<CollapsibleTrigger className="hover:bg-accent flex w-full items-center justify-between rounded-lg border p-4 text-left">
						<span className="font-semibold">How do I track my order?</span>
						<span>{open2 ? '−' : '+'}</span>
					</CollapsibleTrigger>
					<CollapsibleContent className="text-muted-foreground px-4 pt-2 pb-4 text-sm">
						Once your order ships, you'll receive a tracking number via email.
						You can use this number on our website to track your package.
					</CollapsibleContent>
				</Collapsible>

				<Collapsible open={open3} onOpenChange={setOpen3}>
					<CollapsibleTrigger className="hover:bg-accent flex w-full items-center justify-between rounded-lg border p-4 text-left">
						<span className="font-semibold">Do you ship internationally?</span>
						<span>{open3 ? '−' : '+'}</span>
					</CollapsibleTrigger>
					<CollapsibleContent className="text-muted-foreground px-4 pt-2 pb-4 text-sm">
						Yes, we ship to over 100 countries worldwide. Shipping times and
						costs vary by destination.
					</CollapsibleContent>
				</Collapsible>
			</div>
		)
	},
}
