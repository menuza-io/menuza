import { type Meta, type StoryObj } from '@storybook/react'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'
import { Button } from '../ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'

const meta = {
	title: 'Components/HoverCard',
	component: HoverCard,

	tags: ['autodocs'],
} satisfies Meta<typeof HoverCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => (
		<HoverCard>
			<HoverCardTrigger
				render={<Button variant="link">Hover over me</Button>}
			></HoverCardTrigger>
			<HoverCardContent>
				<div className="space-y-2">
					<h4 className="text-sm">Hover Card</h4>
					<p className="text-sm">
						This is a hover card. It appears when you hover over the trigger.
					</p>
				</div>
			</HoverCardContent>
		</HoverCard>
	),
}

export const WithAvatar: Story = {
	render: () => (
		<HoverCard>
			<HoverCardTrigger
				render={<Button variant="link">@username</Button>}
			></HoverCardTrigger>
			<HoverCardContent className="w-80">
				<div className="flex gap-4">
					<Avatar>
						<AvatarImage src="https://github.com/vercel.png" />
						<AvatarFallback>VC</AvatarFallback>
					</Avatar>
					<div className="space-y-1">
						<h4 className="text-sm">@username</h4>
						<p className="text-sm">
							Software engineer and creator of various open source projects.
						</p>
						<div className="flex items-center pt-2">
							<span className="text-muted-foreground text-xs">
								Joined December 2021
							</span>
						</div>
					</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	),
}

export const RichContent: Story = {
	render: () => (
		<HoverCard>
			<HoverCardTrigger
				render={<Button variant="outline">Product Details</Button>}
			></HoverCardTrigger>
			<HoverCardContent className="w-80">
				<div className="space-y-2">
					<h4 className="text-sm">Premium Product</h4>
					<p className="text-muted-foreground text-sm">
						A high-quality product with excellent features.
					</p>
					<div className="flex items-center gap-2 pt-2">
						<span className="text-lg font-bold">$99.99</span>
						<span className="text-muted-foreground text-xs line-through">
							$149.99
						</span>
					</div>
					<div className="text-xs text-green-600">In Stock</div>
				</div>
			</HoverCardContent>
		</HoverCard>
	),
}
