import { cn } from '@repo/ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'

/**
 * A round color choice with its name in a tooltip. Used wherever a palette is
 * picked from a row of swatches (site accent and gray colors, position colors)
 * so every color picker in the App looks and behaves the same.
 */
export function ColorSwatch({
	label,
	swatch,
	selected,
	disabled,
	radio,
	onSelect,
}: {
	label: string
	/** Any CSS color, including `var(--token)`. */
	swatch: string
	selected: boolean
	disabled?: boolean
	/**
	 * Expose the swatch as a radio inside a `role="radiogroup"` (exclusive
	 * choice, roving tab stop) instead of an independent toggle button.
	 */
	radio?: boolean
	onSelect: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						disabled={disabled}
						onClick={onSelect}
						aria-label={label}
						{...(radio
							? {
									role: 'radio',
									'aria-checked': selected,
									tabIndex: selected ? 0 : -1,
								}
							: { 'aria-pressed': selected })}
						className={cn(
							'size-6 rounded-full transition-[box-shadow,transform] duration-150 ease-out',
							'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
							'disabled:pointer-events-none disabled:opacity-50',
							selected
								? 'ring-foreground ring-offset-background scale-105 ring-2 ring-offset-2'
								: 'hover:ring-foreground/30 hover:ring-offset-background hover:ring-2 hover:ring-offset-2',
						)}
						style={{ backgroundColor: swatch }}
					/>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}
