import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trans } from '@lingui/macro'
import { type PublicFormField } from '@repo/common/public-form'
import { pickLocalized } from '@repo/common/site-locales'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon, type IconName } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Switch } from '@repo/ui/switch'
import {
	useContext,
	useEffect,
	useId,
	useState,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
} from 'react'
import {
	LocaleContext,
	LocalizedInput,
	LocalizedTextarea,
	LocaleSwitcher,
} from '#app/components/website/locale-fields.tsx'
import { TranslateItemsButton } from '#app/components/website/translate-provider.tsx'
import {
	ADDABLE_FIELD_TYPES,
	createField,
	FIELD_TYPES,
	type FieldType,
} from '#app/utils/website/field-types.ts'
import {
	applyFormTranslations,
	collectFieldTranslationFields,
	collectFormTranslationFields,
} from '#app/utils/website/form-translation.ts'

type WebsiteForm = {
	id: string
	name: string
	description: string | null
	fields: PublicFormField[]
	status: 'draft' | 'published'
	submitLabel: string
	successMessage: string
}

function fieldPreviewText(
	field: PublicFormField,
	activeLocale: string,
	defaultLocale: string,
) {
	const label = pickLocalized(field.label, activeLocale, defaultLocale)
	if (field.type === 'single_choice' || field.type === 'multiple_choice') {
		const count = field.options?.length ?? 0
		if (count > 0) {
			return `${count} choice${count === 1 ? '' : 's'}`
		}
	}
	return label || FIELD_TYPES[field.type].label
}

