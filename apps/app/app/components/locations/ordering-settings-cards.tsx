'use client'

import { Trans } from '@lingui/macro'
import {
	type FulfillmentHoursMode,
	DAYS_OF_WEEK,
	DAY_LABELS,
	type DayOfWeek,
} from '@repo/common/location-types'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
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
import { Switch } from '@repo/ui/switch'
import {
	type OnlineOrderingFormValues,
	type PrepScheduleFormRow,
	type PrayerPauseFormValues,
	type SlotLimitFormValues,
} from '#app/utils/orders/ordering-settings.ts'

const QUARTER_HOUR_OPTIONS = Array.from({ length: 96 }, (_, i) => {
	const hour = Math.floor(i / 4)
	const minute = (i % 4) * 15
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
})

const FULFILLMENT_MODE_ITEMS: Record<FulfillmentHoursMode, string> = {
	follow_online: 'Follow online hours',
	custom: 'Custom (same as online for now)',
	closed: 'Closed for this channel',
}

interface OnlineOrderingBuffersCardProps {
	values: OnlineOrderingFormValues
	onChange: (next: OnlineOrderingFormValues) => void
}

export function OnlineOrderingBuffersCard({
	values,
	onChange,
}: OnlineOrderingBuffersCardProps) {
	const set = (partial: Partial<OnlineOrderingFormValues>) =>
		onChange({ ...values, ...partial })

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Online ordering windows</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Opening and closing buffers trim when guests can place orders.
						Per-channel modes control pickup, delivery, and catering hours.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div className="space-y-1.5">
						<Label htmlFor="opening-buffer">
							<Trans>Opening buffer (minutes)</Trans>
						</Label>
						<Input
							id="opening-buffer"
							type="number"
							min={0}
							max={120}
							value={values.openingBufferMinutes}
							onChange={(e) => set({ openingBufferMinutes: e.target.value })}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="closing-buffer">
							<Trans>Closing buffer (minutes)</Trans>
						</Label>
						<Input
							id="closing-buffer"
							type="number"
							min={0}
							max={120}
							value={values.closingBufferMinutes}
							onChange={(e) => set({ closingBufferMinutes: e.target.value })}
						/>
					</div>
				</div>

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
					{(
						[
							['pickup', 'Pickup'],
							['delivery', 'Delivery'],
							['catering', 'Catering'],
						] as const
					).map(([key, label]) => (
						<div key={key} className="space-y-1.5">
							<Label>{label}</Label>
							<Select
								value={values[key]}
								items={FULFILLMENT_MODE_ITEMS}
								onValueChange={(val) =>
									val && set({ [key]: val as FulfillmentHoursMode })
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(FULFILLMENT_MODE_ITEMS).map(
										([value, text]) => (
											<SelectItem key={value} value={value}>
												{text}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	)
}

interface SlotLimitsCardProps {
	values: SlotLimitFormValues
	onChange: (next: SlotLimitFormValues) => void
}

export function SlotLimitsCard({ values, onChange }: SlotLimitsCardProps) {
	const set = (partial: Partial<SlotLimitFormValues>) =>
		onChange({ ...values, ...partial })

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Slot limits</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Cap how many orders or dishes can be promised per time slot. Leave a
						limit blank for unlimited.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between rounded-md border p-3">
					<div>
						<Label htmlFor="slot-limits-enabled" className="font-medium">
							<Trans>Enable slot limits</Trans>
						</Label>
						<p className="text-muted-foreground text-xs">
							<Trans>Turn off to stop enforcing caps at checkout.</Trans>
						</p>
					</div>
					<Switch
						id="slot-limits-enabled"
						checked={values.enabled}
						onCheckedChange={(checked) => set({ enabled: checked })}
					/>
				</div>

				{values.enabled ? (
					<>
						<div className="space-y-1.5">
							<Label>
								<Trans>Count</Trans>
							</Label>
							<Select
								value={values.unit}
								items={{ orders: 'Orders', dishes: 'Dishes' }}
								onValueChange={(val) =>
									val && set({ unit: val as 'orders' | 'dishes' })
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="orders">
										<Trans>Orders</Trans>
									</SelectItem>
									<SelectItem value="dishes">
										<Trans>Dishes</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<div className="space-y-1.5">
								<Label htmlFor="slot-default">
									<Trans>Default limit</Trans>
								</Label>
								<Input
									id="slot-default"
									type="number"
									min={1}
									max={500}
									placeholder="Unlimited"
									value={values.defaultLimit}
									onChange={(e) => set({ defaultLimit: e.target.value })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="slot-pickup">
									<Trans>Pickup limit</Trans>
								</Label>
								<Input
									id="slot-pickup"
									type="number"
									min={1}
									max={500}
									placeholder="Use default"
									value={values.pickupLimit}
									onChange={(e) => set({ pickupLimit: e.target.value })}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="slot-delivery">
									<Trans>Delivery limit</Trans>
								</Label>
								<Input
									id="slot-delivery"
									type="number"
									min={1}
									max={500}
									placeholder="Use default"
									value={values.deliveryLimit}
									onChange={(e) => set({ deliveryLimit: e.target.value })}
								/>
							</div>
						</div>

						<label className="flex cursor-pointer items-center gap-2">
							<Checkbox
								checked={values.allowOneLargeOrderPerSlot}
								onCheckedChange={(c) =>
									set({ allowOneLargeOrderPerSlot: c === true })
								}
							/>
							<span className="text-sm">
								<Trans>Allow one large order per slot</Trans>
							</span>
						</label>
					</>
				) : null}
			</CardContent>
		</Card>
	)
}

interface PrepScheduleCardProps {
	rows: PrepScheduleFormRow[]
	onChange: (rows: PrepScheduleFormRow[]) => void
}

export function PrepScheduleCard({ rows, onChange }: PrepScheduleCardProps) {
	const updateRow = (index: number, partial: Partial<PrepScheduleFormRow>) => {
		onChange(rows.map((row, i) => (i === index ? { ...row, ...partial } : row)))
	}

	const toggleDay = (index: number, day: DayOfWeek) => {
		const row = rows[index]
		if (!row) return
		const days = row.days.includes(day)
			? row.days.filter((d) => d !== day)
			: [...row.days, day]
		updateRow(index, { days })
	}

	const addRow = () => {
		onChange([
			...rows,
			{
				days: ['monday'],
				from: '11:00',
				to: '14:00',
				minutes: '30',
			},
		])
	}

	const removeRow = (index: number) => {
		onChange(rows.filter((_, i) => i !== index))
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Variable prep time</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Override base prep minutes during specific windows (15-minute
						steps).
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{rows.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>No variable prep windows yet.</Trans>
					</p>
				) : (
					<div className="space-y-3">
						{rows.map((row, index) => (
							<div
								key={index}
								className="border-border space-y-3 rounded-md border p-3"
							>
								<div className="flex flex-wrap gap-2">
									{DAYS_OF_WEEK.map((day) => (
										<label
											key={day}
											className="flex cursor-pointer items-center gap-1.5 text-xs"
										>
											<Checkbox
												checked={row.days.includes(day)}
												onCheckedChange={() => toggleDay(index, day)}
											/>
											{DAY_LABELS[day]}
										</label>
									))}
								</div>
								<div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
									<Select
										value={row.from}
										items={Object.fromEntries(
											QUARTER_HOUR_OPTIONS.map((t) => [t, t]),
										)}
										onValueChange={(val) =>
											val && updateRow(index, { from: val })
										}
									>
										<SelectTrigger>
											<SelectValue placeholder="From" />
										</SelectTrigger>
										<SelectContent>
											{QUARTER_HOUR_OPTIONS.map((t) => (
												<SelectItem key={t} value={t}>
													{t}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Select
										value={row.to}
										items={Object.fromEntries(
											QUARTER_HOUR_OPTIONS.map((t) => [t, t]),
										)}
										onValueChange={(val) =>
											val && updateRow(index, { to: val })
										}
									>
										<SelectTrigger>
											<SelectValue placeholder="To" />
										</SelectTrigger>
										<SelectContent>
											{QUARTER_HOUR_OPTIONS.map((t) => (
												<SelectItem key={t} value={t}>
													{t}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Input
										type="number"
										min={0}
										max={180}
										value={row.minutes}
										onChange={(e) =>
											updateRow(index, { minutes: e.target.value })
										}
										placeholder="Minutes"
									/>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => removeRow(index)}
									>
										<Icon name="trash-2" className="size-4" />
										<Trans>Remove</Trans>
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
				<Button type="button" variant="outline" size="sm" onClick={addRow}>
					<Icon name="plus" className="size-4" />
					<Trans>Add window</Trans>
				</Button>
			</CardContent>
		</Card>
	)
}

interface PrayerPauseCardProps {
	values: PrayerPauseFormValues
	onChange: (next: PrayerPauseFormValues) => void
}

const PRAYER_LABELS: Record<
	PrayerPauseFormValues['prayers'][number]['name'],
	string
> = {
	fajr: 'Fajr',
	dhuhr: 'Dhuhr',
	asr: 'Asr',
	maghrib: 'Maghrib',
	isha: 'Isha',
}

export function PrayerPauseCard({ values, onChange }: PrayerPauseCardProps) {
	const set = (partial: Partial<PrayerPauseFormValues>) =>
		onChange({ ...values, ...partial })

	const updatePrayer = (
		index: number,
		partial: Partial<PrayerPauseFormValues['prayers'][number]>,
	) => {
		onChange({
			...values,
			prayers: values.prayers.map((row, i) =>
				i === index ? { ...row, ...partial } : row,
			),
		})
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Prayer pauses</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Pause online ordering around daily prayers using the store address
						coordinates.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex items-center justify-between rounded-md border p-3">
					<Label htmlFor="prayer-enabled" className="font-medium">
						<Trans>Enable prayer pauses</Trans>
					</Label>
					<Switch
						id="prayer-enabled"
						checked={values.enabled}
						onCheckedChange={(checked) => set({ enabled: checked })}
					/>
				</div>

				{values.enabled ? (
					<>
						<div className="space-y-1.5">
							<Label>
								<Trans>Calculation method</Trans>
							</Label>
							<Select
								value={values.calculationMethod}
								items={{
									UmmAlQura: 'Umm al-Qura',
									MuslimWorldLeague: 'Muslim World League',
									Egyptian: 'Egyptian',
								}}
								onValueChange={(val) =>
									val &&
									set({
										calculationMethod:
											val as PrayerPauseFormValues['calculationMethod'],
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="UmmAlQura">Umm al-Qura</SelectItem>
									<SelectItem value="MuslimWorldLeague">
										Muslim World League
									</SelectItem>
									<SelectItem value="Egyptian">Egyptian</SelectItem>
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							{values.prayers.map((row, index) => (
								<div
									key={row.name}
									className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4"
								>
									<div className="text-sm font-medium">
										{PRAYER_LABELS[row.name]}
									</div>
									<div className="space-y-1">
										<Label className="text-xs">
											<Trans>Before (min)</Trans>
										</Label>
										<Input
											type="number"
											min={0}
											max={60}
											value={row.beforeMinutes}
											onChange={(e) =>
												updatePrayer(index, { beforeMinutes: e.target.value })
											}
										/>
									</div>
									<div className="space-y-1">
										<Label className="text-xs">
											<Trans>After (min)</Trans>
										</Label>
										<Input
											type="number"
											min={0}
											max={60}
											value={row.afterMinutes}
											onChange={(e) =>
												updatePrayer(index, { afterMinutes: e.target.value })
											}
										/>
									</div>
								</div>
							))}
						</div>
					</>
				) : null}
			</CardContent>
		</Card>
	)
}
