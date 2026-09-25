import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	Frame,
	FrameDescription,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Item, ItemContent, ItemTitle, ItemDescription } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useId, useState, useMemo } from 'react'
import { Form } from 'react-router'
import {
	LocaleContext,
	LocalizedInput,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { AssignedSortableList } from './assigned-sortable-list.tsx'
import {
	LocationOverridesCard,
	type LocationItem,
	type LocationOverrideState,
} from './location-overrides-card.tsx'
import { MenuAvailabilityCard } from './menu-availability-card.tsx'
import { MenuFormHeader } from './menu-form-header.tsx'
import { ModifierGuestPreview } from './modifier-guest-preview.tsx'

export interface ModifierOptionData {
	id: string
	displayName: string
	internalName: string
	price: number
	priceWhole?: number | null
	priceLeft?: number | null
	priceRight?: number | null
	minSelections?: number
	maxSelections?: number | null
	isGlutenFree?: boolean
	isVegetarian?: boolean
	isAlcohol?: boolean
	isTopping?: boolean
	isDefault?: boolean
	nestedModifierGroupIds?: string[]
	availabilityStatus?: string
}

function SortableOptionRow({
	option,
	selectionType,
	activeLocale,
	defaultLocale,
	availableModifierGroups,
	onToggleDefault,
	onEdit,
	onRemove,
	onAddNestedGroup,
	onRemoveNestedGroup,
}: {
	option: ModifierOptionData
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	activeLocale: string
	defaultLocale: string
	availableModifierGroups: Array<{
		id: string
		name: string
		internalName: string | null
	}>
	onToggleDefault: (isDefault: boolean) => void
	onEdit: () => void
	onRemove: () => void
	onAddNestedGroup?: (groupId: string) => void
	onRemoveNestedGroup?: (groupId: string) => void
}) {
	const {
		attributes,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: option.id })

	const displayName =
		getLocalizedMenuValue(option.displayName, activeLocale, defaultLocale) ||
		option.internalName ||
		'Option'

	const isPizza = selectionType === 'pizza'
	const priceWhole = option.priceWhole ?? option.price ?? 0
	const priceHalf =
		option.priceLeft ??
		option.priceRight ??
		(priceWhole > 0 ? priceWhole / 2 : 0)

	const nestedGroupNames = useMemo(() => {
		if (
			!option.nestedModifierGroupIds ||
			option.nestedModifierGroupIds.length === 0
		)
			return []
		return option.nestedModifierGroupIds
			.map((gId) => {
				const found = availableModifierGroups.find((g) => g.id === gId)
				return found
					? getLocalizedMenuValue(found.name, activeLocale, defaultLocale) ||
							found.name
					: null
			})
			.filter(Boolean) as string[]
	}, [
		option.nestedModifierGroupIds,
		availableModifierGroups,
		activeLocale,
		defaultLocale,
	])

	return (
		<FramePanel
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
			}}
			className={cn(
				'flex min-h-14 items-center gap-3 px-4 py-1.5',
				isDragging && 'z-10',
			)}
		>
			<button
				type="button"
				ref={setActivatorNodeRef}
				{...attributes}
				{...listeners}
				className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring shrink-0 cursor-grab rounded p-1 transition-colors focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
				aria-label="Drag to reorder option"
			>
				<Icon name="grip-vertical" className="size-4" />
			</button>

			<div
				className="flex shrink-0 items-center gap-1.5"
				onClick={(e) => e.stopPropagation()}
				title={
					option.isDefault ? t`Preselected (default)` : t`Mark as preselected`
				}
			>
				<Checkbox
					id={`option-default-${option.id}`}
					checked={option.isDefault ?? false}
					onCheckedChange={(checked) => onToggleDefault(Boolean(checked))}
					aria-label={t`Preselected`}
				/>
				<label
					htmlFor={`option-default-${option.id}`}
					className="text-muted-foreground hidden cursor-pointer text-xs select-none sm:inline"
				>
					<Trans>Preselected</Trans>
				</label>
			</div>

			<div
				className="min-w-0 flex-1 cursor-pointer"
				onClick={onEdit}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						onEdit()
					}
				}}
			>
				<div className="flex items-center gap-2">
					<p className="truncate text-sm font-medium">{displayName}</p>
					{option.isGlutenFree && (
						<span className="inline-flex items-center rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
							GF
						</span>
					)}
					{option.isVegetarian && (
						<span className="inline-flex items-center rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
							V
						</span>
					)}
					{option.isAlcohol && (
						<span className="inline-flex items-center rounded border border-purple-500/30 bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-600 dark:text-purple-400">
							21+
						</span>
					)}
				</div>
				{option.internalName ? (
					<p className="text-muted-foreground mt-0.5 truncate text-xs">
						{option.internalName}
					</p>
				) : null}

				{/* Nested Sub-Modifier Groups badge / direct selector */}
				<div
					className="mt-1.5 flex flex-wrap items-center gap-1.5"
					onClick={(e) => e.stopPropagation()}
				>
					<span className="flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
						<Icon name="route" className="size-3" />
						<Trans>Nested Groups:</Trans>
					</span>
					{option.nestedModifierGroupIds &&
					option.nestedModifierGroupIds.length > 0 ? (
						option.nestedModifierGroupIds.map((groupId) => {
							const found = availableModifierGroups.find(
								(g) => g.id === groupId,
							)
							const name = found
								? getLocalizedMenuValue(
										found.name,
										activeLocale,
										defaultLocale,
									) || found.name
								: groupId
							return (
								<span
									key={groupId}
									className="inline-flex items-center gap-1 rounded border border-indigo-500/20 bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:text-indigo-300"
								>
									{name}
									{onRemoveNestedGroup && (
										<button
											type="button"
											onClick={() => onRemoveNestedGroup(groupId)}
											className="hover:text-destructive rounded-full p-0.5 transition-colors"
										>
											<Icon name="x" className="size-2.5" />
										</button>
									)}
								</span>
							)
						})
					) : (
						<span className="text-muted-foreground text-[11px] italic">
							<Trans>None</Trans>
						</span>
					)}
					{onAddNestedGroup &&
						availableModifierGroups.filter(
							(g) => !(option.nestedModifierGroupIds ?? []).includes(g.id),
						).length > 0 && (
							<Select
								value="placeholder"
								onValueChange={(val) => {
									if (val && val !== 'placeholder') {
										onAddNestedGroup(val)
									}
								}}
							>
								<SelectTrigger className="border-border h-5 w-auto gap-1 border-dashed px-1.5 text-[10px] font-normal">
									<SelectValue placeholder="+ Nested group" />
								</SelectTrigger>
								<SelectContent align="start" className="max-h-56">
									<SelectItem value="placeholder" disabled>
										<Trans>Select sub-modifier group...</Trans>
									</SelectItem>
									{availableModifierGroups
										.filter(
											(g) =>
												!(option.nestedModifierGroupIds ?? []).includes(g.id),
										)
										.map((g) => (
											<SelectItem key={g.id} value={g.id}>
												{getLocalizedMenuValue(
													g.name,
													activeLocale,
													defaultLocale,
												) ||
													g.internalName ||
													'Untitled'}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						)}
				</div>
			</div>

			{isPizza ? (
				<div className="shrink-0 cursor-pointer text-right" onClick={onEdit}>
					<span className="text-muted-foreground text-xs font-medium tabular-nums">
						${priceWhole.toFixed(2)} / ${priceHalf.toFixed(2)}
					</span>
					<span className="text-muted-foreground block text-[10px]">
						<Trans>Whole / Left or right</Trans>
					</span>
				</div>
			) : (
				<span
					className="text-muted-foreground shrink-0 cursor-pointer text-xs font-medium tabular-nums"
					onClick={onEdit}
				>
					{option.price > 0 ? `$${option.price.toFixed(2)}` : '$0.00'}
				</span>
			)}

			<div
				className="flex shrink-0 items-center gap-0.5"
				onClick={(e) => e.stopPropagation()}
			>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					onClick={onEdit}
					aria-label={t`Edit option`}
				>
					<Icon name="pencil" className="size-3.5" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					onClick={onRemove}
					aria-label={t`Remove option`}
				>
					<Icon name="x" className="size-4" />
				</Button>
			</div>
		</FramePanel>
	)
}

export interface ModifierGroupFormData {
	id?: string
	name: string
	internalName: string
	selectionType: 'single' | 'multiple' | 'quantity' | 'pizza'
	minSelections: number
	maxSelections?: number | null
	availabilityStatus:
		| 'available'
		| 'unavailable_until'
		| 'unavailable_until_tomorrow'
		| 'unavailable'
	unavailableUntil?: Date | string | null
	options: ModifierOptionData[]
	assignedItemIds: string[]
	locationOverrides: Record<string, LocationOverrideState>
}

interface ModifierFormProps {
	initialData?: Partial<ModifierGroupFormData>
	availableModifierGroups?: Array<{
		id: string
		name: string
		internalName: string | null
	}>
	orgSlug: string
	defaultLocale: string
	supportedLocales?: string[]
	availableOptions?: Array<{
		id: string
		displayName: string
		internalName: string | null
		price: number
		priceWhole?: number | null
		priceLeft?: number | null
		priceRight?: number | null
		isGlutenFree?: boolean
		isVegetarian?: boolean
		isAlcohol?: boolean
		isTopping?: boolean
		imageKey?: string | null
	}>
	allItems: Array<{
		id: string
		displayName: string
		internalName: string | null
		price: number
	}>
	allLocations: LocationItem[]
	initialParentOptionIds?: string[]
	availableParentOptions?: Array<{
		id: string
		displayName: string
		internalName?: string | null
		groupName: string | null
		groupInternalName: string | null
	}>
	isSubmitting: boolean
	pageTitle: string
}

export function ModifierForm({
	initialData,
	availableModifierGroups = [],
	orgSlug,
	defaultLocale,
	supportedLocales = [defaultLocale],
	availableOptions = [],
	allItems,
	allLocations,
	initialParentOptionIds = [],
	availableParentOptions = [],
	isSubmitting,
	pageTitle,
}: ModifierFormProps) {
	const { _ } = useLingui()
	const [activeLocale, setActiveLocale] = useState(defaultLocale)

	const handleAddOptionNestedGroup = (
		optionId: string,
		targetGroupId: string,
	) => {
		setOptions((prev) =>
			prev.map((opt) => {
				if (opt.id !== optionId) return opt
				const existing = opt.nestedModifierGroupIds ?? []
				if (existing.includes(targetGroupId)) return opt
				return {
					...opt,
					nestedModifierGroupIds: [...existing, targetGroupId],
				}
			}),
		)
	}

	const handleRemoveOptionNestedGroup = (
		optionId: string,
		targetGroupId: string,
	) => {
		setOptions((prev) =>
			prev.map((opt) => {
				if (opt.id !== optionId) return opt
				const existing = opt.nestedModifierGroupIds ?? []
				return {
					...opt,
					nestedModifierGroupIds: existing.filter((id) => id !== targetGroupId),
				}
			}),
		)
	}

	// State
	const [name, setName] = useState(
		initialData?.name ?? JSON.stringify({ [defaultLocale]: '' }),
	)
	const [internalName, setInternalName] = useState(
		initialData?.internalName ?? '',
	)
	const [selectionType, setSelectionType] = useState<
		'single' | 'multiple' | 'quantity' | 'pizza'
	>(initialData?.selectionType ?? 'single')

	const [minSelections, setMinSelections] = useState<number>(
		initialData?.minSelections ?? 0,
	)
	const [maxSelections, setMaxSelections] = useState<string>(
		initialData?.maxSelections !== undefined &&
			initialData?.maxSelections !== null
			? String(initialData.maxSelections)
			: '',
	)
	const [availabilityStatus, setAvailabilityStatus] = useState<string>(
		initialData?.availabilityStatus ?? 'available',
	)
	const [unavailableUntil, setUnavailableUntil] = useState<Date | null>(() => {
		if (initialData?.unavailableUntil) {
			const d =
				initialData.unavailableUntil instanceof Date
					? initialData.unavailableUntil
					: new Date(initialData.unavailableUntil)
			return isNaN(d.getTime()) ? null : d
		}
		return null
	})

	// Options list
	const [options, setOptions] = useState<ModifierOptionData[]>(
		initialData?.options ?? [],
	)

	const [activeSubGroupIds, setActiveSubGroupIds] = useState<string[]>(() => {
		const s = new Set<string>()
		for (const o of initialData?.options ?? []) {
			for (const id of o.nestedModifierGroupIds ?? []) s.add(id)
		}
		return Array.from(s)
	})

	const [selectedItemIds, setSelectedItemIds] = useState<string[]>(
		initialData?.assignedItemIds ?? [],
	)
	const [locationOverrides, setLocationOverrides] = useState<
		Record<string, LocationOverrideState>
	>(initialData?.locationOverrides ?? {})

	// Drag & drop state for options
	const [isOptionSorting, setIsOptionSorting] = useState(false)
	const dndId = useId()
	const optionSensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	// Modal / Dialog state
	const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
	const [dialogMode, setDialogMode] = useState<'pick' | 'create'>('pick')
	const [editingOption, setEditingOption] = useState<ModifierOptionData | null>(
		null,
	)
	const [optionSearchQuery, setOptionSearchQuery] = useState('')

	// Modal form fields
	const [modalDisplayName, setModalDisplayName] = useState('')
	const [modalInternalName, setModalInternalName] = useState('')
	const [modalPrice, setModalPrice] = useState<number>(0)
	const [modalPriceWhole, setModalPriceWhole] = useState<number>(0)
	const [modalPriceLeft, setModalPriceLeft] = useState<number>(0)
	const [modalPriceRight, setModalPriceRight] = useState<number>(0)
	const [modalIsGlutenFree, setModalIsGlutenFree] = useState(false)
	const [modalIsVegetarian, setModalIsVegetarian] = useState(false)
	const [modalIsAlcohol, setModalIsAlcohol] = useState(false)
	const [modalIsDefault, setModalIsDefault] = useState(false)
	const [modalNestedModifierGroupIds, setModalNestedModifierGroupIds] =
		useState<string[]>([])

	const eligibleModifierGroups = useMemo(() => {
		const currentGroupId = initialData?.id
		return availableModifierGroups.filter((g) => g.id !== currentGroupId)
	}, [availableModifierGroups, initialData?.id])

	const handleAddExistingOption = (opt: {
		id: string
		displayName: string
		internalName: string | null
		price: number
		priceWhole?: number | null
		priceLeft?: number | null
		priceRight?: number | null
		isGlutenFree?: boolean
		isVegetarian?: boolean
		isAlcohol?: boolean
		isTopping?: boolean
	}) => {
		setOptions((prev) => [
			...prev,
			{
				id: opt.id,
				displayName: opt.displayName,
				internalName: opt.internalName ?? '',
				price: opt.price,
				priceWhole:
					opt.priceWhole ?? (selectionType === 'pizza' ? opt.price : null),
				priceLeft:
					opt.priceLeft ?? (selectionType === 'pizza' ? opt.price / 2 : null),
				priceRight:
					opt.priceRight ?? (selectionType === 'pizza' ? opt.price / 2 : null),
				isGlutenFree: opt.isGlutenFree ?? false,
				isVegetarian: opt.isVegetarian ?? false,
				isAlcohol: opt.isAlcohol ?? false,
				isTopping: opt.isTopping ?? selectionType === 'pizza',
				isDefault: false,
			},
		])
	}

	const handleRemoveOption = (id: string) => {
		setOptions(options.filter((o) => o.id !== id))
	}

	const handleSetOptionDefault = (id: string, isDefault: boolean) => {
		setOptions((currentOptions) =>
			currentOptions.map((option) => ({
				...option,
				// A radio-style modifier can only have one preselected choice.
				isDefault:
					option.id === id
						? isDefault
						: selectionType === 'single'
							? false
							: option.isDefault,
			})),
		)
	}

	const handleOptionDragStart = () => {
		setIsOptionSorting(true)
	}

	const handleOptionDragCancel = () => {
		setIsOptionSorting(false)
	}

	const handleOptionDragEnd = ({ active, over }: DragEndEvent) => {
		setIsOptionSorting(false)
		if (!over || active.id === over.id) return
		setOptions((currentOptions) => {
			const oldIndex = currentOptions.findIndex(
				(option) => option.id === String(active.id),
			)
			const newIndex = currentOptions.findIndex(
				(option) => option.id === String(over.id),
			)
			return oldIndex >= 0 && newIndex >= 0
				? arrayMove(currentOptions, oldIndex, newIndex)
				: currentOptions
		})
	}

	const handleSelectionTypeChange = (
		val: 'single' | 'multiple' | 'quantity' | 'pizza',
	) => {
		setSelectionType(val)
		if (val === 'single') {
			let foundFirst = false
			setOptions((prev) =>
				prev.map((opt) => {
					if (opt.isDefault) {
						if (!foundFirst) {
							foundFirst = true
							return opt
						}
						return { ...opt, isDefault: false }
					}
					return opt
				}),
			)
		}
	}

	// Dialog helpers
	const availableUnselectedOptions = availableOptions.filter(
		(opt) => !options.some((o) => o.id === opt.id),
	)

	const filteredAvailableOptions = availableUnselectedOptions.filter((opt) => {
		if (!optionSearchQuery.trim()) return true
		const q = optionSearchQuery.toLowerCase()
		const name = getLocalizedMenuValue(
			opt.displayName,
			activeLocale,
			defaultLocale,
		).toLowerCase()
		const internal = (opt.internalName ?? '').toLowerCase()
		return name.includes(q) || internal.includes(q)
	})

	const handleOpenAddOption = () => {
		setOptionSearchQuery('')
		if (availableUnselectedOptions.length === 0) {
			setModalDisplayName(JSON.stringify({ [defaultLocale]: '' }))
			setModalInternalName('')
			setModalPrice(0)
			setModalPriceWhole(0)
			setModalPriceLeft(0)
			setModalPriceRight(0)
			setModalIsGlutenFree(false)
			setModalIsVegetarian(false)
			setModalIsAlcohol(false)
			setModalIsDefault(false)
			setDialogMode('create')
		} else {
			setDialogMode('pick')
		}
		setIsAddDialogOpen(true)
	}

	const handleStartCreateNew = () => {
		setModalDisplayName(JSON.stringify({ [defaultLocale]: '' }))
		setModalInternalName('')
		setModalPrice(0)
		setModalPriceWhole(0)
		setModalPriceLeft(0)
		setModalPriceRight(0)
		setModalIsGlutenFree(false)
		setModalIsVegetarian(false)
		setModalIsAlcohol(false)
		setModalIsDefault(false)
		setModalNestedModifierGroupIds([])
		setDialogMode('create')
	}

	const handleSelectExistingOption = (opt: any) => {
		handleAddExistingOption(opt)
		setIsAddDialogOpen(false)
	}

	const handleSaveNewOption = () => {
		const newId = `opt_${Date.now()}`
		const isPizza = selectionType === 'pizza'
		const newOption: ModifierOptionData = {
			id: newId,
			displayName:
				modalDisplayName ||
				JSON.stringify({ [defaultLocale]: `Option ${options.length + 1}` }),
			internalName: modalInternalName,
			price: isPizza ? modalPriceWhole : modalPrice,
			priceWhole: modalPriceWhole,
			priceLeft: modalPriceLeft,
			priceRight: modalPriceRight,
			isGlutenFree: modalIsGlutenFree,
			isVegetarian: modalIsVegetarian,
			isAlcohol: modalIsAlcohol,
			isTopping: isPizza,
			isDefault: modalIsDefault,
			nestedModifierGroupIds: modalNestedModifierGroupIds,
		}

		if (modalIsDefault && selectionType === 'single') {
			setOptions([
				...options.map((o) => ({ ...o, isDefault: false })),
				newOption,
			])
		} else {
			setOptions([...options, newOption])
		}
		setIsAddDialogOpen(false)
	}

	const handleOpenEdit = (option: ModifierOptionData) => {
		setEditingOption(option)
		setModalDisplayName(option.displayName)
		setModalInternalName(option.internalName ?? '')
		setModalPrice(option.price ?? 0)
		setModalPriceWhole(option.priceWhole ?? option.price ?? 0)
		const halfPrice =
			option.priceLeft ??
			option.priceRight ??
			(option.priceWhole ? option.priceWhole / 2 : option.price / 2)
		setModalPriceLeft(halfPrice)
		setModalPriceRight(halfPrice)
		setModalIsGlutenFree(option.isGlutenFree ?? false)
		setModalIsVegetarian(option.isVegetarian ?? false)
		setModalIsAlcohol(option.isAlcohol ?? false)
		setModalIsDefault(option.isDefault ?? false)
		setModalNestedModifierGroupIds(option.nestedModifierGroupIds ?? [])
	}

	const handleSaveEditOption = () => {
		if (!editingOption) return
		const isPizza = selectionType === 'pizza'
		const updated: ModifierOptionData = {
			...editingOption,
			displayName: modalDisplayName,
			internalName: modalInternalName,
			price: isPizza ? modalPriceWhole : modalPrice,
			priceWhole: modalPriceWhole,
			priceLeft: modalPriceLeft,
			priceRight: modalPriceRight,
			isGlutenFree: modalIsGlutenFree,
			isVegetarian: modalIsVegetarian,
			isAlcohol: modalIsAlcohol,
			isTopping: isPizza || editingOption.isTopping,
			isDefault: modalIsDefault,
			nestedModifierGroupIds: modalNestedModifierGroupIds,
		}

		setOptions((currentOptions) =>
			currentOptions.map((opt) => {
				if (opt.id === editingOption.id) {
					return updated
				}
				if (modalIsDefault && selectionType === 'single') {
					return { ...opt, isDefault: false }
				}
				return opt
			}),
		)
		setEditingOption(null)
	}

	const isSingleSelection = selectionType === 'single'
	const effectiveMinSelections = isSingleSelection
		? minSelections > 0
			? 1
			: 0
		: minSelections
	const effectiveMaxSelections = isSingleSelection ? '1' : maxSelections
	const parsedMaxSelections = effectiveMaxSelections
		? parseInt(effectiveMaxSelections, 10)
		: null

	return (
		<LocaleContext.Provider
			value={{
				activeLocale,
				defaultLocale,
				locales: supportedLocales,
				setActiveLocale,
			}}
		>
			<TranslateProvider
				activeLocale={activeLocale}
				defaultLocale={defaultLocale}
			>
				<Form method="POST" className="flex flex-1 flex-col">
					{/* Hidden inputs to submit values */}
					<input type="hidden" name="name" value={name} />
					<input type="hidden" name="selectionType" value={selectionType} />
					<input
						type="hidden"
						name="minSelections"
						value={String(effectiveMinSelections)}
					/>
					<input
						type="hidden"
						name="maxSelections"
						value={effectiveMaxSelections}
					/>
					<input type="hidden" name="options" value={JSON.stringify(options)} />
					<input
						type="hidden"
						name="assignedItemIds"
						value={JSON.stringify(selectedItemIds)}
					/>
					<input
						type="hidden"
						name="locationOverrides"
						value={JSON.stringify(locationOverrides)}
					/>

					{/* Minimal Sticky Full-Width Header */}
					<MenuFormHeader
						pageTitle={pageTitle}
						backHref={`/${orgSlug}/menu/modifiers`}
						backLabel={t`Back to modifier groups`}
						saveButtonText={t`Save Modifier Group`}
						isSubmitting={isSubmitting}
					/>

					{/* 2-Column Shopify Layout */}
					<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
						<div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
							{/* Main Left Column (8 cols) */}
							<div className="flex flex-col gap-6 lg:col-span-8">
								{/* Basic Details Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Modifier Group Information</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>Guest-facing name and internal identifier.</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4">
										<div className="space-y-2">
											<Label>
												<Trans>Group Name (Guest-Facing)</Trans>
											</Label>
											<LocalizedInput
												value={name}
												onChange={setName}
												placeholder="e.g. Choice of Protein, Pizza Toppings, Sides"
												required
											/>
										</div>

										<div className="space-y-2">
											<Label>
												<Trans>Internal Reference (Optional)</Trans>
											</Label>
											<Input
												name="internalName"
												value={internalName}
												onChange={(e) => setInternalName(e.target.value)}
												placeholder="e.g. salad_dressings_bar"
											/>
										</div>
									</FramePanel>
								</Frame>

								{/* Selection Behavior Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Selection Behavior & Limits</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>
												Configure how guests interact with these options.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="p-5">
										<div className="space-y-3">
											<Label>
												<Trans>Selection Mode</Trans>
											</Label>
											<RadioGroup
												value={selectionType}
												onValueChange={(val: any) =>
													handleSelectionTypeChange(val)
												}
												className="grid grid-cols-1 gap-3 sm:grid-cols-2"
											>
												<Item
													variant="outline"
													className={cn(
														'cursor-pointer items-start gap-3 p-3.5 transition-colors select-none',
														selectionType === 'single' &&
															'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
													)}
													onClick={() => handleSelectionTypeChange('single')}
												>
													<RadioGroupItem
														value="single"
														id="st_single"
														className="mt-0.5"
													/>
													<ItemContent className="min-w-0">
														<ItemTitle>
															<Trans>Single Choice (Radio)</Trans>
														</ItemTitle>
														<ItemDescription className="text-muted-foreground text-xs">
															<Trans>Guests can pick up to 1 option.</Trans>
														</ItemDescription>
													</ItemContent>
												</Item>

												<Item
													variant="outline"
													className={cn(
														'cursor-pointer items-start gap-3 p-3.5 transition-colors select-none',
														selectionType === 'multiple' &&
															'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
													)}
													onClick={() => handleSelectionTypeChange('multiple')}
												>
													<RadioGroupItem
														value="multiple"
														id="st_multiple"
														className="mt-0.5"
													/>
													<ItemContent className="min-w-0">
														<ItemTitle>
															<Trans>Multiple Choice (Checkboxes)</Trans>
														</ItemTitle>
														<ItemDescription className="text-muted-foreground text-xs">
															<Trans>Guests can pick multiple options.</Trans>
														</ItemDescription>
													</ItemContent>
												</Item>

												<Item
													variant="outline"
													className={cn(
														'cursor-pointer items-start gap-3 p-3.5 transition-colors select-none',
														selectionType === 'quantity' &&
															'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
													)}
													onClick={() => handleSelectionTypeChange('quantity')}
												>
													<RadioGroupItem
														value="quantity"
														id="st_quantity"
														className="mt-0.5"
													/>
													<ItemContent className="min-w-0">
														<ItemTitle>
															<Trans>Quantity Counter (+/-)</Trans>
														</ItemTitle>
														<ItemDescription className="text-muted-foreground text-xs">
															<Trans>Guests choose counts per option.</Trans>
														</ItemDescription>
													</ItemContent>
												</Item>

												<Item
													variant="outline"
													className={cn(
														'cursor-pointer items-start gap-3 p-3.5 transition-colors select-none',
														selectionType === 'pizza' &&
															'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
													)}
													onClick={() => handleSelectionTypeChange('pizza')}
												>
													<RadioGroupItem
														value="pizza"
														id="st_pizza"
														className="mt-0.5"
													/>
													<ItemContent className="min-w-0">
														<ItemTitle>
															<Trans>Pizza Toppings (Whole / Halves)</Trans>
														</ItemTitle>
														<ItemDescription className="text-muted-foreground text-xs">
															<Trans>
																Whole pizza, left half, or right half pricing.
															</Trans>
														</ItemDescription>
													</ItemContent>
												</Item>
											</RadioGroup>
										</div>
									</FramePanel>

									{isSingleSelection ? (
										<FramePanel className="flex items-center justify-between gap-4 p-5">
											<Label
												htmlFor="single-choice-required"
												className="block min-w-0 cursor-pointer space-y-0.5 font-normal"
											>
												<div className="text-foreground text-sm">
													<Trans>Required selection</Trans>
												</div>
												<p className="text-muted-foreground text-xs">
													{effectiveMinSelections === 1 ? (
														<Trans>
															Guests must choose one option before continuing.
														</Trans>
													) : (
														<Trans>Guests can skip this selection.</Trans>
													)}
												</p>
											</Label>
											<Switch
												id="single-choice-required"
												checked={effectiveMinSelections === 1}
												onCheckedChange={(isRequired) =>
													setMinSelections(isRequired ? 1 : 0)
												}
											/>
										</FramePanel>
									) : (
										<FramePanel className="p-5">
											<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
												<div className="space-y-1.5">
													<Label>
														<Trans>Minimum Selections</Trans>
													</Label>
													<Input
														type="number"
														min="0"
														value={minSelections}
														onChange={(e) =>
															setMinSelections(
																parseInt(e.target.value, 10) || 0,
															)
														}
													/>
													<span className="text-muted-foreground text-xs">
														0 = optional choice, 1+ = required
													</span>
												</div>

												<div className="space-y-1.5">
													<Label>
														<Trans>Maximum Selections (Optional)</Trans>
													</Label>
													<Input
														type="number"
														min="1"
														placeholder="Leave blank for unlimited"
														value={maxSelections}
														onChange={(e) => setMaxSelections(e.target.value)}
													/>
												</div>
											</div>
										</FramePanel>
									)}
								</Frame>

								{/* Nested Modifier Groups Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="flex items-center gap-2 text-base">
											<Icon name="route" className="text-primary size-4" />
											<Trans>Nested Modifier Groups</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>
												Trigger child modifier groups when specific options are
												selected.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4 p-5">
										{activeSubGroupIds.length === 0 ? (
											<div className="text-muted-foreground bg-muted/20 border-border/60 rounded-md border border-dashed p-4 text-center text-sm">
												<Trans>No nested modifier groups added yet.</Trans>
											</div>
										) : (
											<div className="space-y-4">
												{activeSubGroupIds.map((subId) => {
													const grp = availableModifierGroups.find(
														(g) => g.id === subId,
													)
													if (!grp) return null

													const grpName =
														getLocalizedMenuValue(
															grp.name,
															activeLocale,
															defaultLocale,
														) ||
														grp.internalName ||
														grp.name ||
														'Untitled'
													return (
														<div
															key={subId}
															className="border-border bg-card space-y-3 rounded-xl border p-4"
														>
															<div className="flex items-center justify-between">
																<div className="flex items-center gap-2">
																	<Icon
																		name="route"
																		className="text-muted-foreground size-4"
																	/>
																	<h4 className="text-sm font-semibold">
																		{grpName}
																	</h4>
																</div>
																<Button
																	variant="ghost"
																	size="icon-sm"
																	className="text-destructive hover:bg-destructive/10"
																	type="button"
																	onClick={() => {
																		setActiveSubGroupIds((prev) =>
																			prev.filter((id) => id !== subId),
																		)
																		setOptions((prev) =>
																			prev.map((o) => ({
																				...o,
																				nestedModifierGroupIds: (
																					o.nestedModifierGroupIds || []
																				).filter((id) => id !== subId),
																			})),
																		)
																	}}
																>
																	<Icon name="trash" className="size-4" />
																</Button>
															</div>
															<div className="border-border/50 space-y-2 border-t pt-2">
																<p className="text-muted-foreground mt-1 mb-1 text-xs font-medium">
																	<Trans>Triggered by options:</Trans>
																</p>
																{options.length === 0 ? (
																	<p className="text-muted-foreground text-[11px] italic">
																		<Trans>
																			Add options to this group first.
																		</Trans>
																	</p>
																) : (
																	<div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
																		{options.map((opt) => {
																			const isActive = (
																				opt.nestedModifierGroupIds || []
																			).includes(subId)
																			const optName =
																				getLocalizedMenuValue(
																					opt.displayName,
																					activeLocale,
																					defaultLocale,
																				) ||
																				opt.internalName ||
																				opt.displayName ||
																				'Untitled option'
																			return (
																				<label
																					key={opt.id}
																					className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-colors select-none ${isActive ? 'border-primary/50 bg-primary/5 dark:bg-primary/10' : 'border-border/60 hover:bg-muted/40'}`}
																				>
																					<div className="flex h-full items-center">
																						<input
																							type="checkbox"
																							className="border-input text-primary focus:ring-primary size-3.5 rounded"
																							checked={isActive}
																							onChange={(e) => {
																								if (e.target.checked)
																									handleAddOptionNestedGroup(
																										opt.id,
																										subId,
																									)
																								else
																									handleRemoveOptionNestedGroup(
																										opt.id,
																										subId,
																									)
																							}}
																						/>
																					</div>
																					<span
																						className={`truncate font-medium ${isActive ? 'text-primary' : 'text-foreground'}`}
																					>
																						{optName}
																					</span>
																				</label>
																			)
																		})}
																	</div>
																)}
															</div>
														</div>
													)
												})}
											</div>
										)}

										<div className="pt-1">
											<Select
												value="placeholder"
												onValueChange={(val) => {
													if (val && val !== 'placeholder') {
														setActiveSubGroupIds((prev) => [...prev, val])
													}
												}}
											>
												<SelectTrigger className="bg-muted/10 w-full border-dashed shadow-none sm:max-w-xs">
													<SelectValue placeholder="+ Add nested modifier group" />
												</SelectTrigger>
												<SelectContent align="start" className="max-h-64">
													<SelectItem
														value="placeholder"
														disabled
														className="hidden"
													>
														<Trans>Select sub-modifier group...</Trans>
													</SelectItem>
													{eligibleModifierGroups.filter(
														(g) => !activeSubGroupIds.includes(g.id),
													).length === 0 && (
														<div className="text-muted-foreground p-2 text-center text-xs">
															<Trans>No other modifier groups available.</Trans>
														</div>
													)}
													{eligibleModifierGroups
														.filter((g) => !activeSubGroupIds.includes(g.id))
														.map((g) => (
															<SelectItem key={g.id} value={g.id}>
																{getLocalizedMenuValue(
																	g.name,
																	activeLocale,
																	defaultLocale,
																) ||
																	g.internalName ||
																	'Untitled'}
															</SelectItem>
														))}
												</SelectContent>
											</Select>
										</div>
									</FramePanel>
								</Frame>

								{/* Options Management Frame */}
								<Frame className="w-full" stackedPanels={!isOptionSorting}>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Modifier Options</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>
												Add the individual choices, prices, and dietary tags.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									{options.length === 0 ? (
										<FramePanel className="text-muted-foreground px-5 py-6 text-center text-sm">
											<p className="text-muted-foreground text-xs italic">
												<Trans>
													No options added yet. Click &ldquo;Add option&rdquo;
													to get started.
												</Trans>
											</p>
										</FramePanel>
									) : (
										<DndContext
											id={dndId}
											sensors={optionSensors}
											onDragStart={handleOptionDragStart}
											onDragEnd={handleOptionDragEnd}
											onDragCancel={handleOptionDragCancel}
										>
											<SortableContext
												id={dndId}
												items={options.map((option) => option.id)}
												strategy={verticalListSortingStrategy}
											>
												{options.map((option) => (
													<SortableOptionRow
														key={option.id}
														option={option}
														selectionType={selectionType}
														activeLocale={activeLocale}
														defaultLocale={defaultLocale}
														availableModifierGroups={eligibleModifierGroups}
														onToggleDefault={(checked) =>
															handleSetOptionDefault(option.id, checked)
														}
														onEdit={() => handleOpenEdit(option)}
														onRemove={() => handleRemoveOption(option.id)}
													/>
												))}
											</SortableContext>
										</DndContext>
									)}
									<FrameFooter className="items-end pt-3">
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={handleOpenAddOption}
											className="w-full"
										>
											<Icon name="plus" className="size-4" />
											<Trans>Add option</Trans>
										</Button>
									</FrameFooter>
								</Frame>

								<AssignedSortableList
									title={<Trans>Assigned Items</Trans>}
									description={
										<Trans>Items that offer this modifier group.</Trans>
									}
									addLabel={<Trans>Add item</Trans>}
									selectionTitle={<Trans>Add an item</Trans>}
									selectionDescription={
										<Trans>Select an item to offer this modifier group.</Trans>
									}
									emptyMessage={
										<Trans>
											No items assigned yet. Add one to get started.
										</Trans>
									}
									entries={allItems.map((item) => ({
										id: item.id,
										name:
											getLocalizedMenuValue(
												item.displayName,
												defaultLocale,
												defaultLocale,
											) ||
											item.internalName ||
											'Item',
										description: item.internalName,
										meta: `$${item.price.toFixed(2)}`,
									}))}
									selectedIds={selectedItemIds}
									onChange={setSelectedItemIds}
								/>
							</div>

							{/* Sidebar Right Column (4 cols) */}
							<div className="flex flex-col gap-6 lg:col-span-4">
								{/* Live Guest Preview Card */}
								<ModifierGuestPreview
									groupName={name}
									availableModifierGroups={availableModifierGroups}
									selectionType={selectionType}
									minSelections={effectiveMinSelections}
									maxSelections={parsedMaxSelections}
									options={options}
									locale={activeLocale}
									defaultLocale={defaultLocale}
								/>

								{/* Nested Modifier Usage Card (Otter pattern) */}
								{availableParentOptions.filter((opt) =>
									(initialParentOptionIds || []).includes(opt.id),
								).length > 0 && (
									<Frame className="w-full">
										<FrameHeader>
											<FrameTitle className="flex items-center gap-2 text-sm font-semibold">
												<Icon
													name="route"
													className="size-4 text-indigo-600 dark:text-indigo-400"
												/>
												<Trans>Nested Modifier Usage</Trans>
											</FrameTitle>
											<FrameDescription className="text-xs">
												<Trans>
													This modifier group is triggered when customers select
													these modifier items:
												</Trans>
											</FrameDescription>
										</FrameHeader>
										<FramePanel className="space-y-2 p-4 text-xs">
											{availableParentOptions
												.filter((opt) =>
													(initialParentOptionIds || []).includes(opt.id),
												)
												.map((opt) => {
													const grpName = opt.groupName
														? getLocalizedMenuValue(
																opt.groupName,
																activeLocale,
																defaultLocale,
															) ||
															opt.groupInternalName ||
															'Group'
														: 'Group'
													const optName =
														getLocalizedMenuValue(
															opt.displayName,
															activeLocale,
															defaultLocale,
														) ||
														opt.internalName ||
														'Option'
													return (
														<div
															key={opt.id}
															className="border-border/60 bg-muted/20 flex items-center justify-between rounded-md border px-3 py-2"
														>
															<div className="min-w-0 flex-1 truncate pr-2">
																<span className="text-muted-foreground font-medium">
																	{grpName}
																</span>
																<span className="text-muted-foreground mx-1.5">
																	➔
																</span>
																<span className="text-foreground font-semibold">
																	{optName}
																</span>
															</div>
															<Badge
																variant="outline"
																className="text-muted-foreground shrink-0 text-[10px]"
															>
																<Trans>Trigger</Trans>
															</Badge>
														</div>
													)
												})}
										</FramePanel>
									</Frame>
								)}

								{/* Status Frame */}
								<MenuAvailabilityCard
									value={availabilityStatus}
									onChange={(val: any) => setAvailabilityStatus(val)}
									unavailableUntil={unavailableUntil}
									onUnavailableUntilChange={setUnavailableUntil}
									locations={allLocations}
								/>

								{/* Location Availability Card */}
								<LocationOverridesCard
									locations={allLocations}
									overrides={locationOverrides}
									onChange={setLocationOverrides}
								/>
							</div>
						</div>
					</div>

					{/* Dialog for Adding Options (Pick or Create) */}
					<Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
						<DialogContent className="sm:max-w-md">
							<DialogHeader>
								<DialogTitle>
									{dialogMode === 'create' ? (
										<Trans>Create New Option</Trans>
									) : (
										<Trans>Add an Option</Trans>
									)}
								</DialogTitle>
								<DialogDescription>
									{dialogMode === 'create' ? (
										<Trans>Create a new choice for this modifier group.</Trans>
									) : (
										<Trans>
											Select an option to add to this modifier group.
										</Trans>
									)}
								</DialogDescription>
							</DialogHeader>

							{dialogMode === 'create' ? (
								<div className="space-y-4 py-2">
									<div className="space-y-2">
										<Label>
											<Trans>Option Display Name (Guest-Facing)</Trans>
										</Label>
										<LocalizedInput
											value={modalDisplayName}
											onChange={setModalDisplayName}
											placeholder="e.g. Ranch, Pepperoni, Extra Cheese"
											required
										/>
									</div>

									<div className="space-y-2">
										<Label>
											<Trans>Internal Reference (Optional)</Trans>
										</Label>
										<Input
											value={modalInternalName}
											onChange={(e) => setModalInternalName(e.target.value)}
											placeholder="e.g. sauce_ranch_side"
										/>
									</div>

									{selectionType === 'pizza' ? (
										<div className="grid grid-cols-2 gap-3">
											<div className="space-y-1.5">
												<Label>
													<Trans>Whole pizza ($)</Trans>
												</Label>
												<Input
													type="number"
													step="0.01"
													min="0"
													value={modalPriceWhole || ''}
													onChange={(e) => {
														const val = parseFloat(e.target.value) || 0
														setModalPriceWhole(val)
														setModalPrice(val)
													}}
													placeholder="0.00"
												/>
											</div>
											<div className="space-y-1.5">
												<Label>
													<Trans>Left or right ($)</Trans>
												</Label>
												<Input
													type="number"
													step="0.01"
													min="0"
													value={modalPriceLeft || ''}
													onChange={(e) => {
														const val = parseFloat(e.target.value) || 0
														setModalPriceLeft(val)
														setModalPriceRight(val)
													}}
													placeholder={(modalPriceWhole > 0
														? modalPriceWhole / 2
														: 0
													).toFixed(2)}
												/>
											</div>
										</div>
									) : (
										<div className="space-y-1.5">
											<Label>
												<Trans>Price ($)</Trans>
											</Label>
											<Input
												type="number"
												step="0.01"
												min="0"
												value={modalPrice || ''}
												onChange={(e) => {
													const val = parseFloat(e.target.value) || 0
													setModalPrice(val)
													setModalPriceWhole(val)
												}}
												placeholder="0.00"
											/>
										</div>
									)}

									<div className="flex items-center gap-2 pt-1">
										<Checkbox
											id="modal-create-preselected"
											checked={modalIsDefault}
											onCheckedChange={(c) => setModalIsDefault(Boolean(c))}
										/>
										<Label
											htmlFor="modal-create-preselected"
											className="cursor-pointer text-xs font-normal"
										>
											<Trans>
												Preselected (Included when guests first open this group)
											</Trans>
										</Label>
									</div>

									<div className="space-y-2 pt-1">
										<Label>
											<Trans>Dietary Tags</Trans>
										</Label>
										<div className="flex flex-wrap items-center gap-2 text-xs">
											<button
												type="button"
												onClick={() => setModalIsGlutenFree(!modalIsGlutenFree)}
												className={cn(
													'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
													modalIsGlutenFree
														? 'border-amber-500/50 bg-amber-500/10 font-medium text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-400'
														: 'border-border/70 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
												)}
											>
												<Icon
													name={modalIsGlutenFree ? 'check' : 'plus'}
													className="size-3"
												/>
												<span>
													<Trans>Gluten-Free</Trans>
												</span>
											</button>
											<button
												type="button"
												onClick={() => setModalIsVegetarian(!modalIsVegetarian)}
												className={cn(
													'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
													modalIsVegetarian
														? 'border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400'
														: 'border-border/70 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
												)}
											>
												<Icon
													name={modalIsVegetarian ? 'check' : 'plus'}
													className="size-3"
												/>
												<span>
													<Trans>Vegetarian</Trans>
												</span>
											</button>
											<button
												type="button"
												onClick={() => setModalIsAlcohol(!modalIsAlcohol)}
												className={cn(
													'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
													modalIsAlcohol
														? 'border-purple-500/50 bg-purple-500/10 font-medium text-purple-600 ring-1 ring-purple-500/20 dark:text-purple-400'
														: 'border-border/70 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
												)}
											>
												<Icon
													name={modalIsAlcohol ? 'check' : 'plus'}
													className="size-3"
												/>
												<span>
													<Trans>Alcohol (21+)</Trans>
												</span>
											</button>
										</div>
									</div>

									<div className="border-border/70 bg-muted/20 space-y-2 rounded-lg border p-3">
										<div className="flex items-center gap-1.5">
											<Icon name="route" className="text-primary size-4" />
											<Label className="text-xs font-semibold">
												<Trans>Sub / Nested Modifier Groups</Trans>
											</Label>
										</div>
										<p className="text-muted-foreground text-[11px]">
											<Trans>
												When a customer selects this option, reveal these
												conditional modifier groups (e.g. selecting "French
												Fries" unlocks "Fry Size").
											</Trans>
										</p>
										{eligibleModifierGroups.length === 0 ? (
											<p className="text-muted-foreground text-xs italic">
												<Trans>
													No other modifier groups available to nest.
												</Trans>
											</p>
										) : (
											<div className="border-border/50 bg-background/50 max-h-36 space-y-1.5 overflow-y-auto rounded-md border p-2">
												{eligibleModifierGroups.map(
													(grp: {
														id: string
														name: string
														internalName: string | null
													}) => {
														const isChecked =
															modalNestedModifierGroupIds.includes(grp.id)
														const grpDisplayName =
															getLocalizedMenuValue(
																grp.name,
																activeLocale,
																defaultLocale,
															) ||
															grp.internalName ||
															grp.name
														return (
															<label
																key={grp.id}
																className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs"
															>
																<Checkbox
																	checked={isChecked}
																	onCheckedChange={(checked) => {
																		if (checked) {
																			setModalNestedModifierGroupIds((prev) => [
																				...prev,
																				grp.id,
																			])
																		} else {
																			setModalNestedModifierGroupIds((prev) =>
																				prev.filter((id) => id !== grp.id),
																			)
																		}
																	}}
																/>
																<span className="text-foreground font-medium">
																	{grpDisplayName}
																</span>
																{grp.internalName && (
																	<span className="text-muted-foreground text-[10px]">
																		({grp.internalName})
																	</span>
																)}
															</label>
														)
													},
												)}
											</div>
										)}
									</div>

									<DialogFooter className="gap-2 sm:justify-end">
										{availableUnselectedOptions.length > 0 && (
											<Button
												type="button"
												variant="outline"
												onClick={() => setDialogMode('pick')}
											>
												<Trans>Back to list</Trans>
											</Button>
										)}
										<Button type="button" onClick={handleSaveNewOption}>
											<Trans>Add Option</Trans>
										</Button>
									</DialogFooter>
								</div>
							) : (
								<div className="space-y-3 py-2">
									<Button
										type="button"
										variant="outline"
										className="w-full gap-2"
										onClick={handleStartCreateNew}
									>
										<Icon name="plus" className="size-4" />
										<Trans>Create New Option</Trans>
									</Button>

									{availableUnselectedOptions.length > 0 && (
										<div className="relative">
											<Icon
												name="search"
												className="text-muted-foreground absolute top-2.5 left-3 size-4"
											/>
											<Input
												placeholder={t`Search available options...`}
												value={optionSearchQuery}
												onChange={(e) => setOptionSearchQuery(e.target.value)}
												className="pl-9 text-xs"
											/>
										</div>
									)}

									<div className="max-h-80 space-y-1 overflow-y-auto py-1">
										{filteredAvailableOptions.length === 0 ? (
											<div className="text-muted-foreground px-4 py-8 text-center text-xs">
												<Trans>No matching options found.</Trans>
											</div>
										) : (
											filteredAvailableOptions.map((opt) => {
												const isPizza = selectionType === 'pizza'
												const whole = opt.priceWhole ?? opt.price ?? 0
												const half =
													opt.priceLeft ??
													opt.priceRight ??
													(whole > 0 ? whole / 2 : 0)
												return (
													<button
														key={opt.id}
														type="button"
														className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
														onClick={() => handleSelectExistingOption(opt)}
													>
														<Icon
															name="plus"
															className="text-muted-foreground size-4 shrink-0"
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate text-sm font-medium">
																{getLocalizedMenuValue(
																	opt.displayName,
																	activeLocale,
																	defaultLocale,
																) ||
																	opt.internalName ||
																	'Option'}
															</span>
															{opt.internalName ? (
																<span className="text-muted-foreground block truncate text-xs">
																	{opt.internalName}
																</span>
															) : null}
														</span>
														{isPizza ? (
															<span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">
																${whole.toFixed(2)} / ${half.toFixed(2)}
															</span>
														) : (
															<span className="text-muted-foreground shrink-0 text-xs font-medium tabular-nums">
																{opt.price > 0
																	? `+$${opt.price.toFixed(2)}`
																	: 'Free'}
															</span>
														)}
													</button>
												)
											})
										)}
									</div>
								</div>
							)}
						</DialogContent>
					</Dialog>

					{/* Dialog for Editing an Option */}
					<Dialog
						open={Boolean(editingOption)}
						onOpenChange={(open) => {
							if (!open) setEditingOption(null)
						}}
					>
						<DialogContent className="sm:max-w-md">
							<DialogHeader>
								<DialogTitle>
									<Trans>Edit Option</Trans>
								</DialogTitle>
								<DialogDescription>
									<Trans>Update option details and pricing.</Trans>
								</DialogDescription>
							</DialogHeader>

							<div className="space-y-4 py-2">
								<div className="space-y-2">
									<Label>
										<Trans>Option Display Name (Guest-Facing)</Trans>
									</Label>
									<LocalizedInput
										value={modalDisplayName}
										onChange={setModalDisplayName}
										placeholder="e.g. Ranch, Pepperoni, Extra Cheese"
										required
									/>
								</div>

								<div className="space-y-2">
									<Label>
										<Trans>Internal Reference (Optional)</Trans>
									</Label>
									<Input
										value={modalInternalName}
										onChange={(e) => setModalInternalName(e.target.value)}
										placeholder="e.g. sauce_ranch_side"
									/>
								</div>

								{selectionType === 'pizza' ? (
									<div className="grid grid-cols-2 gap-3">
										<div className="space-y-1.5">
											<Label>
												<Trans>Whole pizza ($)</Trans>
											</Label>
											<Input
												type="number"
												step="0.01"
												min="0"
												value={modalPriceWhole || ''}
												onChange={(e) => {
													const val = parseFloat(e.target.value) || 0
													setModalPriceWhole(val)
													setModalPrice(val)
												}}
												placeholder="0.00"
											/>
										</div>
										<div className="space-y-1.5">
											<Label>
												<Trans>Left or right ($)</Trans>
											</Label>
											<Input
												type="number"
												step="0.01"
												min="0"
												value={modalPriceLeft || ''}
												onChange={(e) => {
													const val = parseFloat(e.target.value) || 0
													setModalPriceLeft(val)
													setModalPriceRight(val)
												}}
												placeholder={(modalPriceWhole > 0
													? modalPriceWhole / 2
													: 0
												).toFixed(2)}
											/>
										</div>
									</div>
								) : (
									<div className="space-y-1.5">
										<Label>
											<Trans>Price ($)</Trans>
										</Label>
										<Input
											type="number"
											step="0.01"
											min="0"
											value={modalPrice || ''}
											onChange={(e) => {
												const val = parseFloat(e.target.value) || 0
												setModalPrice(val)
												setModalPriceWhole(val)
											}}
											placeholder="0.00"
										/>
									</div>
								)}

								<div className="flex items-center gap-2 pt-1">
									<Checkbox
										id="modal-edit-preselected"
										checked={modalIsDefault}
										onCheckedChange={(c) => setModalIsDefault(Boolean(c))}
									/>
									<Label
										htmlFor="modal-edit-preselected"
										className="cursor-pointer text-xs font-normal"
									>
										<Trans>
											Preselected (Included when guests first open this group)
										</Trans>
									</Label>
								</div>

								<div className="space-y-2 pt-1">
									<Label>
										<Trans>Dietary Tags</Trans>
									</Label>
									<div className="flex flex-wrap items-center gap-2 text-xs">
										<button
											type="button"
											onClick={() => setModalIsGlutenFree(!modalIsGlutenFree)}
											className={cn(
												'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
												modalIsGlutenFree
													? 'border-amber-500/50 bg-amber-500/10 font-medium text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-400'
													: 'border-border/70 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
											)}
										>
											<Icon
												name={modalIsGlutenFree ? 'check' : 'plus'}
												className="size-3"
											/>
											<span>
												<Trans>Gluten-Free</Trans>
											</span>
										</button>
										<button
											type="button"
											onClick={() => setModalIsVegetarian(!modalIsVegetarian)}
											className={cn(
												'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
												modalIsVegetarian
													? 'border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400'
													: 'border-border/70 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
											)}
										>
											<Icon
												name={modalIsVegetarian ? 'check' : 'plus'}
												className="size-3"
											/>
											<span>
												<Trans>Vegetarian</Trans>
											</span>
										</button>
										<button
											type="button"
											onClick={() => setModalIsAlcohol(!modalIsAlcohol)}
											className={cn(
												'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors select-none',
												modalIsAlcohol
													? 'border-purple-500/50 bg-purple-500/10 font-medium text-purple-600 ring-1 ring-purple-500/20 dark:text-purple-400'
													: 'border-border/70 bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground',
											)}
										>
											<Icon
												name={modalIsAlcohol ? 'check' : 'plus'}
												className="size-3"
											/>
											<span>
												<Trans>Alcohol (21+)</Trans>
											</span>
										</button>
									</div>
								</div>

								<div className="border-border/70 bg-muted/20 space-y-2 rounded-lg border p-3">
									<div className="flex items-center gap-1.5">
										<Icon name="route" className="text-primary size-4" />
										<Label className="text-xs font-semibold">
											<Trans>Sub / Nested Modifier Groups</Trans>
										</Label>
									</div>
									<p className="text-muted-foreground text-[11px]">
										<Trans>
											When a customer selects this option, reveal these
											conditional modifier groups (e.g. selecting "French Fries"
											unlocks "Fry Size").
										</Trans>
									</p>
									{eligibleModifierGroups.length === 0 ? (
										<p className="text-muted-foreground text-xs italic">
											<Trans>No other modifier groups available to nest.</Trans>
										</p>
									) : (
										<div className="border-border/50 bg-background/50 max-h-36 space-y-1.5 overflow-y-auto rounded-md border p-2">
											{eligibleModifierGroups.map(
												(grp: {
													id: string
													name: string
													internalName: string | null
												}) => {
													const isChecked =
														modalNestedModifierGroupIds.includes(grp.id)
													const grpDisplayName =
														getLocalizedMenuValue(
															grp.name,
															activeLocale,
															defaultLocale,
														) ||
														grp.internalName ||
														grp.name
													return (
														<label
															key={grp.id}
															className="hover:bg-muted/50 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs"
														>
															<Checkbox
																checked={isChecked}
																onCheckedChange={(checked) => {
																	if (checked) {
																		setModalNestedModifierGroupIds((prev) => [
																			...prev,
																			grp.id,
																		])
																	} else {
																		setModalNestedModifierGroupIds((prev) =>
																			prev.filter((id) => id !== grp.id),
																		)
																	}
																}}
															/>
															<span className="text-foreground font-medium">
																{grpDisplayName}
															</span>
															{grp.internalName && (
																<span className="text-muted-foreground text-[10px]">
																	({grp.internalName})
																</span>
															)}
														</label>
													)
												},
											)}
										</div>
									)}
								</div>

								<DialogFooter className="gap-2 sm:justify-end">
									<Button
										type="button"
										variant="outline"
										onClick={() => setEditingOption(null)}
									>
										<Trans>Cancel</Trans>
									</Button>
									<Button type="button" onClick={handleSaveEditOption}>
										<Trans>Save Changes</Trans>
									</Button>
								</DialogFooter>
							</div>
						</DialogContent>
					</Dialog>
				</Form>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}
