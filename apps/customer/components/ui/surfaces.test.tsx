import { ScrollView, View } from 'react-native'
import { findPressable, findPressables, press, render } from '../../test/render'
import { Banner } from './banner'
import { Card } from './card'
import { EmptyState } from './empty-state'
import { LoadingView } from './loading-view'
import { Screen } from './screen'
import { Text } from './text'

describe('Screen', () => {
	it('paints the background and pads by default', () => {
		const renderer = render(
			<Screen>
				<Text>Hi</Text>
			</Screen>,
		)
		const outer = renderer.root.findAllByType(View)[0]
		expect(outer?.props.className).toContain('bg-background')
		const inner = renderer.root.findAllByType(View)[1]
		expect(inner?.props.style).toEqual({ paddingHorizontal: 20 })
	})

	it('scrolls when asked', () => {
		const renderer = render(
			<Screen scroll>
				<Text>Hi</Text>
			</Screen>,
		)
		expect(renderer.root.findByType(ScrollView)).toBeTruthy()
	})
})

describe('Card', () => {
	it('uses the card surface tokens', () => {
		const renderer = render(
			<Card>
				<Text>Body</Text>
			</Card>,
		)
		const view = renderer.root.findAllByType(View)[0]
		// Class order follows Prettier's Tailwind sorting, so compare the set.
		expect(String(view?.props.className).split(/\s+/)).toEqual(
			expect.arrayContaining([
				'rounded-xl',
				'border',
				'border-border',
				'bg-card',
			]),
		)
	})
})

describe('Banner', () => {
	it('maps severity like the Sites announcement banner', () => {
		for (const [kind, bg, fg] of [
			['info', 'bg-primary', 'text-primary-foreground'],
			['warning', 'bg-accent', 'text-accent-foreground'],
			['error', 'bg-destructive', 'text-destructive-foreground'],
		] as const) {
			const renderer = render(<Banner kind={kind}>Note</Banner>)
			const view = renderer.root.findAllByType(View)[0]
			expect(view?.props.className).toContain(bg)
			expect(view?.props.className).toContain('px-4 py-3')
			expect(renderer.root.findByType(Text).props.className).toContain(fg)
		}
	})

	it('renders the link only with both a label and a handler', () => {
		const onAction = jest.fn()
		const withLink = render(
			<Banner actionLabel="Learn more" onAction={onAction}>
				Note
			</Banner>,
		)
		const link = findPressable(withLink.root)
		expect(link.props.accessibilityRole).toBe('link')
		press(link)
		expect(onAction).toHaveBeenCalledTimes(1)

		const labelOnly = render(<Banner actionLabel="Learn more">Note</Banner>)
		expect(findPressables(labelOnly.root)).toHaveLength(0)
	})
})

describe('LoadingView', () => {
	it('centers a spinner with an optional label', () => {
		const renderer = render(<LoadingView label="Loading your bookings" />)
		expect(renderer.root.findByType(Text).props.children).toBe(
			'Loading your bookings',
		)
		const bare = render(<LoadingView />)
		expect(bare.root.findAllByType(Text)).toHaveLength(0)
	})
})

describe('EmptyState', () => {
	it('shows title, body and an optional action', () => {
		const onAction = jest.fn()
		const renderer = render(
			<EmptyState
				title="No bookings yet"
				body="Book a table"
				actionLabel="Find a time"
				onAction={onAction}
			/>,
		)
		const texts = renderer.root
			.findAllByType(Text)
			.map((node) => node.props.children)
		expect(texts).toContain('No bookings yet')
		expect(texts).toContain('Book a table')
		press(findPressable(renderer.root))
		expect(onAction).toHaveBeenCalledTimes(1)
	})
})
