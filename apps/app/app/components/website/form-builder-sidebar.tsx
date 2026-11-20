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
import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type FormNotify } from '@repo/common/form-alerts'
import {
	clearBrokenConditions,
	type PublicFormField,
} from '@repo/common/public-form'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Switch } from '@repo/ui/switch'
import {
	useContext,
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
	createField,
	DEFAULT_CHOICE_OPTIONS,
	nextChoiceOption,
	useFieldTypes,
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
	/** Restricted form (#357). */
	restricted: boolean
	/** Who hears about a new response (#142); null means every member. */
	notify: FormNotify | null
}

/** An active location the Location field can offer (#239). */
export type FormLocationOption = { id: string; name: string }

/** A member who can be chosen to hear about responses (#142). */
export type FormMemberOption = { id: string; label: string }

/** What the form settings need to know about the signed-in member (#357). */
export type FormSettingsContext = {
	members: FormMemberOption[]
	/** Holds `read:form_restricted:any`: may lift the restriction again. */
	canUnrestrict: boolean
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
	const { _ } = useLingui()
	const { FIELD_TYPES, ADDABLE_FIELD_TYPES } = useFieldTypes()
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
					aria-label={_(msg`Insert field here`)}
				>
					<span className="bg-border absolute inset-x-3 h-px origin-center scale-x-0 opacity-0 transition duration-160 ease-out group-hover/insert:scale-x-100 group-hover/insert:opacity-100 group-focus-visible/insert:scale-x-100 group-focus-visible/insert:opacity-100" />
					<span className="border-border bg-background text-muted-foreground relative z-10 flex size-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition duration-160 ease-out group-hover/insert:opacity-100 group-focus-visible/insert:opacity-100">
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
					aria-label={_(msg`Field types`)}
					className="grid grid-cols-2 gap-2 sm:grid-cols-4"
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
								onFocus={() => setSelected(option.type)}
								onDoubleClick={() => confirmAdd(option.type)}
								className={cn(
									'group/tile border-border hover:bg-muted/50 focus-visible:ring-ring flex flex-col items-start gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color] duration-160 outline-none focus-visible:ring-2',
									isSelected
										? 'border-primary/40 bg-primary/5'
										: 'bg-background',
								)}
							>
								<span
									className={cn(
										'flex size-9 items-center justify-center rounded-lg transition-colors',
										isSelected
											? 'bg-primary text-primary-foreground'
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
	const { _ } = useLingui()
	const { FIELD_TYPES } = useFieldTypes()
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const fieldDef = FIELD_TYPES[field.type]
	const choiceCount = field.options?.length ?? 0
	const preview =
		(field.type === 'single_choice' || field.type === 'multiple_choice') &&
		choiceCount > 0
			? _(plural(choiceCount, { one: '# choice', other: '# choices' }))
			: pickLocalized(field.label, activeLocale, defaultLocale) ||
				fieldDef.label

	return (
		<div
			className={cn(
				'group relative cursor-pointer rounded-lg px-2 py-2 transition-colors duration-160',
				isSelected ? 'bg-muted' : 'hover:bg-muted/60 focus-within:bg-muted/60',
			)}
			onClick={onSelect}
			role="button"
			tabIndex={0}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return
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
							'size-3.5 transition-opacity duration-160',
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
			<div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-160 group-focus-within:opacity-100 group-hover:opacity-100">
				<Button
					variant="ghost"
					size="icon-xs"
					className="text-destructive hover:text-destructive"
					aria-label={_(msg`Remove field`)}
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
	const { _ } = useLingui()
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
							'text-muted-foreground hover:text-foreground peer pointer-events-none absolute inset-0 z-10 flex cursor-grab items-center justify-center rounded-md opacity-0 transition-opacity duration-160 active:cursor-grabbing',
							'group-hover:pointer-events-auto group-hover:opacity-100',
							'focus-visible:pointer-events-auto focus-visible:opacity-100',
							isDragging && 'pointer-events-auto opacity-100',
						)}
						aria-label={_(msg`Drag to reorder`)}
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
	const [isDragging, setIsDragging] = useState(false)

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	)

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		setIsDragging(false)
		if (!over || active.id === over.id) return

		const oldIndex = fields.findIndex((field) => field.id === active.id)
		const newIndex = fields.findIndex((field) => field.id === over.id)
		if (oldIndex < 0 || newIndex < 0) return

		onReorder(arrayMove(fields, oldIndex, newIndex).map((field) => field.id))
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
					items={fields.map((field) => field.id)}
					strategy={verticalListSortingStrategy}
				>
					{fields.map((field, index) => (
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
	fieldsAbove,
	locations,
	onBack,
	onUpdate,
	onRemove,
	canRemove,
}: {
	field: PublicFormField
	/** The fields placed above this one: the only ones a condition may point at. */
	fieldsAbove: PublicFormField[]
	locations: FormLocationOption[]
	onBack: () => void
	onUpdate: (patch: Partial<PublicFormField>) => void
	onRemove: () => void
	canRemove: boolean
}) {
	const { _ } = useLingui()
	const { FIELD_TYPES, ADDABLE_FIELD_TYPES } = useFieldTypes()
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
					aria-label={_(msg`Back to fields`)}
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
							aria-label={_(msg`Remove field`)}
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
										? { options: [...DEFAULT_CHOICE_OPTIONS] }
										: {}),
								})
							}
							className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
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
												nextChoiceOption(field.options?.length ?? 0),
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
										aria-label={_(msg`Remove choice`)}
									>
										<Icon name="x" className="size-4" />
									</Button>
								</div>
							))}
						</div>
					) : null}
					{field.type === 'text' ? (
						<NumberOption field={field} onUpdate={onUpdate} />
					) : null}
					{field.type === 'location' ? (
						<LocationOption
							field={field}
							locations={locations}
							onUpdate={onUpdate}
						/>
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
					<ConditionOption
						field={field}
						fieldsAbove={fieldsAbove}
						onUpdate={onUpdate}
					/>
				</div>
			</ScrollArea>
		</div>
	)
}

