'use client'

import { Trans } from '@lingui/macro'
import { GOOGLE_MAPS_MOCK_PLACE } from '@repo/common/google-maps-mock'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'

type MockLocationMapProps = {
	latitude?: number | null
	longitude?: number | null
	onPinChange?: (lat: number, lng: number) => void
}

export function MockLocationMap({
	latitude,
	longitude,
	onPinChange,
}: MockLocationMapProps) {
	const lat = latitude ?? GOOGLE_MAPS_MOCK_PLACE.latitude
	const lng = longitude ?? GOOGLE_MAPS_MOCK_PLACE.longitude

	return (
		<div className="flex flex-col gap-3 rounded-lg border border-dashed p-4">
			<p className="text-muted-foreground text-sm">
				<Trans>
					Mock map (no Google API key). Coordinates are used for delivery and
					publish validation.
				</Trans>
			</p>
			<div
				className="bg-muted flex h-32 items-center justify-center rounded-md text-sm"
				aria-hidden
			>
				<Trans>Map preview — mock mode</Trans>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1">
					<Label htmlFor="mock-latitude">
						<Trans>Latitude</Trans>
					</Label>
					<Input
						id="mock-latitude"
						type="number"
						step="any"
						value={lat}
						onChange={(event) => {
							const next = Number(event.target.value)
							if (!Number.isNaN(next) && onPinChange) onPinChange(next, lng)
						}}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="mock-longitude">
						<Trans>Longitude</Trans>
					</Label>
					<Input
						id="mock-longitude"
						type="number"
						step="any"
						value={lng}
						onChange={(event) => {
							const next = Number(event.target.value)
							if (!Number.isNaN(next) && onPinChange) onPinChange(lat, next)
						}}
					/>
				</div>
			</div>
			{onPinChange ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="w-fit"
					onClick={() =>
						onPinChange(
							GOOGLE_MAPS_MOCK_PLACE.latitude,
							GOOGLE_MAPS_MOCK_PLACE.longitude,
						)
					}
				>
					<Trans>Reset to sample pin (Houston)</Trans>
				</Button>
			) : null}
		</div>
	)
}
