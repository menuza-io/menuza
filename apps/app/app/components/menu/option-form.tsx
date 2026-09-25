import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useMemo, useState } from 'react'
import { Form } from 'react-router'
import { getLocalizedMenuValue, type Allergen } from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemGroup,
	ItemContent,
	ItemTitle,
	ItemDescription,
	ItemActions,
} from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { MenuAvailabilityCard } from './menu-availability-card.tsx'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'
import {
	LocaleContext,
	LocalizedInput,
	LocalizedTextarea,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import {
	LocationOverridesCard,
	type LocationItem,
	type LocationOverrideState,
} from './location-overrides-card.tsx'
import { MenuAllergenSelector } from './menu-allergen-selector.tsx'
import { MenuFormHeader } from './menu-form-header.tsx'

export interface OptionFormData {
	displayName: string
	internalName: string
	description: string
	price: number
	priceWhole: number | null
	priceLeft: number | null
	priceRight: number | null
	calories: number | null
	minSelections: number
	maxSelections: number | null
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	isTopping: boolean
	allergens: string[]
	applySalesTax: boolean
	availabilityStatus: string
	unavailableUntil?: Date | string | null
	imageKey: string | null
	imageUrl: string | null
	modifierGroupIds: string[]
	nestedModifierGroupIds?: string[]
	locationOverrides?: Record<string, LocationOverrideState>
}

interface OptionFormProps {
	orgSlug: string
	initialData?: Partial<OptionFormData>
	availableModifierGroups: Array<{
		id: string
		name: string
		internalName: string | null
		selectionType?: string | null
	}>
	locations: LocationItem[]
	supportedLocales: string[]
	defaultLocale: string
	isSubmitting?: boolean
	pageTitle: React.ReactNode
	actionError?: unknown
}

export function OptionForm({
	orgSlug,
	initialData,
	availableModifierGroups,
	locations,
	supportedLocales,
	defaultLocale,
	isSubmitting,
	pageTitle,
	actionError,
}: OptionFormProps) {
	const { _ } = useLingui()
	const [activeLocale, setActiveLocale] = useState(defaultLocale)

	// Form state
	const [displayName, setDisplayName] = useState(initialData?.displayName ?? '')
	const [internalName, setInternalName] = useState(
		initialData?.internalName ?? '',
	)
	const [description, setDescription] = useState(initialData?.description ?? '')
	const [price, setPrice] = useState<number>(() => {
		const base = initialData?.price ?? 0
		if (initialData?.isTopping) {
			return initialData.priceWhole ?? base
		}
		return base
	})
	const [priceWhole, setPriceWhole] = useState<number | null>(
		initialData?.priceWhole ?? null,
	)
	const [priceLeft, setPriceLeft] = useState<number | null>(
		initialData?.priceLeft ?? null,
	)
	const [priceRight, setPriceRight] = useState<number | null>(
		initialData?.priceRight ?? null,
	)

	const setHalfPrice = (value: number | null) => {
		setPriceLeft(value)
		setPriceRight(value)
	}
	const [calories, setCalories] = useState<number | null>(
		initialData?.calories ?? null,
	)
	const [minSelections, setMinSelections] = useState<number>(
		initialData?.minSelections ?? 0,
	)
	const [maxSelections, setMaxSelections] = useState<number | null>(
		initialData?.maxSelections ?? null,
	)

	// Image state
	const [imageKey, setImageKey] = useState<string | null>(
		initialData?.imageKey ?? null,
	)
	const [imageUrl, setImageUrl] = useState<string | null>(
		initialData?.imageUrl ?? null,
	)
	const [isMediaPickerOpen, setIsMediaPickerOpen] = useState(false)

	// Dietary & Flags
	const [isAlcohol, setIsAlcohol] = useState(initialData?.isAlcohol ?? false)
	const [isGlutenFree, setIsGlutenFree] = useState(
		initialData?.isGlutenFree ?? false,
	)
	const [isVegetarian, setIsVegetarian] = useState(
		initialData?.isVegetarian ?? false,
	)
	const [allergens, setAllergens] = useState<string[]>(
		initialData?.allergens ?? [],
	)
	const [applySalesTax, setApplySalesTax] = useState(
		initialData?.applySalesTax ?? true,
	)
	const [availabilityStatus, setAvailabilityStatus] = useState(
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

	// Modifier Group Assignments (Many-to-Many)
	const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
		new Set(initialData?.modifierGroupIds ?? []),
	)

	// Automatically acts as Pizza Topping if any assigned group has selectionType === 'pizza'
	const isTopping = useMemo(() => {
		return Array.from(selectedGroupIds).some((groupId) => {
			const group = availableModifierGroups.find((g) => g.id === groupId)
			return group?.selectionType === 'pizza'
		})
	}, [selectedGroupIds, availableModifierGroups])

	// Location overrides
	const [locationOverrides, setLocationOverrides] = useState<
		Record<string, LocationOverrideState>
	>(initialData?.locationOverrides ?? {})

	const toggleAllergen = (allergen: Allergen) => {
		setAllergens((prev) =>
			prev.includes(allergen)
				? prev.filter((a) => a !== allergen)
				: [...prev, allergen],
		)
	}

	const [nestedModifierGroupIds, setNestedModifierGroupIds] = useState<
		string[]
	>(initialData?.nestedModifierGroupIds ?? [])

	const toggleNestedModifierGroup = (groupId: string) => {
		setNestedModifierGroupIds((prev) =>
			prev.includes(groupId)
				? prev.filter((id) => id !== groupId)
				: [...prev, groupId],
		)
	}

	const toggleModifierGroup = (groupId: string) => {
		setSelectedGroupIds((prev) => {
			const next = new Set(prev)
			if (next.has(groupId)) {
				next.delete(groupId)
			} else {
				next.add(groupId)
			}
			return next
		})
	}

	const handleImageSelected = (asset: MediaLibraryAsset) => {
		setImageKey(asset.id)
		setImageUrl(asset.url)
		setIsMediaPickerOpen(false)
	}

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
					{/* Hidden inputs to submit complex values */}
					<input type="hidden" name="displayName" value={displayName} />
					<input type="hidden" name="description" value={description} />
					<input type="hidden" name="imageKey" value={imageKey || ''} />
					<input type="hidden" name="imageUrl" value={imageUrl || ''} />
					<input
						type="hidden"
						name="isAlcohol"
						value={isAlcohol ? 'true' : 'false'}
					/>
					<input
						type="hidden"
						name="isGlutenFree"
						value={isGlutenFree ? 'true' : 'false'}
					/>
					<input
						type="hidden"
						name="isVegetarian"
						value={isVegetarian ? 'true' : 'false'}
					/>
					<input
						type="hidden"
						name="isTopping"
						value={isTopping ? 'true' : 'false'}
					/>
					<input
						type="hidden"
						name="applySalesTax"
						value={applySalesTax ? 'true' : 'false'}
					/>
					<input
						type="hidden"
						name="allergens"
						value={JSON.stringify(allergens)}
					/>
					<input
						type="hidden"
						name="modifierGroupIds"
						value={JSON.stringify(Array.from(selectedGroupIds))}
					/>
					<input
						type="hidden"
						name="locationOverrides"
						value={JSON.stringify(locationOverrides)}
					/>

					{/* Minimal Sticky Full-Width Header */}
					<MenuFormHeader
						pageTitle={pageTitle}
						backHref={`/${orgSlug}/menu/options`}
						backLabel={t`Back to options`}
						saveButtonText={t`Save Option`}
						isSubmitting={isSubmitting}
					/>

					{/* 2-Column Shopify Layout */}
					<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
						{actionError ? (
							<div className="border-destructive/20 bg-destructive/10 text-destructive mb-6 rounded-lg border p-4 text-sm">
								<p className="font-semibold">
									<Trans>
										Failed to save option. Please check the fields below.
									</Trans>
								</p>
							</div>
						) : null}
						<div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
							{/* Main Column (8 cols) */}
							<div className="flex flex-col gap-6 lg:col-span-8">
								{/* Option Media / Photo Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Option Photo</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												High-resolution photos increase ordering conversion by
												over 30%. Stored in your organization's Media Library.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel>
										<div className="flex flex-col gap-4 sm:flex-row sm:items-center">
											<div className="bg-muted flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border">
												{imageUrl ? (
													<img
														src={imageUrl}
														alt={getLocalizedMenuValue(
															displayName,
															activeLocale,
															defaultLocale,
														)}
														className="h-full w-full object-cover"
													/>
												) : (
													<Icon
														name="image"
														className="text-muted-foreground/30 size-10"
													/>
												)}
											</div>
											<div className="flex flex-col gap-2">
												<div className="flex flex-wrap items-center gap-2">
													<Button
														type="button"
														variant="outline"
														size="sm"
														onClick={() => setIsMediaPickerOpen(true)}
													>
														<Icon name="image" className="size-4" />
														{imageUrl ? (
															<Trans>Change Photo</Trans>
														) : (
															<Trans>Select Photo</Trans>
														)}
													</Button>
													{imageUrl && (
														<Button
															type="button"
															variant="ghost"
															size="sm"
															className="text-destructive hover:bg-destructive/10"
															onClick={() => {
																setImageUrl(null)
																setImageKey(null)
															}}
														>
															<Icon name="trash-2" className="size-4" />
															<Trans>Remove</Trans>
														</Button>
													)}
												</div>
												<p className="text-muted-foreground text-xs">
													<Trans>
														Option photos are displayed in online ordering menus
														and modifier trays.
													</Trans>
												</p>
											</div>
										</div>
									</FramePanel>
								</Frame>

								{/* Option Information Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Option Information</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Guest-facing name, internal SKU, and description.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4">
										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Option Name (Guest-Facing)</Trans>
											</Label>
											<LocalizedInput
												value={displayName}
												onChange={setDisplayName}
												placeholder="e.g. Extra Cheese, Ranch Dressing, Oat Milk"
												required
											/>
										</div>

										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Internal Reference / SKU (Optional)</Trans>
											</Label>
											<Input
												name="internalName"
												value={internalName}
												onChange={(e) => setInternalName(e.target.value)}
												placeholder="e.g. opt_extra_cheese_v1"
											/>
										</div>

										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Description (Guest-Facing)</Trans>
											</Label>
											<LocalizedTextarea
												value={description}
												onChange={setDescription}
												placeholder="e.g. Aged sharp white cheddar melted to perfection."
											/>
										</div>
									</FramePanel>
								</Frame>

								{/* Pricing Frame */}
								<Frame className="w-full" stackedPanels>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Pricing & Tax</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Set baseline option price delta and sales tax settings.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4 p-5">
										<div
											className={cn(
												'grid grid-cols-1 gap-4',
												isTopping && 'sm:grid-cols-2',
											)}
										>
											<div className="space-y-2">
												<Label className="text-xs" htmlFor="option-base-price">
													{isTopping ? (
														<Trans>Whole pizza price ($)</Trans>
													) : (
														<Trans>Base Price Delta ($)</Trans>
													)}
												</Label>
												<Input
													id="option-base-price"
													type="number"
													name="price"
													step="0.01"
													min="0"
													value={price || ''}
													onChange={(e) => {
														const next = parseFloat(e.target.value) || 0
														setPrice(next)
														if (isTopping) {
															setPriceWhole(next)
														}
													}}
													placeholder="0.00"
												/>
												<p className="text-muted-foreground text-[11px]">
													{isTopping ? (
														<Trans>
															Extra charge when this topping is added to the
															whole pizza.
														</Trans>
													) : (
														<Trans>
															Enter 0.00 for no extra charge (e.g. Free choice).
														</Trans>
													)}
												</p>
											</div>

											{isTopping && (
												<div className="space-y-2">
													<input
														type="hidden"
														name="priceWhole"
														value={price}
													/>
													<input
														type="hidden"
														name="priceLeft"
														value={priceLeft ?? ''}
													/>
													<input
														type="hidden"
														name="priceRight"
														value={priceRight ?? ''}
													/>
													<Label
														className="text-xs"
														htmlFor="option-price-half"
													>
														<Trans>Half pizza price ($)</Trans>
													</Label>
													<Input
														id="option-price-half"
														type="number"
														step="0.01"
														min="0"
														value={priceLeft ?? priceRight ?? ''}
														onChange={(e) =>
															setHalfPrice(
																e.target.value
																	? parseFloat(e.target.value)
																	: null,
															)
														}
														placeholder={(price / 2).toFixed(2)}
													/>
													<p className="text-muted-foreground text-[11px]">
														<Trans>Same price for left or right half.</Trans>
													</p>
												</div>
											)}
										</div>

										{isTopping && (
											<p className="text-muted-foreground text-xs">
												<Trans>
													Whole / half pricing is on because this option is
													assigned to a pizza-style modifier group.
												</Trans>
											</p>
										)}

										<div className="border-border grid grid-cols-1 gap-4 border-t pt-2 sm:grid-cols-2">
											<div className="space-y-2">
												<Label className="text-xs">
													<Trans>Minimum Selections</Trans>
												</Label>
												<Input
													type="number"
													name="minSelections"
													min="0"
													value={minSelections}
													onChange={(e) =>
														setMinSelections(parseInt(e.target.value) || 0)
													}
												/>
											</div>

											<div className="space-y-2">
												<Label className="text-xs">
													<Trans>Maximum Selections (Optional)</Trans>
												</Label>
												<Input
													type="number"
													name="maxSelections"
													min="1"
													value={maxSelections ?? ''}
													onChange={(e) =>
														setMaxSelections(
															e.target.value ? parseInt(e.target.value) : null,
														)
													}
													placeholder="Leave blank for no limit"
												/>
											</div>
										</div>
									</FramePanel>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="tax-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Apply Sales Tax</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Charge sales tax on this option at checkout.
												</Trans>
											</p>
										</Label>
										<Switch
											id="tax-switch"
											checked={applySalesTax}
											onCheckedChange={setApplySalesTax}
										/>
									</FramePanel>
								</Frame>

								{/* Dietary, Allergens & Calories Frame */}
								<Frame className="w-full lg:grid lg:grid-cols-[minmax(0,15.5rem)_minmax(0,1fr)] lg:gap-1 [&>[data-slot=frame-panel-header]]:col-span-full [&>[data-slot=frame-panel]+[data-slot=frame-panel]]:lg:mt-0">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Dietary, Allergens & Calories</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>
												Guest dietary tags and allergen disclosure information.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="flex flex-col gap-3.5 py-3.5">
										<div className="divide-border/60 bg-background divide-y overflow-hidden rounded-md border">
											<div className="flex items-center justify-between gap-3 px-3 py-2.5">
												<Label
													htmlFor="option-dietary-gf-switch"
													className="min-w-0 flex-1 cursor-pointer font-normal"
												>
													<span className="text-foreground text-sm font-medium">
														<Trans>Gluten-Free</Trans>
													</span>
												</Label>
												<Switch
													id="option-dietary-gf-switch"
													checked={isGlutenFree}
													onCheckedChange={setIsGlutenFree}
													className="shrink-0"
												/>
											</div>
											<div className="flex items-center justify-between gap-3 px-3 py-2.5">
												<Label
													htmlFor="option-dietary-veg-switch"
													className="min-w-0 flex-1 cursor-pointer font-normal"
												>
													<span className="text-foreground text-sm font-medium">
														<Trans>Vegetarian</Trans>
													</span>
												</Label>
												<Switch
													id="option-dietary-veg-switch"
													checked={isVegetarian}
													onCheckedChange={setIsVegetarian}
													className="shrink-0"
												/>
											</div>
											<div className="flex items-center justify-between gap-3 px-3 py-2.5">
												<Label
													htmlFor="option-dietary-alc-switch"
													className="min-w-0 flex-1 cursor-pointer font-normal"
												>
													<span className="text-foreground text-sm font-medium">
														<Trans>Alcoholic</Trans>
													</span>
												</Label>
												<Switch
													id="option-dietary-alc-switch"
													checked={isAlcohol}
													onCheckedChange={setIsAlcohol}
													className="shrink-0"
												/>
											</div>
										</div>
										<div className="flex flex-col gap-2">
											<Label className="text-xs">
												<Trans>Calories (kCal)</Trans>
											</Label>
											<Input
												type="number"
												name="calories"
												min="0"
												value={calories ?? ''}
												onChange={(e) =>
													setCalories(
														e.target.value ? parseInt(e.target.value) : null,
													)
												}
												placeholder="e.g. 120"
												className="text-xs"
											/>
										</div>
									</FramePanel>
									<FramePanel className="py-3.5">
										<MenuAllergenSelector
											variant="ledger"
											selectedAllergens={allergens}
											onToggle={toggleAllergen}
										/>
									</FramePanel>
								</Frame>

								{/* Modifier Groups Assignment (Many-to-Many) Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Assigned Modifier Groups</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Select all modifier groups where this option should
												appear. Assigning to a Pizza Topping group automatically
												enables whole/half split pricing.
											</Trans>
										</FrameDescription>
										<FrameAction>
											<Badge variant="secondary" className="text-xs">
												{selectedGroupIds.size} selected
											</Badge>
										</FrameAction>
									</FrameHeader>
									<FramePanel>
										{availableModifierGroups.length === 0 ? (
											<div className="border-border text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
												<Trans>
													No modifier groups found. You can create modifier
													groups first in the Modifier Groups tab.
												</Trans>
											</div>
										) : (
											<ItemGroup className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
												{availableModifierGroups.map((group) => {
													const isSelected = selectedGroupIds.has(group.id)
													const isPizzaGroup = group.selectionType === 'pizza'
													return (
														<Item
															key={group.id}
															variant="outline"
															size="sm"
															className={cn(
																'cursor-pointer justify-between transition-colors select-none',
																isSelected &&
																	'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
															)}
															onClick={() => toggleModifierGroup(group.id)}
														>
															<div className="flex min-w-0 flex-1 items-center gap-2.5">
																<Checkbox
																	id={`group-opt-${group.id}`}
																	checked={isSelected}
																	onCheckedChange={() =>
																		toggleModifierGroup(group.id)
																	}
																/>
																<ItemContent className="min-w-0">
																	<ItemTitle className="truncate text-xs font-medium">
																		{getLocalizedMenuValue(
																			group.name,
																			activeLocale,
																			defaultLocale,
																		)}
																	</ItemTitle>
																	{group.internalName && (
																		<ItemDescription className="truncate text-[11px]">
																			{group.internalName}
																		</ItemDescription>
																	)}
																</ItemContent>
															</div>
															<ItemActions className="shrink-0">
																{isPizzaGroup ? (
																	<Badge
																		variant="outline"
																		className="border-sky-500/40 text-[10px] font-medium text-sky-600 dark:text-sky-400"
																	>
																		<Trans>Pizza Topping</Trans>
																	</Badge>
																) : (
																	<Badge
																		variant="outline"
																		className="text-muted-foreground text-[10px] capitalize"
																	>
																		{group.selectionType === 'single' ? (
																			<Trans>Single</Trans>
																		) : group.selectionType === 'multiple' ? (
																			<Trans>Multiple</Trans>
																		) : group.selectionType === 'quantity' ? (
																			<Trans>Quantity</Trans>
																		) : (
																			(group.selectionType ?? 'standard')
																		)}
																	</Badge>
																)}
															</ItemActions>
														</Item>
													)
												})}
											</ItemGroup>
										)}
									</FramePanel>
								</Frame>
								{/* Nested / Sub Modifier Groups (Conditional Modifiers) */}
								<Frame className="w-full">
									<FrameHeader>
										<div className="flex items-center justify-between">
											<FrameTitle className="text-base">
												<Trans>Nested / Sub-Modifier Groups</Trans>
											</FrameTitle>
											{nestedModifierGroupIds.length > 0 && (
												<Badge variant="secondary" className="text-xs">
													{nestedModifierGroupIds.length}{' '}
													{nestedModifierGroupIds.length === 1
														? 'group'
														: 'groups'}
												</Badge>
											)}
										</div>
										<FrameDescription>
											<Trans>
												When a customer selects this option, reveal these
												conditional modifier groups (e.g. selecting "French
												Fries" unlocks "Fry Size").
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-3">
										{availableModifierGroups.filter(
											(g) => !selectedGroupIds.has(g.id),
										).length === 0 ? (
											<p className="text-muted-foreground py-4 text-center text-xs">
												<Trans>
													No other modifier groups available to nest.
												</Trans>
											</p>
										) : (
											<ItemGroup className="divide-border/60 divide-y rounded-md border">
												{availableModifierGroups
													.filter((g) => !selectedGroupIds.has(g.id))
													.map((group) => {
														const isSelected = nestedModifierGroupIds.includes(
															group.id,
														)
														return (
															<Item
																key={group.id}
																className={cn(
																	'flex cursor-pointer items-center justify-between p-3 transition-colors',
																	isSelected &&
																		'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
																)}
																onClick={() =>
																	toggleNestedModifierGroup(group.id)
																}
															>
																<div className="flex min-w-0 flex-1 items-center gap-2.5">
																	<Checkbox
																		id={`nested-group-${group.id}`}
																		checked={isSelected}
																		onCheckedChange={() =>
																			toggleNestedModifierGroup(group.id)
																		}
																	/>
																	<ItemContent className="min-w-0">
																		<ItemTitle className="truncate text-xs font-medium">
																			{getLocalizedMenuValue(
																				group.name,
																				activeLocale,
																				defaultLocale,
																			)}
																		</ItemTitle>
																		{group.internalName && (
																			<ItemDescription className="truncate text-[11px]">
																				{group.internalName}
																			</ItemDescription>
																		)}
																	</ItemContent>
																</div>
																<Badge
																	variant="outline"
																	className="text-muted-foreground text-[10px] capitalize"
																>
																	{group.selectionType ?? 'standard'}
																</Badge>
															</Item>
														)
													})}
											</ItemGroup>
										)}
									</FramePanel>
								</Frame>
							</div>

							{/* Sidebar Column (4 cols) */}
							<div className="flex flex-col gap-6 lg:col-span-4">
								{/* Status Frame */}
								<MenuAvailabilityCard
									value={availabilityStatus}
									onChange={(val: any) => setAvailabilityStatus(val)}
									unavailableUntil={unavailableUntil}
									onUnavailableUntilChange={setUnavailableUntil}
									locations={locations}
								/>

								{/* Location Overrides Card */}
								<LocationOverridesCard
									locations={locations}
									overrides={locationOverrides}
									onChange={setLocationOverrides}
									allowPriceOverride={true}
									basePrice={price}
								/>
							</div>
						</div>
					</div>
				</Form>

				{/* Media Library Picker Modal */}
				<MediaLibraryPicker
					className="hidden"
					open={isMediaPickerOpen}
					onOpenChange={setIsMediaPickerOpen}
					onSelect={handleImageSelected}
					orgSlug={orgSlug}
				/>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}
