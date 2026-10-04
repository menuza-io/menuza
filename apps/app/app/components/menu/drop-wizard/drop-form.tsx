import { getOrgSiteUrl } from '@repo/common/url'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import slugify from '@sindresorhus/slugify'
import {
	type DropInput,
	type DropPickupWindowInput,
	type DropInventoryInput,
	type DropReminderInput,
	type DropStatus,
	DROP_STATUS_LABELS,
	generatePickupSlots,
} from '@repo/common/menu-types'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card } from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogFooter,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Textarea } from '@repo/ui/textarea'
import { useState, useMemo } from 'react'
import { Form, Link, useNavigation } from 'react-router'
import {
	CreatePickupWindowDrawer,
	PickupWindowSettingsDrawer,
	ItemInventoryDrawer,
	SectionInventoryDrawer,
	AdditionalOptionsDrawer,
	AddReminderModal,
	type LocationOption,
} from './drop-drawers.tsx'

export interface CategoryOption {
	id: string
	displayName: string
	items: ItemOption[]
}

export interface ItemOption {
	id: string
	displayName: string
	price: number
	imageKey?: string | null
	imageUrl?: string | null
}

export interface DropFormProps {
	orgSlug: string
	locations: LocationOption[]
	availableCategories: CategoryOption[]
	availableItems: ItemOption[]
	initialData?: Partial<DropInput> & {
		assignedCategoryIds?: string[]
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

export function DropForm({
	orgSlug,
	locations,
	availableCategories,
	availableItems,
	initialData,
	isEdit = false,
	currency = 'USD',
}: DropFormProps) {
	const { _ } = useLingui()
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'

	// Form State
	const [activeTab, setActiveTab] = useState<'info' | 'menu' | 'schedule'>(
		'info',
	)

	// Step 1: Info State
	const [title, setTitle] = useState(initialData?.title || '')
	const [slug, setSlug] = useState(initialData?.slug || '')
	const [description, setDescription] = useState(initialData?.description || '')
	const [pickupWindows, setPickupWindows] = useState<DropPickupWindowInput[]>(
		initialData?.pickupWindows || [],
	)
	const [ordersOpenAt, setOrdersOpenAt] = useState<string>(
		formatToLocalDateTimeInput(initialData?.ordersOpenAt),
	)
	const [ordersCloseAt, setOrdersCloseAt] = useState<string>(
		formatToLocalDateTimeInput(initialData?.ordersCloseAt),
	)

	// Pickup Window Global Settings
	const [slotInterval, setSlotInterval] = useState<number>(
		pickupWindows[0]?.slotIntervalMinutes || 30,
	)
	const [maxOrdersPerSlot, setMaxOrdersPerSlot] = useState<number | null>(
		pickupWindows[0]?.maxOrdersPerSlot ?? null,
	)
	const [orderLeadTime, setOrderLeadTime] = useState<number>(
		pickupWindows[0]?.orderLeadTimeMinutes || 0,
	)

	// Step 2: Menu Sections & Items
	const [assignedCategoryIds, setAssignedCategoryIds] = useState<string[]>(
		initialData?.assignedCategoryIds ||
			(availableCategories[0] ? [availableCategories[0].id] : []),
	)
	const [inventoryOverrides, setInventoryOverrides] = useState<
		DropInventoryInput[]
	>(initialData?.inventoryOverrides || [])

	// Step 3: Schedule & Marketing
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
	const [visibility, setVisibility] = useState<'public' | 'unlisted'>(
		initialData?.visibility || 'public',
	)
	const [status, setStatus] = useState<DropStatus>(
		initialData?.status || 'draft',
	)

	// Additional Options
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

	// Drawer toggles
	const [createWindowOpen, setCreateWindowOpen] = useState(false)
	const [windowSettingsOpen, setWindowSettingsOpen] = useState(false)
	const [itemInventoryOpen, setItemInventoryOpen] = useState(false)
	const [selectedItemForInventory, setSelectedItemForInventory] =
		useState<ItemOption | null>(null)
	const [sectionInventoryOpen, setSectionInventoryOpen] = useState(false)
	const [selectedCategoryForInventory, setSelectedCategoryForInventory] =
		useState<CategoryOption | null>(null)
	const [additionalOptionsOpen, setAdditionalOptionsOpen] = useState(false)
	const [addReminderOpen, setAddReminderOpen] = useState(false)
	const [addSectionModalOpen, setAddSectionModalOpen] = useState(false)

	// Auto-slug when title changes
	const handleTitleChange = (val: string) => {
		setTitle(val)
		if (!isEdit && !slug) {
			setSlug(slugify(val, { lowercase: true, separator: '-' }))
		}
	}

	// Active categories with their items
	const activeCategories = useMemo(() => {
		return availableCategories.filter((c) => assignedCategoryIds.includes(c.id))
	}, [availableCategories, assignedCategoryIds])

	const locationMap = useMemo(() => {
		return new Map(locations.map((l) => [l.id, l]))
	}, [locations])

	// Lookup inventory override
	const getOverride = (type: 'item' | 'category', id: string) => {
		return inventoryOverrides.find(
			(o) => o.entityType === type && o.entityId === id,
		)
	}

	const saveInventoryOverride = (override: DropInventoryInput) => {
		setInventoryOverrides((prev) => {
			const filtered = prev.filter(
				(o) =>
					!(
						o.entityType === override.entityType &&
						o.entityId === override.entityId
					),
			)
			return [...filtered, override]
		})
	}

	const handleAddWindow = (window: DropPickupWindowInput) => {
		setPickupWindows((prev) => [
			...prev,
			{
				...window,
				slotIntervalMinutes: slotInterval,
				maxOrdersPerSlot: maxOrdersPerSlot,
				orderLeadTimeMinutes: orderLeadTime,
			},
		])
	}

	const handleRemoveWindow = (index: number) => {
		setPickupWindows((prev) => prev.filter((_, i) => i !== index))
	}

	const handleAddSection = (categoryId: string) => {
		if (!assignedCategoryIds.includes(categoryId)) {
			setAssignedCategoryIds((prev) => [...prev, categoryId])
		}
		setAddSectionModalOpen(false)
	}

	const handleRemoveSection = (categoryId: string) => {
		setAssignedCategoryIds((prev) => prev.filter((id) => id !== categoryId))
	}

	return (
		<div className="bg-muted/20 min-h-screen pb-24">
			{/* Top Bar Header */}
			<header className="bg-background/95 sticky top-0 z-30 border-b backdrop-blur-sm">
				<div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
					<div className="flex items-center gap-3">
						<Button
							variant="ghost"
							size="icon-sm"
							render={<Link to={`/${orgSlug}/menu/drops`} />}
							className="size-8 rounded-full"
							aria-label="Back to drops"
						>
							<Icon name="arrow-left" className="size-4" />
						</Button>
						<div className="flex items-center gap-2">
							<h1 className="text-foreground text-base font-semibold tracking-tight sm:text-lg">
								{title || _(t`Untitled drop`)}
							</h1>
							<Badge
								variant={
									status === 'live'
										? 'default'
										: status === 'scheduled'
											? 'secondary'
											: 'outline'
								}
								className="text-xs uppercase"
							>
								{DROP_STATUS_LABELS[status]}
							</Badge>
						</div>
					</div>

					<div className="flex items-center gap-2 sm:gap-3">
						{slug && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								render={
									<a
										href={`${getOrgSiteUrl(orgSlug)}/drop/${slug}?preview=true`}
										target="_blank"
										rel="noreferrer"
									/>
								}
								className="hidden items-center gap-1.5 sm:inline-flex"
							>
								<Icon name="external-link" className="size-3.5" />
								<span>
									<Trans>Preview</Trans>
								</span>
							</Button>
						)}

						{status === 'draft' ? (
							<>
								<Button
									form="drop-form"
									type="submit"
									name="status"
									value="draft"
									variant="outline"
									size="sm"
									disabled={isSubmitting || !title}
									className="font-medium"
								>
									<Trans>Save draft</Trans>
								</Button>
								<Button
									form="drop-form"
									type="submit"
									name="status"
									value="scheduled"
									size="sm"
									disabled={
										isSubmitting || !title || pickupWindows.length === 0
									}
									className="font-medium"
								>
									{isSubmitting ? (
										<Trans>Saving...</Trans>
									) : (
										<Trans>Schedule drop</Trans>
									)}
								</Button>
							</>
						) : (
							<Button
								form="drop-form"
								type="submit"
								name="status"
								value={status}
								size="sm"
								disabled={isSubmitting || !title || pickupWindows.length === 0}
								className="font-medium"
							>
								{isSubmitting ? (
									<Trans>Saving...</Trans>
								) : (
									<Trans>Save changes</Trans>
								)}
							</Button>
						)}
					</div>
				</div>

				{/* 3 Step Wizard Tabs Bar */}
				<div className="border-border bg-background border-t">
					<div className="mx-auto flex max-w-5xl justify-center gap-8 px-4 py-2 sm:gap-16">
						{[
							{ key: 'info', label: '1 Info' },
							{ key: 'menu', label: '2 Menu' },
							{ key: 'schedule', label: '3 Schedule' },
						].map((tab) => (
							<button
								key={tab.key}
								type="button"
								onClick={() => setActiveTab(tab.key as any)}
								className={`border-b-2 pb-1.5 text-sm font-medium transition-colors ${
									activeTab === tab.key
										? 'border-primary text-foreground font-semibold'
										: 'text-muted-foreground hover:text-foreground border-transparent'
								}`}
							>
								{tab.label}
							</button>
						))}
					</div>
				</div>
			</header>

			{/* Main Form Body */}
			<main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
				<Form id="drop-form" method="post" className="space-y-8">
					{/* Hidden inputs to serialize state */}
					<input type="hidden" name="title" value={title} />
					<input type="hidden" name="slug" value={slug} />
					<input type="hidden" name="description" value={description} />
					<input type="hidden" name="visibility" value={visibility} />
					<input type="hidden" name="ordersOpenAt" value={ordersOpenAt} />
					<input type="hidden" name="ordersCloseAt" value={ordersCloseAt} />
					<input
						type="hidden"
						name="checkoutHoldMinutes"
						value={checkoutHoldMinutes}
					/>
					<input
						type="hidden"
						name="showOrdersOpenTime"
						value={String(showOrdersOpenTime)}
					/>
					<input
						type="hidden"
						name="showMenuPreview"
						value={String(showMenuPreview)}
					/>
					<input
						type="hidden"
						name="showInventoryRemaining"
						value={String(showInventoryRemaining)}
					/>
					<input
						type="hidden"
						name="includeGiftCard"
						value={String(includeGiftCard)}
					/>
					<input
						type="hidden"
						name="pickupWindows"
						value={JSON.stringify(pickupWindows)}
					/>
					<input
						type="hidden"
						name="assignedCategoryIds"
						value={JSON.stringify(assignedCategoryIds)}
					/>
					<input
						type="hidden"
						name="inventoryOverrides"
						value={JSON.stringify(inventoryOverrides)}
					/>
					<input
						type="hidden"
						name="reminders"
						value={JSON.stringify(
							reminders.map((r) => {
								let scheduledAt = r.scheduledAt
								if (r.triggerType === 'before_open' && ordersOpenAt) {
									const openDate = new Date(ordersOpenAt)
									const offset = 2 * 60 * 60 * 1000
									scheduledAt = new Date(openDate.getTime() - offset)
								} else if (r.triggerType === 'before_close' && ordersCloseAt) {
									const closeDate = new Date(ordersCloseAt)
									const offset = 2 * 60 * 60 * 1000
									scheduledAt = new Date(closeDate.getTime() - offset)
								}
								return { ...r, scheduledAt }
							}),
						)}
					/>

					{/* TAB 1: INFO */}
					{activeTab === 'info' && (
						<div className="space-y-6">
							{/* Basic Details Card */}
							<Card className="bg-card space-y-4 p-6 shadow-sm">
								<div className="space-y-1.5">
									<Label htmlFor="drop-title" className="text-base font-medium">
										<Trans>Drop title</Trans>
									</Label>
									<Input
										id="drop-title"
										placeholder="e.g. Khan bakes's first drop"
										value={title}
										onChange={(e) => handleTitleChange(e.target.value)}
										className="py-5 text-base"
										required
									/>
								</div>

								<div className="space-y-1.5">
									<Label htmlFor="drop-desc" className="text-sm font-medium">
										<Trans>Drop description</Trans>
									</Label>
									<Textarea
										id="drop-desc"
										placeholder={_(
											t`Share the story behind this drop, pickup instructions, or special ingredients...`,
										)}
										rows={3}
										value={description}
										onChange={(e) => setDescription(e.target.value)}
									/>
								</div>
							</Card>

							{/* Pickup Schedule Card */}
							<Card className="bg-card space-y-5 p-6 shadow-sm">
								<div className="flex items-center justify-between">
									<div className="space-y-0.5">
										<h2 className="text-foreground text-base font-semibold">
											<Trans>Pickup schedule</Trans>
										</h2>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Set the pickup times and locations where customers will
												collect their orders.
											</Trans>
										</p>
									</div>

									<div className="flex items-center gap-1.5">
										<Button
											type="button"
											variant="outline"
											size="icon-sm"
											onClick={() => setCreateWindowOpen(true)}
											title={_(t`Add pickup window`)}
										>
											<Icon name="plus" className="size-4" />
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											onClick={() => setWindowSettingsOpen(true)}
											title={_(t`Pickup window settings`)}
										>
											<Icon
												name="gear"
												className="text-muted-foreground size-4"
											/>
										</Button>
									</div>
								</div>

								{/* Pickup Window Cards List */}
								{pickupWindows.length === 0 ? (
									<div
										onClick={() => setCreateWindowOpen(true)}
										className="border-border hover:border-primary/50 bg-muted/10 flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors"
									>
										<Icon
											name="calendar"
											className="text-muted-foreground/60 mb-2 size-8"
										/>
										<p className="text-foreground text-sm font-medium">
											<Trans>No pickup window added yet</Trans>
										</p>
										<p className="text-muted-foreground mt-0.5 text-xs">
											<Trans>
												Click here or the + button above to schedule your pickup
												window.
											</Trans>
										</p>
									</div>
								) : (
									<div className="space-y-3">
										{pickupWindows.map((pw, idx) => {
											const loc = locationMap.get(pw.locationId)
											const slots = generatePickupSlots(
												pw.startTime,
												pw.endTime,
												pw.slotIntervalMinutes,
											)
											return (
												<div
													key={idx}
													className="bg-muted/20 flex items-center justify-between rounded-lg border p-4"
												>
													<div className="space-y-1">
														<p className="text-primary text-xs font-semibold tracking-wider uppercase">
															{loc?.name || _(t`Pickup Location`)}
														</p>
														<p className="text-foreground text-sm font-medium">
															{pw.date} &bull; {pw.startTime} - {pw.endTime}
														</p>
														<p className="text-muted-foreground text-xs">
															{slots.length} <Trans>pickup slots (every</Trans>{' '}
															{pw.slotIntervalMinutes}m)
														</p>
													</div>

													<Button
														type="button"
														variant="ghost"
														size="icon-sm"
														onClick={() => handleRemoveWindow(idx)}
														className="text-muted-foreground hover:text-destructive"
													>
														<Icon name="trash-2" className="size-4" />
													</Button>
												</div>
											)
										})}
									</div>
								)}
							</Card>

							{/* When orders open and close timeline */}
							<Card className="bg-card space-y-6 p-6 shadow-sm">
								<div className="space-y-1">
									<h2 className="text-foreground text-base font-semibold">
										<Trans>When orders open and close</Trans>
									</h2>
									<p className="text-muted-foreground text-xs">
										<Trans>
											Control when customers can view and place orders for this
											drop.
										</Trans>
									</p>
								</div>

								<div className="before:bg-border relative space-y-6 pl-6 before:absolute before:top-3 before:bottom-3 before:left-2.5 before:w-0.5">
									{/* Orders open node */}
									<div className="relative space-y-2">
										<div className="border-primary bg-background absolute top-1.5 -left-6 size-3.5 rounded-full border-2" />
										<Label
											htmlFor="orders-open"
											className="text-sm font-medium"
										>
											<Trans>Orders open</Trans>
										</Label>
										<Input
											id="orders-open"
											type="datetime-local"
											value={ordersOpenAt}
											onChange={(e) => setOrdersOpenAt(e.target.value)}
											className="max-w-xs"
										/>
									</div>

									{/* Orders close node */}
									<div className="relative space-y-2">
										<div className="border-primary bg-primary absolute top-1.5 -left-6 size-3.5 rounded-full border-2" />
										<Label
											htmlFor="orders-close"
											className="text-sm font-medium"
										>
											<Trans>Orders close</Trans>
										</Label>
										<Input
											id="orders-close"
											type="datetime-local"
											value={ordersCloseAt}
											onChange={(e) => setOrdersCloseAt(e.target.value)}
											className="max-w-xs"
										/>
									</div>
								</div>
							</Card>

							<div className="flex justify-end pt-2">
								<Button
									type="button"
									onClick={() => setActiveTab('menu')}
									className="px-6"
								>
									<Trans>Continue to Menu</Trans>
								</Button>
							</div>
						</div>
					)}

					{/* TAB 2: MENU */}
					{activeTab === 'menu' && (
						<div className="space-y-6">
							<div className="flex items-center justify-between">
								<div className="space-y-0.5">
									<h2 className="text-foreground text-lg font-semibold tracking-tight">
										<Trans>What you are selling</Trans>
									</h2>
									<p className="text-muted-foreground text-xs">
										<Trans>
											Assign sections and items to this drop, and set pooled or
											per-item limits.
										</Trans>
									</p>
								</div>

								<div className="flex items-center gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setAddSectionModalOpen(true)}
									>
										<Icon name="plus" className="mr-1.5 size-3.5" />
										<Trans>Add section</Trans>
									</Button>
								</div>
							</div>

							{activeCategories.length === 0 ? (
								<Card className="bg-muted/10 space-y-3 border-dashed p-8 text-center">
									<Icon
										name="menu"
										className="text-muted-foreground/60 mx-auto size-8"
									/>
									<p className="text-foreground text-sm font-medium">
										<Trans>No sections added to this drop yet</Trans>
									</p>
									<p className="text-muted-foreground mx-auto max-w-sm text-xs">
										<Trans>
											Add a section from your menu categories to start
											populating items for this drop.
										</Trans>
									</p>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setAddSectionModalOpen(true)}
									>
										<Trans>Choose section</Trans>
									</Button>
								</Card>
							) : (
								<div className="space-y-6">
									{activeCategories.map((category) => {
										const catOverride = getOverride('category', category.id)
										return (
											<Card
												key={category.id}
												className="bg-card space-y-4 p-5 shadow-sm"
											>
												<div className="flex items-center justify-between border-b pb-3">
													<div className="flex items-center gap-2.5">
														<h3 className="text-foreground text-base font-semibold">
															{category.displayName}
														</h3>
														{catOverride?.inventory !== null &&
															catOverride?.inventory !== undefined && (
																<Badge variant="secondary" className="text-xs">
																	{catOverride.inventory}{' '}
																	<Trans>inventory (pooled)</Trans>
																</Badge>
															)}
													</div>

													<div className="flex items-center gap-1.5">
														<Button
															type="button"
															variant="ghost"
															size="icon-sm"
															onClick={() => {
																setSelectedCategoryForInventory(category)
																setSectionInventoryOpen(true)
															}}
															title={_(t`Section settings`)}
														>
															<Icon
																name="gear"
																className="text-muted-foreground size-4"
															/>
														</Button>
														<Button
															type="button"
															variant="ghost"
															size="icon-sm"
															onClick={() => handleRemoveSection(category.id)}
															className="text-muted-foreground hover:text-destructive"
															title={_(t`Remove section from drop`)}
														>
															<Icon name="trash-2" className="size-4" />
														</Button>
													</div>
												</div>

												{/* Items under category */}
												<div className="space-y-2">
													{category.items.length === 0 ? (
														<p className="text-muted-foreground py-2 text-xs italic">
															<Trans>No items in this category yet.</Trans>
														</p>
													) : (
														category.items.map((item) => {
															const itemOverride = getOverride('item', item.id)
															const hasLimit =
																itemOverride?.inventory !== null &&
																itemOverride?.inventory !== undefined
															return (
																<div
																	key={item.id}
																	onClick={() => {
																		setSelectedItemForInventory(item)
																		setItemInventoryOpen(true)
																	}}
																	className="hover:bg-muted/40 flex cursor-pointer items-center justify-between rounded-md border p-3 transition-colors"
																>
																	<div className="flex items-center gap-3">
																		{item.imageUrl ? (
																			<img
																				src={item.imageUrl}
																				alt={item.displayName}
																				className="size-10 rounded-md object-cover"
																			/>
																		) : (
																			<div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-md text-xs">
																				<Icon
																					name="file-text"
																					className="size-4"
																				/>
																			</div>
																		)}
																		<div>
																			<p className="text-foreground text-sm font-medium">
																				{item.displayName}
																			</p>
																			<p className="text-muted-foreground text-xs">
																				{new Intl.NumberFormat(undefined, {
																					style: 'currency',
																					currency,
																				}).format(item.price)}
																			</p>
																		</div>
																	</div>

																	<div className="flex items-center gap-2">
																		<Badge
																			variant={hasLimit ? 'default' : 'outline'}
																			className="text-xs font-normal"
																		>
																			{hasLimit
																				? `${itemOverride.inventory} inventory`
																				: _(t`Unlimited`)}
																		</Badge>
																		<Icon
																			name="gear"
																			className="text-muted-foreground size-3.5"
																		/>
																	</div>
																</div>
															)
														})
													)}
												</div>
											</Card>
										)
									})}
								</div>
							)}

							<div className="flex justify-between pt-2">
								<Button
									type="button"
									variant="outline"
									onClick={() => setActiveTab('info')}
								>
									<Trans>Back to Info</Trans>
								</Button>
								<Button
									type="button"
									onClick={() => setActiveTab('schedule')}
									className="px-6"
								>
									<Trans>Continue to Schedule</Trans>
								</Button>
							</div>
						</div>
					)}

					{/* TAB 3: SCHEDULE */}
					{activeTab === 'schedule' && (
						<div className="space-y-6">
							<div className="space-y-1">
								<h2 className="text-foreground text-lg font-semibold tracking-tight">
									<Trans>Marketing and scheduling</Trans>
								</h2>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Configure drop announcements, visibility, and checkout
										limits.
									</Trans>
								</p>
							</div>

							{/* Drop Reminders Card */}
							<Card className="bg-card space-y-4 p-6 shadow-sm">
								<div className="flex items-center justify-between">
									<div className="space-y-0.5">
										<h3 className="text-foreground text-base font-semibold">
											<Trans>Drop reminders</Trans>
										</h3>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Automated customer notifications to create excitement
												and urge checkout.
											</Trans>
										</p>
									</div>

									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setAddReminderOpen(true)}
									>
										<Icon name="plus" className="mr-1.5 size-3.5" />
										<Trans>Add reminder</Trans>
									</Button>
								</div>

								<div className="space-y-3">
									{reminders.map((rem, idx) => (
										<div
											key={idx}
											className="bg-muted/20 flex items-start justify-between rounded-lg border p-3.5"
										>
											<div className="flex items-start gap-3">
												{rem.triggerType === 'before_open' ? (
													<Icon
														name="sparkles"
														className="mt-0.5 size-5 shrink-0 text-orange-500"
													/>
												) : (
													<Icon
														name="clock"
														className="mt-0.5 size-5 shrink-0 text-blue-500"
													/>
												)}
												<div className="space-y-0.5">
													<p className="text-foreground text-sm font-medium">
														{rem.title}
													</p>
													{rem.message && (
														<p className="text-muted-foreground text-xs">
															{rem.message}
														</p>
													)}
													<Badge variant="outline" className="mt-1 text-[10px]">
														{rem.triggerType === 'before_open'
															? _(t`Before drop opens`)
															: rem.triggerType === 'before_close'
																? _(t`Before drop closes`)
																: _(t`Custom timing`)}
													</Badge>
												</div>
											</div>

											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												onClick={() =>
													setReminders((prev) =>
														prev.filter((_, i) => i !== idx),
													)
												}
												className="text-muted-foreground hover:text-destructive"
											>
												<Icon name="trash-2" className="size-4" />
											</Button>
										</div>
									))}
								</div>
							</Card>

							{/* Drop Visibility Card */}
							<Card className="bg-card space-y-4 p-6 shadow-sm">
								<h3 className="text-foreground text-base font-semibold">
									<Trans>Drop visibility</Trans>
								</h3>
								<RadioGroup
									value={visibility}
									onValueChange={(val: any) => setVisibility(val)}
									className="space-y-3"
								>
									<div className="hover:bg-muted/30 flex cursor-pointer items-start space-x-3 rounded-lg border p-3">
										<RadioGroupItem
											value="public"
											id="vis-public"
											className="mt-1"
										/>
										<div className="space-y-0.5">
											<Label
												htmlFor="vis-public"
												className="cursor-pointer font-medium"
											>
												<Trans>Public</Trans>
											</Label>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Anyone can view and discover this drop on your site.
												</Trans>
											</p>
										</div>
									</div>

									<div className="hover:bg-muted/30 flex cursor-pointer items-start space-x-3 rounded-lg border p-3">
										<RadioGroupItem
											value="unlisted"
											id="vis-unlisted"
											className="mt-1"
										/>
										<div className="space-y-0.5">
											<Label
												htmlFor="vis-unlisted"
												className="cursor-pointer font-medium"
											>
												<Trans>Unlisted</Trans>
											</Label>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Only people with the secret link can view and order.
												</Trans>
											</p>
										</div>
									</div>
								</RadioGroup>
							</Card>

							{/* Additional Options Summary Card */}
							<Card
								onClick={() => setAdditionalOptionsOpen(true)}
								className="hover:bg-muted/30 bg-card flex cursor-pointer items-center justify-between p-5 shadow-sm transition-colors"
							>
								<div className="space-y-1">
									<h3 className="text-foreground text-sm font-semibold">
										<Trans>Additional options</Trans>
									</h3>
									<p className="text-muted-foreground text-xs">
										{checkoutHoldMinutes}m checkout timer &bull;{' '}
										{showOrdersOpenTime
											? _(t`Open countdown visible`)
											: _(t`Open countdown hidden`)}{' '}
										&bull;{' '}
										{showMenuPreview
											? _(t`Menu preview on`)
											: _(t`Menu preview off`)}
									</p>
								</div>
								<Icon name="gear" className="text-muted-foreground size-4" />
							</Card>

							<div className="flex justify-between pt-4">
								<Button
									type="button"
									variant="outline"
									onClick={() => setActiveTab('menu')}
								>
									<Trans>Back to Menu</Trans>
								</Button>

								<Button
									type="submit"
									name="status"
									value={status === 'draft' ? 'scheduled' : status}
									disabled={
										isSubmitting || !title || pickupWindows.length === 0
									}
									className="px-8 py-2.5 text-sm font-semibold"
								>
									{isSubmitting ? (
										<Trans>Scheduling...</Trans>
									) : status === 'draft' ? (
										<Trans>Schedule drop</Trans>
									) : (
										<Trans>Save changes</Trans>
									)}
								</Button>
							</div>
						</div>
					)}
				</Form>
			</main>

