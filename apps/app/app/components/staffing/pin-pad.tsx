import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@repo/staffing'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useEffect } from 'react'

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * Large-target PIN entry for a shared tablet. Digits are never echoed, and a
 * hardware keyboard works too.
 */
export function PinPad({
	value,
	onChange,
	onSubmit,
	disabled,
}: {
	value: string
	onChange: (value: string) => void
	onSubmit: () => void
	disabled?: boolean
}) {
	const { _ } = useLingui()
	const press = (digit: string) => {
		if (!disabled && value.length < PIN_MAX_LENGTH) onChange(value + digit)
	}
	const back = () => onChange(value.slice(0, -1))
	const ready = value.length >= PIN_MIN_LENGTH && !disabled
	const entered = value.length

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (disabled) return
			if (/^\d$/.test(event.key)) {
				if (value.length < PIN_MAX_LENGTH) onChange(value + event.key)
			} else if (event.key === 'Backspace') {
				onChange(value.slice(0, -1))
			} else if (event.key === 'Enter' && value.length >= PIN_MIN_LENGTH) {
				onSubmit()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [value, onChange, onSubmit, disabled])

	return (
		<div className="mx-auto w-full max-w-xs space-y-6">
			<div
				className="flex h-6 justify-center gap-3"
				role="status"
				aria-label={_(msg`${entered} digits entered`)}
			>
				{Array.from({ length: PIN_MAX_LENGTH }, (_unused, index) => (
					<span
						key={index}
						className={
							index < value.length
								? 'bg-foreground size-4 rounded-full'
								: index < PIN_MIN_LENGTH
									? 'border-foreground size-4 rounded-full border-2'
									: 'border-muted-foreground/40 size-4 rounded-full border-2'
						}
					/>
				))}
			</div>
			<div className="grid grid-cols-3 gap-3" dir="ltr">
				{DIGITS.map((digit) => (
					<Button
						key={digit}
						type="button"
						variant="outline"
						className="h-16 text-2xl"
						disabled={disabled}
						onClick={() => press(digit)}
					>
						{digit}
					</Button>
				))}
				<Button
					type="button"
					variant="ghost"
					className="h-16"
					disabled={disabled || value.length === 0}
					aria-label={_(msg`Delete last digit`)}
					onClick={back}
				>
					<Icon name="arrow-left" className="size-6" />
				</Button>
				<Button
					type="button"
					variant="outline"
					className="h-16 text-2xl"
					disabled={disabled}
					onClick={() => press('0')}
				>
					0
				</Button>
				<Button
					type="button"
					className="h-16"
					disabled={!ready}
					onClick={onSubmit}
				>
					<Trans>Enter</Trans>
				</Button>
			</div>
		</div>
	)
}
