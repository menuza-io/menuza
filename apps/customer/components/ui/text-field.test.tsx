import { Text as NativeText, TextInput } from 'react-native'
import TestRenderer, { act } from 'react-test-renderer'
import { TextField } from './text-field'

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
	let renderer: TestRenderer.ReactTestRenderer | undefined
	act(() => {
		renderer = TestRenderer.create(element)
	})
	if (!renderer) throw new Error('render failed')
	return renderer
}

describe('TextField', () => {
	it('labels the input for the screen reader', () => {
		const renderer = render(<TextField label="Phone number" />)
		const input = renderer.root.findByType(TextInput)
		expect(input.props.accessibilityLabel).toBe('Phone number')
		expect(
			renderer.root
				.findAllByType(NativeText)
				.map((node) => node.props.children),
		).toContain('Phone number')
	})

	it('uses themed placeholder and cursor colors', () => {
		const renderer = render(<TextField placeholder="Name" />)
		const input = renderer.root.findByType(TextInput)
		expect(input.props.placeholderTextColorClassName).toBe(
			'accent-muted-foreground',
		)
		expect(input.props.cursorColorClassName).toBe('accent-primary')
	})

	it('shows the error with the destructive border, else the hint', () => {
		const withError = render(
			<TextField label="Code" error="That code is not right" />,
		)
		expect(withError.root.findByType(TextInput).props.className).toContain(
			'border-destructive',
		)
		const errorText = withError.root
			.findAllByType(NativeText)
			.find((node) => node.props.children === 'That code is not right')
		expect(errorText?.props.accessibilityLiveRegion).toBe('polite')

		const withHint = render(
			<TextField label="Code" hint="We sent you a text" />,
		)
		expect(withHint.root.findByType(TextInput).props.className).toContain(
			'border-input',
		)
		expect(
			withHint.root
				.findAllByType(NativeText)
				.map((node) => node.props.children),
		).toContain('We sent you a text')
	})
})
