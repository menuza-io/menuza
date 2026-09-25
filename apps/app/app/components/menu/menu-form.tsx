import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useState } from 'react'
import { Form } from 'react-router'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { cn } from '@repo/ui'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { Item, ItemContent, ItemTitle, ItemDescription } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'
import {
	LocaleContext,
	LocalizedInput,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { AvailabilityHoursSection } from './availability-hours-section.tsx'
import {
	LocationOverridesCard,
	type LocationItem,
	type LocationOverrideState,
} from './location-overrides-card.tsx'
import { MenuAvailabilityCard } from './menu-availability-card.tsx'
import { MenuFormHeader } from './menu-form-header.tsx'
import { AssignedSortableList } from './assigned-sortable-list.tsx'

export interface MenuFormData {
	displayName: string
	internalName: string
	menuType: 'online_pos_kiosk' | 'catering'
	nutritionalInfo: boolean
	specialInstructions: boolean
	availabilityStatus:
		| 'available'
		| 'unavailable_until'
		| 'unavailable_until_tomorrow'
		| 'unavailable'
	unavailableUntil?: Date | string | null
	availabilityHours?: string
	assignedCategoryIds: string[]
	locationOverrides: Record<string, LocationOverrideState>
}

interface MenuFormProps {
	initialData?: Partial<MenuFormData>
	orgSlug: string
	defaultLocale: string
	supportedLocales?: string[]
	allCategories: Array<{
		id: string
		displayName: string
		internalName: string | null
	}>
	allLocations: LocationItem[]
	isSubmitting: boolean
	pageTitle: string
}

export function MenuForm({
	initialData,
	orgSlug,
	defaultLocale,
	supportedLocales = [defaultLocale],
	allCategories,
	allLocations,
	isSubmitting,
	pageTitle,
}: MenuFormProps) {
	const { _ } = useLingui()
	const [activeLocale, setActiveLocale] = useState(defaultLocale)

	// State
	const [displayName, setDisplayName] = useState(
		initialData?.displayName ?? JSON.stringify({ [defaultLocale]: '' }),
	)
	const [internalName, setInternalName] = useState(
		initialData?.internalName ?? '',
	)
	const [menuType, setMenuType] = useState<'online_pos_kiosk' | 'catering'>(
		initialData?.menuType ?? 'online_pos_kiosk',
	)
	const [nutritionalInfo, setNutritionalInfo] = useState(
		initialData?.nutritionalInfo ?? true,
	)
	const [specialInstructions, setSpecialInstructions] = useState(
		initialData?.specialInstructions ?? true,
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
	const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(
		initialData?.assignedCategoryIds ?? [],
	)
	const [locationOverrides, setLocationOverrides] = useState<
		Record<string, LocationOverrideState>
	>(initialData?.locationOverrides ?? {})

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
					<input
						type="hidden"
						name="availabilityHours"
						value={availabilityHours}
					/>
					<input
						type="hidden"
						name="assignedCategoryIds"
						value={JSON.stringify(selectedCategoryIds)}
					/>
					<input
						type="hidden"
						name="locationOverrides"
						value={JSON.stringify(locationOverrides)}
					/>
					<input
						type="hidden"
						name="nutritionalInfo"
						value={String(nutritionalInfo)}
					/>
					<input
						type="hidden"
						name="specialInstructions"
						value={String(specialInstructions)}
					/>

					{/* Minimal Sticky Full-Width Header */}
					<MenuFormHeader
						pageTitle={pageTitle}
						backHref={`/${orgSlug}/menu/menus`}
						backLabel="Back to menus"
						saveButtonText="Save Menu"
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
											<Trans>Menu Information</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>Guest-facing name and internal identifier.</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="space-y-4">
										<div className="space-y-2">
											<Label>
												<Trans>Menu Name (Guest-Facing)</Trans>
											</Label>
											<LocalizedInput
												value={displayName}
												onChange={setDisplayName}
												placeholder="e.g. Lunch Menu, Dinner Specials, Main Dining"
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
												placeholder="e.g. 2026_spring_dinner_v2"
											/>
										</div>
									</FramePanel>
								</Frame>

								{/* Menu Type & Features Frame */}
								<Frame className="w-full" stackedPanels>
									<FrameHeader>
										<FrameTitle className="text-base">
											<Trans>Menu Type & Capabilities</Trans>
										</FrameTitle>
										<FrameDescription>
											<Trans>
												Define the ordering channel and guest information
												options.
											</Trans>
										</FrameDescription>
									</FrameHeader>
									<FramePanel className="p-5">
										<div className="space-y-3">
											<Label>
												<Trans>Menu Type</Trans>
											</Label>
											<RadioGroup
												name="menuType"
												value={menuType}
												onValueChange={(val: any) => setMenuType(val)}
												className="grid grid-cols-1 gap-3 sm:grid-cols-2"
											>
												<Item
													variant="outline"
													className={cn(
														'cursor-pointer items-start gap-3 p-3.5 transition-colors select-none',
														menuType === 'online_pos_kiosk' &&
															'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
													)}
													onClick={() => setMenuType('online_pos_kiosk')}
												>
													<RadioGroupItem
														value="online_pos_kiosk"
														id="type_online"
														className="mt-0.5"
													/>
													<ItemContent className="min-w-0">
														<ItemTitle>
															<Trans>Online Ordering, POS & Kiosk</Trans>
														</ItemTitle>
														<ItemDescription className="text-muted-foreground text-xs">
															<Trans>
																Standard restaurant menus for dine-in, takeout,
																and delivery.
															</Trans>
														</ItemDescription>
													</ItemContent>
												</Item>

												<Item
													variant="outline"
													className={cn(
														'cursor-pointer items-start gap-3 p-3.5 transition-colors select-none',
														menuType === 'catering' &&
															'border-primary/60 bg-primary/5 ring-primary/20 ring-1',
													)}
													onClick={() => setMenuType('catering')}
												>
													<RadioGroupItem
														value="catering"
														id="type_catering"
														className="mt-0.5"
													/>
													<ItemContent className="min-w-0">
														<ItemTitle>
															<Trans>Catering & Large Events</Trans>
														</ItemTitle>
														<ItemDescription className="text-muted-foreground text-xs">
															<Trans>
																Platters, party bundles, and advanced lead-time
																catering menus.
															</Trans>
														</ItemDescription>
													</ItemContent>
												</Item>
											</RadioGroup>
										</div>
									</FramePanel>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="nutrition-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Nutritional Information</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Show calorie counts and allergen warnings on this
													menu.
												</Trans>
											</p>
										</Label>
										<Switch
											id="nutrition-switch"
											checked={nutritionalInfo}
											onCheckedChange={setNutritionalInfo}
										/>
									</FramePanel>
									<FramePanel className="flex items-center justify-between px-5 py-3.5">
										<Label
											htmlFor="special-instructions-switch"
											className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
										>
											<div className="text-foreground text-sm">
												<Trans>Allow Special Instructions</Trans>
											</div>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Allow guests to add custom preparation notes to items.
												</Trans>
											</p>
										</Label>
										<Switch
											id="special-instructions-switch"
											checked={specialInstructions}
											onCheckedChange={setSpecialInstructions}
										/>
									</FramePanel>
								</Frame>

								<AssignedSortableList
									title={<Trans>Assigned Categories</Trans>}
									description={
										<Trans>Categories that belong to this menu.</Trans>
									}
									addLabel={<Trans>Add category</Trans>}
									selectionTitle={<Trans>Add a category</Trans>}
									selectionDescription={
										<Trans>Select a category to add to this menu.</Trans>
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