			{/* Drawers and Modals */}
			<CreatePickupWindowDrawer
				open={createWindowOpen}
				onOpenChange={setCreateWindowOpen}
				locations={locations}
				defaultInterval={slotInterval}
				onAddWindow={handleAddWindow}
			/>

			<PickupWindowSettingsDrawer
				open={windowSettingsOpen}
				onOpenChange={setWindowSettingsOpen}
				intervalMinutes={slotInterval}
				onIntervalChange={(val) => {
					setSlotInterval(val)
					setPickupWindows((prev) =>
						prev.map((w) => ({ ...w, slotIntervalMinutes: val })),
					)
				}}
				maxOrdersPerSlot={maxOrdersPerSlot}
				onMaxOrdersChange={(val) => {
					setMaxOrdersPerSlot(val)
					setPickupWindows((prev) =>
						prev.map((w) => ({ ...w, maxOrdersPerSlot: val })),
					)
				}}
				leadTimeMinutes={orderLeadTime}
				onLeadTimeChange={(val) => {
					setOrderLeadTime(val)
					setPickupWindows((prev) =>
						prev.map((w) => ({ ...w, orderLeadTimeMinutes: val })),
					)
				}}
			/>

			<ItemInventoryDrawer
				open={itemInventoryOpen}
				onOpenChange={setItemInventoryOpen}
				item={selectedItemForInventory}
				override={
					selectedItemForInventory
						? getOverride('item', selectedItemForInventory.id)
						: undefined
				}
				onSave={saveInventoryOverride}
			/>

