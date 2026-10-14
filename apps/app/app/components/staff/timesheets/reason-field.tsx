import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { useId } from 'react'
import { TextAreaField } from '#app/components/staff/controls.tsx'
import { REASON_SUGGESTIONS } from '#app/utils/staffing/timesheet-form.ts'

/**
 * Why a card is being changed. Required by the server and kept in the card's
 * history, so it is a real field with a few one-tap starters for the usual
 * reasons, not a hidden default.
 */
export function ReasonField({
	value,
	onChange,
	error,
	label,
	hint,
	disabled,
	autoFocus,
}: {
	value: string
	onChange: (value: string) => void
	error?: string | null
	label?: string
	hint?: string
	disabled?: boolean
	autoFocus?: boolean
}) {
	const { _ } = useLingui()
	const id = useId()
	return (
		<div className="flex flex-col gap-2">
			<TextAreaField
				id={id}
				label={label ?? <Trans>Reason</Trans>}
				hint={hint ?? _(t`Kept with the card and shown in its history.`)}
				error={error}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				rows={2}
				maxLength={500}
				disabled={disabled}
				autoFocus={autoFocus}
				required
			/>
			<div
				role="group"
				aria-label={_(t`Common reasons`)}
				className="flex flex-wrap gap-1.5"
			>
				{REASON_SUGGESTIONS.map((suggestion) => {
					const text = _(suggestion)
					return (
						<Button
							key={suggestion.id}
							type="button"
							variant="outline"
							size="sm"
							className="h-9 md:h-7"
							disabled={disabled}
							onClick={() => onChange(text)}
						>
							{text}
						</Button>
					)
				})}
			</div>
		</div>
	)
}