function AddFieldDialog({
	position,
	onAdd,
	trigger = 'button',
}: {
	position: number
	onAdd: (type: FieldType, position: number) => void
	trigger?: 'button' | 'insert' | 'footer'
}) {
	const [open, setOpen] = useState(false)
	const [selected, setSelected] = useState<FieldType>(
		ADDABLE_FIELD_TYPES[0]?.type ?? 'name',
	)

	const confirmAdd = (type: FieldType = selected) => {
		onAdd(type, position)
		setOpen(false)
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next)
				if (next) setSelected(ADDABLE_FIELD_TYPES[0]?.type ?? 'name')
			}}
		>
			{trigger === 'insert' ? (
				<button
					type="button"
					className="group/insert relative -my-0.5 flex h-3.5 w-full items-center justify-center"
					onClick={() => setOpen(true)}
					aria-label="Insert field here"
				>
					<span className="bg-border absolute inset-x-3 h-px origin-center scale-x-0 opacity-0 transition duration-150 ease-out group-hover/insert:scale-x-100 group-hover/insert:opacity-100 group-focus-visible/insert:scale-x-100 group-focus-visible/insert:opacity-100" />
					<span className="border-border bg-background text-muted-foreground relative z-10 flex size-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition duration-150 ease-out group-hover/insert:opacity-100 group-focus-visible/insert:opacity-100">
						<Icon name="plus" className="size-3" />
					</span>
				</button>
			) : (
				<Button
					variant="outline"
					size="sm"
					className={cn(
						trigger === 'footer' && 'w-full justify-center',
						trigger === 'button' && 'border-dashed',
					)}
					onClick={() => setOpen(true)}
				>
					<Icon name="plus" className="size-3.5" />
					<Trans>Add field</Trans>
				</Button>
			)}
			<DialogContent className="gap-5 sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add field</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Pick a field to add to your form.</Trans>
					</DialogDescription>
				</DialogHeader>
				<div
					role="listbox"
					aria-label="Field types"
					className="grid grid-cols-2 gap-2 sm:grid-cols-4"
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							confirmAdd()
						}
					}}
				>
					{ADDABLE_FIELD_TYPES.map((option) => {
						const isSelected = selected === option.type
						return (
							<button
								key={option.type}
								type="button"
								role="option"
								aria-selected={isSelected}
								onClick={() => setSelected(option.type)}
								onDoubleClick={() => confirmAdd(option.type)}
								className={cn(
									'group/tile border-border hover:bg-muted/50 focus-visible:ring-ring flex flex-col items-start gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color] duration-150 outline-none focus-visible:ring-2',
									isSelected
										? 'border-foreground/30 bg-muted'
										: 'bg-background',
								)}
							>
								<span
									className={cn(
										'flex size-9 items-center justify-center rounded-lg transition-colors',
										isSelected
											? 'bg-foreground text-background'
											: 'bg-muted text-muted-foreground group-hover/tile:text-foreground',
									)}
								>
									<Icon name={option.icon} className="size-4" />
								</span>
								<span className="min-w-0 space-y-1">
									<span className="block text-sm font-medium tracking-tight">
										{option.label}
									</span>
									<span className="text-muted-foreground line-clamp-2 text-xs leading-snug">
										{option.description}
									</span>
								</span>
							</button>
						)
					})}
				</div>
				<DialogFooter className="gap-2 sm:items-center sm:justify-between">
					<p className="text-muted-foreground hidden text-xs sm:block">
						<Trans>Double-click a field to add it instantly</Trans>
					</p>
					<div className="flex gap-2">
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
						<Button onClick={() => confirmAdd()}>
							<Icon name="plus" className="size-4" />
							<span>
								<Trans>Add</Trans> {FIELD_TYPES[selected].label}
							</span>
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function FieldPreviewCard({
	field,
	isSelected,
	onSelect,
	onRemove,
	dragHandle,
	isDragging = false,
}: {
	field: PublicFormField
	isSelected: boolean
	onSelect: () => void
	onRemove: () => void
	dragHandle?: ReactNode
	isDragging?: boolean
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const fieldDef = FIELD_TYPES[field.type]
	const preview = fieldPreviewText(field, activeLocale, defaultLocale)

	return (
		<div
			className={cn(
				'group relative cursor-pointer rounded-lg px-2 py-2 transition-colors duration-150',
				isSelected ? 'bg-muted' : 'hover:bg-muted/60 focus-within:bg-muted/60',
			)}
			onClick={onSelect}
			role="button"
			tabIndex={0}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault()
					onSelect()
				}
			}}
		>
			<div className="flex items-start gap-2">
				<span className="border-border/70 bg-background text-muted-foreground relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border">
					{dragHandle}
					<Icon
						name={fieldDef.icon as IconName}
						className={cn(
							'size-3.5 transition-opacity duration-150',
							'group-hover:opacity-0 peer-focus-visible:opacity-0',
							isDragging && 'opacity-0',
						)}
					/>
				</span>
				<div className="min-w-0 flex-1 pr-8">
					<div className="truncate text-sm font-medium">{fieldDef.label}</div>
					{preview ? (
						<p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
							{preview}
						</p>
					) : null}
				</div>
			</div>
			<div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
				<Button
					variant="ghost"
					size="icon-xs"
					className="text-destructive hover:text-destructive"
					aria-label="Remove field"
					onClick={(event) => {
						event.stopPropagation()
						onRemove()
					}}
				>
					<Icon name="trash-2" className="size-3.5" />
				</Button>
			</div>
		</div>
	)
}

function SortableFieldCard({
	field,
	isSelected,
	onSelect,
	onRemove,
}: {
	field: PublicFormField
	isSelected: boolean
	onSelect: () => void
	onRemove: () => void
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: field.id })

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn(isDragging && 'z-10 opacity-80')}
		>
			<FieldPreviewCard
				field={field}
				isSelected={isSelected}
				onSelect={onSelect}
				onRemove={onRemove}
				isDragging={isDragging}
				dragHandle={
					<button
						type="button"
						ref={setActivatorNodeRef}
						className={cn(
							'text-muted-foreground hover:text-foreground peer pointer-events-none absolute inset-0 z-10 flex cursor-grab items-center justify-center rounded-md opacity-0 transition-opacity duration-150 active:cursor-grabbing',
							'group-hover:pointer-events-auto group-hover:opacity-100',
							'focus-visible:pointer-events-auto focus-visible:opacity-100',
							isDragging && 'pointer-events-auto opacity-100',
						)}
						aria-label="Drag to reorder"
						{...attributes}
						{...listeners}
					>
						<Icon name="grip-vertical" className="size-3.5" />
					</button>
				}
			/>
		</div>
	)
}