/** Accept a number on a text field, within an optional range (#239). */
function NumberOption({
	field,
	onUpdate,
}: {
	field: PublicFormField
	onUpdate: (patch: Partial<PublicFormField>) => void
}) {
	const numberId = useId()
	const toNumber = (value: string) =>
		value.trim() === '' || !Number.isFinite(Number(value))
			? undefined
			: Number(value)
	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<Label htmlFor={`${numberId}-numeric`}>
					<Trans>Only accept a number</Trans>
				</Label>
				<Switch
					id={`${numberId}-numeric`}
					checked={Boolean(field.numeric)}
					onCheckedChange={(numeric) =>
						onUpdate(
							numeric
								? { numeric: true }
								: { numeric: undefined, min: undefined, max: undefined },
						)
					}
				/>
			</div>
			{field.numeric ? (
				<div className="grid grid-cols-2 gap-2">
					<div className="space-y-1">
						<Label htmlFor={`${numberId}-min`}>
							<Trans>Smallest</Trans>
						</Label>
						<Input
							id={`${numberId}-min`}
							type="number"
							inputMode="decimal"
							value={field.min ?? ''}
							onChange={(event) =>
								onUpdate({ min: toNumber(event.target.value) })
							}
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor={`${numberId}-max`}>
							<Trans>Largest</Trans>
						</Label>
						<Input
							id={`${numberId}-max`}
							type="number"
							inputMode="decimal"
							value={field.max ?? ''}
							onChange={(event) =>
								onUpdate({ max: toNumber(event.target.value) })
							}
						/>
					</div>
				</div>
			) : null}
		</div>
	)
}

/**
 * Which locations a Location field offers (#239). Nothing ticked offers every
 * active location; a deactivated location is never offered on the site.
 */
