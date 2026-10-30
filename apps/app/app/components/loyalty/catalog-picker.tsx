import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from '@repo/ui/command'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { type ReactNode, useId, useMemo, useState } from 'react'
import { type LoyaltyCatalogOption } from '#app/utils/loyalty/catalog.ts'

type Choice = LoyaltyCatalogOption & { missing: boolean }

/**
 * Picks menu items or categories by name for an earning rule or a reward. The
 * value is a list of catalog ids. An id the menu no longer has keeps the name
 * saved with it and stays chosen until the operator removes it.
 */
export function CatalogPicker({
	id,
	label,
	hint,
	error,
	options,
	value,
	onChange,
	onClose,
	multiple = false,
	max,
	savedLabels,
	disabled = false,
	placeholder,
	emptyMessage,
	className,
	testId,
}: {
	id: string
	label: ReactNode
	hint?: ReactNode
	error?: string | null
	options: readonly LoyaltyCatalogOption[]
	value: readonly string[]
	onChange: (ids: string[]) => void
	/** Called when the list closes, so validate-on-blur forms can check it. */
	onClose?: () => void
	multiple?: boolean
	max?: number
	savedLabels?: Readonly<Record<string, string>>
	disabled?: boolean
	placeholder: string
	/** Shown in the list when the menu has nothing to choose. */
	emptyMessage: ReactNode
	className?: string
	testId?: string
}) {
	const { t } = useLingui()
	const [open, setOpen] = useState(false)
	const labelId = useId()
	const summaryId = useId()
	const byId = useMemo(
		() => new Map(options.map((option) => [option.id, option])),
		[options],
	)
	const chosen: Choice[] = value.map((choiceId) => {
		const option = byId.get(choiceId)
		if (option) return { ...option, missing: false }
		const saved =
			savedLabels && Object.hasOwn(savedLabels, choiceId)
				? savedLabels[choiceId]
				: undefined
		return {
			id: choiceId,
			name: saved ?? choiceId,
			detail: null,
			missing: true,
		}
	})
	const selected = new Set(value)
	const atMax = multiple && max !== undefined && value.length >= max
	const single = multiple ? null : (chosen[0] ?? null)
	const describedBy =
		[
			single?.missing ? `${id}-missing` : null,
			hint ? `${id}-hint` : null,
			error ? `${id}-error` : null,
		]
			.filter(Boolean)
			.join(' ') || undefined

	const close = () => {
		setOpen(false)
		onClose?.()
	}

	const toggle = (choiceId: string) => {
		if (!multiple) {
			onChange([choiceId])
			close()
			return
		}
		if (selected.has(choiceId)) {
			onChange(value.filter((current) => current !== choiceId))
		} else if (!atMax) {
			onChange([...value, choiceId])
		}
	}

	const remove = (choiceId: string) => {
		onChange(value.filter((current) => current !== choiceId))
		onClose?.()
	}

	return (
		<Field className={className} data-invalid={error ? true : undefined}>
			<FieldLabel id={labelId} htmlFor={id}>
				{label}
			</FieldLabel>
			<Popover
				open={open}
				onOpenChange={(next) => {
					if (next) setOpen(true)
					else close()
				}}
			>
				<PopoverTrigger
					render={
						<Button
							id={id}
							type="button"
							variant="outline"
							disabled={disabled}
							aria-invalid={error ? true : undefined}
							aria-labelledby={`${labelId} ${summaryId}`}
							aria-describedby={describedBy}
							className="h-11 w-full justify-between rounded-md font-normal md:h-8"
							data-testid={testId}
						>
							<span
								id={summaryId}
								className={cn(
									'truncate',
									value.length === 0 && 'text-muted-foreground',
								)}
							>
								{multiple ? (
									value.length === 0 ? (
										placeholder
									) : (
										<Plural
											value={value.length}
											one="# chosen"
											other="# chosen"
										/>
									)
								) : (
									(single?.name ?? placeholder)
								)}
							</span>
							<Icon name="chevron-down" />
						</Button>
					}
				/>
				<PopoverContent
					align="start"
					className="w-(--anchor-width) min-w-64 p-0"
				>
					{/* cmdk names its input from this label (aria-labelledby). */}
					<Command label={t`Search by name`}>
						<CommandInput placeholder={t`Search by name`} />
						<CommandList>
							<CommandEmpty>
								{options.length === 0 ? (
									emptyMessage
								) : (
									<Trans>Nothing matches that search.</Trans>
								)}
							</CommandEmpty>
							<CommandGroup>
								{options.map((option) => {
									const isChosen = selected.has(option.id)
									return (
										<CommandItem
											key={option.id}
											value={option.id}
											keywords={
												option.detail
													? [option.name, option.detail]
													: [option.name]
											}
											disabled={!isChosen && atMax}
											data-checked={isChosen ? 'true' : 'false'}
											aria-checked={multiple ? isChosen : undefined}
											onSelect={() => toggle(option.id)}
											data-testid={
												testId ? `${testId}-option-${option.id}` : undefined
											}
										>
											<span className="flex min-w-0 flex-col">
												<span className="truncate">{option.name}</span>
												{option.detail ? (
													<span className="text-muted-foreground truncate text-xs">
														{option.detail}
													</span>
												) : null}
											</span>
											{isChosen ? (
												<span className="sr-only">
													<Trans>Chosen</Trans>
												</span>
											) : null}
										</CommandItem>
									)
								})}
							</CommandGroup>
						</CommandList>
						{atMax ? (
							<p className="text-muted-foreground border-t p-2 text-xs">
								<Trans>
									That is the most you can choose. Remove one to add another.
								</Trans>
							</p>
						) : null}
					</Command>
				</PopoverContent>
			</Popover>
			{multiple && chosen.length > 0 ? (
				<ul
					className="flex flex-wrap gap-1.5"
					data-testid={testId ? `${testId}-chosen` : undefined}
				>
					{chosen.map((choice, index) => {
						const choiceName = choice.name
						const missingId = `${id}-chosen-${index}-missing`
						return (
							<li key={choice.id} className="max-w-full">
								{disabled ? (
									<Badge variant="secondary" className="max-w-full">
										<span className="truncate">{choiceName}</span>
									</Badge>
								) : (
									<Button
										type="button"
										variant="outline"
										size="xs"
										className="max-w-full"
										onClick={() => remove(choice.id)}
										aria-label={t`Remove ${choiceName}`}
										aria-describedby={choice.missing ? missingId : undefined}
									>
										<span className="truncate">{choiceName}</span>
										{choice.missing ? (
											<span id={missingId} className="text-muted-foreground">
												<Trans>(not on the menu)</Trans>
											</span>
										) : null}
										<Icon name="x" data-icon="inline-end" />
									</Button>
								)}
							</li>
						)
					})}
				</ul>
			) : null}
			{single?.missing ? (
				<FieldDescription id={`${id}-missing`}>
					<Trans>This is no longer on the menu. Choose another.</Trans>
				</FieldDescription>
			) : null}
			{hint ? (
				<FieldDescription id={`${id}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
		</Field>
	)
}
