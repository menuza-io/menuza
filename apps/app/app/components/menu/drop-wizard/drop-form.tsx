import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DropInput,
	type DropPickupWindowInput,
	type DropInventoryInput,
	type DropReminderInput,
	type DropStatus,
	DROP_STATUS_LABELS,
	DROP_CHECKOUT_HOLD_OPTIONS,
	generatePickupSlots,
} from '@repo/common/menu-types'
import { getOrgSiteUrl } from '@repo/common/url'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
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
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from '@repo/ui/input-group'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import slugify from '@sindresorhus/slugify'
import { useState, useMemo } from 'react'
import { Form, Link, useActionData, useNavigation } from 'react-router'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'
import { MenuFormHeader } from '#app/components/menu/menu-form-header.tsx'
import { MenuStatusBadge } from '#app/components/menu/menu-status-badge.tsx'
import {
	CreatePickupWindowDrawer,
	ItemInventoryDrawer,
	SectionInventoryDrawer,
	AddReminderModal,
	type LocationOption,
} from './drop-drawers.tsx'

export interface AvailableMenuItem {
	id: string
	displayName: string
	price: number
	imageKey?: string | null
	imageUrl?: string | null
}

export interface AvailableMenuCategory {
	id: string
	displayName: string
	internalName?: string | null
	items: AvailableMenuItem[]
}

export interface AvailableMenu {
	id: string
	displayName: string
	internalName?: string | null
	availabilityStatus?: string | null
	categories: AvailableMenuCategory[]
}

function inventoryOverridesForMenu(
	overrides: DropInventoryInput[],
	menu: AvailableMenu | undefined,
) {
	if (!menu) return []
	const categoryIds = new Set(menu.categories.map((category) => category.id))
	const itemIds = new Set(
		menu.categories.flatMap((category) =>
			category.items.map((item) => item.id),
		),
	)
	return overrides.filter((override) =>
		override.entityType === 'category'
			? categoryIds.has(override.entityId)
			: itemIds.has(override.entityId),
	)
}

export interface DropFormProps {
	pageTitle?: string
	orgSlug: string
	locations: LocationOption[]
	availableMenus: AvailableMenu[]
	initialData?: Partial<DropInput> & {
		id?: string
		menuId?: string
	}
	isEdit?: boolean
	currency?: string
}

function formatToLocalDateTimeInput(dateInput?: Date | string | null): string {
	if (!dateInput) return ''
	const d = new Date(dateInput)
	if (isNaN(d.getTime())) return ''
	const pad = (n: number) => n.toString().padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatCurrency(amount: number, currency: string = 'USD') {
	return new Intl.NumberFormat(undefined, {
		style: 'currency',
		currency,
	}).format(amount)
}

function formatTime12(timeStr?: string | null): string {
	if (!timeStr) return ''
	const [hStr, mStr] = timeStr.split(':')
	if (!hStr) return timeStr
	const h = parseInt(hStr, 10)
	if (isNaN(h)) return timeStr
	const m = mStr || '00'
	const period = h >= 12 ? 'PM' : 'AM'
	const h12 = h % 12 === 0 ? 12 : h % 12
	return `${h12}:${m} ${period}`
}

function formatDisplayDate(dateStr?: string | null): string {
	if (!dateStr) return ''
	try {
		const [year, month, day] = dateStr.split('-').map(Number)
		if (!year || !month || !day) return dateStr
		const d = new Date(year, month - 1, day)
		return d.toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		})
	} catch {
		return dateStr
	}
}