function LocationOption({
	field,
	locations,
	onUpdate,
}: {
	field: PublicFormField
	locations: FormLocationOption[]
	onUpdate: (patch: Partial<PublicFormField>) => void
}) {
	const { _ } = useLingui()
	const chosen = new Set(field.locationIds ?? [])
	if (locations.length === 0) {
		return (
			<p className="text-muted-foreground text-xs leading-relaxed">
				<Trans>
					You have no active locations, so this field is hidden on your site.
				</Trans>
			</p>
		)
	}
	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium">
				<Trans>Locations guests can pick</Trans>
			</legend>
			<p className="text-muted-foreground text-xs leading-relaxed">
				<Trans>
					Leave all unticked to offer every active location. With one location,
					guests are not asked.
				</Trans>
			</p>
			{locations.map((location) => {
				const locationName = location.name
				return (
					<label key={location.id} className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="accent-primary size-4"
							checked={chosen.has(location.id)}
							aria-label={_(msg`Offer ${locationName}`)}
							onChange={(event) => {
								const next = new Set(chosen)
								if (event.target.checked) next.add(location.id)
								else next.delete(location.id)
								onUpdate({
									locationIds: next.size > 0 ? [...next] : undefined,
								})
							}}
						/>
						{locationName}
					</label>
				)
			})}
		</fieldset>
	)
}

/**
 * Show this field only for chosen answers of a single-choice field above it
 * (#357). Chains are allowed; the picker lists only fields placed above, so a
 * loop cannot be made.
 */
function ConditionOption({
	field,
	fieldsAbove,
	onUpdate,
}: {
	field: PublicFormField
	fieldsAbove: PublicFormField[]
	onUpdate: (patch: Partial<PublicFormField>) => void
}) {
	const { _ } = useLingui()
	const conditionId = useId()
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const sources = fieldsAbove.filter(
		(candidate) =>
			candidate.type === 'single_choice' &&
			(candidate.options?.length ?? 0) > 0,
	)
	const condition = field.showWhen
	const source = condition
		? sources.find((candidate) => candidate.id === condition.fieldId)
		: undefined
	const label = (value: string) =>
		pickLocalized(value, activeLocale, defaultLocale) || value
	return (
		<div className="border-border space-y-3 border-t pt-4">
			<div className="flex items-center justify-between">
				<Label htmlFor={`${conditionId}-on`}>
					<Trans>Show conditionally</Trans>
				</Label>
				<Switch
					id={`${conditionId}-on`}
					checked={Boolean(condition)}
					disabled={!condition && sources.length === 0}
					onCheckedChange={(on) => {
						if (!on) return onUpdate({ showWhen: undefined })
						const first = sources[0]
						if (!first) return
						onUpdate({
							showWhen: { fieldId: first.id, values: [first.options![0]!] },
						})
					}}
				/>
			</div>
			{!condition && sources.length === 0 ? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					<Trans>
						Place a single-choice field above this one to show it only for
						certain answers.
					</Trans>
				</p>
			) : null}
			{condition ? (
				<div className="space-y-2">
					<Label htmlFor={`${conditionId}-source`}>
						<Trans>Show when this field is answered</Trans>
					</Label>
					<select
						id={`${conditionId}-source`}
						value={condition.fieldId}
						onChange={(event) => {
							const next = sources.find(
								(candidate) => candidate.id === event.target.value,
							)
							if (next) {
								onUpdate({
									showWhen: { fieldId: next.id, values: [next.options![0]!] },
								})
							}
						}}
						className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
					>
						{sources.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{label(candidate.label)}
							</option>
						))}
					</select>
					<fieldset className="space-y-2">
						<legend className="text-muted-foreground text-xs">
							<Trans>With one of these answers</Trans>
						</legend>
						{(source?.options ?? []).map((option) => {
							const optionLabel = label(option)
							return (
								<label key={option} className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										className="accent-primary size-4"
										checked={condition.values.includes(option)}
										aria-label={_(msg`Answer ${optionLabel}`)}
										onChange={(event) => {
											const values = event.target.checked
												? [...condition.values, option]
												: condition.values.filter((value) => value !== option)
											if (values.length === 0) return
											onUpdate({
												showWhen: { fieldId: condition.fieldId, values },
											})
										}}
									/>
									{optionLabel}
								</label>
							)
						})}
					</fieldset>
					<p className="text-muted-foreground text-xs leading-relaxed">
						<Trans>
							A hidden field is never required and its answer is not stored.
						</Trans>
					</p>
				</div>
			) : null}
		</div>
	)
}

