import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DropPickupWindowInput,
	type DropInventoryInput,
	type DropReminderInput,
	DROP_SLOT_INTERVALS,
	DROP_CHECKOUT_HOLD_OPTIONS,
} from '@repo/common/menu-types'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetFooter,
} from '@repo/ui/sheet'
import { Switch } from '@repo/ui/switch'
import { useState, useEffect } from 'react'

export interface LocationOption {
	id: string
	name: string
	timezone?: string
}

/* -------------------------------------------------------------------------- */
/*                        CREATE PICKUP WINDOW DRAWER                         */
/* -------------------------------------------------------------------------- */

interface CreatePickupWindowDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	locations: LocationOption[]
	defaultInterval?: number
	onAddWindow: (window: DropPickupWindowInput) => void
}

export function CreatePickupWindowDrawer({
	open,
	onOpenChange,
	locations,
	defaultInterval = 30,
	onAddWindow,
}: CreatePickupWindowDrawerProps) {
	const { _ } = useLingui()
	const [locationId, setLocationId] = useState(locations[0]?.id || '')
	const [date, setDate] = useState(() => {
		const nextSaturday = new Date()
		nextSaturday.setDate(
			nextSaturday.getDate() + ((6 - nextSaturday.getDay() + 7) % 7 || 7),
		)
		const pad = (n: number) => String(n).padStart(2, '0')
		return `${nextSaturday.getFullYear()}-${pad(nextSaturday.getMonth() + 1)}-${pad(nextSaturday.getDate())}`
	})
	const [startTime, setStartTime] = useState('12:00')
	const [endTime, setEndTime] = useState('16:00')
	const [slotIntervalMinutes, setSlotIntervalMinutes] =
		useState(defaultInterval)
	const [timeError, setTimeError] = useState<string | null>(null)

	useEffect(() => {
		if (locations.length > 0 && !locationId && locations[0]) {
			setLocationId(locations[0].id)
		}
	}, [locations, locationId])

	const handleAdd = () => {
		if (!locationId || !date || !startTime || !endTime) return
		if (endTime <= startTime) {
			setTimeError(t`End time must be after start time`)
			return
		}
		setTimeError(null)
		onAddWindow({
			locationId,
			date,
			startTime,
			endTime,
			slotIntervalMinutes,
			maxOrdersPerSlot: null,
			orderLeadTimeMinutes: 0,
		})
		onOpenChange(false)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-md"
			>
				<SheetHeader>
					<SheetTitle className="text-xl font-semibold">
						<Trans>Create pickup window</Trans>
					</SheetTitle>
				</SheetHeader>

				<div className="space-y-5">
					<div className="space-y-2">
						<Label htmlFor="pw-location">
							<Trans>Location</Trans>
						</Label>
						<Select
							value={locationId}
							onValueChange={(val) => setLocationId(val || '')}
						>
							<SelectTrigger id="pw-location" className="w-full">
								<SelectValue placeholder={_(t`Select a location`)} />
							</SelectTrigger>
							<SelectContent>
								{locations.map((loc) => (
									<SelectItem key={loc.id} value={loc.id}>
										{loc.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="pw-date">
							<Trans>Pickup Date</Trans>
						</Label>
						<Input
							id="pw-date"
							type="date"
							value={date}
							onChange={(e) => setDate(e.target.value)}
						/>
					</div>

					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-2">
							<Label htmlFor="pw-start">
								<Trans>Start Time</Trans>
							</Label>
							<Input
								id="pw-start"
								type="time"
								value={startTime}
								onChange={(e) => setStartTime(e.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="pw-end">
								<Trans>End Time</Trans>
							</Label>
							<Input
								id="pw-end"
								type="time"
								value={endTime}
								onChange={(e) => setEndTime(e.target.value)}
							/>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="pw-interval">
							<Trans>Pickup interval (minutes)</Trans>
						</Label>
						<Select
							value={String(slotIntervalMinutes)}
							onValueChange={(val) => setSlotIntervalMinutes(Number(val) || 30)}
						>
							<SelectTrigger id="pw-interval" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DROP_SLOT_INTERVALS.map((int) => (
									<SelectItem key={int} value={String(int)}>
										{int} minutes
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Customers choose their pickup time in intervals of this
								duration.
							</Trans>
						</p>
					</div>
				</div>

				<SheetFooter className="mt-auto border-t pt-4">
					<Button onClick={handleAdd} className="w-full">
						<Trans>Add pickup window</Trans>
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* -------------------------------------------------------------------------- */
/*                       PICKUP WINDOW SETTINGS DRAWER                        */
/* -------------------------------------------------------------------------- */

interface PickupWindowSettingsDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	intervalMinutes: number
	onIntervalChange: (interval: number) => void
	maxOrdersPerSlot: number | null
	onMaxOrdersChange: (limit: number | null) => void
	leadTimeMinutes: number
	onLeadTimeChange: (lead: number) => void
}

export function PickupWindowSettingsDrawer({
	open,
	onOpenChange,
	intervalMinutes,
	onIntervalChange,
	maxOrdersPerSlot,
	onMaxOrdersChange,
	leadTimeMinutes,
	onLeadTimeChange,
}: PickupWindowSettingsDrawerProps) {
	const [hasMaxLimit, setHasMaxLimit] = useState(maxOrdersPerSlot !== null)
	const [maxLimitVal, setMaxLimitVal] = useState(maxOrdersPerSlot ?? 5)

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-md"
			>
				<SheetHeader>
					<SheetTitle className="text-xl font-semibold">
						<Trans>Pickup window settings</Trans>
					</SheetTitle>
				</SheetHeader>

				<div className="space-y-6">
					<div className="space-y-2">
						<Label>
							<Trans>Pickup times occur</Trans>
						</Label>
						<Select
							value={String(intervalMinutes)}
							onValueChange={(val) => onIntervalChange(Number(val) || 30)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DROP_SLOT_INTERVALS.map((int) => (
									<SelectItem key={int} value={String(int)}>
										{int} minutes
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label>
									<Trans>Limit orders per pickup time</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Setting a limit helps you pace preparation and avoid
										crowding.
									</Trans>
								</p>
							</div>
							<Switch
								checked={hasMaxLimit}
								onCheckedChange={(checked) => {
									setHasMaxLimit(checked)
									onMaxOrdersChange(checked ? maxLimitVal : null)
								}}
							/>
						</div>

						{hasMaxLimit && (
							<div className="space-y-1.5 pl-1">
								<Label htmlFor="pw-max-orders">
									<Trans>Max orders per slot</Trans>
								</Label>
								<Input
									id="pw-max-orders"
									type="number"
									min={1}
									value={maxLimitVal}
									onChange={(e) => {
										const val = Number(e.target.value) || 1
										setMaxLimitVal(val)
										onMaxOrdersChange(val)
									}}
								/>
							</div>
						)}
					</div>

					<div className="space-y-2">
						<Label>
							<Trans>Order lead time</Trans>
						</Label>
						<Select
							value={String(leadTimeMinutes)}
							onValueChange={(val) => onLeadTimeChange(Number(val) || 0)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="0">
									<Trans>No lead time (orders stay open until slot)</Trans>
								</SelectItem>
								<SelectItem value="15">
									<Trans>15 minutes before slot</Trans>
								</SelectItem>
								<SelectItem value="30">
									<Trans>30 minutes before slot</Trans>
								</SelectItem>
								<SelectItem value="60">
									<Trans>1 hour before slot</Trans>
								</SelectItem>
								<SelectItem value="120">
									<Trans>2 hours before slot</Trans>
								</SelectItem>
								<SelectItem value="1440">
									<Trans>24 hours before slot</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							<Trans>
								How far in advance customers must order before a pickup slot.
							</Trans>
						</p>
					</div>
				</div>

				<SheetFooter className="mt-auto border-t pt-4">
					<Button onClick={() => onOpenChange(false)} className="w-full">
						<Trans>Done</Trans>
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* -------------------------------------------------------------------------- */
/*                            ITEM INVENTORY DRAWER                           */
/* -------------------------------------------------------------------------- */

interface ItemInventoryDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	item: { id: string; displayName: string; price: number } | null
	override?: DropInventoryInput
	onSave: (override: DropInventoryInput) => void
}

export function ItemInventoryDrawer({
	open,
	onOpenChange,
	item,
	override,
	onSave,
}: ItemInventoryDrawerProps) {
	const [hasInventoryLimit, setHasInventoryLimit] = useState(false)
	const [inventory, setInventory] = useState<number>(10)
	const [maxPerOrder, setMaxPerOrder] = useState<string>('')
	const [maxPerPickupSlot, setMaxPerPickupSlot] = useState<string>('')

	useEffect(() => {
		if (override) {
			setHasInventoryLimit(
				override.inventory !== null && override.inventory !== undefined,
			)
			setInventory(override.inventory ?? 10)
			setMaxPerOrder(
				override.maxPerOrder !== null && override.maxPerOrder !== undefined
					? String(override.maxPerOrder)
					: '',
			)
			setMaxPerPickupSlot(
				override.maxPerPickupSlot !== null &&
					override.maxPerPickupSlot !== undefined
					? String(override.maxPerPickupSlot)
					: '',
			)
		} else {
			setHasInventoryLimit(false)
			setInventory(10)
			setMaxPerOrder('')
			setMaxPerPickupSlot('')
		}
	}, [override, open])

	if (!item) return null

	const handleSave = () => {
		onSave({
			entityType: 'item',
			entityId: item.id,
			inventory: hasInventoryLimit ? Number(inventory) : null,
			maxPerOrder: maxPerOrder ? Number(maxPerOrder) : null,
			maxPerPickupSlot: maxPerPickupSlot ? Number(maxPerPickupSlot) : null,
		})
		onOpenChange(false)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-md"
			>
				<SheetHeader>
					<SheetTitle className="text-xl font-semibold">
						{item.displayName}
					</SheetTitle>
					<p className="text-muted-foreground text-sm">
						${item.price.toFixed(2)}
					</p>
				</SheetHeader>

				<div className="space-y-6">
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label className="text-base">
									<Trans>Inventory limit</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Set how many of this item are available for this drop.
									</Trans>
								</p>
							</div>
							<Switch
								checked={hasInventoryLimit}
								onCheckedChange={setHasInventoryLimit}
							/>
						</div>

						{hasInventoryLimit && (
							<div className="space-y-1.5 pt-1">
								<Label htmlFor="item-inventory-count">
									<Trans>Total Available</Trans>
								</Label>
								<Input
									id="item-inventory-count"
									type="number"
									min={1}
									value={inventory}
									onChange={(e) => setInventory(Number(e.target.value) || 1)}
								/>
							</div>
						)}
					</div>

					{/* Tip card from hotplate */}
					<Card className="bg-muted/40 border-primary/30 flex gap-3 border-dashed p-4 text-sm">
						<Icon
							name="help-circle"
							className="text-primary mt-0.5 size-5 shrink-0"
						/>
						<div className="space-y-1">
							<p className="text-foreground font-medium">
								<Trans>Setting a limit helps you sell out</Trans>
							</p>
							<p className="text-muted-foreground text-xs leading-relaxed">
								<Trans>
									Limiting how many items you sell builds urgency and keeps
									customers excited for your next drop.
								</Trans>
							</p>
						</div>
					</Card>

					<div className="space-y-4 border-t pt-2">
						<div className="space-y-1.5">
							<Label htmlFor="item-max-order">
								<Trans>Max per order</Trans>
							</Label>
							<Input
								id="item-max-order"
								type="number"
								placeholder="No limit"
								value={maxPerOrder}
								onChange={(e) => setMaxPerOrder(e.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Max number of this item a customer can add to their cart.
								</Trans>
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="item-max-slot">
								<Trans>Max per pickup time</Trans>
							</Label>
							<Input
								id="item-max-slot"
								type="number"
								placeholder="No limit"
								value={maxPerPickupSlot}
								onChange={(e) => setMaxPerPickupSlot(e.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Max number that can be scheduled for a single pickup slot.
								</Trans>
							</p>
						</div>
					</div>
				</div>

				<SheetFooter className="mt-auto border-t pt-4">
					<Button onClick={handleSave} className="w-full">
						<Trans>Save</Trans>
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* -------------------------------------------------------------------------- */
/*                         SECTION INVENTORY DRAWER                           */
/* -------------------------------------------------------------------------- */

interface SectionInventoryDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	category: { id: string; displayName: string } | null
	override?: DropInventoryInput
	onSave: (override: DropInventoryInput) => void
}

export function SectionInventoryDrawer({
	open,
	onOpenChange,
	category,
	override,
	onSave,
}: SectionInventoryDrawerProps) {
	const [hasPooledInventory, setHasPooledInventory] = useState(false)
	const [inventory, setInventory] = useState<number>(20)
	const [maxPerOrder, setMaxPerOrder] = useState<string>('')
	const [maxPerPickupSlot, setMaxPerPickupSlot] = useState<string>('')

	useEffect(() => {
		if (override) {
			setHasPooledInventory(
				override.inventory !== null && override.inventory !== undefined,
			)
			setInventory(override.inventory ?? 20)
			setMaxPerOrder(
				override.maxPerOrder !== null && override.maxPerOrder !== undefined
					? String(override.maxPerOrder)
					: '',
			)
			setMaxPerPickupSlot(
				override.maxPerPickupSlot !== null &&
					override.maxPerPickupSlot !== undefined
					? String(override.maxPerPickupSlot)
					: '',
			)
		} else {
			setHasPooledInventory(false)
			setInventory(20)
			setMaxPerOrder('')
			setMaxPerPickupSlot('')
		}
	}, [override, open])

	if (!category) return null

	const handleSave = () => {
		onSave({
			entityType: 'category',
			entityId: category.id,
			inventory: hasPooledInventory ? Number(inventory) : null,
			maxPerOrder: maxPerOrder ? Number(maxPerOrder) : null,
			maxPerPickupSlot: maxPerPickupSlot ? Number(maxPerPickupSlot) : null,
		})
		onOpenChange(false)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-md"
			>
				<SheetHeader>
					<SheetTitle className="text-xl font-semibold">
						<Trans>Section settings</Trans>
					</SheetTitle>
					<p className="text-muted-foreground text-sm">
						{category.displayName}
					</p>
				</SheetHeader>

				<div className="space-y-6">
					<div className="space-y-3">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label className="text-base">
									<Trans>Section pooled inventory</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Items in this section share a total pooled inventory limit.
									</Trans>
								</p>
							</div>
							<Switch
								checked={hasPooledInventory}
								onCheckedChange={setHasPooledInventory}
							/>
						</div>

						{hasPooledInventory && (
							<div className="space-y-1.5 pt-1">
								<Label htmlFor="sec-inventory">
									<Trans>Total Section Inventory</Trans>
								</Label>
								<Input
									id="sec-inventory"
									type="number"
									min={1}
									value={inventory}
									onChange={(e) => setInventory(Number(e.target.value) || 1)}
								/>
							</div>
						)}
					</div>

					<div className="space-y-4 border-t pt-2">
						<div className="space-y-1.5">
							<Label htmlFor="sec-max-order">
								<Trans>Max per order</Trans>
							</Label>
							<Input
								id="sec-max-order"
								type="number"
								placeholder="No limit"
								value={maxPerOrder}
								onChange={(e) => setMaxPerOrder(e.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Max items from this section a customer can purchase in one
									order.
								</Trans>
							</p>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="sec-max-slot">
								<Trans>Max per pickup time</Trans>
							</Label>
							<Input
								id="sec-max-slot"
								type="number"
								placeholder="No limit"
								value={maxPerPickupSlot}
								onChange={(e) => setMaxPerPickupSlot(e.target.value)}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Max items from this section allowed across any single pickup
									slot.
								</Trans>
							</p>
						</div>
					</div>
				</div>

				<SheetFooter className="mt-auto border-t pt-4">
					<Button onClick={handleSave} className="w-full">
						<Trans>Save section settings</Trans>
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* -------------------------------------------------------------------------- */
/*                         ADDITIONAL OPTIONS DRAWER                          */
/* -------------------------------------------------------------------------- */

interface AdditionalOptionsDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	checkoutHoldMinutes: number
	onHoldMinutesChange: (mins: number) => void
	showOrdersOpenTime: boolean
	onShowOpenTimeChange: (show: boolean) => void
	showMenuPreview: boolean
	onShowMenuPreviewChange: (show: boolean) => void
	showInventoryRemaining: boolean
	onShowInventoryChange: (show: boolean) => void
	includeGiftCard: boolean
	onIncludeGiftCardChange: (include: boolean) => void
}

export function AdditionalOptionsDrawer({
	open,
	onOpenChange,
	checkoutHoldMinutes,
	onHoldMinutesChange,
	showOrdersOpenTime,
	onShowOpenTimeChange,
	showMenuPreview,
	onShowMenuPreviewChange,
	showInventoryRemaining,
	onShowInventoryChange,
	includeGiftCard,
	onIncludeGiftCardChange,
}: AdditionalOptionsDrawerProps) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-md"
			>
				<SheetHeader>
					<SheetTitle className="text-xl font-semibold">
						<Trans>Additional options</Trans>
					</SheetTitle>
				</SheetHeader>

				<div className="space-y-6">
					<div className="space-y-2">
						<Label>
							<Trans>Checkout countdown timer</Trans>
						</Label>
						<Select
							value={String(checkoutHoldMinutes)}
							onValueChange={(v) => onHoldMinutesChange(Number(v) || 5)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DROP_CHECKOUT_HOLD_OPTIONS.map((min) => (
									<SelectItem key={min} value={String(min)}>
										{min} minutes
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Customers have this much time to finish checkout before their
								items are released back to inventory.
							</Trans>
						</p>
					</div>

					<div className="space-y-5 border-t pt-3">
						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label>
									<Trans>Orders open time</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Show the exact countdown timer until drop orders open.
									</Trans>
								</p>
							</div>
							<Switch
								checked={showOrdersOpenTime}
								onCheckedChange={onShowOpenTimeChange}
							/>
						</div>

						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label>
									<Trans>Menu preview</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Allow customers to preview menu items before orders open.
									</Trans>
								</p>
							</div>
							<Switch
								checked={showMenuPreview}
								onCheckedChange={onShowMenuPreviewChange}
							/>
						</div>

						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label>
									<Trans>Inventory remaining on storefront</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Display remaining badges (e.g. "Only 3 left") on item cards.
									</Trans>
								</p>
							</div>
							<Switch
								checked={showInventoryRemaining}
								onCheckedChange={onShowInventoryChange}
							/>
						</div>

						<div className="flex items-center justify-between">
							<div className="space-y-0.5">
								<Label>
									<Trans>Add gift card to menu</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Allow customers to purchase gift cards alongside their drop
										order.
									</Trans>
								</p>
							</div>
							<Switch
								checked={includeGiftCard}
								onCheckedChange={onIncludeGiftCardChange}
							/>
						</div>
					</div>
				</div>

				<SheetFooter className="mt-auto border-t pt-4">
					<Button onClick={() => onOpenChange(false)} className="w-full">
						<Trans>Done</Trans>
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	)
}

/* -------------------------------------------------------------------------- */
/*                            ADD REMINDER MODAL                              */
/* -------------------------------------------------------------------------- */

interface AddReminderModalProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	ordersOpenAt?: string
	ordersCloseAt?: string
	onAddReminder: (reminder: DropReminderInput) => void
}

export function AddReminderModal({
	open,
	onOpenChange,
	ordersOpenAt,
	ordersCloseAt,
	onAddReminder,
}: AddReminderModalProps) {
	const [title, setTitle] = useState('')
	const [triggerType, setTriggerType] = useState<
		'before_open' | 'before_close' | 'custom'
	>('before_open')
	const [offsetMinutes, setOffsetMinutes] = useState(15)
	const [customDateTime, setCustomDateTime] = useState('')

	const canAdd =
		Boolean(title.trim()) &&
		(triggerType === 'custom'
			? Boolean(customDateTime)
			: triggerType === 'before_open'
				? Boolean(ordersOpenAt)
				: Boolean(ordersCloseAt))

	const handleAdd = () => {
		if (!canAdd) return
		let scheduledAt: Date
		if (triggerType === 'before_open' && ordersOpenAt) {
			scheduledAt = new Date(
				new Date(ordersOpenAt).getTime() - offsetMinutes * 60 * 1000,
			)
		} else if (triggerType === 'before_close' && ordersCloseAt) {
			scheduledAt = new Date(
				new Date(ordersCloseAt).getTime() - offsetMinutes * 60 * 1000,
			)
		} else if (triggerType === 'custom' && customDateTime) {
			scheduledAt = new Date(customDateTime)
		} else {
			return
		}
		onAddReminder({
			title,
			triggerType,
			scheduledAt,
			status: 'pending',
		})
		setTitle('')
		onOpenChange(false)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Add drop reminder</Trans>
					</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 py-2">
					<div className="space-y-1.5">
						<Label htmlFor="rem-title">
							<Trans>Reminder title</Trans>
						</Label>
						<Input
							id="rem-title"
							placeholder="e.g. We are about to drop!"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</div>

					<div className="space-y-1.5">
						<Label>
							<Trans>Trigger timing</Trans>
						</Label>
						<Select
							value={triggerType}
							onValueChange={(val: any) => setTriggerType(val)}
						>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="before_open">
									<Trans>Before drop opens</Trans>
								</SelectItem>
								<SelectItem value="before_close">
									<Trans>Before drop closes</Trans>
								</SelectItem>
								<SelectItem value="custom">
									<Trans>Custom scheduled time</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{triggerType === 'custom' ? (
						<div className="space-y-1.5">
							<Label htmlFor="rem-custom-time">
								<Trans>Custom scheduled time</Trans>
							</Label>
							<Input
								id="rem-custom-time"
								type="datetime-local"
								value={customDateTime}
								onChange={(e) => setCustomDateTime(e.target.value)}
							/>
						</div>
					) : (
						<div className="space-y-1.5">
							<Label>
								<Trans>Offset</Trans>
							</Label>
							<Select
								value={String(offsetMinutes)}
								onValueChange={(v) => setOffsetMinutes(Number(v) || 15)}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="5">
										<Trans>5 minutes before</Trans>
									</SelectItem>
									<SelectItem value="15">
										<Trans>15 minutes before</Trans>
									</SelectItem>
									<SelectItem value="30">
										<Trans>30 minutes before</Trans>
									</SelectItem>
									<SelectItem value="60">
										<Trans>1 hour before</Trans>
									</SelectItem>
									<SelectItem value="120">
										<Trans>2 hours before</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
							{triggerType === 'before_open' && !ordersOpenAt && (
								<p className="text-xs text-amber-600 dark:text-amber-400">
									<Trans>
										Orders open time must be configured in Step 1 first.
									</Trans>
								</p>
							)}
							{triggerType === 'before_close' && !ordersCloseAt && (
								<p className="text-xs text-amber-600 dark:text-amber-400">
									<Trans>
										Orders close time must be configured in Step 1 first.
									</Trans>
								</p>
							)}
						</div>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						<Trans>Cancel</Trans>
					</Button>
					<Button onClick={handleAdd} disabled={!title}>
						<Trans>Add reminder</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
