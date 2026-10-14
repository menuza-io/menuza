import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { FieldLabel, FieldLegend, FieldSet } from '@repo/ui/field'
import {
	POSITION_COLOR_KEYS,
	PositionDot,
	type PositionColorKey,
} from '@repo/ui/position-color'
import { useId } from 'react'

/**
 * Position colors are theme-token keys, so they follow light and dark themes.
 * Native radio inputs give arrow-key navigation and screen-reader names for
 * free; the swatch is the visible label and its name is read aloud.
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
	const name = useId()
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
			<div className="flex flex-wrap gap-1">
				{POSITION_COLOR_KEYS.map((key) => (
					<FieldLabel
						key={key}
						className="has-checked:ring-ring has-focus-visible:ring-ring/50 relative grid size-9 cursor-pointer place-items-center rounded-lg ring-1 ring-transparent has-checked:ring-2 has-focus-visible:ring-3"
					>
						<input
							type="radio"
							name={name}
							value={key}
							checked={value === key}
							onChange={() => onChange(key)}
							className="sr-only"
						/>
						<PositionDot colorKey={key} className="size-4" />
						<span className="sr-only">{labels[key]}</span>
					</FieldLabel>
				))}
			</div>
		</FieldSet>
	)
}
