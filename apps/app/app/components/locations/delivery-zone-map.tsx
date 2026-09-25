'use client'

import { Trans } from '@lingui/macro'
import {
	type DeliveryPoint,
	type DeliveryZoneType,
} from '@repo/common/location-types'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import React, { useState, useRef } from 'react'

interface DeliveryZoneMapProps {
	centerLat: number
	centerLng: number
	zoneType: DeliveryZoneType
	radiusValue: number // in miles or km
	radiusUnit: 'miles' | 'km'
	polygonPoints: DeliveryPoint[]
	onPolygonPointsChange?: (points: DeliveryPoint[]) => void
	isRestricted?: boolean
	className?: string
	editable?: boolean
}

export function DeliveryZoneMap({
	centerLat,
	centerLng,
	zoneType,
	radiusValue = 5,
	radiusUnit = 'miles',
	polygonPoints = [],
	onPolygonPointsChange,
	isRestricted = false,
	className,
	editable = true,
}: DeliveryZoneMapProps) {
	const [zoom, setZoom] = useState(1)
	const pan = { x: 0, y: 0 }
	const mapRef = useRef<SVGSVGElement>(null)

	// SVG coordinate system center
	const width = 560
	const height = 360
	const centerX = width / 2
	const centerY = height / 2

	// Scale: pixels per mile/km
	// At zoom 1, 1 mile ≈ 24px
	const pixelsPerUnit = (radiusUnit === 'miles' ? 24 : 15) * zoom

	// Map coordinates to SVG
	// 1 degree lat ≈ 69 miles (approx)
	const milesPerLatDegree = 69
	const milesPerLngDegree = 54.6 // approximate at mid-latitude

	const latLngToSvg = (lat: number, lng: number) => {
		const dLat = (lat - centerLat) * milesPerLatDegree
		const dLng = (lng - centerLng) * milesPerLngDegree
		const unitConversion = radiusUnit === 'km' ? 1.60934 : 1
		const x = centerX + dLng * unitConversion * pixelsPerUnit + pan.x
		const y = centerY - dLat * unitConversion * pixelsPerUnit + pan.y
		return { x, y }
	}

	const svgToLatLng = (svgX: number, svgY: number) => {
		const unitConversion = radiusUnit === 'km' ? 1.60934 : 1
		const dLng =
			(svgX - centerX - pan.x) /
			(unitConversion * pixelsPerUnit * milesPerLngDegree)
		const dLat =
			-(svgY - centerY - pan.y) /
			(unitConversion * pixelsPerUnit * milesPerLatDegree)
		return {
			lat: parseFloat((centerLat + dLat).toFixed(6)),
			lng: parseFloat((centerLng + dLng).toFixed(6)),
		}
	}

	// Handle map canvas click in polygon mode
	const handleSvgClick = (event: React.MouseEvent<SVGSVGElement>) => {
		if (zoneType !== 'polygon' || !editable || !onPolygonPointsChange) return

		const rect = mapRef.current?.getBoundingClientRect()
		if (!rect) return

		const svgX = event.clientX - rect.left
		const svgY = event.clientY - rect.top

		const newPoint = svgToLatLng(svgX, svgY)
		onPolygonPointsChange([...(polygonPoints || []), newPoint])
	}

	const handleUndoPoint = () => {
		if (!polygonPoints || polygonPoints.length === 0 || !onPolygonPointsChange)
			return
		onPolygonPointsChange(polygonPoints.slice(0, -1))
	}

	const handleClearPoints = () => {
		if (!onPolygonPointsChange) return
		onPolygonPointsChange([])
	}

	// Convert polygon points to SVG path string
	const polygonSvgPoints = (polygonPoints || [])
		.map((p) => {
			const svg = latLngToSvg(p.lat, p.lng)
			return `${svg.x},${svg.y}`
		})
		.join(' ')

	// Radius in pixels
	const radiusPixels = radiusValue * pixelsPerUnit

	const zoneColor = isRestricted
		? 'rgba(239, 68, 68, 0.22)'
		: 'rgba(16, 185, 129, 0.22)'
	const zoneStroke = isRestricted
		? 'var(--color-destructive)'
		: 'var(--color-primary)'
	const pointCount = polygonPoints.length

	return (
		<div
			className={cn(
				'border-border bg-card text-card-foreground relative overflow-hidden rounded-md border select-none',
				className,
			)}
		>
			{/* Map SVG Canvas */}
			<svg
				ref={mapRef}
				viewBox={`0 0 ${width} ${height}`}
				className={cn(
					'h-full w-full',
					zoneType === 'polygon' && editable
						? 'cursor-crosshair'
						: 'cursor-default',
				)}
				onClick={handleSvgClick}
			>
				<defs>
					{/* Grid background pattern */}
					<pattern
						id="map-grid"
						width="30"
						height="30"
						patternUnits="userSpaceOnUse"
					>
						<path
							d="M 30 0 L 0 0 0 30"
							fill="none"
							stroke="currentColor"
							className="text-border/40"
							strokeWidth="1"
						/>
					</pattern>
					{/* Major grid */}
					<pattern
						id="major-grid"
						width="120"
						height="120"
						patternUnits="userSpaceOnUse"
					>
						<rect width="120" height="120" fill="url(#map-grid)" />
						<path
							d="M 120 0 L 0 0 0 120"
							fill="none"
							stroke="currentColor"
							className="text-border/60"
							strokeWidth="1.5"
						/>
					</pattern>
				</defs>

				{/* Map base background */}
				<rect width={width} height={height} className="fill-muted/20" />
				<rect width={width} height={height} fill="url(#major-grid)" />

				{/* Stylized road arteries */}
				<g opacity="0.3">
					<line
						x1="0"
						y1={centerY - 40}
						x2={width}
						y2={centerY - 40}
						className="stroke-muted-foreground"
						strokeWidth="4"
					/>
					<line
						x1="0"
						y1={centerY + 60}
						x2={width}
						y2={centerY + 60}
						className="stroke-muted-foreground"
						strokeWidth="3"
					/>
					<line
						x1={centerX - 80}
						y1="0"
						x2={centerX - 80}
						y2={height}
						className="stroke-muted-foreground"
						strokeWidth="4"
					/>
					<line
						x1={centerX + 110}
						y1="0"
						x2={centerX + 110}
						y2={height}
						className="stroke-muted-foreground"
						strokeWidth="3"
					/>
					<path
						d={`M 0,${centerY + 120} Q ${centerX},${centerY - 100} ${width},${centerY + 80}`}
						fill="none"
						className="stroke-muted-foreground"
						strokeWidth="5"
					/>
				</g>

				{/* RADIUS OVERLAY */}
				{zoneType === 'radius' && (
					<g>
						{/* Radius fill */}
						<circle
							cx={centerX + pan.x}
							cy={centerY + pan.y}
							r={radiusPixels}
							fill={zoneColor}
							stroke={zoneStroke}
							strokeWidth="2"
							strokeDasharray="6 4"
						/>
						{/* Distance marker line */}
						<line
							x1={centerX + pan.x}
							cy={centerY + pan.y}
							x2={centerX + pan.x + radiusPixels}
							y2={centerY + pan.y}
							stroke={zoneStroke}
							strokeWidth="1.5"
						/>
						{/* Distance badge label */}
						<g
							transform={`translate(${centerX + pan.x + radiusPixels / 2 - 28}, ${centerY + pan.y - 12})`}
						>
							<rect
								width="56"
								height="20"
								rx="4"
								className="fill-card stroke-border"
								strokeWidth="1"
							/>
							<text
								x="28"
								y="14"
								className="fill-card-foreground text-[10px]"
								textAnchor="middle"
							>
								{radiusValue} {radiusUnit}
							</text>
						</g>
					</g>
				)}

				{/* POLYGON OVERLAY */}
				{zoneType === 'polygon' && (
					<g>
						{polygonPoints.length >= 3 && (
							<polygon
								points={polygonSvgPoints}
								fill={zoneColor}
								stroke={zoneStroke}
								strokeWidth="2"
							/>
						)}

						{/* In-progress polygon lines */}
						{polygonPoints.length === 2 && (
							<line
								x1={latLngToSvg(polygonPoints[0]!.lat, polygonPoints[0]!.lng).x}
								y1={latLngToSvg(polygonPoints[0]!.lat, polygonPoints[0]!.lng).y}
								x2={latLngToSvg(polygonPoints[1]!.lat, polygonPoints[1]!.lng).x}
								y2={latLngToSvg(polygonPoints[1]!.lat, polygonPoints[1]!.lng).y}
								stroke={zoneStroke}
								strokeWidth="2"
							/>
						)}

						{/* Polygon vertex handles */}
						{polygonPoints.map((p, idx) => {
							const svg = latLngToSvg(p.lat, p.lng)
							return (
								<g key={idx}>
									<circle
										cx={svg.x}
										cy={svg.y}
										r="5"
										className="fill-background stroke-primary"
										strokeWidth="2"
									/>
									<text
										x={svg.x}
										y={svg.y - 9}
										className="fill-muted-foreground text-[9px]"
										textAnchor="middle"
									>
										P{idx + 1}
									</text>
								</g>
							)
						})}
					</g>
				)}

				{/* CENTER RESTAURANT PIN */}
				<g transform={`translate(${centerX + pan.x}, ${centerY + pan.y})`}>
					{/* Pulse effect */}
					<circle r="12" className="fill-primary/30 animate-ping" />
					<circle
						r="8"
						className="fill-primary stroke-background"
						strokeWidth="2"
					/>
					<circle r="3" className="fill-background" />
					{/* Store label */}
					<g transform="translate(-32, 14)">
						<rect
							width="64"
							height="18"
							rx="4"
							className="fill-card stroke-border"
							strokeWidth="1"
						/>
						<text
							x="32"
							y="13"
							className="fill-card-foreground text-[9px]"
							textAnchor="middle"
						>
							Store Location
						</text>
					</g>
				</g>
			</svg>

			{/* Floating Map Controls & Info */}
			<div className="absolute top-3 left-3 flex flex-col gap-1.5">
				<div className="border-border bg-background/90 text-foreground rounded-md border px-2.5 py-1 text-xs shadow-xs">
					{zoneType === 'radius' && (
						<Trans>
							Radius: {radiusValue} {radiusUnit}
						</Trans>
					)}
					{zoneType === 'polygon' && (
						<Trans>Polygon Area: {pointCount} points</Trans>
					)}
					{zoneType === 'zip_code' && <Trans>Zip Code Zone</Trans>}
				</div>

				{zoneType === 'polygon' && editable && (
					<span className="text-muted-foreground bg-background/90 border-border rounded border px-2 py-0.5 text-[11px] shadow-xs">
						<Trans>Click anywhere on the map to add polygon corners</Trans>
					</span>
				)}
			</div>

			{/* Action buttons (Zoom + Polygon tools) */}
			<div className="absolute right-3 bottom-3 flex items-center gap-1.5">
				{zoneType === 'polygon' && editable && polygonPoints.length > 0 && (
					<>
						<Button
							type="button"
							size="sm"
							variant="secondary"
							className="h-7 px-2 text-xs"
							onClick={handleUndoPoint}
						>
							<Icon name="undo-2" className="mr-1 size-3" />
							<Trans>Undo</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							variant="destructive"
							className="h-7 px-2 text-xs"
							onClick={handleClearPoints}
						>
							<Icon name="trash-2" className="mr-1 size-3" />
							<Trans>Clear</Trans>
						</Button>
					</>
				)}

				<div className="border-border bg-background/90 flex rounded-md border shadow-xs">
					<button
						type="button"
						onClick={() => setZoom((z) => Math.min(z + 0.25, 2.5))}
						className="text-foreground hover:bg-muted flex size-7 items-center justify-center"
						title="Zoom in"
					>
						<Icon name="plus" className="size-3.5" />
					</button>
					<div className="bg-border w-[1px]" />
					<button
						type="button"
						onClick={() => setZoom((z) => Math.max(z - 0.25, 0.5))}
						className="text-foreground hover:bg-muted flex size-7 items-center justify-center"
						title="Zoom out"
					>
						<Icon name="minus" className="size-3.5" />
					</button>
				</div>
			</div>
		</div>
	)
}
