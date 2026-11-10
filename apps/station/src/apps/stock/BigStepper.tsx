import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import {
	formatQuantityText,
	MAX_TYPED_QUANTITY,
	parseQuantityText,
	stepQuantity,
} from '@repo/ui/quantity-input'
import { useEffect, useState } from 'react'
import { Button, cn, Input } from '~/ui/primitives.tsx'

const FRACTIONS = [
	{ value: 0.25, text: '¼' },
	{ value: 0.5, text: '½' },
	{ value: 0.75, text: '¾' },
] as const

/**
 * The counting stepper for a tablet: big − and + (56 px) either side of a
 * number that can also be typed ("2.5", "1½", Arabic digits), and ¼ ½ ¾ under
 * it. Blank means "not counted": the first − makes it 0 and the first + makes
 * it one step, so an empty field is never mistaken for a count. The pad reads
 * left to right in Arabic too, the way digits do.
 *
 * Typed text is settled when the field loses focus or Enter is pressed, so a
 * count is queued once per change, not once per key.
 */
export function BigStepper({
	value,
	onChange,
	step = 1,
	fractions = true,
	label,
	max = MAX_TYPED_QUANTITY,
	disabled = false,
	allowClear = false,
	autoFocus = false,
}: {
	value: number | null
	onChange: (next: number | null) => void
	step?: number
	fractions?: boolean
	/** What this is a count of, for assistive technology ("Tomatoes"). */
	label: string
	max?: number
	disabled?: boolean
	/** Show a clear button once there is an amount (counting only: clearing is an entry). */
	allowClear?: boolean
	autoFocus?: boolean
}) {
	const { _ } = useLingui()
	const [text, setText] = useState(() => formatQuantityText(value))
	// Follow the value when a button or the parent changes it, but never rewrite
	// what is still being typed ("2." reads as 2 and stays).
	useEffect(() => {
		setText((current) =>
			parseQuantityText(current) === value
				? current
				: formatQuantityText(value),
		)
	}, [value])

	const commit = (next: number | null) => {
		setText(formatQuantityText(next))
		onChange(next)
	}
	const whole = value === null ? 0 : Math.floor(value)
	const fraction =
		value === null ? 0 : Math.round((value - whole) * 1000) / 1000
	const bad = text.trim() !== '' && parseQuantityText(text) === null
	const settle = () => {
		const parsed = parseQuantityText(text)
		if (text.trim() === '') {
			if (value !== null && allowClear) onChange(null)
			else setText(formatQuantityText(value))
			return
		}
		if (parsed === null || parsed > max) {
			// Junk is put back to what it was, never guessed.
			setText(formatQuantityText(value))
			return
		}
		setText(formatQuantityText(parsed))
		if (parsed !== value) onChange(parsed)
	}

	return (
		<div dir="ltr" className="flex w-fit max-w-full flex-col gap-2">
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					className="size-14 shrink-0 px-0"
					aria-label={_(t`One less ${label}`)}
					disabled={disabled || value === 0}
					onClick={() => commit(stepQuantity(value, -step, { max }))}
				>
					<Icon name="minus" className="size-6" />
				</Button>
				<Input
					type="text"
					inputMode="decimal"
					autoComplete="off"
					dir="ltr"
					aria-label={label}
					aria-invalid={bad || undefined}
					autoFocus={autoFocus}
					placeholder="—"
					value={text}
					disabled={disabled}
					className={cn(
						'h-14 w-28 text-center text-2xl font-semibold tabular-nums',
						bad && 'border-destructive',
					)}
					onChange={(event) => setText(event.target.value)}
					onBlur={settle}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							settle()
						}
					}}
				/>
				<Button
					variant="outline"
					className="size-14 shrink-0 px-0"
					aria-label={_(t`One more ${label}`)}
					disabled={disabled || (value ?? 0) >= max}
					onClick={() => commit(stepQuantity(value, step, { max }))}
				>
					<Icon name="plus" className="size-6" />
				</Button>
			</div>
			{fractions || allowClear ? (
				<div className="flex flex-wrap items-center gap-2">
					{fractions
						? FRACTIONS.map(({ value: part, text: symbol }) => (
								<Button
									key={symbol}
									variant="outline"
									className="min-w-14 px-3 text-base"
									aria-pressed={fraction === part}
									aria-label={_(t`${symbol} of ${label}`)}
									disabled={disabled || whole + part > max}
									onClick={() =>
										commit(fraction === part ? whole : whole + part)
									}
								>
									{symbol}
								</Button>
							))
						: null}
					{allowClear && value !== null ? (
						<Button
							variant="ghost"
							disabled={disabled}
							aria-label={_(t`Clear ${label}`)}
							onClick={() => onChange(null)}
						>
							<Icon name="x" className="size-4" />
							<span className="text-sm">{_(t`Clear`)}</span>
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	)
}
