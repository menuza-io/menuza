import { ActivityIndicator, Text as NativeText, View } from 'react-native'
import { findPressable, press, render } from '../../test/render'
import { Button } from './button'

describe('Button', () => {
	it('renders the label in the variant and size classes', () => {
		const renderer = render(
			<Button variant="secondary" size="lg">
				Save
			</Button>,
		)
		const pressable = findPressable(renderer.root)
		expect(pressable.props.className).toContain(
			'bg-secondary border border-border',
		)
		expect(pressable.props.className).toContain('h-13 px-6')
		const label = renderer.root.findByType(NativeText)
		expect(label.props.className).toContain('text-secondary-foreground')
		expect(label.props.className).toContain('text-lg')
		expect(label.props.children).toBe('Save')
	})

	it('calls onPress and exposes the button role', () => {
		const onPress = jest.fn()
		const renderer = render(<Button onPress={onPress}>Go</Button>)
		const pressable = findPressable(renderer.root)
		press(pressable)
		expect(onPress).toHaveBeenCalledTimes(1)
		expect(pressable.props.accessibilityRole).toBe('button')
		expect(pressable.props.accessibilityState).toEqual({
			disabled: false,
			busy: false,
		})
	})

	it('swallows presses while disabled', () => {
		const onPress = jest.fn()
		const renderer = render(
			<Button disabled onPress={onPress}>
				Go
			</Button>,
		)
		const pressable = findPressable(renderer.root)
		press(pressable)
		expect(onPress).not.toHaveBeenCalled()
		expect(pressable.props.className).toContain('opacity-50')
		expect(pressable.props.accessibilityState.disabled).toBe(true)
	})

	it('shows a spinner instead of the label while loading', () => {
		const onPress = jest.fn()
		const renderer = render(
			<Button loading onPress={onPress}>
				Go
			</Button>,
		)
		expect(
			renderer.root.findByType(ActivityIndicator).props.colorClassName,
		).toBe('accent-primary-foreground')
		expect(renderer.root.findAllByType(NativeText)).toHaveLength(0)
		press(findPressable(renderer.root))
		expect(onPress).not.toHaveBeenCalled()
	})

	it('renders non-string children untouched (icons, Trans elements)', () => {
		const renderer = render(
			<Button>
				<View testID="custom" />
			</Button>,
		)
		expect(renderer.root.findByProps({ testID: 'custom' })).toBeTruthy()
	})
})