function FormSettingsPanel({
	form,
	settings,
	onBack,
	onChange,
}: {
	form: WebsiteForm
	settings: FormSettingsContext
	onBack: () => void
	onChange: Dispatch<SetStateAction<WebsiteForm>>
}) {
	const { _ } = useLingui()
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
					aria-label={_(msg`Back to fields`)}
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
					<RestrictedOption
						form={form}
						settings={settings}
						onChange={onChange}
					/>
					<NotifyOption form={form} settings={settings} onChange={onChange} />
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

/**
 * Restricted form (#357): only members with "Read restricted form responses"
 * can open or export its responses; others see the form exists and a count.
 * It applies to past responses too. Turning it off needs that permission.
 */
function RestrictedOption({
	form,
	settings,
	onChange,
}: {
	form: WebsiteForm
	settings: FormSettingsContext
	onChange: Dispatch<SetStateAction<WebsiteForm>>
}) {
	const restrictedId = useId()
	const restricted = Boolean(form.restricted)
	return (
		<div className="border-border space-y-1.5 border-t pt-4">
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor={restrictedId}>
					<Icon name="lock" className="me-1.5 inline size-3.5" />
					<Trans>Restricted form</Trans>
				</Label>
				<Switch
					id={restrictedId}
					checked={restricted}
					disabled={restricted && !settings.canUnrestrict}
					onCheckedChange={(next) =>
						onChange((current) => ({ ...current, restricted: next }))
					}
				/>
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				<Trans>
					Only members with the “Read restricted form responses” permission can
					open or export the responses, including ones already received. Others
					see that the form exists and how many responses it has.
				</Trans>
			</p>
			{restricted && !settings.canUnrestrict ? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					<Trans>
						Turning this off needs the “Read restricted form responses”
						permission.
					</Trans>
				</p>
			) : null}
		</div>
	)
}

/** Who is told about a new response (#142): everyone with website access, or chosen members. */
function NotifyOption({
	form,
	settings,
	onChange,
}: {
	form: WebsiteForm
	settings: FormSettingsContext
	onChange: Dispatch<SetStateAction<WebsiteForm>>
}) {
	const notifyId = useId()
	const notify: FormNotify = form.notify ?? { mode: 'all' }
	const chosen = new Set(notify.mode === 'members' ? notify.userIds : [])
	return (
		<fieldset className="border-border space-y-2 border-t pt-4">
			<legend className="text-sm font-medium">
				<Trans>Who is notified</Trans>
			</legend>
			<p className="text-muted-foreground text-xs leading-relaxed">
				<Trans>
					Members hear about each new response in the app and, if they choose,
					by email (at most one email every 10 minutes). The message names the
					form, never the answers.
				</Trans>
			</p>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="radio"
					name={`${notifyId}-mode`}
					className="accent-primary size-4"
					checked={notify.mode === 'all'}
					onChange={() =>
						onChange((current) => ({ ...current, notify: { mode: 'all' } }))
					}
				/>
				<Trans>Everyone with website access</Trans>
			</label>
			<label className="flex items-center gap-2 text-sm">
				<input
					type="radio"
					name={`${notifyId}-mode`}
					className="accent-primary size-4"
					checked={notify.mode === 'members'}
					onChange={() =>
						onChange((current) => ({
							...current,
							notify: { mode: 'members', userIds: [...chosen] },
						}))
					}
				/>
				<Trans>Chosen members</Trans>
			</label>
			{notify.mode === 'members' ? (
				<div className="space-y-1.5 ps-6">
					{settings.members.map((member) => (
						<label key={member.id} className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								className="accent-primary size-4"
								checked={chosen.has(member.id)}
								onChange={(event) => {
									const next = new Set(chosen)
									if (event.target.checked) next.add(member.id)
									else next.delete(member.id)
									onChange((current) => ({
										...current,
										notify: { mode: 'members', userIds: [...next] },
									}))
								}}
							/>
							<span className="wrap-anywhere">{member.label}</span>
						</label>
					))}
				</div>
			) : null}
		</fieldset>
	)
}

