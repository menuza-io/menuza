import { Trans, useLingui } from '@lingui/react/macro'
import { listItemsResultSchema, type StockItem } from '@repo/inventory'
import { cn } from '@repo/ui'
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
import { type ReactNode, useEffect, useId, useState } from 'react'
import { type InventoryClient } from '#app/components/inventory/inventory-client-provider.tsx'
import { categoryLabel } from '#app/utils/inventory/labels.ts'

const RESULT_LIMIT = 20
const SEARCH_DELAY_MS = 200

/**
 * Picks one stock item by name: a Popover with a Command list, searched on
 * the region as you type (the catalogue can be hundreds of items, so the
 * list is never loaded whole). Items only for now; dishes come with recipes.
 */
export function ItemPicker({
	id,
	label,
	error,
	hint,
	client,
	locationId,
	value,
	onChange,
	placeholder,
	disabled = false,
	testId,
}: {
	id?: string
	label: ReactNode
	error?: string | null
	hint?: ReactNode
	client: Pick<InventoryClient, 'request'>
	locationId: string
	value: Pick<StockItem, 'id' | 'name'> | null
	onChange: (item: StockItem) => void
	placeholder: string
	disabled?: boolean
	testId?: string
}) {
	const { t, i18n } = useLingui()
	const generated = useId()
	const fieldId = id ?? generated
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [state, setState] = useState<{
		items: StockItem[]
		loading: boolean
		failed: boolean
	}>({ items: [], loading: false, failed: false })
	const { request } = client

	useEffect(() => {
		if (!open) return
		let live = true
		const timer = setTimeout(
			() => {
				setState((current) => ({ ...current, loading: true, failed: false }))
				const params = new URLSearchParams({
					locationId,
					limit: String(RESULT_LIMIT),
				})
				if (query.trim()) params.set('q', query.trim())
				request(`/items?${params.toString()}`).then(
					(body) => {
						if (!live) return
						const parsed = listItemsResultSchema.safeParse(body)
						setState(
							parsed.success
								? { items: parsed.data.items, loading: false, failed: false }
								: { items: [], loading: false, failed: true },
						)
					},
					() => {
						if (live) setState({ items: [], loading: false, failed: true })
					},
				)
			},
			query === '' ? 0 : SEARCH_DELAY_MS,
		)
		return () => {
			live = false
			clearTimeout(timer)
		}
	}, [open, query, locationId, request])

	const describedBy =
		[hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
			.filter(Boolean)
			.join(' ') || undefined

	return (
		<Field data-invalid={error ? true : undefined}>
			<FieldLabel htmlFor={fieldId}>{label}</FieldLabel>
			<Popover
				open={open}
				onOpenChange={(next) => {
					setOpen(next)
					if (!next) setQuery('')
				}}
			>
				<PopoverTrigger
					render={
						<Button
							id={fieldId}
							type="button"
							variant="outline"
							disabled={disabled}
							aria-invalid={error ? true : undefined}
							aria-describedby={describedBy}
							className="h-11 w-full justify-between rounded-md font-normal md:h-8"
							data-testid={testId}
						>
							<span
								className={cn('truncate', !value && 'text-muted-foreground')}
							>
								{value?.name ?? placeholder}
							</span>
							<Icon name="chevron-down" />
						</Button>
					}
				/>
				<PopoverContent
					align="start"
					className="w-(--anchor-width) min-w-64 p-0"
				>
					<Command label={t`Search items`} shouldFilter={false}>
						<CommandInput
							placeholder={t`Search items`}
							value={query}
							onValueChange={setQuery}
						/>
						<CommandList>
							{state.failed ? (
								<p className="text-destructive p-3 text-sm" role="alert">
									<Trans>We could not load your items. Try again.</Trans>
								</p>
							) : state.loading && state.items.length === 0 ? (
								<p className="text-muted-foreground p-3 text-sm" role="status">
									<Trans>Loading…</Trans>
								</p>
							) : (
								<CommandEmpty>
									{query.trim() === '' ? (
										<Trans>No items yet. Add items in Stock first.</Trans>
									) : (
										<Trans>Nothing matches that search.</Trans>
									)}
								</CommandEmpty>
							)}
							<CommandGroup>
								{state.items.map((item) => (
									<CommandItem
										key={item.id}
										value={item.id}
										onSelect={() => {
											onChange(item)
											setOpen(false)
											setQuery('')
										}}
										data-testid={
											testId ? `${testId}-option-${item.id}` : undefined
										}
									>
										<span className="flex min-w-0 flex-col">
											<span className="truncate">{item.name}</span>
											<span className="text-muted-foreground truncate text-xs">
												{categoryLabel(item.category, i18n)}
											</span>
										</span>
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
			{hint ? (
				<FieldDescription id={`${fieldId}-hint`}>{hint}</FieldDescription>
			) : null}
			{error ? <FieldError id={`${fieldId}-error`}>{error}</FieldError> : null}
		</Field>
	)
}