function FieldsList({
	fields,
	selectedFieldId,
	onSelect,
	onRemove,
	onReorder,
	onAdd,
}: {
	fields: PublicFormField[]
	selectedFieldId: string | null
	onSelect: (fieldId: string) => void
	onRemove: (fieldId: string) => void
	onReorder: (orderedIds: string[]) => void
	onAdd: (type: FieldType, position: number) => void
}) {
	const dndId = useId()
	const [items, setItems] = useState(fields)
	const [isDragging, setIsDragging] = useState(false)

	useEffect(() => {
		setItems(fields)
	}, [fields])

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	)

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		setIsDragging(false)
		if (!over || active.id === over.id) return

		const oldIndex = items.findIndex((field) => field.id === active.id)
		const newIndex = items.findIndex((field) => field.id === over.id)
		if (oldIndex < 0 || newIndex < 0) return

		const next = arrayMove(items, oldIndex, newIndex)
		setItems(next)
		onReorder(next.map((field) => field.id))
	}

	return (
		<div className="mt-2 px-2 pb-2">
			<DndContext
				id={dndId}
				sensors={sensors}
				collisionDetection={closestCenter}
				modifiers={[restrictToVerticalAxis]}
				onDragStart={() => setIsDragging(true)}
				onDragCancel={() => setIsDragging(false)}
				onDragEnd={handleDragEnd}
			>
				<SortableContext
					items={items.map((field) => field.id)}
					strategy={verticalListSortingStrategy}
				>
					{items.map((field, index) => (
						<div key={field.id}>
							{index === 0 ? (
								<div
									className={cn(isDragging && 'pointer-events-none')}
									aria-hidden={isDragging || undefined}
								>
									<AddFieldDialog position={0} onAdd={onAdd} trigger="insert" />
								</div>
							) : null}
							<SortableFieldCard
								field={field}
								isSelected={selectedFieldId === field.id}
								onSelect={() => onSelect(field.id)}
								onRemove={() => onRemove(field.id)}
							/>
							<div
								className={cn(isDragging && 'pointer-events-none')}
								aria-hidden={isDragging || undefined}
							>
								<AddFieldDialog
									position={index + 1}
									onAdd={onAdd}
									trigger="insert"
								/>
							</div>
						</div>
					))}
				</SortableContext>
			</DndContext>
		</div>
	)
}