			<SectionInventoryDrawer
				open={sectionInventoryOpen}
				onOpenChange={setSectionInventoryOpen}
				category={selectedCategoryForInventory}
				override={
					selectedCategoryForInventory
						? getOverride('category', selectedCategoryForInventory.id)
						: undefined
				}
				onSave={saveInventoryOverride}
			/>

			<AdditionalOptionsDrawer
				open={additionalOptionsOpen}
				onOpenChange={setAdditionalOptionsOpen}
				checkoutHoldMinutes={checkoutHoldMinutes}
				onHoldMinutesChange={setCheckoutHoldMinutes}
				showOrdersOpenTime={showOrdersOpenTime}
				onShowOpenTimeChange={setShowOrdersOpenTime}
				showMenuPreview={showMenuPreview}
				onShowMenuPreviewChange={setShowMenuPreview}
				showInventoryRemaining={showInventoryRemaining}
				onShowInventoryChange={setShowInventoryRemaining}
				includeGiftCard={includeGiftCard}
				onIncludeGiftCardChange={setIncludeGiftCard}
			/>

			<AddReminderModal
				open={addReminderOpen}
				onOpenChange={setAddReminderOpen}
				ordersOpenAt={ordersOpenAt}
				ordersCloseAt={ordersCloseAt}
				onAddReminder={(rem) => setReminders((prev) => [...prev, rem])}
			/>

			{/* Add Section Modal */}
			<Dialog open={addSectionModalOpen} onOpenChange={setAddSectionModalOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Add section to drop</Trans>
						</DialogTitle>
					</DialogHeader>
					<div className="max-h-80 space-y-2 overflow-y-auto py-3">
						{availableCategories.map((c) => {
							const isSelected = assignedCategoryIds.includes(c.id)
							return (
								<div
									key={c.id}
									onClick={() => handleAddSection(c.id)}
									className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-colors ${
										isSelected
											? 'bg-primary/5 border-primary/40'
											: 'hover:bg-muted/40'
									}`}
								>
									<div>
										<p className="text-foreground text-sm font-medium">
											{c.displayName}
										</p>
										<p className="text-muted-foreground text-xs">
											{c.items.length} items
										</p>
									</div>
									{isSelected && (
										<Icon name="check" className="text-primary size-4" />
									)}
								</div>
							)
						})}
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setAddSectionModalOpen(false)}
						>
							<Trans>Cancel</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
