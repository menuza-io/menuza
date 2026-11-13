import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { useId, useRef, useState } from 'react'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import {
	type QuickModifierGroupInput,
	type QuickModifierGroupResult,
} from '#app/routes/_app+/$orgSlug_+/menu+/modifiers.quick-create.ts'
import {
	ModifierRequiredSelectionField,
	ModifierSelectionLimitsFields,
	ModifierSelectionModeField,
	type ModifierSelectionType,
} from './modifier-selection-fields.tsx'

export interface QuickCreatedModifierGroup {
	id: string
	/** Localized JSON, as the loaders return group names. */
	name: string
	selectionType: string
}

interface OptionRow {
	key: string
	displayName: string
	price: string
}

/** Members who may create a modifier group (the server checks again). */
export function useCanCreateModifierGroup() {
	return useHasPermission()('update:menu:any')
}

function newRequestId() {
	return `mg-${crypto.randomUUID()}`
}

function OptionRowFields({
	row,
	index,
	onChange,
	onRemove,
}: {
	row: OptionRow
	index: number
	onChange: (patch: Partial<OptionRow>) => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const {
		attributes,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: row.key })
	const position = index + 1

	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(
				'bg-background flex items-center gap-2 p-2',
				isDragging && 'z-10',
			)}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				{...attributes}
				{...listeners}
				className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring shrink-0 cursor-grab rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
				aria-label={_(t`Drag to reorder option ${position}`)}
			>
				<Icon name="grip-vertical" className="size-4" />
			</button>
			<Input
				value={row.displayName}
				onChange={(e) => onChange({ displayName: e.target.value })}
				placeholder={_(t`Option name`)}
				aria-label={_(t`Option ${position} name`)}
				maxLength={200}
				className="min-w-0 flex-1"
			/>
			<Input
				type="number"
				inputMode="decimal"
				step="0.01"
				min="0"
				value={row.price}
				onChange={(e) => onChange({ price: e.target.value })}
				placeholder="0.00"
				aria-label={_(t`Option ${position} price`)}
				className="w-24 shrink-0"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				onClick={onRemove}
				aria-label={_(t`Remove option ${position}`)}
			>
				<Icon name="x" className="size-4" />
			</Button>
		</div>
	)
}

/**
 * Creates a modifier group and its options without leaving the dish or option
 * form. The group is saved at once (it is reusable on other dishes), so the
 * sheet is its own small save: it never submits, cleans or resets the form it
 * was opened from. Render it outside that form's `<Form>`.
 */
