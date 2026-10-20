import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FieldLegend, FieldSet } from '@repo/ui/field'
import {
	POSITION_COLOR_KEYS,
	type PositionColorKey,
} from '@repo/ui/position-color'
import { ColorSwatch } from '#app/components/color-swatch.tsx'

/**
 * Position colors are theme-token keys, so they follow light and dark themes:
 * each swatch paints with its `--position-*` variable rather than a hex value.
 * Uses the same swatch as the site Accent color picker.
 */
export function PositionColorField({
	value,
	onChange,
	legend,
}: {
	value: PositionColorKey
	onChange: (value: PositionColorKey) => void
	legend: string
}) {
	const { _ } = useLingui()
	const labels: Record<PositionColorKey, string> = {
		neutral: _(t`Neutral`),
		red: _(t`Red`),
		orange: _(t`Orange`),
		amber: _(t`Amber`),
		green: _(t`Green`),
		teal: _(t`Teal`),
		blue: _(t`Blue`),
		violet: _(t`Violet`),
		pink: _(t`Pink`),
	}
	return (
		<FieldSet>
			<FieldLegend variant="label">{legend}</FieldLegend>
			<div
				role="radiogroup"
				aria-label={legend}
				className="flex flex-wrap gap-2"
				onKeyDown={(event) => {
					const step =
						event.key === 'ArrowRight' || event.key === 'ArrowDown'
							? 1
							: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
								? -1
								: 0
					if (!step) return
					event.preventDefault()
					const count = POSITION_COLOR_KEYS.length
					const next =
						POSITION_COLOR_KEYS[
							(POSITION_COLOR_KEYS.indexOf(value) + step + count) % count
						]
					if (!next) return
					onChange(next)
					const swatches =
						event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')
					swatches[POSITION_COLOR_KEYS.indexOf(next)]?.focus()
				}}
			>
				{POSITION_COLOR_KEYS.map((key) => (
					<ColorSwatch
						key={key}
						label={labels[key]}
						swatch={`var(--position-${key})`}
						selected={value === key}
						radio
						onSelect={() => onChange(key)}
					/>
				))}
			</div>
		</FieldSet>
	)
}
