'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	getLocationCurrency,
	type LocationAddress,
} from '@repo/common/location-types'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Spinner } from '@repo/ui/spinner'
import React, { useState, useEffect, useRef } from 'react'

interface AutocompletePrediction {
	placeId: string
	description: string
	mainText: string
	secondaryText: string
	details: {
		formattedAddress: string
		streetNumber?: string
		streetName?: string
		unit?: string
		city: string
		state: string
		postalCode: string
		country: string
		lat: number
		lng: number
	}
}

interface AddressAutocompleteProps {
	address: LocationAddress
	onChange: (address: LocationAddress) => void
	className?: string
}

export function AddressAutocomplete({
	address,
	onChange,
	className,
}: AddressAutocompleteProps) {
	const { _ } = useLingui()
	const [searchTerm, setSearchTerm] = useState('')
	const [predictions, setPredictions] = useState<AutocompletePrediction[]>([])
	const [isLoading, setIsLoading] = useState(false)
	const [isOpen, setIsOpen] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	// Debounced search query
	useEffect(() => {
		if (!searchTerm.trim()) {
			setPredictions([])
			setIsOpen(false)
			return
		}

		const timer = setTimeout(async () => {
			setIsLoading(true)
			try {
				const res = await fetch(
					`/resources/places/autocomplete?query=${encodeURIComponent(searchTerm)}`,
				)
				if (res.ok) {
					const data = (await res.json()) as {
						predictions?: AutocompletePrediction[]
					}
					setPredictions(data.predictions || [])
					setIsOpen((data.predictions || []).length > 0)
				}
			} catch {
				setPredictions([])
			} finally {
				setIsLoading(false)
			}
		}, 250)

		return () => clearTimeout(timer)
	}, [searchTerm])

	// Close on click outside
	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (
				containerRef.current &&
				!containerRef.current.contains(event.target as Node)
			) {
				setIsOpen(false)
			}
		}

		document.addEventListener('mousedown', handleClickOutside)
		return () => document.removeEventListener('mousedown', handleClickOutside)
	}, [])

	const handleSelectPrediction = (prediction: AutocompletePrediction) => {
		const { details } = prediction
		onChange({
			formattedAddress: details.formattedAddress,
			streetNumber: details.streetNumber,
			streetName: details.streetName,
			unit: address.unit || '',
			city: details.city,
			state: details.state,
			postalCode: details.postalCode,
			country: details.country,
			lat: details.lat,
			lng: details.lng,
		})
		setSearchTerm('')
		setIsOpen(false)
	}

	const handleFieldChange = (field: keyof LocationAddress, value: any) => {
		onChange({
			...address,
			[field]: value,
		})
	}

	return (
		<div className={cn('space-y-4', className)} ref={containerRef}>
			{/* Autocomplete Search Input */}
			<div className="relative">
				<Label htmlFor="address-autocomplete-input" className="mb-1.5 block">
					<Trans>Search Address (Google Autocomplete)</Trans>
				</Label>
				<div className="relative">
					<Icon
						name="search"
						className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
					/>
					<Input
						id="address-autocomplete-input"
						type="text"
						placeholder={_(msg`Start typing an address, city, or zip code...`)}
						value={searchTerm}
						onChange={(e) => setSearchTerm(e.target.value)}
						onFocus={() => {
							if (predictions.length > 0) setIsOpen(true)
						}}
						className="pr-10 pl-9"
					/>
					{isLoading && (
						<div className="absolute top-1/2 right-3 -translate-y-1/2">
							<Spinner className="size-4" />
						</div>
					)}
				</div>

				{/* Autocomplete Dropdown */}
				{isOpen && (
					<div className="bg-popover text-popover-foreground border-border absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-md border p-1 shadow-md">
						{predictions.map((p) => (
							<button
								key={p.placeId}
								type="button"
								onClick={() => handleSelectPrediction(p)}
								className="hover:bg-accent hover:text-accent-foreground flex w-full items-start gap-2.5 rounded-sm px-3 py-2 text-left text-sm transition-colors"
							>
								<Icon
									name="building"
									className="text-muted-foreground mt-0.5 size-4 shrink-0"
								/>
								<div className="min-w-0 flex-1 leading-tight">
									<p className="font-medium">{p.mainText}</p>
									<p className="text-muted-foreground text-xs">
										{p.secondaryText}
									</p>
								</div>
							</button>
						))}
					</div>
				)}
			</div>

			{/* Formatted Address Display */}
			{address.formattedAddress && (
				<div className="bg-muted/40 border-border flex items-center justify-between rounded-md border p-3">
					<div className="min-w-0 flex-1">
						<span className="text-muted-foreground block text-xs font-medium uppercase">
							<Trans>Selected Address</Trans>
						</span>
						<p className="text-foreground truncate text-sm font-medium">
							{address.formattedAddress}
						</p>
						<span className="text-muted-foreground text-xs">
							Lat: {address.lat.toFixed(5)}, Lng: {address.lng.toFixed(5)}
						</span>
					</div>
				</div>
			)}

			{/* Structured Address Fields */}
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<div className="sm:col-span-2">
					<Label htmlFor="loc-street" className="mb-1 block text-xs">
						<Trans>Street Address</Trans>
					</Label>
					<Input
						id="loc-street"
						value={
							address.streetNumber && address.streetName
								? `${address.streetNumber} ${address.streetName}`
								: address.formattedAddress?.split(',')[0] || ''
						}
						onChange={(e) => {
							handleFieldChange('formattedAddress', e.target.value)
						}}
						placeholder="123 Main Street"
					/>
				</div>

				<div>
					<Label htmlFor="loc-unit" className="mb-1 block text-xs">
						<Trans>Suite / Unit / Floor (Optional)</Trans>
					</Label>
					<Input
						id="loc-unit"
						value={address.unit || ''}
						onChange={(e) => handleFieldChange('unit', e.target.value)}
						placeholder="Suite 400"
					/>
				</div>

				<div>
					<Label htmlFor="loc-city" className="mb-1 block text-xs">
						<Trans>City</Trans>
					</Label>
					<Input
						id="loc-city"
						value={address.city}
						onChange={(e) => handleFieldChange('city', e.target.value)}
						placeholder="City"
						required
					/>
				</div>

				<div>
					<Label htmlFor="loc-state" className="mb-1 block text-xs">
						<Trans>State / Province</Trans>
					</Label>
					<Input
						id="loc-state"
						value={address.state}
						onChange={(e) => handleFieldChange('state', e.target.value)}
						placeholder="State"
						required
					/>
				</div>

				<div>
					<Label htmlFor="loc-postal" className="mb-1 block text-xs">
						<Trans>Postal / ZIP Code</Trans>
					</Label>
					<Input
						id="loc-postal"
						value={address.postalCode}
						onChange={(e) => handleFieldChange('postalCode', e.target.value)}
						placeholder="10001"
						required
					/>
				</div>

				<div>
					<Label htmlFor="loc-country" className="mb-1 block text-xs">
						<Trans>Country</Trans>
					</Label>
					<Input
						id="loc-country"
						value={address.country}
						onChange={(e) => handleFieldChange('country', e.target.value)}
						placeholder="United States"
						required
					/>
				</div>

				<div>
					<Label htmlFor="loc-coords" className="mb-1 block text-xs">
						<Trans>Coordinates (Lat, Lng)</Trans>
					</Label>
					<div className="flex gap-2">
						<Input
							id="loc-coords-lat"
							type="number"
							step="0.0001"
							value={address.lat}
							onChange={(e) =>
								handleFieldChange('lat', parseFloat(e.target.value) || 0)
							}
							placeholder="Latitude"
						/>
						<Input
							id="loc-coords-lng"
							type="number"
							step="0.0001"
							value={address.lng}
							onChange={(e) =>
								handleFieldChange('lng', parseFloat(e.target.value) || 0)
							}
							placeholder="Longitude"
						/>
					</div>
				</div>

				{/* Tied Currency Indicator */}
				<div className="border-border/60 bg-muted/40 flex items-center justify-between rounded-lg border px-3.5 py-2 text-xs sm:col-span-2">
					<div className="flex items-center gap-2">
						<span className="text-base" aria-hidden="true">
							{getLocationCurrency(address) === 'CAD' ? '🇨🇦' : '🇺🇸'}
						</span>
						<div>
							<span className="text-foreground">
								<Trans>Location Currency:</Trans>{' '}
								{getLocationCurrency(address) === 'CAD' ? 'CAD ($)' : 'USD ($)'}
							</span>
							<span className="text-muted-foreground ml-2">
								{getLocationCurrency(address) === 'CAD' ? (
									<Trans>(Tied to Canada address)</Trans>
								) : (
									<Trans>(Tied to US address)</Trans>
								)}
							</span>
						</div>
					</div>
					<span className="bg-primary/10 text-primary rounded px-2 py-0.5 font-mono text-[11px]">
						{getLocationCurrency(address)}
					</span>
				</div>
			</div>
		</div>
	)
}
