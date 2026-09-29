import React, { useState, useRef, useEffect } from 'react'
import {
	View,
	TextInput,
	type NativeSyntheticEvent,
	type TextInputKeyPressEventData,
} from 'react-native'

interface SimpleOTPInputProps {
	length: number
	value: string
	onChange: (value: string) => void
	disabled?: boolean
	className?: string
}

export function SimpleOTPInput({
	length,
	value,
	onChange,
	disabled,
	className,
}: SimpleOTPInputProps) {
	const [focusedIndex, setFocusedIndex] = useState(0)
	const inputRefs = useRef<(TextInput | null)[]>([])

	useEffect(() => {
		inputRefs.current = inputRefs.current.slice(0, length)
	}, [length])

	const handleChangeText = (text: string, index: number) => {
		const char = text
			.replace(/[^A-Za-z0-9]/g, '')
			.slice(-1)
			.toUpperCase()

		const newValue = Array(length).fill('')

		for (let i = 0; i < Math.min(value.length, length); i++) {
			newValue[i] = value[i] || ''
		}

		newValue[index] = char

		const finalValue = newValue.join('')
		onChange(finalValue)

		if (char && index < length - 1) {
			inputRefs.current[index + 1]?.focus()
			setFocusedIndex(index + 1)
		}
	}

	const handleKeyPress = (
		event: NativeSyntheticEvent<TextInputKeyPressEventData>,
		index: number,
	) => {
		if (event.nativeEvent.key === 'Backspace') {
			const currentValue = value[index] || ''

			if (!currentValue && index > 0) {
				inputRefs.current[index - 1]?.focus()
				setFocusedIndex(index - 1)

				const newValue = Array(length).fill('')
				for (let i = 0; i < Math.min(value.length, length); i++) {
					newValue[i] = value[i] || ''
				}
				newValue[index - 1] = ''

				const finalValue = newValue.join('')
				onChange(finalValue)
			}
		}
	}

	const handleFocus = (index: number) => {
		setFocusedIndex(index)
	}

	return (
		<View className={`flex-row justify-center gap-2 ${className ?? ''}`}>
			{Array.from({ length }, (_, index) => (
				<TextInput
					key={index}
					ref={(ref) => {
						inputRefs.current[index] = ref
					}}
					className={`text-foreground bg-background h-12 w-12 rounded-lg border-2 text-center text-lg ${
						focusedIndex === index
							? 'border-primary bg-slate-50'
							: 'border-input'
					} ${disabled ? 'bg-muted text-muted-foreground' : ''}`}
					value={value[index] || ''}
					onChangeText={(text) => handleChangeText(text, index)}
					onKeyPress={(event) => handleKeyPress(event, index)}
					onFocus={() => handleFocus(index)}
					maxLength={1}
					keyboardType="default"
					textAlign="center"
					editable={!disabled}
					autoFocus={index === 0}
					selectTextOnFocus
					accessibilityLabel={`Digit ${index + 1} of ${length}`}
				/>
			))}
		</View>
	)
}
