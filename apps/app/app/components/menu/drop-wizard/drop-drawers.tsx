import { Trans, t, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DropPickupWindowInput,
	type DropInventoryInput,
	type DropReminderInput,
	DROP_SLOT_INTERVALS,
	generatePickupSlots,
} from '@repo/common/menu-types'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
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
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Switch } from '@repo/ui/switch'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useMemo, useState } from 'react'

export interface LocationOption {
	id: string
	name: string
	timezone?: string
}

/* -------------------------------------------------------------------------- */
/*                        CREATE PICKUP WINDOW DRAWER                         */
/* -------------------------------------------------------------------------- */

function defaultPickupDateString(): string {
	const nextSaturday = new Date()
	nextSaturday.setDate(
		nextSaturday.getDate() + ((6 - nextSaturday.getDay() + 7) % 7 || 7),
	)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${nextSaturday.getFullYear()}-${pad(nextSaturday.getMonth() + 1)}-${pad(nextSaturday.getDate())}`
}

function formatPickupDateLabel(dateStr: string): string {
	try {
		const d = new Date(`${dateStr}T12:00:00`)
		if (isNaN(d.getTime())) return dateStr
		return d.toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
		})
	} catch {
		return dateStr
	}
}

interface CreatePickupWindowDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	locations: LocationOption[]
	defaultInterval?: number
	initialWindow?: DropPickupWindowInput | null
	onSaveWindow: (window: DropPickupWindowInput) => void
}

export function CreatePickupWindowDrawer({
	open,
	onOpenChange,
	locations,
	defaultInterval = 30,
	initialWindow,
	onSaveWindow,
}: CreatePickupWindowDrawerProps) {
	const { _ } = useLingui()
	const isEditing = initialWindow != null
	const [locationId, setLocationId] = useState(locations[0]?.id || '')
	const effectiveLocationId = locationId || locations[0]?.id || ''
	const [date, setDate] = useState(defaultPickupDateString)
	const [startTime, setStartTime] = useState('12:00')
	const [endTime, setEndTime] = useState('16:00')
	const [slotIntervalMinutes, setSlotIntervalMinutes] =
		useState(defaultInterval)
	const [maxOrdersPerSlot, setMaxOrdersPerSlot] = useState<string>('')
	const [orderLeadTimeMinutes, setOrderLeadTimeMinutes] = useState<number>(0)
	const [timeError, setTimeError] = useState<string | null>(null)

	useEffect(() => {
		if (!open) return
		if (initialWindow) {
			setLocationId(initialWindow.locationId)
			setDate(initialWindow.date)
			setStartTime(initialWindow.startTime)
			setEndTime(initialWindow.endTime)
			setSlotIntervalMinutes(
				initialWindow.slotIntervalMinutes ?? defaultInterval,
			)
			setMaxOrdersPerSlot(
				initialWindow.maxOrdersPerSlot != null
					? String(initialWindow.maxOrdersPerSlot)
					: '',
			)
			setOrderLeadTimeMinutes(initialWindow.orderLeadTimeMinutes ?? 0)
		} else {
			setLocationId(locations[0]?.id || '')
			setDate(defaultPickupDateString())
			setStartTime('12:00')
			setEndTime('16:00')
			setSlotIntervalMinutes(defaultInterval)
			setMaxOrdersPerSlot('')
			setOrderLeadTimeMinutes(0)
		}
		setTimeError(null)
	}, [open, initialWindow, locations, defaultInterval])

	const previewSlots = useMemo(() => {
		if (!startTime || !endTime || endTime <= startTime) return []
		return generatePickupSlots(startTime, endTime, slotIntervalMinutes)
	}, [startTime, endTime, slotIntervalMinutes])
	const slotCount = previewSlots.length
	const slotPreview = previewSlots.slice(0, 6)
	const hiddenSlotCount = Math.max(0, slotCount - slotPreview.length)
	const moreSlots = hiddenSlotCount
	const parsedMaxOrdersPreview =
		maxOrdersPerSlot.trim() !== '' ? Number(maxOrdersPerSlot) : null
	const windowCapacityPreview =
		parsedMaxOrdersPreview != null &&
		!isNaN(parsedMaxOrdersPreview) &&
		parsedMaxOrdersPreview > 0 &&
		slotCount > 0
			? slotCount * parsedMaxOrdersPreview
			: null

	const handleSave = () => {
		if (!effectiveLocationId || !date || !startTime || !endTime) return
		if (endTime <= startTime) {
			setTimeError(_(msg`End time must be after start time`))
			return
		}
		setTimeError(null)
		const parsedMaxOrders =
			maxOrdersPerSlot.trim() !== '' ? Number(maxOrdersPerSlot) : null
		onSaveWindow({
			...(initialWindow?.id ? { id: initialWindow.id } : {}),
			locationId: effectiveLocationId,
			date,
			startTime,
			endTime,
			slotIntervalMinutes,
			maxOrdersPerSlot:
				parsedMaxOrders !== null &&
				!isNaN(parsedMaxOrders) &&
				parsedMaxOrders > 0
					? parsedMaxOrders
					: null,
			orderLeadTimeMinutes,
		})
		onOpenChange(false)
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
			>
				<SheetHeader className="border-b px-6 py-4">
					<SheetTitle className="text-base font-semibold">
						{isEditing ? (
							formatPickupDateLabel(date)
						) : (
							<Trans>Add pickup window</Trans>
						)}
					</SheetTitle>
					<SheetDescription className="text-muted-foreground text-xs">
						{isEditing ? (
							<Trans>Update date, hours, and capacity.</Trans>
						) : (
							<Trans>When and where customers pick up orders.</Trans>
						)}
					</SheetDescription>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto px-6 py-5">
					<div className="divide-border/60 border-border/60 divide-y rounded-lg border">
						<div className="space-y-3 p-4">
							<div className="space-y-1.5">
								<Label htmlFor="pw-date" className="text-sm font-medium">
									<Trans>Date</Trans>
								</Label>
								<Input
									id="pw-date"
									type="date"
									value={date}
									onChange={(e) => setDate(e.target.value)}
									className="text-xs"
								/>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<div className="space-y-1.5">
									<Label htmlFor="pw-start" className="text-xs font-medium">
										<Trans>Start</Trans>
									</Label>
									<Input
										id="pw-start"
										type="time"
										value={startTime}
										onChange={(e) => setStartTime(e.target.value)}
										className="text-xs"
									/>
								</div>
								<div className="space-y-1.5">
									<Label htmlFor="pw-end" className="text-xs font-medium">
										<Trans>End</Trans>
									</Label>
									<Input
										id="pw-end"
										type="time"
										value={endTime}
										onChange={(e) => setEndTime(e.target.value)}
										className="text-xs"
									/>
								</div>
							</div>
							{timeError && (
								<p className="text-destructive text-xs font-medium">
									{timeError}
								</p>
							)}
						</div>

						<div className="space-y-1.5 p-4">
							<Label htmlFor="pw-location" className="text-sm font-medium">
								<Trans>Location</Trans>
							</Label>
							<Select
								value={effectiveLocationId}
								onValueChange={(val) => setLocationId(val || '')}
							>
								<SelectTrigger id="pw-location" className="w-full text-xs">
									<SelectValue placeholder={_(t`Select a location`)} />
								</SelectTrigger>
								<SelectContent>
									{locations.map((loc) => (
										<SelectItem key={loc.id} value={loc.id} className="text-xs">
											{loc.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2 p-4">
							<Label htmlFor="pw-interval" className="text-sm font-medium">
								<Trans>Slot interval</Trans>
							</Label>
							<Select
								value={String(slotIntervalMinutes)}
								onValueChange={(val) =>
									setSlotIntervalMinutes(Number(val) || 30)
								}
							>
								<SelectTrigger id="pw-interval" className="w-full text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DROP_SLOT_INTERVALS.map((int) => (
										<SelectItem
											key={int}
											value={String(int)}
											className="text-xs"
										>
											<Trans>{int} minutes</Trans>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{slotCount > 0 && (
								<p className="text-muted-foreground text-[11px] leading-relaxed">
									<span>
										{slotCount === 1
											? _(msg`1 pickup slot`)
											: _(msg`${slotCount} pickup slots`)}
									</span>
									<span className="text-foreground/90">
										{' · '}
										{slotPreview.map((slot) => slot.displayTime).join(', ')}
										{hiddenSlotCount > 0 && (
											<>
												{', '}
												<Trans>+{moreSlots} more</Trans>
											</>
										)}
									</span>
								</p>
							)}
							{windowCapacityPreview != null && (
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										{windowCapacityPreview} orders max in this window
									</Trans>
								</p>
							)}
						</div>

						<div className="space-y-1.5 p-4">
							<Label htmlFor="pw-max-orders" className="text-sm font-medium">
								<Trans>Max orders per slot</Trans>
							</Label>
							<Input
								id="pw-max-orders"
								type="number"
								min={1}
								placeholder=""
								value={maxOrdersPerSlot}
								onChange={(e) => setMaxOrdersPerSlot(e.target.value)}
								className="text-xs"
							/>
							<p className="text-muted-foreground text-[11px]">
								<Trans>Leave blank for unlimited.</Trans>
							</p>
						</div>

						<div className="space-y-1.5 p-4">
							<Label htmlFor="pw-lead-time" className="text-sm font-medium">
								<Trans>Order cutoff</Trans>
							</Label>
							<Select
								value={String(orderLeadTimeMinutes)}
								onValueChange={(val) =>
									setOrderLeadTimeMinutes(Number(val) || 0)
								}
							>
								<SelectTrigger id="pw-lead-time" className="w-full text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="0" className="text-xs">
										<Trans>At slot time</Trans>
									</SelectItem>
									<SelectItem value="60" className="text-xs">
										<Trans>1 hour prior</Trans>
									</SelectItem>
									<SelectItem value="120" className="text-xs">
										<Trans>2 hours prior</Trans>
									</SelectItem>
									<SelectItem value="240" className="text-xs">
										<Trans>4 hours prior</Trans>
									</SelectItem>
									<SelectItem value="720" className="text-xs">
										<Trans>12 hours prior</Trans>
									</SelectItem>
									<SelectItem value="1440" className="text-xs">
										<Trans>24 hours prior</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
				</div>

				<SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						className="text-xs"
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="button" onClick={handleSave} className="text-xs">
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
	if (!category) return null

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
			>
				{open && (
					<SectionInventoryForm
						key={`${category.id}:${override?.id ?? (override ? 'override' : 'new')}`}
						category={category}
						override={override}
						onSave={onSave}
						onOpenChange={onOpenChange}
					/>
				)}
			</SheetContent>
		</Sheet>
	)
}

function SectionInventoryForm({
	category,
	override,
	onSave,
	onOpenChange,
}: {
	category: { id: string; displayName: string }
	override?: DropInventoryInput
	onSave: (override: DropInventoryInput) => void
	onOpenChange: (open: boolean) => void
}) {
	const [hasPooledInventory, setHasPooledInventory] = useState(
		override?.inventory !== null && override?.inventory !== undefined,
	)
	const [inventory, setInventory] = useState<number>(override?.inventory ?? 20)
	const [maxPerOrder, setMaxPerOrder] = useState<string>(
		override?.maxPerOrder !== null && override?.maxPerOrder !== undefined
			? String(override.maxPerOrder)
			: '',
	)
	const [maxPerPickupSlot, setMaxPerPickupSlot] = useState<string>(
		override?.maxPerPickupSlot !== null &&
			override?.maxPerPickupSlot !== undefined
			? String(override.maxPerPickupSlot)
			: '',
	)

	const handleSave = () => {
		onSave({
			id: override?.id,
			entityType: 'category',
			entityId: category.id,
			inventory: hasPooledInventory ? inventory : null,
			maxPerOrder: maxPerOrder.trim() !== '' ? Number(maxPerOrder) : null,
			maxPerPickupSlot:
				maxPerPickupSlot.trim() !== '' ? Number(maxPerPickupSlot) : null,
		})
		onOpenChange(false)
	}

	return (
		<>
			<SheetHeader className="border-b px-6 py-4">
				<SheetTitle className="text-base font-semibold">
					{category.displayName}
				</SheetTitle>
				<SheetDescription className="text-muted-foreground text-xs">
					<Trans>Optional limits for this section on this drop.</Trans>
				</SheetDescription>
			</SheetHeader>

			<div className="flex-1 overflow-y-auto px-6 py-5">
				<div className="divide-border/60 border-border/60 divide-y rounded-lg border">
					<div className="space-y-3 p-4">
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-0.5">
								<Label
									htmlFor="sec-inv-toggle"
									className="text-foreground text-sm font-medium"
								>
									<Trans>Pooled total</Trans>
								</Label>
								<p className="text-muted-foreground text-[11px]">
									<Trans>Shared cap across all items in this section.</Trans>
								</p>
							</div>
							<Switch
								id="sec-inv-toggle"
								checked={hasPooledInventory}
								onCheckedChange={setHasPooledInventory}
							/>
						</div>
						{hasPooledInventory && (
							<div className="space-y-1.5">
								<Label htmlFor="sec-inv-count" className="text-xs font-medium">
									<Trans>Units available</Trans>
								</Label>
								<Input
									id="sec-inv-count"
									type="number"
									min={1}
									value={inventory}
									onChange={(e) =>
										setInventory(Math.max(1, Number(e.target.value) || 1))
									}
									className="text-xs"
								/>
								<p className="text-muted-foreground text-[11px]">
									<Trans>
										When this total is reached, every item in the section sells
										out.
									</Trans>
								</p>
							</div>
						)}
					</div>

					<div className="space-y-1.5 p-4">
						<Label htmlFor="sec-max-order" className="text-sm font-medium">
							<Trans>Max per order</Trans>
						</Label>
						<Input
							id="sec-max-order"
							type="number"
							min={1}
							placeholder=""
							value={maxPerOrder}
							onChange={(e) => setMaxPerOrder(e.target.value)}
							className="text-xs"
						/>
						<p className="text-muted-foreground text-[11px]">
							<Trans>Leave blank for no limit.</Trans>
						</p>
					</div>

					<div className="space-y-1.5 p-4">
						<Label htmlFor="sec-max-slot" className="text-sm font-medium">
							<Trans>Max per pickup slot</Trans>
						</Label>
						<Input
							id="sec-max-slot"
							type="number"
							min={1}
							placeholder=""
							value={maxPerPickupSlot}
							onChange={(e) => setMaxPerPickupSlot(e.target.value)}
							className="text-xs"
						/>
						<p className="text-muted-foreground text-[11px]">
							<Trans>Leave blank for no limit.</Trans>
						</p>
					</div>
				</div>
			</div>

			<SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
				<Button
					type="button"
					variant="outline"
					onClick={() => onOpenChange(false)}
					className="text-xs"
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button type="button" onClick={handleSave} className="text-xs">
					<Trans>Save</Trans>
				</Button>
			</SheetFooter>
		</>
	)
}

/* -------------------------------------------------------------------------- */
/*                           ITEM INVENTORY DRAWER                            */
/* -------------------------------------------------------------------------- */

interface ItemInventoryDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	item: { id: string; displayName: string } | null
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
	if (!item) return null

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
			>
				{open && (
					<ItemInventoryForm
						key={`${item.id}:${override?.id ?? (override ? 'override' : 'new')}`}
						item={item}
						override={override}
						onSave={onSave}
						onOpenChange={onOpenChange}
					/>
				)}
			</SheetContent>
		</Sheet>
	)
}

function ItemInventoryForm({
	item,
	override,
	onSave,
	onOpenChange,
}: {
	item: { id: string; displayName: string }
	override?: DropInventoryInput
	onSave: (override: DropInventoryInput) => void
	onOpenChange: (open: boolean) => void
}) {
	const [hasInventoryLimit, setHasInventoryLimit] = useState(
		override?.inventory !== null && override?.inventory !== undefined,
	)
	const [inventory, setInventory] = useState<number>(override?.inventory ?? 10)
	const [maxPerOrder, setMaxPerOrder] = useState<string>(
		override?.maxPerOrder !== null && override?.maxPerOrder !== undefined
			? String(override.maxPerOrder)
			: '',
	)
	const [maxPerPickupSlot, setMaxPerPickupSlot] = useState<string>(
		override?.maxPerPickupSlot !== null &&
			override?.maxPerPickupSlot !== undefined
			? String(override.maxPerPickupSlot)
			: '',
	)

	const handleSave = () => {
		onSave({
			id: override?.id,
			entityType: 'item',
			entityId: item.id,
			inventory: hasInventoryLimit ? inventory : null,
			maxPerOrder: maxPerOrder.trim() !== '' ? Number(maxPerOrder) : null,
			maxPerPickupSlot:
				maxPerPickupSlot.trim() !== '' ? Number(maxPerPickupSlot) : null,
		})
		onOpenChange(false)
	}

	return (
		<>
			<SheetHeader className="border-b px-6 py-4">
				<SheetTitle className="text-base font-semibold">
					{item.displayName}
				</SheetTitle>
				<SheetDescription className="text-muted-foreground text-xs">
					<Trans>Optional limits for this item on this drop.</Trans>
				</SheetDescription>
			</SheetHeader>

			<div className="flex-1 overflow-y-auto px-6 py-5">
				<div className="divide-border/60 border-border/60 divide-y rounded-lg border">
					<div className="space-y-3 p-4">
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-0.5">
								<Label
									htmlFor="item-inv-toggle"
									className="text-foreground text-sm font-medium"
								>
									<Trans>Total units</Trans>
								</Label>
								<p className="text-muted-foreground text-[11px]">
									<Trans>Cap how many units can be sold in this drop.</Trans>
								</p>
							</div>
							<Switch
								id="item-inv-toggle"
								checked={hasInventoryLimit}
								onCheckedChange={setHasInventoryLimit}
							/>
						</div>
						{hasInventoryLimit && (
							<div className="space-y-1.5">
								<Label htmlFor="item-inv-count" className="text-xs font-medium">
									<Trans>Units available</Trans>
								</Label>
								<Input
									id="item-inv-count"
									type="number"
									min={1}
									value={inventory}
									onChange={(e) =>
										setInventory(Math.max(1, Number(e.target.value) || 1))
									}
									className="text-xs"
								/>
							</div>
						)}
					</div>

					<div className="space-y-1.5 p-4">
						<Label htmlFor="item-max-order" className="text-sm font-medium">
							<Trans>Max per order</Trans>
						</Label>
						<Input
							id="item-max-order"
							type="number"
							min={1}
							placeholder=""
							value={maxPerOrder}
							onChange={(e) => setMaxPerOrder(e.target.value)}
							className="text-xs"
						/>
						<p className="text-muted-foreground text-[11px]">
							<Trans>Leave blank for no limit.</Trans>
						</p>
					</div>

					<div className="space-y-1.5 p-4">
						<Label htmlFor="item-max-slot" className="text-sm font-medium">
							<Trans>Max per pickup slot</Trans>
						</Label>
						<Input
							id="item-max-slot"
							type="number"
							min={1}
							placeholder=""
							value={maxPerPickupSlot}
							onChange={(e) => setMaxPerPickupSlot(e.target.value)}
							className="text-xs"
						/>
						<p className="text-muted-foreground text-[11px]">
							<Trans>Leave blank for no limit.</Trans>
						</p>
					</div>
				</div>
			</div>

			<SheetFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
				<Button
					type="button"
					variant="outline"
					onClick={() => onOpenChange(false)}
					className="text-xs"
				>
					<Trans>Cancel</Trans>
				</Button>
				<Button type="button" onClick={handleSave} className="text-xs">
					<Trans>Save</Trans>
				</Button>
			</SheetFooter>
		</>
	)
}

/* -------------------------------------------------------------------------- */
/*                            ADD REMINDER MODAL                              */
/* -------------------------------------------------------------------------- */

interface AddReminderModalProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	initialReminder?: DropReminderInput | null
	onSaveReminder: (reminder: DropReminderInput) => void
}

export function AddReminderModal({
	open,
	onOpenChange,
	initialReminder,
	onSaveReminder,
}: AddReminderModalProps) {
	const { _ } = useLingui()
	const isEditing = initialReminder != null
	const [title, setTitle] = useState('')
	const [message, setMessage] = useState('')
	const [triggerType, setTriggerType] = useState<
		'before_open' | 'before_close' | 'custom'
	>('before_open')

	useEffect(() => {
		if (!open) return
		if (initialReminder) {
			setTitle(initialReminder.title)
			setMessage(initialReminder.message ?? '')
			setTriggerType(initialReminder.triggerType)
		} else {
			setTitle('')
			setMessage('')
			setTriggerType('before_open')
		}
	}, [open, initialReminder])

	const handleSave = () => {
		if (!title.trim()) return
		const existingScheduledAt = initialReminder?.scheduledAt
		onSaveReminder({
			...(initialReminder?.id ? { id: initialReminder.id } : {}),
			title: title.trim(),
			message: message.trim() || null,
			triggerType,
			scheduledAt: existingScheduledAt
				? new Date(existingScheduledAt)
				: new Date(),
			status: initialReminder?.status ?? 'pending',
		})
		onOpenChange(false)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="overflow-hidden p-0 sm:max-w-md">
				<DialogHeader className="border-b px-6 py-4">
					<DialogTitle className="text-base font-semibold">
						{isEditing ? (
							<Trans>Edit Reminder</Trans>
						) : (
							<Trans>Schedule Customer Reminder</Trans>
						)}
					</DialogTitle>
					<DialogDescription className="text-muted-foreground text-xs">
						<Trans>
							Send automated notifications to subscribed guests before your drop
							opens or closes.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 px-6 py-5">
					<div className="space-y-1.5">
						<Label htmlFor="rem-type" className="text-xs font-medium">
							<Trans>Trigger Timing</Trans>
						</Label>
						<Select
							value={triggerType}
							onValueChange={(val: any) => setTriggerType(val)}
						>
							<SelectTrigger id="rem-type" className="w-full text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="before_open" className="text-xs">
									<Trans>Before drop opens</Trans>
								</SelectItem>
								<SelectItem value="before_close" className="text-xs">
									<Trans>Before drop closes</Trans>
								</SelectItem>
								<SelectItem value="custom" className="text-xs">
									<Trans>Custom scheduled date/time</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="rem-title" className="text-xs font-medium">
							<Trans>Subject / Notification Title</Trans>
						</Label>
						<Input
							id="rem-title"
							placeholder={_(msg`e.g. Orders are now open!`)}
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							className="text-xs"
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="rem-msg" className="text-xs font-medium">
							<Trans>Notification Message</Trans>
						</Label>
						<Textarea
							id="rem-msg"
							rows={3}
							placeholder={_(
								msg`e.g. Order now before your favorites sell out.`,
							)}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							className="resize-none text-xs"
						/>
					</div>
				</div>

				<DialogFooter className="flex-row justify-end gap-2 border-t px-6 py-4">
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						className="text-xs"
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={handleSave}
						disabled={!title.trim()}
						className="text-xs"
					>
						{isEditing ? (
							<Trans>Save Changes</Trans>
						) : (
							<Trans>Add Reminder</Trans>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
