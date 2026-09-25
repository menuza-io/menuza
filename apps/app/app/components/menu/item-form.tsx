import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useState } from 'react'
import { Form } from 'react-router'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
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
import { AssignedSortableList } from './assigned-sortable-list.tsx'

export interface ItemFormData {
	displayName: string
	internalName: string
	description: string
	price: number
	imageKey: string | null
	imageUrl: string | null
	images: ItemImage[]
	isAlcohol: boolean
	isGlutenFree: boolean
	isVegetarian: boolean
	allergens: string[]
	calorieMin?: number | null
	calorieMax?: number | null
	applySalesTax: boolean
	excludeFromOverride: boolean
	isPopular: boolean
	isUpsell: boolean
	availabilityStatus:
		| 'available'
		| 'unavailable_until'
		| 'unavailable_until_tomorrow'
		| 'unavailable'
	unavailableUntil?: Date | string | null
	assignedCategoryIds: string[]
	assignedModifierGroupIds: string[]
	locationOverrides: Record<string, LocationOverrideState>
}

type ItemImage = {
	key: string
	url: string
}

interface ItemFormProps {
	initialData?: Partial<ItemFormData>
	orgSlug: string
	defaultLocale: string
	supportedLocales?: string[]
	allCategories: Array<{
		id: string
		displayName: string
		internalName: string | null
	}>
	allModifierGroups: Array<{
		id: string
		name: string
		selectionType: string
	}>
	allLocations: LocationItem[]
	isSubmitting: boolean
	pageTitle: string
}

