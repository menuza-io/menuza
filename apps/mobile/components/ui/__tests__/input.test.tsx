import { render, fireEvent } from '@testing-library/react-native'
import React from 'react'
import { Text, type TextInputInstance } from 'react-native'
import { Input } from '../input'

describe('Input', () => {
	it('should render input with label', () => {
		const { getByText, getByDisplayValue } = render(
			<Input label="Test Label" value="test value" onChangeText={jest.fn()} />,
		)

		expect(getByText('Test Label')).toBeTruthy()
		expect(getByDisplayValue('test value')).toBeTruthy()
	})

	it('should apply email keyboard configuration', () => {
		const { getByDisplayValue } = render(
			<Input
				inputType="email"
				value="test@example.com"
				onChangeText={jest.fn()}
			/>,
		)

		const input = getByDisplayValue('test@example.com')
		expect(input.props.keyboardType).toBe('email-address')
		expect(input.props.autoCapitalize).toBe('none')
		expect(input.props.autoCorrect).toBe(false)
		expect(input.props.returnKeyType).toBe('next')
	})

	it('should apply password keyboard configuration', () => {
		const { getByDisplayValue } = render(
			<Input
				inputType="password"
				value="password123"
				onChangeText={jest.fn()}
				secureTextEntry={true}
			/>,
		)

		const input = getByDisplayValue('password123')
		expect(input.props.keyboardType).toBe('default')
		expect(input.props.autoCapitalize).toBe('none')
		expect(input.props.autoCorrect).toBe(false)
		expect(input.props.returnKeyType).toBe('done')
	})

	it('should apply username keyboard configuration', () => {
		const { getByDisplayValue } = render(
			<Input inputType="username" value="testuser" onChangeText={jest.fn()} />,
		)

		const input = getByDisplayValue('testuser')
		expect(input.props.keyboardType).toBe('default')
		expect(input.props.autoCapitalize).toBe('none')
		expect(input.props.autoCorrect).toBe(false)
		expect(input.props.returnKeyType).toBe('next')
	})

	it('should call onSubmitEditing when provided', () => {
		const onSubmitEditing = jest.fn()

		const { getByDisplayValue } = render(
			<Input
				value="test"
				onChangeText={jest.fn()}
				onSubmitEditing={onSubmitEditing}
			/>,
		)

		const input = getByDisplayValue('test')
		fireEvent(input, 'submitEditing')

		expect(onSubmitEditing).toHaveBeenCalledTimes(1)
	})

	it('should focus next input when nextInputRef is provided', () => {
		const nextInputRef = {
			current: { focus: jest.fn() },
		} as unknown as React.RefObject<TextInputInstance>

		const { getByDisplayValue } = render(
			<Input
				value="test"
				onChangeText={jest.fn()}
				nextInputRef={nextInputRef}
			/>,
		)

		const input = getByDisplayValue('test')
		fireEvent(input, 'submitEditing')

		expect(nextInputRef.current.focus).toHaveBeenCalledTimes(1)
	})

	it('should show error styling when error is provided', () => {
		const { getByText, getByDisplayValue } = render(
			<Input
				value="test"
				onChangeText={jest.fn()}
				error="This field is required"
			/>,
		)

		expect(getByText('This field is required')).toBeTruthy()

		// Input should have error styling
		const input = getByDisplayValue('test')
		expect(input.props.style).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					borderColor: '#EF4444',
				}),
			]),
		)
	})

	it('should render right icon when provided', () => {
		const { getByText } = render(
			<Input
				value="test"
				onChangeText={jest.fn()}
				rightIcon={<Text>👁️</Text>}
			/>,
		)

		expect(getByText('👁️')).toBeTruthy()
	})
})
