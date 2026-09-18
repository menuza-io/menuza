'use client'

import { type GoogleMapsClientMode } from '@repo/common/google-maps-mock'
import { useEffect, useRef } from 'react'

import { MockLocationMap } from '#app/components/locations/mock-location-map.tsx'

type LocationMapProps = {
	mapsMode: GoogleMapsClientMode
	googleMapsApiKey?: string | null
	latitude?: number | null
	longitude?: number | null
	onPinChange?: (lat: number, lng: number) => void
}

function LiveGoogleLocationMap({
	googleMapsApiKey,
	latitude,
	longitude,
	onPinChange,
}: Omit<LocationMapProps, 'mapsMode'>) {
	const mapRef = useRef<HTMLDivElement>(null)
	const mapInstanceRef = useRef<unknown>(null)
	const markerRef = useRef<unknown>(null)
	const lastPositionRef = useRef<{ lat: number; lng: number } | null>(null)
	const onPinChangeRef = useRef(onPinChange)

	onPinChangeRef.current = onPinChange

	useEffect(() => {
		if (!googleMapsApiKey?.trim() || !mapRef.current) return
		const google = (window as typeof window & { google?: any }).google
		if (!google?.maps) return

		if (!mapInstanceRef.current) {
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
				draggable: Boolean(onPinChangeRef.current),
			})
			marker.addListener('dragend', () => {
				const pos = marker.getPosition()
				if (pos && onPinChangeRef.current) {
					onPinChangeRef.current(pos.lat(), pos.lng())
				}
			})
			mapInstanceRef.current = map
			markerRef.current = marker
			lastPositionRef.current = center
			return
		}

		const marker = markerRef.current as {
			setPosition: (pos: { lat: number; lng: number }) => void
		}
		const map = mapInstanceRef.current as {
			setCenter: (pos: { lat: number; lng: number }) => void
		}
		if (latitude != null && longitude != null && marker && map) {
			const position = { lat: latitude, lng: longitude }
			const last = lastPositionRef.current
			if (last?.lat === position.lat && last?.lng === position.lng) {
				return
			}
			lastPositionRef.current = position
			marker.setPosition(position)
			map.setCenter(position)
		}
	}, [googleMapsApiKey, latitude, longitude])

	return <div ref={mapRef} className="h-48 w-full rounded-lg border" />
}

export function LocationMap({
	mapsMode,
	googleMapsApiKey,
	latitude,
	longitude,
	onPinChange,
}: LocationMapProps) {
	const useLiveMaps = mapsMode === 'live' && Boolean(googleMapsApiKey?.trim())

	if (!useLiveMaps) {
		return (
			<MockLocationMap
				latitude={latitude}
				longitude={longitude}
				onPinChange={onPinChange}
			/>
		)
	}

	return (
		<LiveGoogleLocationMap
			googleMapsApiKey={googleMapsApiKey}
			latitude={latitude}
			longitude={longitude}
			onPinChange={onPinChange}
		/>
	)
}
