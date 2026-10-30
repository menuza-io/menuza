import { findPressables, press, render } from '../../test/render'
import { Badge } from './badge'
import { Chip } from './chip'
import { Stepper } from './stepper'
import { Text } from './text'

describe('Chip', () => {
	it('reports its selection as a button and calls back', () => {
		const onPress = jest.fn()
		const renderer = render(
			<Chip label="4" sublabel="Tue" selected onPress={onPress} />,
		)
		const [chip] = findPressables(renderer.root)
		expect(chip?.props.accessibilityRole).toBe('button')
		expect(chip?.props.accessibilityLabel).toBe('Tue 4')
		expect(chip?.props.accessibilityState).toEqual({
			selected: true,
			disabled: false,
		})
		press(chip!)
		expect(onPress).toHaveBeenCalledTimes(1)
	})

	it('reports checked as a radio and ignores presses while disabled', () => {
		const onPress = jest.fn()
		const renderer = render(
			<Chip
				label="Birthday"
				role="radio"
				disabled
				accessibilityLabel="Occasion: Birthday"
				onPress={onPress}
			/>,
		)
		const [chip] = findPressables(renderer.root)
		expect(chip?.props.accessibilityState).toEqual({
			checked: false,
			disabled: true,
		})
		expect(chip?.props.accessibilityLabel).toBe('Occasion: Birthday')
		press(chip!)
		expect(onPress).not.toHaveBeenCalled()
	})
})

describe('Stepper', () => {
	it('steps within its range with named buttons', () => {
		const onChange = jest.fn()
		const renderer = render(
			<Stepper
				label="Party size"
				value={1}
				valueText="1 guest"
				min={1}
				max={2}
				decrementLabel="Fewer"
				incrementLabel="More"
				onChange={onChange}
			/>,
		)
		const [fewer, more] = findPressables(renderer.root)
		expect(fewer?.props.accessibilityLabel).toBe('Fewer')
		expect(fewer?.props.accessibilityState).toEqual({ disabled: true })
		press(fewer!)
		expect(onChange).not.toHaveBeenCalled()
		expect(more?.props.accessibilityState).toEqual({ disabled: false })
		press(more!)
		expect(onChange).toHaveBeenCalledWith(2)
		expect(
			renderer.root.findAllByType(Text).map((node) => node.props.children),
		).toContain('1 guest')
	})

	it('stops at the top of the range', () => {
		const onChange = jest.fn()
		const renderer = render(
			<Stepper
				label="Party size"
				value={2}
				valueText="2 guests"
				min={1}
				max={2}
				decrementLabel="Fewer"
				incrementLabel="More"
				onChange={onChange}
			/>,
		)
		const [fewer, more] = findPressables(renderer.root)
		expect(more?.props.accessibilityState).toEqual({ disabled: true })
		press(fewer!)
		expect(onChange).toHaveBeenCalledWith(1)
	})
})

describe('Badge', () => {
	it('shows its label', () => {
		const renderer = render(<Badge>Booked</Badge>)
		expect(
			renderer.root.findAllByType(Text).map((node) => node.props.children),
		).toEqual(['Booked'])
	})
})
