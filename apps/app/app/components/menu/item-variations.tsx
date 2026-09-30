import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	formatUnavailableUntil,
	getAvailabilityPresets,
	isUnavailableUntilExpired,
	localDateAndTimeToUtc,
	type MenuVariations,
} from '@repo/common/menu-types'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useRef, useState } from 'react'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'
import { type LocationItem } from './location-overrides-card.tsx'
import {
	activeVariationGroups,
	canAddVariationValue,
	discardEmptyDraftValue,
	reconcileDraftVariations,
	toDraftVariationGroups,
	updateDraftVariationValue,
	withTrailingBlank,
	type DraftVariationGroup,
	type VariationHistory,
} from './variation-drafts.ts'

type GalleryImage = { key: string; url: string }
type Variation = MenuVariations['variants'][number]
const nameKey = (name: string) => name.trim().toLocaleLowerCase()

export function ItemVariations({
	value,
	onChange,
	images,
	defaultPrice,
	orgSlug,
	locations = [],
	initialImageUrls = {},
}: {
	value: MenuVariations
	onChange: (next: MenuVariations) => void
	images: GalleryImage[]
	defaultPrice: number
	orgSlug: string
	locations?: LocationItem[]
	initialImageUrls?: Record<string, string>
}) {
	const { _ } = useLingui()
	const [draftGroups, setDraftGroups] = useState(() =>
		toDraftVariationGroups(value.groups),
	)
	const [activeVariantId, setActiveVariantId] = useState<string | null>(null)
	const [imageUrls, setImageUrls] = useState(initialImageUrls)
	const variantHistory = useRef<VariationHistory>(new Map())
	const primaryLocation =
		locations.find((location) => location.isDefault) ?? locations[0] ?? null

	const publish = (groups: DraftVariationGroup[]) => {
		setDraftGroups(groups)
		onChange(
			reconcileDraftVariations(
				value,
				groups,
				defaultPrice,
				variantHistory.current,
			),
		)
	}

	const changeGroupName = (groupId: string, name: string) =>
		publish(
			draftGroups.map((group) =>
				group.id === groupId ? { ...group, name } : group,
			),
		)

	const changeValue = (groupId: string, valueId: string, name: string) => {
		const next = updateDraftVariationValue(draftGroups, groupId, valueId, name)
		if (
			activeVariationGroups(next).reduce(
				(count, group) => count * group.values.length,
				1,
			) > 100
		)
			return
		publish(next)
	}

	const removeGroup = (group: DraftVariationGroup) => {
		const hasValues = group.values.some((option) => option.name.trim())
		const optionName = group.name.trim() || _(msg`this option`)
		if (
			hasValues &&
			!window.confirm(
				_(
					msg`Remove ${optionName}? Its combinations will be removed when you save the item.`,
				),
			)
		)
			return
		publish(draftGroups.filter((entry) => entry.id !== group.id))
	}

	const updateVariant = (id: string, changes: Partial<Variation>) =>
		onChange({
			...value,
			variants: value.variants.map((variant) =>
				variant.id === id ? { ...variant, ...changes } : variant,
			),
		})

	const choosePhoto = (asset: MediaLibraryAsset) => {
		if (!activeVariantId) return
		setImageUrls((current) => ({ ...current, [asset.objectKey]: asset.url }))
		updateVariant(activeVariantId, { imageKey: asset.objectKey })
		setActiveVariantId(null)
	}

	return (
		<Frame className="w-full" stackedPanels>
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Variations</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Options like size or color. Price and availability per combination.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="space-y-4 p-5">
				{draftGroups.length === 0 && (
					<p className="text-muted-foreground text-sm">
						<Trans>
							For example, add Size with Small and Medium, then Color with Black
							and Blue. The combinations appear automatically.
						</Trans>
					</p>
				)}
				{draftGroups.map((group) => {
					const hasValues = group.values.some((option) => option.name.trim())
					const duplicateGroup = Boolean(
						nameKey(group.name) &&
						draftGroups.some(
							(entry) =>
								entry.id !== group.id &&
								nameKey(entry.name) === nameKey(group.name),
						),
					)
					return (
						<div
							key={group.id}
							className="border-border space-y-3 border-b pb-5 last:border-b-0 last:pb-0"
						>
							<div className="flex items-end gap-3">
								<div className="min-w-0 flex-1 space-y-1.5">
									<Label htmlFor={`variation-group-${group.id}`}>
										<Trans>Option name</Trans>
									</Label>
									<Input
										id={`variation-group-${group.id}`}
										value={group.name}
										placeholder="e.g. Size"
										maxLength={80}
										required={hasValues}
										aria-invalid={duplicateGroup}
										onChange={(event) =>
											changeGroupName(group.id, event.target.value)
										}
									/>
									{duplicateGroup && (
										<p className="text-destructive text-xs">
											<Trans>Use a different option name.</Trans>
										</p>
									)}
								</div>
								<Button
									type="button"
									variant="ghost"
									onClick={() => removeGroup(group)}
								>
									<Trans>Remove</Trans>
								</Button>
							</div>
							<div className="space-y-2">
								<Label>
									<Trans>Values</Trans>
								</Label>
								{group.values.map((option, index) => {
									const trailing = index === group.values.length - 1
									const duplicate = Boolean(
										nameKey(option.name) &&
										group.values.some(
											(entry) =>
												entry.id !== option.id &&
												nameKey(entry.name) === nameKey(option.name),
										),
									)
									return (
										<div key={option.id} className="space-y-1">
											<Input
												id={`variation-value-${option.id}`}
												aria-label={`${group.name || 'Option'} value ${index + 1}`}
												value={option.name}
												placeholder={trailing ? 'Add a value' : undefined}
												maxLength={80}
												disabled={
													trailing &&
													!canAddVariationValue(draftGroups, group.id)
												}
												aria-invalid={duplicate}
												onChange={(event) =>
													changeValue(group.id, option.id, event.target.value)
												}
												onBlur={() => {
													const next = discardEmptyDraftValue(
														draftGroups,
														group.id,
														option.id,
													)
													if (next !== draftGroups) publish(next)
												}}
												onKeyDown={(event) => {
													if (event.key !== 'Enter') return
													event.preventDefault()
													const nextId = group.values[index + 1]?.id
													if (nextId)
														document
															.getElementById(`variation-value-${nextId}`)
															?.focus()
												}}
											/>
											{duplicate && (
												<p className="text-destructive text-xs">
													<Trans>Use a different value.</Trans>
												</p>
											)}
										</div>
									)
								})}
								{!canAddVariationValue(draftGroups, group.id) && (
									<p className="text-muted-foreground text-xs">
										<Trans>
											This item has reached the 100 combination limit.
										</Trans>
									</p>
								)}
							</div>
						</div>
					)
				})}
				<Button
					type="button"
					variant="secondary"
					disabled={draftGroups.length >= 3}
					onClick={() => {
						const id = crypto.randomUUID()
						publish([
							...draftGroups,
							withTrailingBlank({ id, name: '', values: [] }),
						])
					}}
				>
					<Trans>Add option</Trans>
				</Button>
			</FramePanel>
			{value.variants.length > 0 && (
				<FramePanel className="p-0">
					<div className="flex items-center justify-between gap-3 px-5 py-3">
						<h3 className="text-sm font-semibold">
							<Trans>Combinations</Trans>
						</h3>
						<span className="text-muted-foreground text-xs tabular-nums">
							{value.variants.length}
						</span>
					</div>
					<div className="border-border/70 bg-muted/30 text-muted-foreground hidden grid-cols-[minmax(0,1fr)_7rem_11rem] gap-4 border-y px-5 py-2 text-xs font-medium sm:grid">
						<span>
							<Trans>Variant</Trans>
						</span>
						<span>
							<Trans>Price ($)</Trans>
						</span>
						<span>
							<Trans>Availability</Trans>
						</span>
					</div>
					<div className="divide-border/70 divide-y border-t sm:border-t-0">
						{value.variants.map((variant) => {
							const name = variant.valueIds
								.map(
									(id, index) =>
										value.groups[index]?.values.find(
											(option) => option.id === id,
										)?.name || '…',
								)
								.join(' / ')
							const imageUrl = variant.imageKey
								? (imageUrls[variant.imageKey] ??
									images.find((image) => image.key === variant.imageKey)?.url)
								: images[0]?.url
							return (
								<div
									key={variant.id}
									className="grid gap-3 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_7rem_11rem] sm:items-start sm:gap-4"
								>
									<div className="flex min-w-0 items-center gap-3">
										<button
											type="button"
											className={`border-border bg-background hover:bg-muted focus-visible:ring-ring text-muted-foreground flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border transition-colors focus-visible:ring-2 focus-visible:outline-none ${imageUrl ? '' : 'border-dashed'}`}
											aria-label={_(msg`Choose photo for ${name}`)}
											title={_(msg`Choose photo for ${name}`)}
											onClick={() => setActiveVariantId(variant.id)}
										>
											{imageUrl ? (
												<img
													src={imageUrl}
													alt=""
													className="size-full object-cover"
												/>
											) : (
												<Icon name="image" className="size-5" />
											)}
										</button>
										<div className="min-w-0 space-y-1">
											<div className="text-sm font-medium">{name}</div>
											{variant.imageKey && (
												<button
													type="button"
													className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
													onClick={() =>
														updateVariant(variant.id, { imageKey: null })
													}
												>
													{images.length ? (
														<Trans>Use item photo</Trans>
													) : (
														<Trans>Remove photo</Trans>
													)}
												</button>
											)}
										</div>
									</div>
									<div className="space-y-1 sm:space-y-0 sm:pt-2">
										<Label
											htmlFor={`variation-price-${variant.id}`}
											className="text-muted-foreground text-xs sm:sr-only"
										>
											<Trans>Price ($)</Trans>
										</Label>
										<Input
											id={`variation-price-${variant.id}`}
											aria-label={_(msg`Price for ${name}`)}
											type="number"
											min="0"
											step="0.01"
											required
											value={variant.price}
											onFocus={(event) => event.target.select()}
											onChange={(event) =>
												updateVariant(variant.id, {
													price: Number(event.target.value),
												})
											}
										/>
									</div>
									<div className="sm:pt-2">
										<VariationAvailabilityControl
											variant={variant}
											name={name}
											location={primaryLocation}
											onChange={(changes) => updateVariant(variant.id, changes)}
										/>
									</div>
								</div>
							)
						})}
					</div>
				</FramePanel>
			)}
			<MediaLibraryPicker
				className="hidden"
				orgSlug={orgSlug}
				open={activeVariantId !== null}
				onOpenChange={(open) => {
					if (!open) setActiveVariantId(null)
				}}
				onSelect={choosePhoto}
			/>
		</Frame>
	)
}