export function QuickModifierGroupSheet({
	orgSlug,
	open,
	onOpenChange,
	onCreated,
}: {
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onCreated: (group: QuickCreatedModifierGroup) => void
}) {
	const { _ } = useLingui()
	const fieldId = useId()
	const rowSeq = useRef(0)
	const newRow = (): OptionRow => ({
		key: `row-${++rowSeq.current}`,
		displayName: '',
		price: '',
	})
	// One id per group being typed: a retry or double click reuses it.
	const requestId = useRef(newRequestId())
	const [name, setName] = useState('')
	const [selectionType, setSelectionType] =
		useState<ModifierSelectionType>('single')
	const [minSelections, setMinSelections] = useState(0)
	const [maxSelections, setMaxSelections] = useState('')
	const [rows, setRows] = useState<OptionRow[]>(() => [newRow(), newRow()])
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	const reset = () => {
		requestId.current = newRequestId()
		setName('')
		setSelectionType('single')
		setMinSelections(0)
		setMaxSelections('')
		setRows([newRow(), newRow()])
		setError(null)
	}

	const handleDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over || active.id === over.id) return
		setRows((current) => {
			const from = current.findIndex((row) => row.key === active.id)
			const to = current.findIndex((row) => row.key === over.id)
			return from >= 0 && to >= 0 ? arrayMove(current, from, to) : current
		})
	}

	const isSingle = selectionType === 'single'

	const save = async () => {
		if (saving) return
		const trimmedName = name.trim()
		if (!trimmedName) {
			setError(_(t`Give the group a name.`))
			return
		}
		const filled = rows.filter(
			(row) => row.displayName.trim() !== '' || row.price.trim() !== '',
		)
		if (filled.some((row) => row.displayName.trim() === '')) {
			setError(_(t`Give every option a name, or remove the empty row.`))
			return
		}
		const max =
			isSingle || maxSelections.trim() === '' ? null : Number(maxSelections)
		if (max !== null && (!Number.isInteger(max) || max < 1)) {
			setError(_(t`Maximum selections must be a whole number of 1 or more.`))
			return
		}
		const min = isSingle ? Math.min(minSelections, 1) : minSelections
		if (max !== null && min > max) {
			setError(_(t`Minimum selections cannot be more than the maximum.`))
			return
		}
		const payload: QuickModifierGroupInput = {
			clientId: requestId.current,
			name: trimmedName,
			selectionType,
			minSelections: min,
			maxSelections: max,
			options: filled.map((row) => ({
				displayName: row.displayName.trim(),
				price: Number(row.price) || 0,
			})),
		}

		setSaving(true)
		setError(null)
		try {
			const response = await fetch(`/${orgSlug}/menu/modifiers/quick-create`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			})
			const body = (await response.json().catch(() => null)) as
				| (Partial<QuickModifierGroupResult> & {
						error?: Record<string, string[] | undefined>
				  })
				| null
			if (!response.ok || !body?.group) {
				const messages = Object.values(body?.error ?? {})
					.flat()
					.filter((message): message is string => Boolean(message))
				setError(
					messages.length > 0
						? messages.join(' ')
						: response.status === 403
							? _(t`You do not have permission to create modifier groups.`)
							: response.status === 429
								? _(t`Too many menu changes. Try again shortly.`)
								: _(t`Could not create the group. Try again.`),
				)
				return
			}
			onCreated(body.group)
			reset()
			onOpenChange(false)
		} catch {
			// The same request id is kept, so trying again makes one group.
			setError(
				_(t`Could not create the group. Check your connection and try again.`),
			)
		} finally {
			setSaving(false)
		}
	}

	return (
		<Sheet open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
			>
				<form
					noValidate
					className="flex min-h-0 flex-1 flex-col"
					onSubmit={(event) => {
						// Never the dish or option form behind the sheet.
						event.preventDefault()
						event.stopPropagation()
						void save()
					}}
				>
					<SheetHeader className="border-b px-6 py-4">
						<SheetTitle className="text-base font-semibold">
							<Trans>Create new group</Trans>
						</SheetTitle>
						<SheetDescription className="text-muted-foreground text-xs">
							<Trans>
								This group is saved now and can be reused on other dishes.
							</Trans>
						</SheetDescription>
					</SheetHeader>

					<div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
						{error ? (
							<p
								role="alert"
								className="border-destructive text-destructive rounded-md border p-3 text-sm"
							>
								{error}
							</p>
						) : null}

						<div className="space-y-1.5">
							<Label htmlFor={`${fieldId}-name`}>
								<Trans>Group name</Trans>
							</Label>
							<Input
								id={`${fieldId}-name`}
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder={_(t`e.g. Choice of Protein, Sides`)}
								maxLength={200}
								autoFocus
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Add other languages later on the group's page with Translate.
								</Trans>
							</p>
						</div>

						<ModifierSelectionModeField
							idPrefix={`${fieldId}-st`}
							value={selectionType}
							onChange={setSelectionType}
						/>

						{isSingle ? (
							<div className="flex items-center justify-between gap-4">
								<ModifierRequiredSelectionField
									id={`${fieldId}-required`}
									required={minSelections > 0}
									onChange={(required) => setMinSelections(required ? 1 : 0)}
								/>
							</div>
						) : (
							<ModifierSelectionLimitsFields
								idPrefix={`${fieldId}-limits`}
								minSelections={minSelections}
								maxSelections={maxSelections}
								onMinChange={setMinSelections}
								onMaxChange={setMaxSelections}
							/>
						)}

						<div className="space-y-2">
							<div>
								<p className="text-sm font-medium">
									<Trans>Options</Trans>
								</p>
								<p className="text-muted-foreground text-xs">
									{selectionType === 'pizza' ? (
										<Trans>
											Name and whole-pizza price. Each half costs half of it.
										</Trans>
									) : (
										<Trans>Name and extra price. Drag to reorder.</Trans>
									)}
								</p>
							</div>
							{rows.length > 0 ? (
								<div className="divide-border/60 divide-y overflow-hidden rounded-md border">
									<DndContext
										id={`${fieldId}-dnd`}
										sensors={sensors}
										onDragEnd={handleDragEnd}
									>
										<SortableContext
											items={rows.map((row) => row.key)}
											strategy={verticalListSortingStrategy}
										>
											{rows.map((row, index) => (
												<OptionRowFields
													key={row.key}
													row={row}
													index={index}
													onChange={(patch) =>
														setRows((current) =>
															current.map((entry) =>
																entry.key === row.key
																	? { ...entry, ...patch }
																	: entry,
															),
														)
													}
													onRemove={() =>
														setRows((current) =>
															current.filter((entry) => entry.key !== row.key),
														)
													}
												/>
											))}
										</SortableContext>
									</DndContext>
								</div>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="w-full"
								onClick={() => setRows((current) => [...current, newRow()])}
								disabled={rows.length >= 200}
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add option</Trans>
							</Button>
						</div>
					</div>

					<SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={saving}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={saving}>
							{saving ? <Trans>Creating…</Trans> : <Trans>Create group</Trans>}
						</Button>
					</SheetFooter>
				</form>
			</SheetContent>
		</Sheet>
	)
}
