import { Trans } from '@lingui/macro'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { Badge } from '@repo/ui/badge'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'

export interface LocationItem {
	id: string
	name: string
	slug: string
	isDefault: boolean
	timezone?: string
	storeHours?: unknown
	onlineHours?: unknown
	specialHours?: unknown
}

export interface LocationOverrideState {
	locationId: string
	isEnabled: boolean
	price?: number | null
	availabilityStatus?: string | null
	unavailableUntil?: Date | string | null
}

export interface LocationOverridesCardProps {
	locations: LocationItem[]
	overrides: Record<string, LocationOverrideState>
	onChange: (overrides: Record<string, LocationOverrideState>) => void
	allowPriceOverride?: boolean
	basePrice?: number
}

export function LocationOverridesCard({
	locations,
	overrides,
	onChange,
	allowPriceOverride = false,
	basePrice = 0,
}: LocationOverridesCardProps) {
	if (locations.length === 0) {
		return null
	}

	const handleToggleEnabled = (locationId: string, isEnabled: boolean) => {
		const current = overrides[locationId] || {
			locationId,
			isEnabled: true,
		}
		onChange({
			...overrides,
			[locationId]: {
				...current,
				isEnabled,
			},
		})
	}

	const handlePriceChange = (locationId: string, priceStr: string) => {
		const price = priceStr === '' ? null : parseFloat(priceStr)
		const current = overrides[locationId] || {
			locationId,
			isEnabled: true,
		}
		onChange({
			...overrides,
			[locationId]: {
				...current,
				price: isNaN(price as number) ? null : price,
			},
		})
	}

	return (
		<Frame className="w-full">
			<FrameHeader>
				<div>
					<FrameTitle className="text-base">
						<Trans>Location Overrides</Trans>
					</FrameTitle>
					<FrameDescription className="text-xs">
						<Trans>Control availability and custom pricing per location.</Trans>
					</FrameDescription>
				</div>
			</FrameHeader>
			<FramePanel className="divide-border divide-y">
				{locations.map((loc) => {
					const override = overrides[loc.id]
					const isEnabled = override ? override.isEnabled : true
					const price = override?.price ?? ''

					return (
						<div
							key={loc.id}
							className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="flex items-center gap-3">
								<Switch
									id={`loc-toggle-${loc.id}`}
									checked={isEnabled}
									onCheckedChange={(checked) =>
										handleToggleEnabled(loc.id, checked)
									}
								/>
								<div>
									<Label
										htmlFor={`loc-toggle-${loc.id}`}
										className="flex cursor-pointer items-center gap-2 text-sm font-medium"
									>
										{loc.name}
										{loc.isDefault && (
											<Badge
												variant="secondary"
												className="px-1.5 py-0 text-[10px] font-normal"
											>
												<Trans>Default</Trans>
											</Badge>
										)}
									</Label>
									<span className="text-muted-foreground block text-xs">
										{isEnabled ? (
											<Trans>Available at this location</Trans>
										) : (
											<Trans>Disabled for this location</Trans>
										)}
									</span>
								</div>
							</div>

							{allowPriceOverride && isEnabled && (
								<div className="flex items-center gap-2 pl-9 sm:pl-0">
									<Label
										htmlFor={`loc-price-${loc.id}`}
										className="text-muted-foreground shrink-0 text-xs"
									>
										<Trans>Price</Trans>
									</Label>
									<div className="relative w-28">
										<span className="text-muted-foreground absolute top-1/2 left-2.5 -translate-y-1/2 text-xs">
											$
										</span>
										<Input
											id={`loc-price-${loc.id}`}
											type="number"
											step="0.01"
											min="0"
											placeholder={basePrice.toFixed(2)}
											value={price}
											onChange={(e) =>
												handlePriceChange(loc.id, e.target.value)
											}
											className="h-8 pl-6 text-xs"
										/>
									</div>
								</div>
							)}
						</div>
					)
				})}
			</FramePanel>
		</Frame>
	)
}
