import React, { useState, useRef, useEffect } from 'react'
import {
	View,
	TextInput,
	type ViewStyle,
	type NativeSyntheticEvent,
	type TextInputKeyPressEventData,
} from 'react-native'

interface InputOTPProps {
	maxLength: number
	value: string
	onChange: (value: string) => void
	disabled?: boolean
	style?: ViewStyle
	children?: React.ReactNode
	className?: string
}

interface InputOTPGroupProps {
	children: React.ReactNode
	className?: string
}

interface InputOTPSlotProps {
	index: number
	className?: string
}

const InputOTPContext = React.createContext<{
	value: string
	onChange: (value: string) => void
	maxLength: number
	disabled?: boolean
	focusedIndex: number
	setFocusedIndex: (index: number) => void
} | null>(null)

export function InputOTP({
	maxLength,
	value,
	onChange,
	disabled,
	style,
	children,
	className,
}: InputOTPProps) {
	const [focusedIndex, setFocusedIndex] = useState(0)

	useEffect(() => {
		if (value.length === 0) {
			setFocusedIndex(0)
		}
	}, [value.length])

	const contextValue = {
		value,
		onChange,
		maxLength,
		disabled,
		focusedIndex,
		setFocusedIndex,
	}

	return (
		<InputOTPContext.Provider value={contextValue}>
			<View className={`items-center ${className ?? ''}`} style={style}>
				{children}
			</View>
		</InputOTPContext.Provider>
	)
}

export function InputOTPGroup({ children, className }: InputOTPGroupProps) {
	return <View className={`flex-row gap-2 ${className ?? ''}`}>{children}</View>
}

export function InputOTPSlot({ index, className }: InputOTPSlotProps) {
	const context = React.useContext(InputOTPContext)
	const inputRef = useRef<TextInput>(null)

	if (!context) {
		throw new Error('InputOTPSlot must be used within InputOTP')
	}

	const {
		value,
		onChange,
		maxLength,
		disabled,
		focusedIndex,
		setFocusedIndex,
	} = context
	const currentValue = value[index] || ''
	const isFocused = focusedIndex === index

	useEffect(() => {
		if (isFocused && inputRef.current) {
			setTimeout(() => {
				inputRef.current?.focus()
			}, 50)
		}
	}, [isFocused])

	useEffect(() => {
		if (index === 0 && value.length === 0) {
			setFocusedIndex(0)
		}
	}, [index, value.length, setFocusedIndex])

	const handleChangeText = (text: string) => {
		if (text.length > 1) {
			const digits = text.replace(/\D/g, '').slice(0, maxLength)
			onChange(digits)

			const nextIndex = Math.min(digits.length, maxLength - 1)
			setFocusedIndex(nextIndex)
			return
		}

		const digit = text.replace(/\D/g, '')

		const newValueArray = Array(maxLength).fill('')
		for (let i = 0; i < value.length; i++) {
			newValueArray[i] = value[i] || ''
		}

		newValueArray[index] = digit

		const finalValue = newValueArray.join('')
		onChange(finalValue)

		if (digit && index < maxLength - 1) {
			setFocusedIndex(index + 1)
		}
	}

	const handleKeyPress = ({
		nativeEvent,
	}: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
		if (nativeEvent.key === 'Backspace') {
			if (currentValue) {
				const newValueArray = Array(maxLength).fill('')
				for (let i = 0; i < value.length; i++) {
					newValueArray[i] = value[i] || ''
				}
				newValueArray[index] = ''

				const finalValue = newValueArray.join('').replace(/undefined/g, '')
				onChange(finalValue)
			} else if (index > 0) {
				setFocusedIndex(index - 1)

				const newValueArray = Array(maxLength).fill('')
				for (let i = 0; i < value.length; i++) {
					newValueArray[i] = value[i] || ''
				}
				newValueArray[index - 1] = ''

				const finalValue = newValueArray.join('').replace(/undefined/g, '')
				onChange(finalValue)
			}
		}
	}

	const handleFocus = () => {
		setFocusedIndex(index)
	}

	const handlePress = () => {
		setFocusedIndex(index)
		inputRef.current?.focus()
	}

	return (
		<TextInput
			ref={inputRef}
			className={`text-foreground bg-background h-12 w-12 rounded-lg border-2 text-center text-lg ${
				isFocused ? 'border-primary bg-slate-50' : 'border-input'
			} ${disabled ? 'bg-muted text-muted-foreground' : ''} ${className ?? ''}`}
			value={currentValue}
			onChangeText={handleChangeText}
			onKeyPress={handleKeyPress}
			onFocus={handleFocus}
			onPressIn={handlePress}
			maxLength={1}
			keyboardType="numeric"
			textAlign="center"
			editable={!disabled}
			selectTextOnFocus={true}
			autoFocus={index === 0}
			blurOnSubmit={false}
			accessibilityLabel={`Digit ${index + 1} of ${maxLength}`}
		/>
	)
}