export function FormBuilderSidebar({
	form,
	setForm,
	selectedId,
	setSelectedId,
	locations = [],
	settings = { members: [], canUnrestrict: false },
	className,
}: {
	form: WebsiteForm
	setForm: Dispatch<SetStateAction<WebsiteForm>>
	selectedId: string | null
	setSelectedId: (id: string | null) => void
	locations?: FormLocationOption[]
	settings?: FormSettingsContext
	className?: string
}) {
	const { _ } = useLingui()
	const { FIELD_TYPES } = useFieldTypes()
	const { activeLocale, defaultLocale } = useContext(LocaleContext)
	const [showSettings, setShowSettings] = useState(false)
	// Fields whose condition was cleared by the last change (#357).
	const [clearedConditions, setClearedConditions] = useState<string[]>([])
	const selected = form.fields.find((field) => field.id === selectedId) ?? null
	const translateItems = collectFormTranslationFields(
		form,
		defaultLocale,
		activeLocale,
	)

	const addField = (type: FieldType, position: number) => {
		let createdId: string | undefined
		setForm((current) => {
			const field = createField(
				type,
				FIELD_TYPES[type].defaultLabel,
				current.fields,
			)
			createdId = field.id
			const fields = [...current.fields]
			fields.splice(position, 0, field)
			return { ...current, fields }
		})
		if (createdId) setSelectedId(createdId)
		setShowSettings(false)
	}

	/**
	 * Every change to the fields goes through here: a condition that no longer
	 * points at a single-choice field above its own is cleared, with a warning.
	 */
	const applyFields = (
		change: (fields: PublicFormField[]) => PublicFormField[],
	) => {
		const { fields, cleared } = clearBrokenConditions(change(form.fields))
		setClearedConditions(cleared)
		setForm((current) => ({ ...current, fields }))
	}

	const removeField = (fieldId: string) => {
		applyFields((fields) => fields.filter((field) => field.id !== fieldId))
		if (selectedId === fieldId) {
			setSelectedId(
				form.fields.find((field) => field.id !== fieldId)?.id ?? null,
			)
		}
	}

	const reorderFields = (orderedIds: string[]) => {
		applyFields((fields) => {
			const byId = new Map(fields.map((field) => [field.id, field]))
			const ordered = orderedIds
				.map((id) => byId.get(id))
				.filter((field): field is PublicFormField => Boolean(field))
			const listed = new Set(orderedIds)
			const missing = fields.filter((field) => !listed.has(field.id))
			return [...ordered, ...missing]
		})
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
						settings={settings}
						onBack={() => setShowSettings(false)}
						onChange={setForm}
					/>
				) : selected ? (
					<FieldEditorPanel
						field={selected}
						fieldsAbove={form.fields.slice(
							0,
							form.fields.findIndex((field) => field.id === selected.id),
						)}
						locations={locations}
						onBack={() => setSelectedId(null)}
						onUpdate={(patch) =>
							applyFields((fields) =>
								fields.map((field) =>
									field.id === selected.id ? { ...field, ...patch } : field,
								),
							)
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
								aria-label={_(msg`Form settings`)}
							>
								<Icon name="cog" className="size-4" />
							</Button>
						</div>
						{clearedConditions.length > 0 ? (
							<p
								role="status"
								className="bg-muted text-muted-foreground border-b px-3 py-2 text-xs leading-relaxed"
							>
								<Trans>
									A “show conditionally” rule was removed because its question
									moved below it or was deleted. Check the fields that were
									conditional.
								</Trans>
							</p>
						) : null}
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
