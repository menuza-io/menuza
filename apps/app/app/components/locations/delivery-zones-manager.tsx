'use client'

import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	validateDistanceBands,
	validateFeeSteps,
	type DeliveryDistanceFees,
	type DeliveryFeeStep,
} from '@repo/common/delivery-fees'
import {
	type DeliveryPoint,
	type DeliveryProvider,
	type DeliveryRestriction,
	type DeliveryZone,
	type DeliveryZoneType,
	type ZonePriorityMode,
} from '@repo/common/location-types'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
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
import { Slider } from '@repo/ui/slider'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import React, { useMemo, useState } from 'react'
import { moveZone, zoneOverlapNotes } from '#app/utils/location/delivery-zones.ts'
import { DeliveryAddressCheck } from './delivery-address-check'
import {
	DistanceBandsEditor,
	FeeStepsEditor,
	normalizeDistanceBands,
	normalizeFeeSteps,
	useTableProblemText,
} from './delivery-fee-tables'
import { DeliveryZoneMap } from './delivery-zone-map'

interface DeliveryZonesManagerProps {
	zones: DeliveryZone[]
	onChange: (zones: DeliveryZone[]) => void
	centerLat: number
	centerLng: number
	/**
	 * Which zone wins where zones overlap (#266). Missing is `cheapest`, what a
	 * location that never reordered does; dragging a zone switches to `order`.
	 */
	priority?: ZonePriorityMode
	onPriorityChange?: (priority: ZonePriorityMode) => void
	/** For the Address check; absent while the location is new. */
	orgSlug?: string
	locationId?: string
	className?: string
}

const DEFAULT_BANDS: DeliveryDistanceFees = {
	mode: 'driving',
	unit: 'km',
	bands: [
		{ from: 0, fee: 3 },
		{ from: 3, fee: 4 },
		{ from: 5, fee: 5 },
	],
}

function SortableZoneRow({
	id,
	disabled,
	children,
}: {
	id: string
	disabled: boolean
	children: (handle: React.ReactNode) => React.ReactNode
}) {
	const { _ } = useLingui()
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id, disabled })
	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(isDragging && 'bg-background relative z-10 shadow-md')}
		>
			{children(
				<button
					type="button"
					ref={setActivatorNodeRef}
					className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md active:cursor-grabbing"
					aria-label={_(msg`Drag to reorder`)}
					{...attributes}
					{...listeners}
				>
					<Icon name="grip-vertical" className="size-4" />
				</button>,
			)}
		</div>
	)
}

