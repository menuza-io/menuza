import { Text as NativeText } from 'react-native'
import TestRenderer, { act } from 'react-test-renderer'
import { Text } from './text'

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
	let renderer: TestRenderer.ReactTestRenderer | undefined
	act(() => {
		renderer = TestRenderer.create(element)
	})
	if (!renderer) throw new Error('render failed')
	return renderer
}

describe('Text', () => {
	it('defaults to the body variant', () => {
		const renderer = render(<Text>Hello</Text>)
		const node = renderer.root.findByType(NativeText)
		expect(node.props.className).toBe('text-base text-foreground')
		expect(node.props.children).toBe('Hello')
	})

	it('applies the variant scale and appends extra classes', () => {
		const renderer = render(
			<Text variant="heading" className="mt-4">
				Title
			</Text>,
		)
		expect(renderer.root.findByType(NativeText).props.className).toBe(
			'text-xl font-semibold text-foreground mt-4',
		)
	})

	it('uses the destructive token for errors', () => {
		const renderer = render(<Text variant="error">Wrong</Text>)
		expect(renderer.root.findByType(NativeText).props.className).toContain(
			'text-destructive',
		)
	})
})
