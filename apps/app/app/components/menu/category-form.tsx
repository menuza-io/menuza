import { Trans } from '@lingui/macro'
import {
	getLocalizedMenuValue,
	getCategoryDepth,
	isValidParentCategory,
} from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { Item, ItemContent, ItemGroup, ItemTitle } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { useState, useMemo } from 'react'
import { Form } from 'react-router'
import {
	LocaleContext,
	LocalizedInput,
	LocalizedTextarea,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { AssignedSortableList } from './assigned-sortable-list.tsx'
import { AvailabilityHoursSection } from './availability-hours-section.tsx'
import {
	LocationOverridesCard,
	type LocationItem,
	type LocationOverrideState,
} from './location-overrides-card.tsx'
import { MenuAvailabilityCard } from './menu-availability-card.tsx'
import { MenuFormHeader } from './menu-form-header.tsx'

export interface CategoryFormData {
	parentId?: string | null
	displayName: string
	internalName: string
	description: string
	availabilityStatus:
		| 'available'
		| 'unavailable_until'
		| 'unavailable_until_tomorrow'
		| 'unavailable'
	unavailableUntil?: Date | string | null
	availabilityHours?: string
	excludeFromOverride: boolean
	assignedItemIds: string[]
	assignedMenuIds: string[]
	upsellCategoryIds: string[]
	locationOverrides: Record<string, LocationOverrideState>
}

interface CategoryFormProps {
	categoryId?: string
	initialData?: Partial<CategoryFormData>
	orgSlug: string
	defaultLocale: string
	supportedLocales?: string[]
	allItems: Array<{
		id: string
		displayName: string
		internalName: string | null
		price: number
	}>
	allMenus: Array<{
		id: string
		displayName: string
	}>
	allCategories: Array<{
		id: string
		displayName: string
		parentId?: string | null
	}>
	allLocations: LocationItem[]
	isSubmitting: boolean
	pageTitle: string
}

export function CategoryForm({
	categoryId,
	initialData,
	orgSlug,
	defaultLocale,
	supportedLocales = [defaultLocale],
	allItems,
	allMenus,
	allCategories,
	allLocations,
	isSubmitting,
	pageTitle,
}: CategoryFormProps) {
	const [activeLocale, setActiveLocale] = useState(defaultLocale)
	const [parentId, setParentId] = useState<string | null>(
		initialData?.parentId ?? null,
	)

	const categoriesMap = useMemo(
		() => new Map(allCategories.map((c) => [c.id, c])),
		[allCategories],
	)

	const eligibleCategories = useMemo(() => {
		return allCategories
			.filter((c) => {
				const check = isValidParentCategory(categoryId, c.id, allCategories, 3)
				return check.valid
			})
			.map((c) => {
				const depth = getCategoryDepth(c.id, categoriesMap)
				const name =
					getLocalizedMenuValue(c.displayName, activeLocale, defaultLocale) ||
					'Untitled'
				const indentPrefix = depth === 1 ? '' : depth === 2 ? '↳ ' : '↳↳ '
				const levelLabel = depth === 1 ? 'Top-Level' : `Level ${depth}`
				return {
					id: c.id,
					name,
					depth,
					indentPrefix,
					levelLabel,
				}
			})
	}, [allCategories, categoryId, categoriesMap, activeLocale, defaultLocale])

	const currentParentDepth = parentId
		? getCategoryDepth(parentId, categoriesMap)
		: 0

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
	const [availabilityHours, setAvailabilityHours] = useState(
		initialData?.availabilityHours ?? '',
	)
	const [excludeFromOverride, setExcludeFromOverride] = useState(
		initialData?.excludeFromOverride ?? false,
	)

	const [selectedItemIds, setSelectedItemIds] = useState<string[]>(
		initialData?.assignedItemIds ?? [],
	)
	const [selectedMenuIds, setSelectedMenuIds] = useState<string[]>(
		initialData?.assignedMenuIds ?? [],
	)
	const [selectedUpsellIds, setSelectedUpsellIds] = useState<Set<string>>(
		new Set(initialData?.upsellCategoryIds ?? []),
	)
	const [locationOverrides, setLocationOverrides] = useState<
		Record<string, LocationOverrideState>
	>(initialData?.locationOverrides ?? {})

	const toggleUpsell = (categoryId: string) => {
		setSelectedUpsellIds((prev) => {
			const next = new Set(prev)
			if (next.has(categoryId)) {
				next.delete(categoryId)
			} else {
				next.add(categoryId)
			}
			return next
		})
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
					{/* Hidden inputs to submit values */}
					<input type="hidden" name="parentId" value={parentId ?? ''} />
					<input type="hidden" name="displayName" value={displayName} />
					<input type="hidden" name="description" value={description} />
					<input
						type="hidden"
						name="availabilityHours"
						value={availabilityHours}
					/>
					<input
						type="hidden"
						name="assignedItemIds"
						value={JSON.stringify(selectedItemIds)}
					/>
					<input
						type="hidden"
						name="assignedMenuIds"
						value={JSON.stringify(selectedMenuIds)}
					/>
					<input
						type="hidden"
						name="upsellCategoryIds"
						value={JSON.stringify(Array.from(selectedUpsellIds))}
					/>
					<input
						type="hidden"
						name="locationOverrides"
						value={JSON.stringify(locationOverrides)}
					/>
					<input
						type="hidden"
						name="excludeFromOverride"
						value={String(excludeFromOverride)}
					/>

					{/* Minimal Sticky Full-Width Header */}
					<MenuFormHeader
						pageTitle={pageTitle}
						backHref={`/${orgSlug}/menu/categories`}
						backLabel="Back to categories"
						saveButtonText="Save Category"
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
											<Trans>Category Information</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Guest-facing name, internal identifier, and description.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4">
										<div className="space-y-2">
											<div className="flex items-center justify-between">
												<Label className="text-xs">
													<Trans>Parent Category (Hierarchy)</Trans>
												</Label>
												{parentId && (
													<Badge variant="secondary" className="text-[10px]">
														<Trans>
															Level {currentParentDepth + 1} Subcategory
														</Trans>
													</Badge>
												)}
											</div>
											<input
												type="hidden"
												name="parentId"
												value={parentId ?? ''}
											/>
											<Select
												value={parentId ?? 'none'}
												onValueChange={(val) => {
													setParentId(
														val === 'none' || !val ? null : (val as string),
													)
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue>
														{parentId
															? (() => {
																	const m = eligibleCategories.find(
																		(c) => c.id === parentId,
																	)
																	return m
																		? `${m.name} (${m.levelLabel})`
																		: parentId
																})()
															: 'None (Top-Level Category)'}
													</SelectValue>
												</SelectTrigger>
												<SelectContent align="start" className="max-h-60">
													<SelectItem value="none">
														<span className="text-muted-foreground">
															<Trans>None (Top-Level Category)</Trans>
														</span>
													</SelectItem>
													{eligibleCategories.map((cat) => (
														<SelectItem key={cat.id} value={cat.id}>
															<div className="flex items-center gap-2">
																{cat.depth > 1 && (
																	<span className="text-muted-foreground font-mono">
																		{cat.indentPrefix}
																	</span>
																)}
																<span>{cat.name}</span>
																<Badge
																	variant="outline"
																	className="px-1 py-0 text-[10px] font-normal"
																>
																	{cat.levelLabel}
																</Badge>
															</div>
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<p className="text-muted-foreground text-[11px]">
												<Trans>
													Nest up to 3 levels deep (e.g. Drinks &gt; Hot Coffees
													&gt; Americanos).
												</Trans>
											</p>
										</div>

										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Category Name (Guest-Facing)</Trans>
											</Label>
											<LocalizedInput
												value={displayName}
												onChange={setDisplayName}
												placeholder="e.g. Starters, Wood-Fired Pizza, Craft Cocktails"
												required
											/>
										</div>

										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Internal Reference (Optional)</Trans>
											</Label>
											<Input
												name="internalName"
												value={internalName}
												onChange={(e) => setInternalName(e.target.value)}
												placeholder="e.g. appetizers_main_kitchen"
											/>
										</div>

										<div className="space-y-2">
											<Label className="text-xs">
												<Trans>Description (Guest-Facing)</Trans>
											</Label>
											<LocalizedTextarea
												value={description}
												onChange={setDescription}
												placeholder="e.g. Handcrafted pizzas baked at 800°F with organic sourdough crust."
												rows={3}
											/>
										</div>
									</FramePanel>
								</Frame>

								<AssignedSortableList
									title={<Trans>Assigned Items</Trans>}
									description={
										<Trans>Dishes and beverages in this category.</Trans>
									}
									addLabel={<Trans>Add item</Trans>}
									selectionTitle={<Trans>Add an item</Trans>}
									selectionDescription={
										<Trans>Select an item to add to this category.</Trans>
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

								{/* Upsell Categories Frame */}
								<Frame className="w-full">
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Recommended Upsells & Pairings</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Suggest other categories as add-ons when guests browse
												this section (e.g. Sides, Wine Pairings).
											</Trans>
										</FrameDescription>
										<FrameAction>
											<Badge variant="secondary" className="text-xs">
												{selectedUpsellIds.size} selected
											</Badge>
										</FrameAction>
									</FrameHeader>
									<FramePanel>
										{allCategories.length === 0 ? (
											<p className="text-muted-foreground text-xs">
												<Trans>No other categories available for upsell.</Trans>
											</p>
										) : (
											<ItemGroup className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
												{allCategories.map((cat) => {
													const isChecked = selectedUpsellIds.has(cat.id)
													const catName =
														getLocalizedMenuValue(
															cat.displayName,
															defaultLocale,
															defaultLocale,
														) || 'Category'

													return (
														<Item
															key={cat.id}
															variant="outline"
															size="sm"
															className={cn(
																'cursor-pointer transition-colors select-none',
																isChecked &&
																	'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
															)}
															onClick={() => toggleUpsell(cat.id)}
														>
															<Checkbox
																checked={isChecked}
																onCheckedChange={() => toggleUpsell(cat.id)}
															/>
															<ItemContent className="min-w-0">
																<ItemTitle className="truncate text-xs font-medium">
																	{catName}
																</ItemTitle>
															</ItemContent>
														</Item>
													)
												})}
											</ItemGroup>
										)}
									</FramePanel>
								</Frame>

								<AvailabilityHoursSection
									value={availabilityHours}
									onChange={setAvailabilityHours}
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

								{/* Order Throttling / Operational Frame */}
								<Frame className="w-full" stackedPanels>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Kitchen Throttling Exemption</Trans>
										</FrameTitle>
										<FrameDescription className="text-xs">
											<Trans>
												Exclude items in this category from kitchen throttling
												and large order prep time delays (e.g. retail items,
												bottled drinks).
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="throttle-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Exempt from Throttling</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Items in this category will not add preparation delay
													to orders.
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

								<AssignedSortableList
									title={<Trans>Assigned Menus</Trans>}
									description={<Trans>Menus that display this category.</Trans>}
									addLabel={<Trans>Add menu</Trans>}
									selectionTitle={<Trans>Add a menu</Trans>}
									selectionDescription={
										<Trans>Select a menu to display this category.</Trans>
									}
									emptyMessage={
										<Trans>
											No menus assigned yet. Add a menu to make this category
											visible.
										</Trans>
									}
									entries={allMenus.map((menu) => ({
										id: menu.id,
										name:
											getLocalizedMenuValue(
												menu.displayName,
												defaultLocale,
												defaultLocale,
											) || 'Menu',
									}))}
									selectedIds={selectedMenuIds}
									onChange={setSelectedMenuIds}
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
				</Form>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}
