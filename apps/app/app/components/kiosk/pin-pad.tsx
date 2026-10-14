import { plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@repo/staffing'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useEffect } from 'react'

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

/**
 * A big, touch-first number pad. The keys fill whatever height the screen
 * gives them (four equal rows), so there is nothing to scroll on a phone or a
 * tablet. Digits are always Western numerals, whichever language is showing: a
 * keypad that rearranges itself is a keypad people mistype on. A physical
 * keyboard works too.
 */
export function PinPad({
	onDigit,
	onBackspace,
	onSubmit,
	submitLabel,
	submitDisabled,
	disabled,
	decimal = false,
	listenToKeyboard = true,
}: {
	onDigit: (digit: string) => void
	onBackspace: () => void
	/** Omit for a pad whose submit lives elsewhere (the tip screen). */
	onSubmit?: () => void
	submitLabel?: string
	submitDisabled?: boolean
	disabled?: boolean
	/** Replace the submit key with a decimal point (amounts). */
	decimal?: boolean
	listenToKeyboard?: boolean
}) {
	const { _ } = useLingui()

	useEffect(() => {
		if (!listenToKeyboard || disabled) return
		function onKey(event: KeyboardEvent) {
			if (event.ctrlKey || event.metaKey || event.altKey) return
			if (/^[0-9]$/.test(event.key)) {
				event.preventDefault()
				onDigit(event.key)
			} else if (event.key === '.' && decimal) {
				event.preventDefault()
				onDigit('.')
			} else if (event.key === 'Backspace') {
				event.preventDefault()
				onBackspace()
			} else if (event.key === 'Enter' && onSubmit && !submitDisabled) {
				event.preventDefault()
				onSubmit()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [
		listenToKeyboard,
		disabled,
		decimal,
		onDigit,
		onBackspace,
		onSubmit,
		submitDisabled,
	])

	const key =
		'border-foreground/40 h-full min-h-12 rounded-2xl border-2 text-3xl font-semibold touch-manipulation tabular-nums active:scale-95 motion-reduce:active:scale-100'

	return (
		<div
			role="group"
			aria-label={_(t`Number pad`)}
			dir="ltr"
			className="grid min-h-0 w-full flex-1 grid-cols-3 grid-rows-4 gap-2 select-none md:gap-3"
		>
			{DIGITS.map((digit) => (
				<Button
					key={digit}
					type="button"
					variant="outline"
					disabled={disabled}
					className={key}
					onClick={() => onDigit(digit)}
				>
					{digit}
				</Button>
			))}
			<Button
				type="button"
				variant="ghost"
				disabled={disabled}
				aria-label={_(t`Delete last digit`)}
				className={key}
				onClick={onBackspace}
			>
				<Icon name="x" size="md" />
			</Button>
			<Button
				type="button"
				variant="outline"
				disabled={disabled}
				className={key}
				onClick={() => onDigit('0')}
			>
				0
			</Button>
			{decimal ? (
				<Button
					type="button"
					variant="outline"
					disabled={disabled}
					aria-label={_(t`Decimal point`)}
					className={key}
					onClick={() => onDigit('.')}
				>
					.
				</Button>
			) : (
				<Button
					type="button"
					disabled={disabled || submitDisabled}
					aria-label={submitLabel ?? _(t`Continue`)}
					className={key}
					onClick={onSubmit}
				>
					<Icon name="check" size="md" />
				</Button>
			)}
		</div>
	)
}

/**
 * The typed PIN as dots, so the number is never on screen. Slots for the
 * shortest PIN are always drawn; more appear as digits are typed.
 */
export function PinDots({ length }: { length: number }) {
	const slots = Math.max(PIN_MIN_LENGTH, Math.min(PIN_MAX_LENGTH, length))
	return (
		<div
			role="img"
			aria-label={plural(length, {
				0: 'No digits entered',
				one: '# digit entered',
				other: '# digits entered',
			})}
			className="flex h-10 items-center justify-center gap-3"
		>
			{Array.from({ length: slots }, (_item, index) => (
				<span
					key={index}
					aria-hidden="true"
					className={cn(
						'size-5 rounded-full border-2 transition-colors duration-100 motion-reduce:transition-none',
						index < length
							? 'bg-foreground border-foreground'
							: 'border-foreground/50',
					)}
				/>
			))}
		</div>
	)
}