export function DropForm({
	pageTitle,
	orgSlug,
	locations,
	availableMenus,
	initialData,
	isEdit = false,
	currency = 'USD',
}: DropFormProps) {
	const { _ } = useLingui()
	const navigation = useNavigation()
	const actionData = useActionData<{
		errors?: Record<string, string[] | undefined>
	}>()
	const isSubmitting = navigation.state === 'submitting'
	const saveErrors = Object.values(actionData?.errors ?? {})
		.flat()
		.filter((message): message is string => Boolean(message))

	// Basic Details State
	const [title, setTitle] = useState(initialData?.title || '')
	const [slug, setSlug] = useState(initialData?.slug || '')
	const [isSlugManuallyEdited, setIsSlugManuallyEdited] = useState(
		Boolean(initialData?.slug),
	)
	const [description, setDescription] = useState(initialData?.description || '')
	const [coverImageUrl, setCoverImageUrl] = useState<string | null>(
		initialData?.coverImageUrl || null,
	)
	const [coverImageKey, setCoverImageKey] = useState<string | null>(
		initialData?.coverImageKey || null,
	)
	const [mediaPickerOpen, setMediaPickerOpen] = useState(false)

	// Menu Selection State (selecting existing menu)
	const [selectedMenuId, setSelectedMenuId] = useState<string>(
		initialData?.menuId || (availableMenus[0]?.id ?? ''),
	)

	const selectedMenu = useMemo(
		() => availableMenus.find((m) => m.id === selectedMenuId),
		[availableMenus, selectedMenuId],
	)

	// Pickup Windows
	const [pickupWindows, setPickupWindows] = useState<DropPickupWindowInput[]>(
		initialData?.pickupWindows || [],
	)
	const [ordersOpenAt, setOrdersOpenAt] = useState<string>(
		formatToLocalDateTimeInput(initialData?.ordersOpenAt),
	)
	const [ordersCloseAt, setOrdersCloseAt] = useState<string>(
		formatToLocalDateTimeInput(initialData?.ordersCloseAt),
	)

	// Inventory Overrides (section caps & item caps)
	const [inventoryOverrides, setInventoryOverrides] = useState<
		DropInventoryInput[]
	>(initialData?.inventoryOverrides || [])

	// Sidebar / Schedule / Options State
	const [status, setStatus] = useState<DropStatus>(
		initialData?.status || 'draft',
	)
	const [visibility, setVisibility] = useState<'public' | 'unlisted'>(
		initialData?.visibility || 'public',
	)
	const [checkoutHoldMinutes, setCheckoutHoldMinutes] = useState(
		initialData?.checkoutHoldMinutes || 5,
	)
	const [showOrdersOpenTime, setShowOrdersOpenTime] = useState(
		initialData?.showOrdersOpenTime ?? true,
	)
	const [showMenuPreview, setShowMenuPreview] = useState(
		initialData?.showMenuPreview ?? true,
	)
	const [showInventoryRemaining, setShowInventoryRemaining] = useState(
		initialData?.showInventoryRemaining ?? true,
	)
	const [includeGiftCard, setIncludeGiftCard] = useState(
		initialData?.includeGiftCard ?? false,
	)

	// Reminders
	const [reminders, setReminders] = useState<DropReminderInput[]>(
		initialData?.reminders && initialData.reminders.length > 0
			? initialData.reminders
			: [
					{
						title: `${title || 'Our shop'} is about to drop!`,
						message:
							'Orders are officially open. Get your favorites before they sell out!',
						triggerType: 'before_open',
						scheduledAt: new Date(),
						status: 'pending',
					},
					{
						title:
							'We are close to running out, only two hours left before orders close!',
						message: 'Final chance to place your order before the drop ends.',
						triggerType: 'before_close',
						scheduledAt: new Date(),
						status: 'pending',
					},
				],
	)

	// Modals & Drawers
	const [createWindowOpen, setCreateWindowOpen] = useState(false)
	const [itemInventoryOpen, setItemInventoryOpen] = useState(false)
	const [selectedItemForInventory, setSelectedItemForInventory] =
		useState<AvailableMenuItem | null>(null)
	const [sectionInventoryOpen, setSectionInventoryOpen] = useState(false)
	const [selectedCategoryForInventory, setSelectedCategoryForInventory] =
		useState<AvailableMenuCategory | null>(null)
	const [addReminderOpen, setAddReminderOpen] = useState(false)
	const [editingPickupIndex, setEditingPickupIndex] = useState<number | null>(
		null,
	)
	const [editingReminderIndex, setEditingReminderIndex] = useState<
		number | null
	>(null)

	const locationMap = useMemo(
		() => new Map(locations.map((loc) => [loc.id, loc])),
		[locations],
	)

	const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value
		setTitle(val)
		if (!isSlugManuallyEdited) {
			setSlug(slugify(val, { lowercase: true, separator: '-' }))
		}
	}

	const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setIsSlugManuallyEdited(true)
		setSlug(slugify(e.target.value, { lowercase: true, separator: '-' }))
	}

	const handleSelectCoverAsset = (asset: MediaLibraryAsset) => {
		setCoverImageKey(asset.objectKey)
		setCoverImageUrl(asset.url)
		setMediaPickerOpen(false)
	}

	// Inventory override helper
	const handleSaveInventoryOverride = (override: DropInventoryInput) => {
		setInventoryOverrides((prev) => {
			const filtered = prev.filter(
				(item) =>
					!(
						item.entityType === override.entityType &&
						item.entityId === override.entityId
					),
			)
			return [...filtered, override]
		})
	}

	const handleSavePickupWindow = (window: DropPickupWindowInput) => {
		setPickupWindows((prev) => {
			if (editingPickupIndex != null) {
				return prev.map((existing, i) =>
					i === editingPickupIndex
						? { ...window, id: existing.id ?? window.id }
						: existing,
				)
			}
			return [...prev, window]
		})
		setEditingPickupIndex(null)
	}

	const handleRemoveWindow = (index: number) => {
		setPickupWindows((prev) => prev.filter((_, i) => i !== index))
	}

	const openNewPickupWindow = () => {
		setEditingPickupIndex(null)
		setCreateWindowOpen(true)
	}

	const openEditPickupWindow = (index: number) => {
		setEditingPickupIndex(index)
		setCreateWindowOpen(true)
	}

	const handleSaveReminder = (reminder: DropReminderInput) => {
		setReminders((prev) => {
			if (editingReminderIndex != null) {
				return prev.map((existing, i) =>
					i === editingReminderIndex
						? { ...reminder, id: existing.id ?? reminder.id }
						: existing,
				)
			}
			return [...prev, reminder]
		})
		setEditingReminderIndex(null)
	}

	const handleRemoveReminder = (index: number) => {
		setReminders((prev) => prev.filter((_, i) => i !== index))
	}

	const openNewReminder = () => {
		setEditingReminderIndex(null)
		setAddReminderOpen(true)
	}

	const openEditReminder = (index: number) => {
		setEditingReminderIndex(index)
		setAddReminderOpen(true)
	}

	const dropSlugPrefix = `${getOrgSiteUrl(orgSlug)}/drop/`

	return (
		<div className="flex min-h-screen flex-col">
			<Form method="post" className="flex flex-1 flex-col">
				<MenuFormHeader
					pageTitle={
						pageTitle || (isEdit ? _(msg`Edit Drop`) : _(msg`Create Drop`))
					}
					backHref={`/${orgSlug}/menu/drops`}
					backLabel={_(msg`Back to drops`)}
					saveButtonText={_(msg`Save Drop`)}
					isSubmitting={isSubmitting}
				/>

				{saveErrors.length > 0 ? (
					<div className="mx-auto w-full max-w-6xl px-4 pt-4 md:px-6 lg:px-8">
						<div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm">
							{saveErrors.map((message) => (
								<p key={message}>{message}</p>
							))}
						</div>
					</div>
				) : null}

				{/* Hidden JSON serialization fields for backend */}
				<input
					type="hidden"
					name="pickupWindows"
					value={JSON.stringify(pickupWindows)}
				/>
				<input
					type="hidden"
					name="inventoryOverrides"
					value={JSON.stringify(
						inventoryOverridesForMenu(inventoryOverrides, selectedMenu),
					)}
				/>
				<input
					type="hidden"
					name="reminders"
					value={JSON.stringify(reminders)}
				/>
				<input type="hidden" name="coverImageKey" value={coverImageKey || ''} />
				<input type="hidden" name="coverImageUrl" value={coverImageUrl || ''} />

				{/* 2-Column Shopify Layout */}
				<div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
					<div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
						{/* Left Column (8 cols): Primary Content */}
						<div className="space-y-6 lg:col-span-8">
							{/* Frame 1: Drop Details */}
							<Frame className="w-full">
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Drop Information</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>
											Name, slug identifier, storefront banner, and custom note
											to guests.
										</Trans>
									</FrameDescription>
								</FrameHeader>
								<FramePanel className="space-y-4">
									<div className="space-y-2">
										<Label htmlFor="drop-title" className="text-sm font-medium">
											<Trans>Drop Title</Trans>{' '}
											<span className="text-destructive">*</span>
										</Label>
										<Input
											id="drop-title"
											name="title"
											value={title}
											onChange={handleTitleChange}
											placeholder={_(msg`e.g. Sourdough Saturday Drop #12`)}
											required
											className="w-full"
										/>
									</div>

									<div className="space-y-2">
										<Label htmlFor="drop-slug" className="text-sm font-medium">
											<Trans>URL Slug</Trans>
										</Label>
										<InputGroup>
											<InputGroupAddon>
												<InputGroupText>{dropSlugPrefix}</InputGroupText>
											</InputGroupAddon>
											<InputGroupInput
												id="drop-slug"
												name="slug"
												value={slug}
												onChange={handleSlugChange}
												placeholder="sourdough-saturday-drop"
											/>
										</InputGroup>
									</div>

									<div className="space-y-2">
										<Label
											htmlFor="drop-description"
											className="text-sm font-medium"
										>
											<Trans>Note to Customers</Trans>
										</Label>
										<Textarea
											id="drop-description"
											name="description"
											value={description}
											onChange={(e) => setDescription(e.target.value)}
											placeholder={_(
												msg`Share pickup instructions, special reheating tips, or what makes this drop special...`,
											)}
											rows={3}
											className="resize-none"
										/>
									</div>

									{/* Cover Banner Image */}
									<div className="space-y-2 pt-2">
										<Label className="text-sm font-medium">
											<Trans>Cover Banner Image</Trans>
										</Label>
										{coverImageUrl ? (
											<div className="group bg-muted/40 relative aspect-video max-w-lg overflow-hidden rounded-lg border">
												<img
													src={coverImageUrl}
													alt={title}
													className="h-full w-full object-cover"
												/>
												<div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
													<Button
														type="button"
														variant="secondary"
														size="sm"
														onClick={() => setMediaPickerOpen(true)}
													>
														<Trans>Replace</Trans>
													</Button>
													<Button
														type="button"
														variant="destructive"
														size="sm"
														onClick={() => {
															setCoverImageUrl(null)
															setCoverImageKey(null)
														}}
													>
														<Trans>Remove</Trans>
													</Button>
												</div>
											</div>
										) : (
											<div
												onClick={() => setMediaPickerOpen(true)}
												className="hover:bg-muted/40 max-w-lg cursor-pointer rounded-lg border border-dashed p-6 text-center transition-colors"
											>
												<Icon
													name="image"
													className="text-muted-foreground/60 mx-auto mb-2 size-8"
												/>
												<p className="text-xs font-medium">
													<Trans>Click to choose a cover image</Trans>
												</p>
												<p className="text-muted-foreground mt-0.5 text-[11px]">
													<Trans>Recommended 16:9 banner ratio</Trans>
												</p>
											</div>
										)}
									</div>
								</FramePanel>
							</Frame>

							{/* Frame 2: Menu Selection (Selecting Existing Menu) */}
							<Frame className="w-full">
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Menu</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>
											Choose which menu this drop sells. Hidden menus are fine.
										</Trans>
									</FrameDescription>
									<FrameAction>
										<div className="flex items-center gap-1.5">
											{selectedMenu && (
												<Button
													type="button"
													variant="outline"
													size="xs"
													className="h-8 gap-1 text-xs"
													render={
														<Link
															to={`/${orgSlug}/menu/menus/${selectedMenu.id}`}
															target="_blank"
														/>
													}
												>
													<Icon name="pencil" className="size-3" />
													<Trans>Edit</Trans>
													<Icon
														name="external-link"
														className="text-muted-foreground ml-0.5 size-2.5"
													/>
												</Button>
											)}
											<Button
												type="button"
												variant={selectedMenu ? 'ghost' : 'outline'}
												size="xs"
												className="h-8 gap-1 text-xs"
												render={
													<Link
														to={`/${orgSlug}/menu/menus/new`}
														target="_blank"
													/>
												}
											>
												<Icon name="plus" className="size-3" />
												<Trans>New menu</Trans>
											</Button>
										</div>
									</FrameAction>
								</FrameHeader>
								<FramePanel className="space-y-4">
									{/* Menu Selector Dropdown */}
									<div className="space-y-1.5">
										<div className="flex items-center justify-between">
											<Label
												htmlFor="drop-menu-select"
												className="text-sm font-medium"
											>
												<Trans>Menu</Trans>{' '}
												<span className="text-destructive">*</span>
											</Label>
											{selectedMenu && (
												<div className="text-muted-foreground flex items-center gap-1.5 text-xs">
													<span>
														{selectedMenu.categories.length}{' '}
														{selectedMenu.categories.length === 1
															? _(msg`category`)
															: _(msg`categories`)}
													</span>
													<span>•</span>
													<span>
														{selectedMenu.categories.reduce(
															(acc, c) => acc + c.items.length,
															0,
														)}{' '}
														<Trans>items</Trans>
													</span>
												</div>
											)}
										</div>
										<Select
											value={selectedMenuId}
											onValueChange={(val) => {
												if (!val || val === selectedMenuId) return
												setSelectedMenuId(val)
												const nextMenu = availableMenus.find(
													(menu) => menu.id === val,
												)
												setInventoryOverrides((current) =>
													inventoryOverridesForMenu(current, nextMenu),
												)
											}}
										>
											<SelectTrigger id="drop-menu-select" className="w-full">
												<SelectValue
													placeholder={_(msg`Choose an existing menu...`)}
												>
													{selectedMenu ? (
														<div className="flex items-center gap-2">
															<span className="font-medium">
																{selectedMenu.displayName}
															</span>
															{selectedMenu.internalName && (
																<span className="text-muted-foreground text-xs">
																	{selectedMenu.internalName}
																</span>
															)}
															<MenuStatusBadge
																status={selectedMenu.availabilityStatus}
																className="ml-auto"
															/>
														</div>
													) : (
														_(msg`Choose an existing menu...`)
													)}
												</SelectValue>
											</SelectTrigger>
											<SelectContent>
												{availableMenus.length === 0 ? (
													<SelectItem value="none" disabled>
														<Trans>
															No menus found. Please create a menu first.
														</Trans>
													</SelectItem>
												) : (
													availableMenus.map((menu) => (
														<SelectItem key={menu.id} value={menu.id}>
															<div className="flex w-full items-center gap-2">
																<span className="font-medium">
																	{menu.displayName}
																</span>
																{menu.internalName && (
																	<span className="text-muted-foreground text-xs">
																		({menu.internalName})
																	</span>
																)}
																<span className="text-muted-foreground text-xs">
																	• {menu.categories.length}{' '}
																	{menu.categories.length === 1
																		? 'category'
																		: 'categories'}
																</span>
																<span className="text-muted-foreground text-xs">
																	•{' '}
																	{menu.availabilityStatus === 'hidden'
																		? 'Hidden'
																		: menu.availabilityStatus === 'available'
																			? 'Available'
																			: 'Unavailable'}
																</span>
															</div>
														</SelectItem>
													))
												)}
											</SelectContent>
										</Select>
										<input type="hidden" name="menuId" value={selectedMenuId} />
									</div>

									{selectedMenu ? (
										<div className="border-border/60 space-y-3 border-t pt-2">
											<div>
												<h4 className="text-foreground text-sm font-semibold">
													<Trans>Inventory limits</Trans>
												</h4>
												<p className="text-muted-foreground text-xs">
													<Trans>Optional caps per section or item.</Trans>
												</p>
											</div>

											{selectedMenu.categories.length === 0 ? (
												<div className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-xs">
													<Trans>
														This menu has no categories assigned yet. Go to
														Menus to add categories and items.
													</Trans>
												</div>
											) : (
												<div className="divide-border/50 divide-y">
													{selectedMenu.categories.map((cat) => {
														const catOverride = inventoryOverrides.find(
															(inv) =>
																inv.entityType === 'category' &&
																inv.entityId === cat.id,
														)
														const hasCatCap = catOverride?.inventory != null
														const pooledCount = catOverride?.inventory

														return (
															<div key={cat.id}>
																<div className="flex items-center justify-between gap-3 py-3.5">
																	<div className="flex min-w-0 items-center gap-2.5">
																		<span className="text-foreground truncate text-sm font-semibold">
																			{cat.displayName}
																		</span>
																		<span className="text-muted-foreground shrink-0 text-[11px]">
																			{cat.items.length}{' '}
																			{cat.items.length === 1
																				? _(msg`item`)
																				: _(msg`items`)}
																		</span>
																		{hasCatCap && pooledCount != null && (
																			<span className="text-primary shrink-0 text-[11px]">
																				<Trans>{pooledCount} pooled</Trans>
																			</span>
																		)}
																	</div>
																	<Button
																		type="button"
																		variant="ghost"
																		size="xs"
																		className="text-foreground h-auto shrink-0 px-0 text-xs font-medium hover:bg-transparent"
																		onClick={() => {
																			setSelectedCategoryForInventory(cat)
																			setSectionInventoryOpen(true)
																		}}
																	>
																		{hasCatCap ? (
																			<Trans>Edit section cap</Trans>
																		) : (
																			<Trans>Section cap</Trans>
																		)}
																	</Button>
																</div>

																{cat.items.length === 0 ? (
																	<p className="text-muted-foreground pb-3 text-xs italic">
																		<Trans>No items in this section.</Trans>
																	</p>
																) : (
																	cat.items.map((item) => {
																		const itemOverride =
																			inventoryOverrides.find(
																				(inv) =>
																					inv.entityType === 'item' &&
																					inv.entityId === item.id,
																			)
																		const hasItemCap =
																			itemOverride?.inventory != null

																		return (
																			<div
																				key={item.id}
																				className="flex items-center justify-between gap-3 py-3"
																			>
																				<div className="min-w-0">
																					<p className="text-foreground truncate text-sm">
																						{item.displayName}
																					</p>
																					<p className="text-muted-foreground text-xs">
																						{formatCurrency(
																							item.price,
																							currency,
																						)}
																					</p>
																				</div>
																				<div className="flex shrink-0 items-center gap-2">
																					{hasItemCap && (
																						<span className="text-muted-foreground text-xs tabular-nums">
																							{itemOverride.inventory}
																						</span>
																					)}
																					<Button
																						type="button"
																						variant="ghost"
																						size="xs"
																						className="text-muted-foreground hover:text-foreground h-auto px-0 text-xs hover:bg-transparent"
																						onClick={() => {
																							setSelectedItemForInventory(item)
																							setItemInventoryOpen(true)
																						}}
																					>
																						{hasItemCap ? (
																							<Trans>Edit</Trans>
																						) : (
																							<Trans>Cap</Trans>
																						)}
																					</Button>
																				</div>
																			</div>
																		)
																	})
																)}
															</div>
														)
													})}
												</div>
											)}
										</div>
									) : (
										<div className="rounded-lg border border-dashed p-8 text-center">
											<Icon
												name="book-open"
												className="text-muted-foreground/60 mx-auto mb-2 size-8"
											/>
											<h4 className="text-sm font-medium">
												<Trans>No menu selected</Trans>
											</h4>
											<p className="text-muted-foreground mt-1 mb-4 text-xs">
												<Trans>
													Select an existing menu above to attach to this drop.
												</Trans>
											</p>
										</div>
									)}
								</FramePanel>
							</Frame>

							{/* Frame 3: Pickup Schedule & Fulfillment Windows */}
							<Frame className="w-full" stackedPanels>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Pickup Schedule & Fulfillment</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>
											Configure collection dates, time spans, interval
											durations, and order slot capacity.
										</Trans>
									</FrameDescription>
									<FrameAction>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={openNewPickupWindow}
										>
											<Icon name="plus" className="mr-1.5 size-4" />
											<Trans>Add Pickup Window</Trans>
										</Button>
									</FrameAction>
								</FrameHeader>
								{pickupWindows.length === 0 ? (
									<FramePanel className="p-8 text-center">
										<Icon
											name="calendar"
											className="text-muted-foreground/60 mx-auto mb-2 size-8"
										/>
										<h4 className="text-sm font-medium">
											<Trans>No pickup windows scheduled</Trans>
										</h4>
										<p className="text-muted-foreground mt-1 mb-4 text-xs">
											<Trans>
												Add dates and collection time slots when customers can
												pick up their orders.
											</Trans>
										</p>
										<Button
											type="button"
											variant="secondary"
											size="sm"
											onClick={openNewPickupWindow}
										>
											<Icon name="plus" className="mr-1.5 size-4" />
											<Trans>Add Pickup Window</Trans>
										</Button>
									</FramePanel>
								) : (
									pickupWindows.map((pw, idx) => {
										const loc = locationMap.get(pw.locationId)
										const slotInterval = pw.slotIntervalMinutes || 30
										const slots = generatePickupSlots(
											pw.startTime,
											pw.endTime,
											slotInterval,
										)
										const slotPreview = slots.slice(0, 6)
										const slotCount = slots.length
										const hiddenSlotCount = Math.max(
											0,
											slotCount - slotPreview.length,
										)
										const maxOrdersPerSlot = pw.maxOrdersPerSlot
										const totalWindowCapacity =
											maxOrdersPerSlot != null
												? slotCount * maxOrdersPerSlot
												: null
										const windowCapacity = totalWindowCapacity
										const moreSlots = hiddenSlotCount

										const metaParts = [
											`${formatTime12(pw.startTime)} – ${formatTime12(pw.endTime)}`,
											loc?.name,
											`${slotInterval} ${_(msg`min intervals`)}`,
											maxOrdersPerSlot != null
												? `${maxOrdersPerSlot} ${_(msg`orders per slot`)}`
												: null,
										].filter(Boolean)

										return (
											<FramePanel
												key={idx}
												className="flex items-start justify-between gap-3 px-5 py-3.5"
											>
												<div className="min-w-0 flex-1 space-y-1">
													<p className="text-foreground text-sm font-medium">
														{formatDisplayDate(pw.date)}
													</p>
													<p className="text-muted-foreground text-xs">
														{metaParts.join(' · ')}
													</p>
													{windowCapacity != null && (
														<p className="text-muted-foreground text-[11px]">
															<Trans>
																{windowCapacity} orders max in this window
															</Trans>
														</p>
													)}
													{slotCount > 0 && (
														<p className="text-muted-foreground text-[11px] leading-relaxed">
															<span>
																{slotCount === 1
																	? _(msg`1 pickup slot`)
																	: _(msg`${slotCount} pickup slots`)}
															</span>
															<span className="text-foreground/90">
																{' · '}
																{slotPreview
																	.map((slot) => slot.displayTime)
																	.join(', ')}
																{hiddenSlotCount > 0 && (
																	<>
																		{', '}
																		<Trans>+{moreSlots} more</Trans>
																	</>
																)}
															</span>
														</p>
													)}
												</div>
												<div className="mt-0.5 flex shrink-0 items-center gap-0.5">
													<Button
														type="button"
														variant="ghost"
														size="icon-xs"
														onClick={() => openEditPickupWindow(idx)}
														className="text-muted-foreground hover:text-foreground"
														title={_(msg`Edit pickup window`)}
													>
														<Icon name="pencil" className="size-3.5" />
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon-xs"
														onClick={() => handleRemoveWindow(idx)}
														className="text-muted-foreground hover:text-destructive"
														title={_(msg`Remove pickup window`)}
													>
														<Icon name="trash-2" className="size-3.5" />
													</Button>
												</div>
											</FramePanel>
										)
									})
								)}
							</Frame>
						</div>

						<div className="space-y-6 lg:col-span-4">
							{/* Status & Visibility */}
							<Frame className="w-full" stackedPanels>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Drop Status</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>
											Control lifecycle stage and storefront visibility.
										</Trans>
									</FrameDescription>
								</FrameHeader>
								<FramePanel className="space-y-1.5 p-5">
									<Label
										htmlFor="drop-status-select"
										className="text-muted-foreground text-xs font-medium"
									>
										<Trans>Lifecycle State</Trans>
									</Label>
									<Select
										value={status}
										onValueChange={(val) => {
											if (val) setStatus(val as DropStatus)
										}}
										name="status"
									>
										<SelectTrigger id="drop-status-select" className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="draft">
												<div className="flex items-center gap-2">
													<span className="size-2 rounded-full bg-slate-400" />
													<span>{DROP_STATUS_LABELS.draft}</span>
												</div>
											</SelectItem>
											<SelectItem value="scheduled">
												<div className="flex items-center gap-2">
													<span className="size-2 rounded-full bg-blue-500" />
													<span>{DROP_STATUS_LABELS.scheduled}</span>
												</div>
											</SelectItem>
											<SelectItem value="live">
												<div className="flex items-center gap-2">
													<span className="size-2 rounded-full bg-emerald-500" />
													<span>{DROP_STATUS_LABELS.live}</span>
												</div>
											</SelectItem>
											<SelectItem value="closed">
												<div className="flex items-center gap-2">
													<span className="size-2 rounded-full bg-amber-500" />
													<span>{DROP_STATUS_LABELS.closed}</span>
												</div>
											</SelectItem>
											<SelectItem value="completed">
												<div className="flex items-center gap-2">
													<span className="bg-muted-foreground size-2 rounded-full" />
													<span>{DROP_STATUS_LABELS.completed}</span>
												</div>
											</SelectItem>
										</SelectContent>
									</Select>
								</FramePanel>
								<FramePanel className="space-y-1.5 p-5">
									<Label className="text-muted-foreground text-xs font-medium">
										<Trans>Visibility</Trans>
									</Label>
									<RadioGroup
										value={visibility}
										onValueChange={(val) => {
											if (val) setVisibility(val as 'public' | 'unlisted')
										}}
										name="visibility"
										className="grid grid-cols-2 gap-2"
									>
										<label
											htmlFor="visibility-public"
											className={cn(
												'flex cursor-pointer items-center justify-between rounded-lg border p-2.5 text-xs',
												visibility === 'public'
													? 'border-primary bg-primary/5 font-medium'
													: 'border-border hover:bg-muted/30',
											)}
										>
											<span>
												<Trans>Public</Trans>
											</span>
											<RadioGroupItem value="public" id="visibility-public" />
										</label>
										<label
											htmlFor="visibility-unlisted"
											className={cn(
												'flex cursor-pointer items-center justify-between rounded-lg border p-2.5 text-xs',
												visibility === 'unlisted'
													? 'border-primary bg-primary/5 font-medium'
													: 'border-border hover:bg-muted/30',
											)}
										>
											<span>
												<Trans>Unlisted</Trans>
											</span>
											<RadioGroupItem
												value="unlisted"
												id="visibility-unlisted"
											/>
										</label>
									</RadioGroup>
								</FramePanel>
							</Frame>

							{/* Ordering Timing & Windows */}
							<Frame className="w-full" stackedPanels>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Ordering Window</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>When orders open and close for customers.</Trans>
									</FrameDescription>
								</FrameHeader>
								<FramePanel className="space-y-1.5 p-5">
									<Label
										htmlFor="orders-open-at"
										className="text-muted-foreground text-xs font-medium"
									>
										<Trans>Orders Open At</Trans>
									</Label>
									<Input
										id="orders-open-at"
										name="ordersOpenAt"
										type="datetime-local"
										value={ordersOpenAt}
										onChange={(e) => setOrdersOpenAt(e.target.value)}
										className="text-xs"
									/>
								</FramePanel>
								<FramePanel className="space-y-1.5 p-5">
									<Label
										htmlFor="orders-close-at"
										className="text-muted-foreground text-xs font-medium"
									>
										<Trans>Orders Close At</Trans>
									</Label>
									<Input
										id="orders-close-at"
										name="ordersCloseAt"
										type="datetime-local"
										value={ordersCloseAt}
										onChange={(e) => setOrdersCloseAt(e.target.value)}
										className="text-xs"
									/>
								</FramePanel>
								<FramePanel className="space-y-1.5 p-5">
									<Label
										htmlFor="checkout-hold-minutes"
										className="text-muted-foreground text-xs font-medium"
									>
										<Trans>Checkout Hold Timer</Trans>
									</Label>
									<Select
										value={String(checkoutHoldMinutes)}
										onValueChange={(val) => {
											if (val) setCheckoutHoldMinutes(Number(val))
										}}
										name="checkoutHoldMinutes"
									>
										<SelectTrigger
											id="checkout-hold-minutes"
											className="w-full text-xs"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{DROP_CHECKOUT_HOLD_OPTIONS.map((mins) => (
												<SelectItem key={mins} value={String(mins)}>
													<Trans>{mins} minutes hold</Trans>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<p className="text-muted-foreground text-[11px]">
										<Trans>
											Locks inventory while customer fills in checkout details.
										</Trans>
									</p>
								</FramePanel>
							</Frame>

							{/* Display Options */}
							<Frame className="w-full" stackedPanels>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Display Options</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>Guest storefront indicators and countdowns.</Trans>
									</FrameDescription>
								</FrameHeader>
								<FramePanel className="flex items-center justify-between px-5 py-3.5">
									<Label
										htmlFor="countdown-timer-switch"
										className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
									>
										<div className="text-foreground text-sm">
											<Trans>Show Countdown Timer</Trans>
										</div>
										<p className="text-muted-foreground text-xs">
											<Trans>Display live countdown until orders open</Trans>
										</p>
									</Label>
									<Switch
										id="countdown-timer-switch"
										checked={showOrdersOpenTime}
										onCheckedChange={setShowOrdersOpenTime}
									/>
									<input
										type="hidden"
										name="showOrdersOpenTime"
										value={String(showOrdersOpenTime)}
									/>
								</FramePanel>
								<FramePanel className="flex items-center justify-between px-5 py-3.5">
									<Label
										htmlFor="preview-menu-switch"
										className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
									>
										<div className="text-foreground text-sm">
											<Trans>Preview Menu in Advance</Trans>
										</div>
										<p className="text-muted-foreground text-xs">
											<Trans>Allow browsing items before launch</Trans>
										</p>
									</Label>
									<Switch
										id="preview-menu-switch"
										checked={showMenuPreview}
										onCheckedChange={setShowMenuPreview}
									/>
									<input
										type="hidden"
										name="showMenuPreview"
										value={String(showMenuPreview)}
									/>
								</FramePanel>
								<FramePanel className="flex items-center justify-between px-5 py-3.5">
									<Label
										htmlFor="inventory-remaining-switch"
										className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
									>
										<div className="text-foreground text-sm">
											<Trans>Show Remaining Inventory</Trans>
										</div>
										<p className="text-muted-foreground text-xs">
											<Trans>Display live stock counters on items</Trans>
										</p>
									</Label>
									<Switch
										id="inventory-remaining-switch"
										checked={showInventoryRemaining}
										onCheckedChange={setShowInventoryRemaining}
									/>
									<input
										type="hidden"
										name="showInventoryRemaining"
										value={String(showInventoryRemaining)}
									/>
								</FramePanel>
								<FramePanel className="flex items-center justify-between px-5 py-3.5">
									<Label
										htmlFor="gift-cards-switch"
										className="block min-w-0 cursor-pointer space-y-0.5 pr-4 font-normal"
									>
										<div className="text-foreground text-sm">
											<Trans>Include Gift Cards</Trans>
										</div>
										<p className="text-muted-foreground text-xs">
											<Trans>Enable gift card redemptions on this drop</Trans>
										</p>
									</Label>
									<Switch
										id="gift-cards-switch"
										checked={includeGiftCard}
										onCheckedChange={setIncludeGiftCard}
									/>
									<input
										type="hidden"
										name="includeGiftCard"
										value={String(includeGiftCard)}
									/>
								</FramePanel>
							</Frame>

							{/* Notification Reminders */}
							<Frame className="w-full" stackedPanels>
								<FrameHeader>
									<FrameTitle className="text-base">
										<Trans>Scheduled Reminders</Trans>
									</FrameTitle>
									<FrameDescription>
										<Trans>
											Notify subscribed guests before open or close.
										</Trans>
									</FrameDescription>
									<FrameAction>
										<Button
											type="button"
											variant="ghost"
											size="xs"
											onClick={openNewReminder}
										>
											<Icon name="plus" className="mr-1 size-3.5" />
											<Trans>Add</Trans>
										</Button>
									</FrameAction>
								</FrameHeader>
								{reminders.length === 0 ? (
									<FramePanel className="p-5 text-center">
										<p className="text-muted-foreground text-xs italic">
											<Trans>No reminder notifications set.</Trans>
										</p>
									</FramePanel>
								) : (
									reminders.map((rem, idx) => (
										<FramePanel
											key={idx}
											className="flex items-start justify-between gap-3 px-5 py-3.5"
										>
											<div className="min-w-0 flex-1 space-y-0.5">
												<p className="text-muted-foreground text-[11px] font-medium capitalize">
													{rem.triggerType.replace('_', ' ')}
												</p>
												<p className="text-foreground line-clamp-1 text-sm font-medium">
													{rem.title}
												</p>
												{rem.message && (
													<p className="text-muted-foreground line-clamp-2 text-xs">
														{rem.message}
													</p>
												)}
											</div>
											<div className="mt-0.5 flex shrink-0 items-center gap-0.5">
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={() => openEditReminder(idx)}
													className="text-muted-foreground hover:text-foreground"
													title={_(msg`Edit reminder`)}
												>
													<Icon name="pencil" className="size-3.5" />
												</Button>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={() => handleRemoveReminder(idx)}
													className="text-muted-foreground hover:text-destructive"
													title={_(msg`Remove reminder`)}
												>
													<Icon name="trash-2" className="size-3.5" />
												</Button>
											</div>
										</FramePanel>
									))
								)}
							</Frame>
						</div>
					</div>
				</div>
			</Form>

			{/* Drawers and Modals */}
			<MediaLibraryPicker
				orgSlug={orgSlug}
				open={mediaPickerOpen}
				onOpenChange={setMediaPickerOpen}
				onSelect={handleSelectCoverAsset}
			/>

			<CreatePickupWindowDrawer
				open={createWindowOpen}
				onOpenChange={(open) => {
					setCreateWindowOpen(open)
					if (!open) setEditingPickupIndex(null)
				}}
				locations={locations}
				initialWindow={
					editingPickupIndex != null ? pickupWindows[editingPickupIndex] : null
				}
				onSaveWindow={handleSavePickupWindow}
			/>

			{selectedCategoryForInventory && (
				<SectionInventoryDrawer
					open={sectionInventoryOpen}
					onOpenChange={setSectionInventoryOpen}
					category={{
						id: selectedCategoryForInventory.id,
						displayName: selectedCategoryForInventory.displayName,
					}}
					override={inventoryOverrides.find(
						(inv) =>
							inv.entityType === 'category' &&
							inv.entityId === selectedCategoryForInventory.id,
					)}
					onSave={handleSaveInventoryOverride}
				/>
			)}

			{selectedItemForInventory && (
				<ItemInventoryDrawer
					open={itemInventoryOpen}
					onOpenChange={setItemInventoryOpen}
					item={{
						id: selectedItemForInventory.id,
						displayName: selectedItemForInventory.displayName,
					}}
					override={inventoryOverrides.find(
						(inv) =>
							inv.entityType === 'item' &&
							inv.entityId === selectedItemForInventory.id,
					)}
					onSave={handleSaveInventoryOverride}
				/>
			)}

			<AddReminderModal
				open={addReminderOpen}
				onOpenChange={(open) => {
					setAddReminderOpen(open)
					if (!open) setEditingReminderIndex(null)
				}}
				initialReminder={
					editingReminderIndex != null ? reminders[editingReminderIndex] : null
				}
				onSaveReminder={handleSaveReminder}
			/>
		</div>
	)
}