export function ItemForm({
	initialData,
	orgSlug,
	defaultLocale,
	supportedLocales = [defaultLocale],
	allCategories,
	allModifierGroups,
	allLocations,
	isSubmitting,
	pageTitle,
}: ItemFormProps) {
	const { _ } = useLingui()
	const [activeLocale, setActiveLocale] = useState(defaultLocale)

	// State
	const [displayName, setDisplayName] = useState(
		initialData?.displayName ?? JSON.stringify({ [defaultLocale]: '' }),
	)
	const [internalName, setInternalName] = useState(
		initialData?.internalName ?? '',
	)
	const [description, setDescription] = useState(
		initialData?.description ?? JSON.stringify({ [defaultLocale]: '' }),
	)
	const [price, setPrice] = useState<number>(initialData?.price ?? 0)
	const [images, setImages] = useState<ItemImage[]>(
		initialData?.images ??
			(initialData?.imageKey && initialData.imageUrl
				? [{ key: initialData.imageKey, url: initialData.imageUrl }]
				: []),
	)
	const [mediaPickerOpen, setMediaPickerOpen] = useState(false)

	const [isAlcohol, setIsAlcohol] = useState(initialData?.isAlcohol ?? false)
	const [isGlutenFree, setIsGlutenFree] = useState(
		initialData?.isGlutenFree ?? false,
	)
	const [isVegetarian, setIsVegetarian] = useState(
		initialData?.isVegetarian ?? false,
	)
	const [allergens, setAllergens] = useState<Set<string>>(
		new Set(initialData?.allergens ?? []),
	)
	const [calorieMin, setCalorieMin] = useState<string>(
		initialData?.calorieMin !== undefined && initialData?.calorieMin !== null
			? String(initialData.calorieMin)
			: '',
	)
	const [calorieMax, setCalorieMax] = useState<string>(
		initialData?.calorieMax !== undefined && initialData?.calorieMax !== null
			? String(initialData.calorieMax)
			: '',
	)
	const [applySalesTax, setApplySalesTax] = useState(
		initialData?.applySalesTax ?? true,
	)
	const [excludeFromOverride, setExcludeFromOverride] = useState(
		initialData?.excludeFromOverride ?? false,
	)
	const [isPopular, setIsPopular] = useState(initialData?.isPopular ?? false)
	const [isUpsell, setIsUpsell] = useState(initialData?.isUpsell ?? false)
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

	const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(
		initialData?.assignedCategoryIds ?? [],
	)
	const [selectedModifierGroupIds, setSelectedModifierGroupIds] = useState<
		string[]
	>(initialData?.assignedModifierGroupIds ?? [])
	const [locationOverrides, setLocationOverrides] = useState<
		Record<string, LocationOverrideState>
	>(initialData?.locationOverrides ?? {})

	const toggleAllergen = (allergenKey: string) => {
		setAllergens((prev) => {
			const next = new Set(prev)
			if (next.has(allergenKey)) {
				next.delete(allergenKey)
			} else {
				next.add(allergenKey)
			}
			return next
		})
	}

	const handleSelectMedia = (asset: MediaLibraryAsset) => {
		setImages((currentImages) => {
			if (
				currentImages.length >= 5 ||
				currentImages.some((image) => image.key === asset.objectKey)
			) {
				return currentImages
			}

			return [...currentImages, { key: asset.objectKey, url: asset.url }]
		})
		setMediaPickerOpen(false)
	}

	const removeImage = (imageKey: string) => {
		setImages((currentImages) =>
			currentImages.filter((image) => image.key !== imageKey),
		)
	}

	const primaryImage = images[0] ?? null
	const photoCount = images.length

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
					<input type="hidden" name="displayName" value={displayName} />
					<input type="hidden" name="description" value={description} />
					<input
						type="hidden"
						name="imageKey"
						value={primaryImage?.key ?? ''}
					/>
					<input
						type="hidden"
						name="imageUrl"
						value={primaryImage?.url ?? ''}
					/>
					<input
						type="hidden"
						name="imageKeys"
						value={JSON.stringify(images.map((image) => image.key))}
					/>
					<input type="hidden" name="isAlcohol" value={String(isAlcohol)} />
					<input
						type="hidden"
						name="isGlutenFree"
						value={String(isGlutenFree)}
					/>
					<input
						type="hidden"
						name="isVegetarian"
						value={String(isVegetarian)}
					/>
					<input
						type="hidden"
						name="allergens"
						value={JSON.stringify(Array.from(allergens))}
					/>
					<input
						type="hidden"
						name="applySalesTax"
						value={String(applySalesTax)}
					/>
					<input
						type="hidden"
						name="excludeFromOverride"
						value={String(excludeFromOverride)}
					/>
					<input type="hidden" name="isPopular" value={String(isPopular)} />
					<input type="hidden" name="isUpsell" value={String(isUpsell)} />
					<input
						type="hidden"
						name="assignedCategoryIds"
						value={JSON.stringify(selectedCategoryIds)}
					/>
					<input
						type="hidden"
						name="assignedModifierGroupIds"
						value={JSON.stringify(selectedModifierGroupIds)}
					/>
					<input
						type="hidden"
						name="locationOverrides"
						value={JSON.stringify(locationOverrides)}
					/>

					{/* Minimal Sticky Full-Width Header */}
					<MenuFormHeader
						pageTitle={pageTitle}
						backHref={`/${orgSlug}/menu/items`}
						backLabel="Back to items"
						saveButtonText="Save Item"
						isSubmitting={isSubmitting}
					/>

					{/* 2-Column Shopify Layout */}
					<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
						<div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
							{/* Main Left Column (8 cols) */}
							<div className="flex flex-col gap-6 lg:col-span-8">
								{/* Item Media / Photo Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Item Photos</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Add up to five high-resolution photos. The first photo
												is used on menu cards. Photos are stored in your
												organization's Media Library.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel>
										<div className="space-y-4">
											{images.length > 0 ? (
												<div className="flex flex-wrap gap-3">
													{images.map((image, index) => (
														<div
															key={image.key}
															className="bg-muted relative size-24 overflow-hidden rounded-xl border"
														>
															<img
																src={image.url}
																alt={
																	index === 0
																		? 'Primary item photo'
																		: 'Item photo'
																}
																className="size-full object-cover"
															/>
															{index === 0 ? (
																<span className="bg-background/90 text-foreground absolute right-1 bottom-1 rounded px-1.5 py-0.5 text-[10px] font-medium">
																	<Trans>Primary</Trans>
																</span>
															) : null}
															<Button
																type="button"
																variant="secondary"
																size="icon-xs"
																className="absolute top-1 right-1"
																onClick={() => removeImage(image.key)}
																aria-label={_(t`Remove photo`)}
															>
																<Icon name="trash-2" className="size-3" />
															</Button>
														</div>
													))}
												</div>
											) : (
												<div className="bg-muted flex size-24 items-center justify-center rounded-xl border">
													<Icon
														name="image"
														className="text-muted-foreground/30 size-10"
													/>
												</div>
											)}
											<div className="flex flex-wrap items-center gap-2">
												<Button
													type="button"
													variant="outline"
													size="sm"
													disabled={photoCount >= 5}
													onClick={() => setMediaPickerOpen(true)}
												>
													<Icon name="image" className="size-4" />
													{photoCount === 0 ? (
														<Trans>Select Photos</Trans>
													) : (
														<Trans>Add Photo</Trans>
													)}
												</Button>
												<span className="text-muted-foreground text-xs">
													<Trans>{photoCount}/5 photos</Trans>
												</span>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Accepts JPG, PNG, WebP up to 5MB. Uploads go directly
													to your media library.
												</Trans>
											</p>
										</div>
									</FramePanel>
								</Frame>

								{/* Basic Details Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Item Information</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Dish or drink title, description, and internal SKU/code.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4">
										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Item Name (Guest-Facing)</Trans>
											</Label>
											<LocalizedInput
												value={displayName}
												onChange={setDisplayName}
												placeholder="e.g. Truffle Mushroom Risotto, Aperol Spritz"
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
												placeholder="e.g. risotto_truffle_v1"
											/>
										</div>

										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Description (Guest-Facing)</Trans>
											</Label>
											<LocalizedTextarea
												value={description}
												onChange={setDescription}
												placeholder="e.g. Creamy Carnaroli rice with wild chanterelles, black truffle shavings, aged Parmigiano Reggiano."
												rows={3}
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
												Set baseline dish price and sales tax settings.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="p-5">
										<div className="max-w-xs space-y-2">
											<Label htmlFor="price-input" className="text-xs">
												<Trans>Base Price ($)</Trans>
											</Label>
											<Input
												id="price-input"
												type="number"
												name="price"
												step="0.01"
												min="0"
												value={price || ''}
												onChange={(e) =>
													setPrice(parseFloat(e.target.value) || 0)
												}
												placeholder="0.00"
												required
											/>
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
												<Trans>Charge tax at checkout.</Trans>
											</p>
										</Label>
										<Switch
											id="tax-switch"
											checked={applySalesTax}
											onCheckedChange={setApplySalesTax}
										/>
									</FramePanel>
								</Frame>

								{/* Modifier Groups Assignment Frame */}
								<AssignedSortableList
									title={<Trans>Modifier Groups</Trans>}
									description={
										<Trans>
											Custom options, toppings, sides, and choices offered with
											this item.
										</Trans>
									}
									addLabel={<Trans>Add group</Trans>}
									selectionTitle={<Trans>Add a modifier group</Trans>}
									selectionDescription={
										<Trans>Select a modifier group for this item.</Trans>
									}
									emptyMessage={
										<Trans>
											No modifier groups assigned yet. Add one to get started.
										</Trans>
									}
									entries={allModifierGroups.map((group) => ({
										id: group.id,
										name:
											getLocalizedMenuValue(
												group.name,
												defaultLocale,
												defaultLocale,
											) || 'Modifier Group',
										meta: group.selectionType,
									}))}
									selectedIds={selectedModifierGroupIds}
									onChange={setSelectedModifierGroupIds}
								/>

								{/* Nutrition, Dietary & Allergens Frame */}
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
													htmlFor="dietary-gf-switch"
													className="min-w-0 flex-1 cursor-pointer font-normal"
												>
													<span className="text-foreground text-sm font-medium">
														<Trans>Gluten-Free</Trans>
													</span>
												</Label>
												<Switch
													id="dietary-gf-switch"
													checked={isGlutenFree}
													onCheckedChange={setIsGlutenFree}
													className="shrink-0"
												/>
											</div>
											<div className="flex items-center justify-between gap-3 px-3 py-2.5">
												<Label
													htmlFor="dietary-veg-switch"
													className="min-w-0 flex-1 cursor-pointer font-normal"
												>
													<span className="text-foreground text-sm font-medium">
														<Trans>Vegetarian</Trans>
													</span>
												</Label>
												<Switch
													id="dietary-veg-switch"
													checked={isVegetarian}
													onCheckedChange={setIsVegetarian}
													className="shrink-0"
												/>
											</div>
											<div className="flex items-center justify-between gap-3 px-3 py-2.5">
												<Label
													htmlFor="dietary-alc-switch"
													className="min-w-0 flex-1 cursor-pointer font-normal"
												>
													<span className="text-foreground text-sm font-medium">
														<Trans>Alcoholic</Trans>
													</span>
												</Label>
												<Switch
													id="dietary-alc-switch"
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
											<div className="flex flex-col gap-1.5">
												<Input
													type="number"
													name="calorieMin"
													min="0"
													placeholder="Min (e.g. 450)"
													value={calorieMin}
													onChange={(e) => setCalorieMin(e.target.value)}
													className="text-xs"
												/>
												<Input
													type="number"
													name="calorieMax"
													min="0"
													placeholder="Max (e.g. 600)"
													value={calorieMax}
													onChange={(e) => setCalorieMax(e.target.value)}
													className="text-xs"
												/>
											</div>
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

								{/* Category Assignment Frame */}
								<AssignedSortableList
									title={<Trans>Assigned Categories</Trans>}
									description={
										<Trans>
											Categories that display this item on the menu.
										</Trans>
									}
									addLabel={<Trans>Add category</Trans>}
									selectionTitle={<Trans>Add a category</Trans>}
									selectionDescription={
										<Trans>Select a category to display this item.</Trans>
									}
									emptyMessage={
										<Trans>
											No categories assigned yet. Add a category to get started.
										</Trans>
									}
									entries={allCategories.map((category) => ({
										id: category.id,
										name:
											getLocalizedMenuValue(
												category.displayName,
												defaultLocale,
												defaultLocale,
											) ||
											category.internalName ||
											'Category',
										description: category.internalName,
									}))}
									selectedIds={selectedCategoryIds}
									onChange={setSelectedCategoryIds}
								/>
							</div>

							{/* Sidebar Right Column (4 cols) */}
							<div className="flex flex-col gap-6 lg:col-span-4">
								{/* Status Frame */}
								<MenuAvailabilityCard
									value={availabilityStatus}
									onChange={(val: any) => setAvailabilityStatus(val)}
									unavailableUntil={unavailableUntil}
									onUnavailableUntilChange={setUnavailableUntil}
									locations={allLocations}
								/>

								{/* Promotions & Highlights Frame */}
								<Frame className="w-full" stackedPanels>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Promotions & Highlights</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Feature this item prominently in ordering flows.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="popular-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Popular Item</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>Show "Popular" badge on menus.</Trans>
											</p>
										</Label>
										<Switch
											id="popular-switch"
											checked={isPopular}
											onCheckedChange={setIsPopular}
										/>
									</FramePanel>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="upsell-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Promote as Upsell</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>Suggest as an add-on at checkout.</Trans>
											</p>
										</Label>
										<Switch
											id="upsell-switch"
											checked={isUpsell}
											onCheckedChange={setIsUpsell}
										/>
									</FramePanel>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="throttle-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Exclude from Throttling</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Exempt from kitchen prep delay calculations.
												</Trans>
											</p>
										</Label>
										<Switch
											id="throttle-switch"
											checked={excludeFromOverride}
											onCheckedChange={setExcludeFromOverride}
										/>
									</FramePanel>
								</Frame>

								{/* Location Availability & Price Overrides Card */}
								<LocationOverridesCard
									locations={allLocations}
									overrides={locationOverrides}
									onChange={setLocationOverrides}
									allowPriceOverride={true}
									basePrice={price}
								/>
							</div>
						</div>
					</div>
				</Form>
				<MediaLibraryPicker
					className="hidden"
					orgSlug={orgSlug}
					open={mediaPickerOpen}
					onOpenChange={setMediaPickerOpen}
					onSelect={handleSelectMedia}
				/>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}