function locationDateTime(value: string, timezone: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
			.formatToParts(new Date(value))
			.map((part) => [part.type, part.value]),
	)
	return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

function VariationAvailabilityControl({
	variant,
	name,
	location,
	onChange,
}: {
	variant: Variation
	name: string
	location: LocationItem | null
	onChange: (changes: Partial<Variation>) => void
}) {
	const { _ } = useLingui()
	const [presetId, setPresetId] = useState(
		variant.availabilityStatus === 'unavailable_until' ? 'custom' : '30_min',
	)
	const timezone = location?.timezone || 'America/New_York'
	const status = isUnavailableUntilExpired(
		variant.availabilityStatus,
		variant.unavailableUntil,
	)
		? 'available'
		: variant.availabilityStatus
	const presets =
		status === 'unavailable_until' ? getAvailabilityPresets(location) : []
	const returnTime = variant.unavailableUntil
		? formatUnavailableUntil(variant.unavailableUntil, timezone)
		: ''

	const changeStatus = (next: string | null) => {
		if (next === 'unavailable_until') {
			const firstPreset = getAvailabilityPresets(location)[0]
			setPresetId(firstPreset?.id ?? '30_min')
			onChange({
				availabilityStatus: 'unavailable_until',
				unavailableUntil: (
					firstPreset?.date ?? new Date(Date.now() + 30 * 60 * 1000)
				).toISOString(),
			})
		} else if (next === 'available' || next === 'unavailable') {
			onChange({ availabilityStatus: next, unavailableUntil: null })
		}
	}

	const changePreset = (next: string | null) => {
		if (!next) return
		setPresetId(next)
		if (next === 'custom') return
		const preset = getAvailabilityPresets(location).find(
			(entry) => entry.id === next,
		)
		if (preset?.date) onChange({ unavailableUntil: preset.date.toISOString() })
	}

	return (
		<div className="max-w-56 space-y-1.5">
			<Label
				htmlFor={`variation-status-${variant.id}`}
				className="text-muted-foreground text-xs sm:sr-only"
			>
				<Trans>Availability</Trans>
			</Label>
			<Select value={status} onValueChange={changeStatus}>
				<SelectTrigger
					id={`variation-status-${variant.id}`}
					className="w-full"
					aria-label={_(msg`Availability for ${name}`)}
				>
					<SelectValue>
						<div className="flex items-center gap-2">
							<span
								className={
									status === 'available'
										? 'size-2 rounded-full bg-emerald-500'
										: status === 'unavailable_until'
											? 'size-2 rounded-full bg-amber-500'
											: 'bg-destructive size-2 rounded-full'
								}
							/>
							{status === 'available' ? (
								<Trans>Available</Trans>
							) : status === 'unavailable_until' ? (
								<Trans>Unavailable Until</Trans>
							) : (
								<Trans>Unavailable</Trans>
							)}
						</div>
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="available">
						<span className="flex items-center gap-2">
							<span className="size-2 rounded-full bg-emerald-500" />
							<Trans>Available</Trans>
						</span>
					</SelectItem>
					<SelectItem value="unavailable_until">
						<span className="flex items-center gap-2">
							<span className="size-2 rounded-full bg-amber-500" />
							<Trans>Unavailable Until</Trans>
						</span>
					</SelectItem>
					<SelectItem value="unavailable">
						<span className="flex items-center gap-2">
							<span className="bg-destructive size-2 rounded-full" />
							<Trans>Unavailable</Trans>
						</span>
					</SelectItem>
				</SelectContent>
			</Select>
			{status === 'unavailable_until' && (
				<div className="space-y-1.5">
					<Label
						htmlFor={`variation-preset-${variant.id}`}
						className="text-muted-foreground text-xs font-normal"
					>
						<Trans>Becomes available</Trans>
					</Label>
					<Select value={presetId} onValueChange={changePreset}>
						<SelectTrigger
							id={`variation-preset-${variant.id}`}
							className="w-full"
						>
							<SelectValue placeholder={_(msg`Select a return time`)} />
						</SelectTrigger>
						<SelectContent>
							{presets.map((preset) => (
								<SelectItem key={preset.id} value={preset.id}>
									{preset.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{presetId === 'custom' && (
						<Input
							type="datetime-local"
							aria-label={_(msg`Return time for ${name}`)}
							min={locationDateTime(new Date().toISOString(), timezone)}
							required
							value={
								variant.unavailableUntil
									? locationDateTime(variant.unavailableUntil, timezone)
									: ''
							}
							onChange={(event) => {
								const [date, time] = event.target.value.split('T')
								onChange({
									unavailableUntil:
										date && time
											? localDateAndTimeToUtc(
													date,
													time,
													timezone,
												).toISOString()
											: null,
								})
							}}
						/>
					)}
					{variant.unavailableUntil && (
						<p className="text-muted-foreground text-xs">
							<Trans>Until {returnTime}</Trans>
						</p>
					)}
				</div>
			)}
		</div>
	)
}
