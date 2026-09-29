import { type Meta, type StoryObj } from '@storybook/react'
import { Card, CardContent } from '../ui/card'
import {
	Carousel,
	CarouselContent,
	CarouselItem,
	CarouselNext,
	CarouselPrevious,
} from '../ui/carousel'

const meta = {
	title: 'Components/Carousel',
	component: Carousel,

	tags: ['autodocs'],
} satisfies Meta<typeof Carousel>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
	render: () => (
		<Carousel className="w-full max-w-xs">
			<CarouselContent>
				{Array.from({ length: 5 }).map((_, index) => (
					<CarouselItem key={index}>
						<div className="p-1">
							<Card>
								<CardContent className="flex aspect-square items-center justify-center p-6">
									<span className="text-4xl">{index + 1}</span>
								</CardContent>
							</Card>
						</div>
					</CarouselItem>
				))}
			</CarouselContent>
			<CarouselPrevious />
			<CarouselNext />
		</Carousel>
	),
}

export const MultipleItemsPerView: Story = {
	render: () => (
		<Carousel
			opts={{
				align: 'start',
			}}
			className="w-full max-w-sm"
		>
			<CarouselContent>
				{Array.from({ length: 10 }).map((_, index) => (
					<CarouselItem key={index} className="md:basis-1/2 lg:basis-1/3">
						<div className="p-1">
							<Card>
								<CardContent className="flex aspect-square items-center justify-center p-6">
									<span className="text-3xl">{index + 1}</span>
								</CardContent>
							</Card>
						</div>
					</CarouselItem>
				))}
			</CarouselContent>
			<CarouselPrevious />
			<CarouselNext />
		</Carousel>
	),
}

export const WithImages: Story = {
	render: () => (
		<Carousel className="w-full max-w-md">
			<CarouselContent>
				{[1, 2, 3, 4, 5].map((num) => (
					<CarouselItem key={num}>
						<Card>
							<CardContent className="flex aspect-video items-center justify-center p-6">
								<div className="text-center">
									<div className="mb-2 text-6xl">🖼️</div>
									<p className="text-muted-foreground text-sm">Image {num}</p>
								</div>
							</CardContent>
						</Card>
					</CarouselItem>
				))}
			</CarouselContent>
			<CarouselPrevious />
			<CarouselNext />
		</Carousel>
	),
}

export const Vertical: Story = {
	render: () => (
		<Carousel
			opts={{
				align: 'start',
			}}
			orientation="vertical"
			className="w-full max-w-xs"
		>
			<CarouselContent className="h-[200px]">
				{Array.from({ length: 5 }).map((_, index) => (
					<CarouselItem key={index}>
						<div className="p-1">
							<Card>
								<CardContent className="flex items-center justify-center p-6">
									<span className="text-3xl">{index + 1}</span>
								</CardContent>
							</Card>
						</div>
					</CarouselItem>
				))}
			</CarouselContent>
			<CarouselPrevious />
			<CarouselNext />
		</Carousel>
	),
}