function FieldEditorPanel({
	field,
	onBack,
	onUpdate,
	onRemove,
	canRemove,
}: {
	field: PublicFormField
	onBack: () => void
	onUpdate: (patch: Partial<PublicFormField>) => void
	onRemove: () => void
	canRemove: boolean
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const fieldDef = FIELD_TYPES[field.type]
	const translateItems = collectFieldTranslationFields(
		field,
		defaultLocale,
		activeLocale,
	)

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={onBack}
					aria-label="Back to fields"
				>
					<Icon name="chevron-left" className="size-4" />
				</Button>
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name={fieldDef.icon} className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{fieldDef.label}
				</span>
				<TranslateItemsButton
					items={translateItems}
					onApply={(translations) => {
						const next = applyFormTranslations(
							{
								name: '',
								description: null,
								submitLabel: '',
								successMessage: '',
								fields: [field],
							},
							translations,
							activeLocale,
							defaultLocale,
						)
						const updated = next.fields[0]
						if (updated) onUpdate(updated)
					}}
				/>
				<LocaleSwitcher />
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-4 p-4">
					<div className="flex items-center justify-between">
						<p className="text-sm font-medium">
							<Trans>Field settings</Trans>
						</p>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							disabled={!canRemove}
							onClick={onRemove}
							aria-label="Remove field"
						>
							<Icon name="trash-2" className="size-4" />
						</Button>
					</div>
					<div className="space-y-2">
						<Label htmlFor="field-label">
							<Trans>Label</Trans>
						</Label>
						<LocalizedInput
							id="field-label"
							value={field.label}
							onChange={(label) => onUpdate({ label })}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="field-type">
							<Trans>Type</Trans>
						</Label>
						<select
							id="field-type"
							value={field.type}
							onChange={(event) =>
								onUpdate({
									type: event.target.value as FieldType,
									...(['single_choice', 'multiple_choice'].includes(
										event.target.value,
									) && !field.options?.length
										? { options: ['Option 1', 'Option 2'] }
										: {}),
								})
							}
							className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
						>
							{ADDABLE_FIELD_TYPES.map((option) => (
								<option key={option.type} value={option.type}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					{field.type === 'single_choice' ||
					field.type === 'multiple_choice' ? (
						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<Label>
									<Trans>Choices</Trans>
								</Label>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() =>
										onUpdate({
											options: [
												...(field.options ?? []),
												`Option ${(field.options?.length ?? 0) + 1}`,
											],
										})
									}
								>
									<Icon name="plus" className="size-3.5" />
									<Trans>Add choice</Trans>
								</Button>
							</div>
							{(field.options ?? []).map((choice, choiceIndex) => (
								<div key={choiceIndex} className="flex gap-2">
									<LocalizedInput
										value={choice}
										onChange={(value) =>
											onUpdate({
												options: (field.options ?? []).map((option, index) =>
													index === choiceIndex ? value : option,
												),
											})
										}
									/>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										disabled={(field.options?.length ?? 0) <= 1}
										onClick={() =>
											onUpdate({
												options: (field.options ?? []).filter(
													(_, index) => index !== choiceIndex,
												),
											})
										}
										aria-label="Remove choice"
									>
										<Icon name="x" className="size-4" />
									</Button>
								</div>
							))}
						</div>
					) : null}
					{field.type !== 'heading' && field.type !== 'paragraph' ? (
						<div className="flex items-center justify-between">
							<Label htmlFor="field-required">
								<Trans>Required</Trans>
							</Label>
							<Switch
								id="field-required"
								checked={field.required}
								onCheckedChange={(required) => onUpdate({ required })}
							/>
						</div>
					) : null}
				</div>
			</ScrollArea>
		</div>
	)
}

function FormSettingsPanel({
	form,
	onBack,
	onChange,
}: {
	form: WebsiteForm
	onBack: () => void
	onChange: Dispatch<SetStateAction<WebsiteForm>>
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const translateItems = collectFormTranslationFields(
		form,
		defaultLocale,
		activeLocale,
	)

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={onBack}
					aria-label="Back to fields"
				>
					<Icon name="chevron-left" className="size-4" />
				</Button>
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name="cog" className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					<Trans>Form settings</Trans>
				</span>
				<TranslateItemsButton
					items={translateItems}
					onApply={(translations) => {
						onChange((current) => ({
							...current,
							...applyFormTranslations(
								current,
								translations,
								activeLocale,
								defaultLocale,
							),
						}))
					}}
				/>
				<LocaleSwitcher />
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-4 p-4">
					<div className="space-y-2">
						<Label htmlFor="form-name">
							<Trans>Name</Trans>
						</Label>
						<LocalizedInput
							id="form-name"
							value={form.name}
							onChange={(name) => onChange((current) => ({ ...current, name }))}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="form-description">
							<Trans>Description</Trans>
						</Label>
						<LocalizedTextarea
							id="form-description"
							value={form.description ?? ''}
							onChange={(description) =>
								onChange((current) => ({ ...current, description }))
							}
							rows={3}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="submit-label">
							<Trans>Button label</Trans>
						</Label>
						<LocalizedInput
							id="submit-label"
							value={form.submitLabel}
							onChange={(submitLabel) =>
								onChange((current) => ({ ...current, submitLabel }))
							}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="success-message">
							<Trans>Success message</Trans>
						</Label>
						<LocalizedTextarea
							id="success-message"
							value={form.successMessage}
							onChange={(successMessage) =>
								onChange((current) => ({ ...current, successMessage }))
							}
							rows={3}
						/>
					</div>
					<div className="flex items-center justify-between">
						<Label htmlFor="published">
							<Trans>Published</Trans>
						</Label>
						<Switch
							id="published"
							checked={form.status === 'published'}
							onCheckedChange={(published) =>
								onChange((current) => ({
									...current,
									status: published ? 'published' : 'draft',
								}))
							}
						/>
					</div>
				</div>
			</ScrollArea>
		</div>
	)
}

export function FormBuilderSidebar({
	form,
	setForm,
	selectedId,
	setSelectedId,
	className,
}: {
	form: WebsiteForm
	setForm: Dispatch<SetStateAction<WebsiteForm>>
	selectedId: string | null
	setSelectedId: (id: string | null) => void
	className?: string
}) {
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const [showSettings, setShowSettings] = useState(false)
	const selected = form.fields.find((field) => field.id === selectedId) ?? null
	const translateItems = collectFormTranslationFields(
		form,
		defaultLocale,
		activeLocale,
	)

	const addField = (type: FieldType, position: number) => {
		const field = createField(type, FIELD_TYPES[type].defaultLabel, form.fields)
		setForm((current) => {
			const fields = [...current.fields]
			fields.splice(position, 0, field)
			return { ...current, fields }
		})
		setSelectedId(field.id)
		setShowSettings(false)
	}

	const removeField = (fieldId: string) => {
		setForm((current) => ({
			...current,
			fields: current.fields.filter((field) => field.id !== fieldId),
		}))
		if (selectedId === fieldId) {
			setSelectedId(
				form.fields.find((field) => field.id !== fieldId)?.id ?? null,
			)
		}
	}

	const reorderFields = (orderedIds: string[]) => {
		setForm((current) => ({
			...current,
			fields: orderedIds.map((id) =>
				current.fields.find((field) => field.id === id)!,
			),
		}))
	}

	return (
		<aside
			className={cn(
				'border-border bg-background flex h-full min-w-0 rounded-xl',
				className,
			)}
		>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{showSettings ? (
					<FormSettingsPanel
						form={form}
						onBack={() => setShowSettings(false)}
						onChange={setForm}
					/>
				) : selected ? (
					<FieldEditorPanel
						field={selected}
						onBack={() => setSelectedId(null)}
						onUpdate={(patch) =>
							setForm((current) => ({
								...current,
								fields: current.fields.map((field) =>
									field.id === selected.id ? { ...field, ...patch } : field,
								),
							}))
						}
						onRemove={() => removeField(selected.id)}
						canRemove={form.fields.length > 1}
					/>
				) : (
					<>
						<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
							<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
								<Icon name="blocks" className="size-3.5" />
							</span>
							<span className="min-w-0 truncate text-sm font-medium">
								<Trans>Fields</Trans>
							</span>
							<span className="text-muted-foreground text-xs tabular-nums">
								{form.fields.length}
							</span>
							<div className="flex-1" />
							<TranslateItemsButton
								items={translateItems}
								onApply={(translations) => {
									setForm((current) => ({
										...current,
										...applyFormTranslations(
											current,
											translations,
											activeLocale,
											defaultLocale,
										),
									}))
								}}
							/>
							<LocaleSwitcher />
							<Button
								variant="ghost"
								size="icon-xs"
								onClick={() => setShowSettings(true)}
								aria-label="Form settings"
							>
								<Icon name="cog" className="size-4" />
							</Button>
						</div>
						<ScrollArea className="min-h-0 flex-1">
							{form.fields.length === 0 ? (
								<div className="flex flex-col items-center justify-center px-4 py-10 text-center">
									<div className="bg-muted text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-lg">
										<Icon name="blocks" className="size-5" />
									</div>
									<p className="text-sm font-medium">
										<Trans>No fields yet</Trans>
									</p>
									<p className="text-muted-foreground mt-1 mb-4 max-w-[16rem] text-xs leading-relaxed">
										<Trans>
											Add name, email, choices, and more to start collecting
											responses.
										</Trans>
									</p>
									<AddFieldDialog position={0} onAdd={addField} />
								</div>
							) : (
								<FieldsList
									fields={form.fields}
									selectedFieldId={selectedId}
									onSelect={(fieldId) => {
										setShowSettings(false)
										setSelectedId(fieldId)
									}}
									onRemove={removeField}
									onReorder={reorderFields}
									onAdd={addField}
								/>
							)}
						</ScrollArea>
					</>
				)}
			</div>
		</aside>
	)
}