export function DeliveryZonesManager({
	zones = [],
	onChange,
	centerLat,
	centerLng,
	priority = 'cheapest',
	onPriorityChange,
	orgSlug,
	locationId,
	className,
}: DeliveryZonesManagerProps) {
	const { _ } = useLingui()
	const tableProblemText = useTableProblemText()
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)
	const store =
		Number.isFinite(centerLat) &&
		Number.isFinite(centerLng) &&
		!(centerLat === 0 && centerLng === 0)
			? { lat: centerLat, lng: centerLng }
			: null
	const overlapNotes = useMemo(
		() => zoneOverlapNotes(zones, store, priority),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[zones, store?.lat, store?.lng, priority],
	)
	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		if (!over || active.id === over.id) return
		onChange(moveZone(zones, String(active.id), String(over.id)))
		// Dragging is the operator choosing the order: from here the list decides.
		onPriorityChange?.('order')
	}
	const [isModalOpen, setIsModalOpen] = useState(false)
	const [editingZoneId, setEditingZoneId] = useState<string | null>(null)

	// Modal form state
	const [zoneName, setZoneName] = useState('')
	const [provider, setProvider] = useState<DeliveryProvider>('in_house')
	const [restriction, setRestriction] = useState<DeliveryRestriction>('allowed')
	const [zoneType, setZoneType] = useState<DeliveryZoneType>('radius')
	const [radiusValue, setRadiusValue] = useState(5)
	const [radiusUnit, setRadiusUnit] = useState<'miles' | 'km'>('miles')
	const [zipCodesText, setZipCodesText] = useState('')
	const [polygonPoints, setPolygonPoints] = useState<DeliveryPoint[]>([])
	const [minimumOrder, setMinimumOrder] = useState(15)
	const [deliveryFee, setDeliveryFee] = useState(3.99)
	const [enabled, setEnabled] = useState(true)
	const [feeByAmount, setFeeByAmount] = useState(false)
	const [feeSteps, setFeeSteps] = useState<DeliveryFeeStep[]>([])
	const [feeByDistance, setFeeByDistance] = useState(false)
	const [distanceFees, setDistanceFees] =
		useState<DeliveryDistanceFees>(DEFAULT_BANDS)

	const handleOpenAdd = () => {
		setEditingZoneId(null)
		setZoneName('')
		setProvider('in_house')
		setRestriction('allowed')
		setZoneType('radius')
		setRadiusValue(5)
		setRadiusUnit('miles')
		setZipCodesText('')
		setPolygonPoints([])
		setMinimumOrder(15)
		setDeliveryFee(3.99)
		setEnabled(true)
		setFeeByAmount(false)
		setFeeSteps([])
		setFeeByDistance(false)
		setDistanceFees(DEFAULT_BANDS)
		setIsModalOpen(true)
	}

	const handleOpenEdit = (zone: DeliveryZone) => {
		setEditingZoneId(zone.id)
		setZoneName(zone.name || '')
		setProvider(zone.provider || 'in_house')
		setRestriction(zone.restriction || 'allowed')
		setZoneType(zone.type || 'radius')
		setRadiusValue(zone.radius?.value ?? 5)
		setRadiusUnit(zone.radius?.unit ?? 'miles')
		setZipCodesText((zone.zipCodes || []).join(', '))
		setPolygonPoints(zone.polygon || [])
		setMinimumOrder(zone.minimumOrder ?? 15)
		setDeliveryFee(zone.deliveryFee ?? 3.99)
		setEnabled(zone.enabled ?? true)
		setFeeByAmount(Boolean(zone.feeSteps && zone.feeSteps.length > 0))
		setFeeSteps(zone.feeSteps ?? [])
		setFeeByDistance(Boolean(zone.distanceFees?.bands.length))
		setDistanceFees(zone.distanceFees ?? DEFAULT_BANDS)
		setIsModalOpen(true)
	}

	// The tables as they will be saved, and what is wrong with them.
	const savedSteps = feeByAmount
		? normalizeFeeSteps(
				feeSteps.length > 0
					? feeSteps
					: [{ from: minimumOrder, fee: deliveryFee }],
				minimumOrder,
			)
		: []
	const savedBands = feeByDistance ? normalizeDistanceBands(distanceFees) : null
	const stepsProblem = feeByAmount
		? validateFeeSteps(savedSteps, minimumOrder)
		: null
	const bandsProblem = savedBands ? validateDistanceBands(savedBands) : null

	const handleSaveZone = () => {
		if (!zoneName.trim() || stepsProblem || bandsProblem) return

		const parsedZipCodes = zipCodesText
			.split(/[,\s\n]+/)
			.map((z) => z.trim())
			.filter(Boolean)

		const zoneData: DeliveryZone = {
			id: editingZoneId || `zone_${Date.now()}`,
			name: zoneName.trim(),
			provider,
			restriction,
			type: zoneType,
			radius: {
				value: radiusValue,
				unit: radiusUnit,
			},
			zipCodes: parsedZipCodes,
			polygon: polygonPoints,
			minimumOrder,
			deliveryFee,
			// Left out when off, so a zone without a table is saved as it always was.
			...(feeByAmount ? { feeSteps: savedSteps } : {}),
			...(savedBands ? { distanceFees: savedBands } : {}),
			enabled,
		}

		if (editingZoneId) {
			onChange(zones.map((z) => (z.id === editingZoneId ? zoneData : z)))
		} else {
			onChange([...zones, zoneData])
		}

		setIsModalOpen(false)
	}

	const handleDeleteZone = (id: string) => {
		onChange(zones.filter((z) => z.id !== id))
	}

	const handleToggleZoneEnabled = (id: string, nextEnabled: boolean) => {
		onChange(
			zones.map((z) => (z.id === id ? { ...z, enabled: nextEnabled } : z)),
		)
	}

	const getProviderLabel = (p: DeliveryProvider) => {
		switch (p) {
			case 'in_house':
				return 'In-House'
			case 'uber_eats':
				return 'Uber Eats'
			case 'doordash':
				return 'DoorDash'
			case 'restricted':
				return 'Restricted Area'
		}
	}

	return (
		<div className={cn('space-y-4', className)}>
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h4 className="text-sm">
						<Trans>Delivery Zones</Trans>
					</h4>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Define allowed and restricted delivery areas by radius, zip codes,
							or polygon maps.
						</Trans>
					</p>
				</div>

				<Button size="sm" variant="outline" onClick={handleOpenAdd}>
					<Icon name="plus" className="mr-1.5 size-3.5" />
					<Trans>Add delivery zone</Trans>
				</Button>
			</div>

			{zones.length === 0 ? (
				<div className="bg-muted/20 rounded-md border border-dashed p-6 text-center">
					<Icon
						name="route"
						className="text-muted-foreground mx-auto mb-2 size-6"
					/>
					<p className="text-foreground text-sm font-medium">
						<Trans>No delivery zones configured</Trans>
					</p>
					<p className="text-muted-foreground mt-1 text-xs">
						<Trans>
							Add a delivery zone to specify radius distance, zip codes, or draw
							custom polygon areas.
						</Trans>
					</p>
				</div>
			) : (
				<div className="space-y-2">
					<p className="text-muted-foreground text-xs" data-testid="zone-priority-note">
						{priority === 'order' ? (
							<Trans>
								Where zones overlap, the first zone in the list that covers the
								address applies. Drag zones to change the order. Zones where
								delivery is not allowed always exclude an address, whatever their
								place.
							</Trans>
						) : (
							<Trans>
								Where zones overlap, the cheapest zone applies. Drag a zone to
								choose the winner yourself instead: the first one in the list
								will apply.
							</Trans>
						)}
					</p>
					{priority === 'order' && onPriorityChange ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => onPriorityChange('cheapest')}
						>
							<Trans>Use the cheapest zone instead</Trans>
						</Button>
					) : null}
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={[restrictToVerticalAxis]}
						onDragEnd={handleDragEnd}
					>
						<SortableContext
							items={zones.map((zone) => zone.id)}
							strategy={verticalListSortingStrategy}
						>
							<div className="divide-border divide-y rounded-md border">
								{zones.map((zone, index) => {
									const note = overlapNotes.get(zone.id)
									const position = index + 1
									return (
										<SortableZoneRow
											key={zone.id}
											id={zone.id}
											disabled={zones.length < 2}
										>
											{(handle) => (
												<div
													className={cn(
														'flex flex-col gap-3 p-4 transition-colors sm:flex-row sm:items-center sm:justify-between',
														!zone.enabled && 'bg-muted/30 opacity-70',
													)}
												>
													<div className="flex items-start gap-2">
														{zones.length > 1 ? handle : null}
														<div className="space-y-1.5">
															<div className="flex flex-wrap items-center gap-2">
																{priority === 'order' && zones.length > 1 ? (
																	<Badge
																		variant="secondary"
																		className="text-[11px]"
																		aria-label={_(msg`Priority ${position}`)}
																	>
																		{position}
																	</Badge>
																) : null}
																<span className="text-sm">{zone.name}</span>

																<Badge
																	variant={
																		zone.restriction === 'disallowed'
																			? 'destructive'
																			: 'outline'
																	}
																	className="text-[11px]"
																>
																	{zone.restriction === 'disallowed'
																		? _(msg`Restricted (No Delivery)`)
																		: _(msg`Allowed`)}
																</Badge>

																<Badge variant="secondary" className="text-[11px]">
																	{getProviderLabel(zone.provider)}
																</Badge>

																<Badge variant="outline" className="text-[11px]">
																	{zone.type === 'radius' &&
																		`${zone.radius.value} ${zone.radius.unit} radius`}
																	{zone.type === 'zip_code' &&
																		`${zone.zipCodes.length} zip codes`}
																	{zone.type === 'polygon' &&
																		`Polygon (${zone.polygon.length} points)`}
																</Badge>
															</div>

															{(() => {
																const minOrder = zone.minimumOrder.toFixed(2)
																const deliveryFee = zone.deliveryFee.toFixed(2)
																const stepCount = zone.feeSteps?.length ?? 0
																const bandCount = zone.distanceFees?.bands.length ?? 0
																return (
																	<div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
																		<span>
																			<Trans>Min Order: ${minOrder}</Trans>
																		</span>
																		<span>·</span>
																		<span>
																			{stepCount > 0 ? (
																				<Trans>
																					Fee by order size ({stepCount} steps)
																				</Trans>
																			) : bandCount > 0 ? (
																				<Trans>
																					Fee by distance ({bandCount} bands)
																				</Trans>
																			) : (
																				<Trans>Fee: ${deliveryFee}</Trans>
																			)}
																		</span>
																		{zone.type === 'zip_code' &&
																			zone.zipCodes.length > 0 && (
																				<>
																					<span>·</span>
																					<span className="max-w-xs truncate">
																						Zips: {zone.zipCodes.slice(0, 5).join(', ')}
																						{zone.zipCodes.length > 5 ? '...' : ''}
																					</span>
																				</>
																			)}
																	</div>
																)
															})()}

															{note
																? note.overlaps.map((other) => {
																		const otherName = other.name
																		return (
																			<p
																				key={other.id}
																				data-testid="zone-overlap-note"
																				className="text-xs text-amber-700 dark:text-amber-400"
																			>
																				{other.thisWins ? (
																					<Trans>
																						Overlaps {otherName}; this one wins.
																					</Trans>
																				) : priority === 'order' ? (
																					<Trans>
																						Overlaps {otherName}; that one wins because
																						it is higher.
																					</Trans>
																				) : (
																					<Trans>
																						Overlaps {otherName}; that one wins because
																						it is cheaper.
																					</Trans>
																				)}
																			</p>
																		)
																	})
																: null}
														</div>
													</div>

													<div className="flex items-center gap-2 self-end sm:self-center">
														<Switch
															checked={zone.enabled}
															onCheckedChange={(checked) =>
																handleToggleZoneEnabled(zone.id, checked)
															}
															title="Enable/Disable Zone"
															aria-label={`Toggle ${zone.name}`}
														/>
														<Button
															size="icon-sm"
															variant="ghost"
															onClick={() => handleOpenEdit(zone)}
															title="Edit Zone"
														>
															<Icon name="pencil" className="size-3.5" />
														</Button>
														<Button
															size="icon-sm"
															variant="ghost"
															className="text-muted-foreground hover:text-destructive"
															onClick={() => handleDeleteZone(zone.id)}
															title="Delete Zone"
														>
															<Icon name="trash-2" className="size-3.5" />
														</Button>
													</div>
												</div>
											)}
										</SortableZoneRow>
									)
								})}
							</div>
						</SortableContext>
					</DndContext>
				</div>
			)}

			{orgSlug ? (
				<DeliveryAddressCheck orgSlug={orgSlug} locationId={locationId} />
			) : null}

			{/* Add / Edit Delivery Zone Modal */}
			<Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
				<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{editingZoneId ? (
								<Trans>Edit Delivery Zone</Trans>
							) : (
								<Trans>Add Delivery Zone</Trans>
							)}
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Configure delivery rules, pricing, provider, and boundary areas.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4 py-2">
						{/* Zone Name & Provider */}
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="zone-name">
									<Trans>Zone Name</Trans>
								</Label>
								<Input
									id="zone-name"
									placeholder={_(msg`e.g. Downtown Express, Zone 1`)}
									value={zoneName}
									onChange={(e) => setZoneName(e.target.value)}
									required
								/>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="zone-provider">
									<Trans>Delivery Provider</Trans>
								</Label>
								<Select
									value={provider}
									items={{
										in_house: 'In-House Fleet',
										uber_eats: 'Uber Eats',
										doordash: 'DoorDash',
										restricted: 'Restricted Area',
									}}
									onValueChange={(val) =>
										val && setProvider(val as DeliveryProvider)
									}
								>
									<SelectTrigger id="zone-provider">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="in_house">In-House Fleet</SelectItem>
										<SelectItem value="uber_eats">Uber Eats</SelectItem>
										<SelectItem value="doordash">DoorDash</SelectItem>
										<SelectItem value="restricted">Restricted Area</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>

						{/* Restriction Status */}
						<div className="border-border flex items-center justify-between rounded-md border p-3">
							<div className="space-y-0.5">
								<Label htmlFor="zone-restriction">
									<Trans>Delivery Allowed</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									{restriction === 'allowed'
										? _(msg`Orders can be delivered inside this zone`)
										: _(
												msg`Delivery is blocked or disallowed for this specific zone`,
											)}
								</p>
							</div>
							<Switch
								id="zone-restriction"
								checked={restriction === 'allowed'}
								onCheckedChange={(checked) =>
									setRestriction(checked ? 'allowed' : 'disallowed')
								}
							/>
						</div>

						{/* Area Type Tabs */}
						<div className="space-y-2">
							<Label>
								<Trans>Area Boundary Type</Trans>
							</Label>
							<Tabs
								value={zoneType}
								onValueChange={(val) => setZoneType(val as DeliveryZoneType)}
								className="w-full"
							>
								<TabsList className="grid w-full grid-cols-3">
									<TabsTrigger value="radius">
										<Trans>Radius Circle</Trans>
									</TabsTrigger>
									<TabsTrigger value="zip_code">
										<Trans>Zip Codes</Trans>
									</TabsTrigger>
									<TabsTrigger value="polygon">
										<Trans>Draw Polygon</Trans>
									</TabsTrigger>
								</TabsList>
							</Tabs>
						</div>

						{/* Radius Controls */}
						{zoneType === 'radius' && (
							<div className="space-y-3 rounded-md border p-3">
								<div className="flex items-center justify-between">
									<Label>
										<Trans>
											Radius Distance ({radiusValue} {radiusUnit})
										</Trans>
									</Label>
									<div className="flex rounded-md border text-xs">
										<button
											type="button"
											onClick={() => setRadiusUnit('miles')}
											className={cn(
												'px-2.5 py-1 font-medium transition-colors',
												radiusUnit === 'miles'
													? 'bg-primary text-primary-foreground'
													: 'text-muted-foreground hover:text-foreground',
											)}
										>
											Miles
										</button>
										<button
											type="button"
											onClick={() => setRadiusUnit('km')}
											className={cn(
												'px-2.5 py-1 font-medium transition-colors',
												radiusUnit === 'km'
													? 'bg-primary text-primary-foreground'
													: 'text-muted-foreground hover:text-foreground',
											)}
										>
											KM
										</button>
									</div>
								</div>

								<Slider
									value={[radiusValue]}
									onValueChange={(vals) => setRadiusValue(vals[0] || 1)}
									min={1}
									max={30}
									step={0.5}
								/>

								{/* Map preview */}
								<div className="h-56 w-full pt-1">
									<DeliveryZoneMap
										centerLat={centerLat}
										centerLng={centerLng}
										zoneType="radius"
										radiusValue={radiusValue}
										radiusUnit={radiusUnit}
										polygonPoints={[]}
										isRestricted={restriction === 'disallowed'}
										editable={false}
									/>
								</div>
							</div>
						)}

						{/* Zip Codes Controls */}
						{zoneType === 'zip_code' && (
							<div className="space-y-2 rounded-md border p-3">
								<Label htmlFor="zone-zips">
									<Trans>Zip Codes (comma or space separated)</Trans>
								</Label>
								<Textarea
									id="zone-zips"
									placeholder="10001, 10002, 10003, 10004"
									rows={3}
									value={zipCodesText}
									onChange={(e) => setZipCodesText(e.target.value)}
								/>
								<p className="text-muted-foreground text-xs">
									<Trans>
										Enter postal or zip codes where this delivery zone applies.
									</Trans>
								</p>
							</div>
						)}

						{/* Polygon Map Drawer */}
						{zoneType === 'polygon' && (
							<div className="space-y-2 rounded-md border p-3">
								<div className="flex items-center justify-between">
									<Label>
										<Trans>Draw Delivery Zone on Map</Trans>
									</Label>
									{(() => {
										const pointsCount = polygonPoints.length
										return (
											<span className="text-muted-foreground text-xs">
												{pointsCount === 1 ? (
													<Trans>1 point</Trans>
												) : (
													<Trans>{pointsCount} points</Trans>
												)}
											</span>
										)
									})()}
								</div>

								<div className="h-64 w-full">
									<DeliveryZoneMap
										centerLat={centerLat}
										centerLng={centerLng}
										zoneType="polygon"
										radiusValue={radiusValue}
										radiusUnit={radiusUnit}
										polygonPoints={polygonPoints}
										onPolygonPointsChange={setPolygonPoints}
										isRestricted={restriction === 'disallowed'}
										editable={true}
									/>
								</div>
							</div>
						)}

						{/* Minimum Order & Delivery Fee */}
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div className="space-y-1.5">
								<Label htmlFor="zone-min-order">
									<Trans>Minimum Order ($)</Trans>
								</Label>
								<Input
									id="zone-min-order"
									type="number"
									step="0.50"
									min="0"
									value={minimumOrder}
									onChange={(e) =>
										setMinimumOrder(parseFloat(e.target.value) || 0)
									}
								/>
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="zone-fee">
									<Trans>In-House Delivery Fee ($)</Trans>
								</Label>
								<Input
									id="zone-fee"
									type="number"
									step="0.50"
									min="0"
									value={deliveryFee}
									onChange={(e) =>
										setDeliveryFee(parseFloat(e.target.value) || 0)
									}
								/>
							</div>
						</div>

						{restriction === 'allowed' ? (
							<div className="space-y-3">
								<div className="border-border flex items-center justify-between rounded-md border p-3">
									<div className="space-y-0.5">
										<Label htmlFor="zone-fee-steps">
											<Trans>Fee by order size</Trans>
										</Label>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Charge less, or nothing, as the order grows. Without it the
												single fee above applies.
											</Trans>
										</p>
									</div>
									<Switch
										id="zone-fee-steps"
										checked={feeByAmount}
										onCheckedChange={(checked) => {
											setFeeByAmount(checked)
											if (checked && feeSteps.length === 0) {
												setFeeSteps([{ from: minimumOrder, fee: deliveryFee }])
											}
										}}
									/>
								</div>
								{feeByAmount ? (
									<FeeStepsEditor
										steps={savedSteps}
										minimumOrder={minimumOrder}
										onChange={setFeeSteps}
										error={tableProblemText(stepsProblem)}
									/>
								) : null}

								<div className="border-border flex items-center justify-between rounded-md border p-3">
									<div className="space-y-0.5">
										<Label htmlFor="zone-fee-distance">
											<Trans>Fee by distance</Trans>
										</Label>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Charge by how far the address is from the store, in a
												straight line or by road.
											</Trans>
										</p>
									</div>
									<Switch
										id="zone-fee-distance"
										checked={feeByDistance}
										onCheckedChange={setFeeByDistance}
									/>
								</div>
								{feeByDistance ? (
									<DistanceBandsEditor
										fees={distanceFees}
										onChange={setDistanceFees}
										error={tableProblemText(bandsProblem)}
									/>
								) : null}
								{feeByAmount && feeByDistance ? (
									<p className="text-muted-foreground text-xs">
										<Trans>
											With both, the order size can only lower the distance fee,
											never raise it.
										</Trans>
									</p>
								) : null}
							</div>
						) : null}
					</div>

					<DialogFooter>
						<Button variant="outline" onClick={() => setIsModalOpen(false)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							onClick={handleSaveZone}
							disabled={!zoneName.trim() || Boolean(stepsProblem || bandsProblem)}
						>
							<Trans>Save zone</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
