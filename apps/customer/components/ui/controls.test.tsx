import { View } from 'react-native'
import { findPressable, press, render } from '../../test/render'
import { Checkbox } from './checkbox'
import { ProgressBar } from './progress-bar'
import { Text } from './text'

describe('ProgressBar', () => {
	it('exposes a clamped value with a spoken amount', () => {
		const renderer = render(
			<ProgressBar percent={83.4} label="Progress" valueText="83%" />,
		)
		const bar = renderer.root.findAllByType(View)[0]
		expect(bar?.props.accessibilityRole).toBe('progressbar')
		expect(bar?.props.accessibilityLabel).toBe('Progress')
		expect(bar?.props.accessibilityValue).toEqual({
			min: 0,
			max: 100,
			now: 83,
			text: '83%',
		})
		expect(renderer.root.findAllByType(View)[1]?.props.style).toEqual({
			width: '83%',
		})

		const over = render(<ProgressBar percent={140} label="Progress" />)
		expect(over.root.findAllByType(View)[0]?.props.accessibilityValue.now).toBe(
			100,
		)
		const under = render(<ProgressBar percent={-5} label="Progress" />)
		expect(
			under.root.findAllByType(View)[0]?.props.accessibilityValue.now,
		).toBe(0)
	})
})

describe('Checkbox', () => {
	it('toggles from the whole row and reports its state', () => {
		const onChange = jest.fn()
		const renderer = render(
			<Checkbox checked={false} onChange={onChange} label="I agree" />,
		)
		const row = findPressable(renderer.root)
		expect(row.props.accessibilityRole).toBe('checkbox')
		expect(row.props.accessibilityLabel).toBe('I agree')
		expect(row.props.accessibilityState).toEqual({
			checked: false,
			disabled: false,
		})
		press(row)
		expect(onChange).toHaveBeenCalledWith(true)

		const checked = render(
			<Checkbox checked onChange={onChange} label="I agree" />,
		)
		expect(
			checked.root.findAllByType(Text).map((node) => node.props.children),
		).toContain('✓')
	})

	it('ignores presses while disabled', () => {
		const onChange = jest.fn()
		const renderer = render(
			<Checkbox checked={false} disabled onChange={onChange} label="I agree" />,
		)
		press(findPressable(renderer.root))
		expect(onChange).not.toHaveBeenCalled()
	})
})
