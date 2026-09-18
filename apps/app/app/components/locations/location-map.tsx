'use client'

import { Trans } from '@lingui/macro'
import { useEffect, useRef } from 'react'

type LocationMapProps = {
	googleMapsApiKey?: string | null
	latitude?: number | null
	longitude?: number | null
	onPinChange?: (lat: number, lng: number) => void
}

export function LocationMap({
	googleMapsApiKey,
	latitude,
	longitude,
	onPinChange,
}: LocationMapProps) {
	const mapRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!googleMapsApiKey?.trim() || !mapRef.current) return
		const google = (window as typeof window & { google?: any }).google
		if (!google?.maps) return

		const center = {
			lat: latitude ?? 29.7604,
			lng: longitude ?? -95.3698,
		}
		const map = new google.maps.Map(mapRef.current, {
			center,
			zoom: latitude != null ? 15 : 4,
		})
		const marker = new google.maps.Marker({
			position: center,
			map,
			draggable: Boolean(onPinChange),
		})
		marker.addListener('dragend', () => {
			const pos = marker.getPosition()
			if (pos && onPinChange) onPinChange(pos.lat(), pos.lng())
		})
	}, [googleMapsApiKey, latitude, longitude, onPinChange])

	if (!googleMapsApiKey?.trim()) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>Map preview appears when Google Maps is configured.</Trans>
			</p>
		)
	}

	return <div ref={mapRef} className="h-48 w-full rounded-lg border" />
}
