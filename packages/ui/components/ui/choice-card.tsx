import type * as React from 'react'

import { cn } from '../../lib/utils'

/**
 * A choice shown as a card: one bordered tile per option, with the radio or
 * checkbox first and a title, an optional description and optional extras
 * after it. The whole card is the label, so a click anywhere picks it.
 *
 * This is the one pattern for choosing between a few options with words, in
 * a RadioGroup or as a set of checkboxes:
 *
 * ```tsx
 * <RadioGroup value={value} onValueChange={setValue} className="sm:grid-cols-2">
 *   <ChoiceCard>
 *     <RadioGroupItem value="percent" />
 *     <ChoiceCardContent>
 *       <ChoiceCardTitle>Percentage off</ChoiceCardTitle>
 *       <ChoiceCardDescription>Takes a percentage off.</ChoiceCardDescription>
 *     </ChoiceCardContent>
 *   </ChoiceCard>
 * </RadioGroup>
 * ```
 *
 * The chosen card has a full primary border and a faint primary tint, and its
 * radio fills in; a disabled card is dimmed once, as a whole. Cards fill their
 * column; add `w-auto` for short chips in a wrapping row. Plain radio lists (a
 * radio and a line of text, no card) stay as they are.
 */
function ChoiceCard({ className, ...props }: React.ComponentProps<'label'>) {
	return (
		<label
			data-slot="choice-card"
			className={cn(
				'group/choice-card border-border relative flex min-h-11 w-full cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm transition-colors duration-150 select-none',
				'not-has-data-checked:not-has-data-disabled:hover:bg-muted/50',
				// Chosen: a full-strength primary border (3:1 against the page) and a faint tint.
				'has-data-checked:border-primary has-data-checked:bg-primary/5 dark:has-data-checked:bg-primary/10',
				// One focus ring, on the card, only for the control's own focus.
				'has-[[data-slot=radio-group-item]:focus-visible]:ring-ring/50 has-[[data-slot=checkbox]:focus-visible]:ring-ring/50 has-[[data-slot=checkbox]:focus-visible]:ring-3 has-[[data-slot=radio-group-item]:focus-visible]:ring-3',
				'*:data-[slot=checkbox]:focus-visible:ring-0 *:data-[slot=radio-group-item]:focus-visible:ring-0',
				'has-aria-invalid:border-destructive',
				// Dim once, on the card; the control inside must not dim again.
				'has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60',
				'*:data-[slot=checkbox]:disabled:opacity-100 *:data-[slot=radio-group-item]:disabled:opacity-100',
				// The control sits on the title's first line.
				'*:data-[slot=checkbox]:mt-0.5 *:data-[slot=radio-group-item]:mt-0.5',
				className,
			)}
			{...props}
		/>
	)
}

/** The text of a choice card: its title and description, stacked. */
function ChoiceCardContent({
	className,
	...props
}: React.ComponentProps<'span'>) {
	return (
		<span
			data-slot="choice-card-content"
			className={cn('flex min-w-0 flex-1 flex-col gap-0.5', className)}
			{...props}
		/>
	)
}

/** The option's name. A badge can sit beside it; long names wrap. */
function ChoiceCardTitle({
	className,
	...props
}: React.ComponentProps<'span'>) {
	return (
		<span
			data-slot="choice-card-title"
			className={cn(
				'text-foreground flex flex-wrap items-center gap-2 leading-5 font-medium wrap-anywhere select-text',
				className,
			)}
			{...props}
		/>
	)
}

/** One line saying what the option does. */
function ChoiceCardDescription({
	className,
	...props
}: React.ComponentProps<'span'>) {
	return (
		<span
			data-slot="choice-card-description"
			className={cn(
				'text-muted-foreground leading-5 font-normal wrap-anywhere select-text',
				className,
			)}
			{...props}
		/>
	)
}

export { ChoiceCard, ChoiceCardContent, ChoiceCardTitle, ChoiceCardDescription }
