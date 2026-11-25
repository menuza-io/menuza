'use client'

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import { useOperatorClient } from '#app/hooks/use-operator-client.ts'

/**
 * Address check (#266): type an address and see which delivery zone applies, with
 * its fee and minimum, or why delivery is not available. The address goes from this
 * browser to the regional tenant-api (the guest quote's own coverage code, behind
 * the orders token) and nowhere else; nothing is stored. It checks the zones as
 * last saved.
 */

type CheckResult =
	| {
			status: 'deliverable'
			quote: {
				zoneName: string
				deliveryFee: number
				minimumOrder: number
				distance?: { meters: number; source: 'driving' | 'straight_line' } | null
			}
	  }
	| {
			status: 'out_of_range'
			reason: 'out_of_range' | 'excluded'
			excludedBy?: string
	  }
	| { status: 'not_found' }
	| { status: 'unavailable'; reason: string }

export function DeliveryAddressCheck({
	orgSlug,
	locationId,
	currencySymbol = '$',
}: {
	orgSlug: string
	locationId: string | undefined
	currencySymbol?: string
}) {
	const { _ } = useLingui()
	const { request } = useOperatorClient(orgSlug, '/operator/orders')
	const [address, setAddress] = useState('')
	const [subtotal, setSubtotal] = useState('')
	const [result, setResult] = useState<CheckResult | null>(null)
	const [busy, setBusy] = useState(false)
	const [failed, setFailed] = useState(false)

	if (!locationId) {
		return (
			<div className="rounded-md border border-dashed p-3 text-xs">
				<p className="text-muted-foreground">
					<Trans>Save this location to check an address against its zones.</Trans>
				</p>
			</div>
		)
	}

	const run = async () => {
		if (address.trim().length < 3) return
		setBusy(true)
		setFailed(false)
		try {
			const amount = parseFloat(subtotal)
			const body = (await request('/delivery-check', {
				method: 'POST',
				readOnly: true,
				body: JSON.stringify({
					locationId,
					address: address.trim(),
					...(Number.isFinite(amount) && amount >= 0 ? { subtotal: amount } : {}),
				}),
			})) as CheckResult
			setResult(body)
		} catch {
			setResult(null)
			setFailed(true)
		} finally {
			setBusy(false)
		}
	}

	const money = (value: number) => `${currencySymbol}${value.toFixed(2)}`
	const unavailableText = (reason: string) => {
		switch (reason) {
			case 'delivery_disabled':
				return _(msg`Delivery is switched off for this location.`)
			case 'no_zones':
				return _(msg`No zone is switched on and allowed for delivery here.`)
			case 'store_location_missing':
				return _(msg`The store address has no map position yet, so distance zones cannot be checked.`)
			default:
				return _(msg`The address lookup is not available right now.`)
		}
	}

	let outcome: React.ReactNode = null
	if (failed) {
		outcome = <Trans>The check could not run. Try again in a moment.</Trans>
	} else if (result?.status === 'deliverable') {
		const { quote } = result
		const zoneName = quote.zoneName
		const fee = money(quote.deliveryFee)
		const minimum = money(quote.minimumOrder)
		const atAmount = subtotal.trim() !== '' && Number.isFinite(parseFloat(subtotal))
		outcome = (
			<span data-testid="check-deliverable">
				{atAmount ? (
					<Trans>
						Zone “{zoneName}” applies. Fee for this order size: {fee}. Minimum
						order: {minimum}.
					</Trans>
				) : (
					<Trans>
						Zone “{zoneName}” applies. Fee {fee}. Minimum order {minimum}.
					</Trans>
				)}
			</span>
		)
	} else if (result?.status === 'out_of_range') {
		const zoneName = result.excludedBy ?? ''
		outcome =
			result.reason === 'excluded' ? (
				zoneName ? (
					<Trans>
						Delivery is not available: this address is inside “{zoneName}”, a
						zone where delivery is not allowed.
					</Trans>
				) : (
					<Trans>
						Delivery is not available: this address is inside a zone where
						delivery is not allowed.
					</Trans>
				)
			) : (
				<Trans>Delivery is not available: this address is outside every delivery zone.</Trans>
			)
	} else if (result?.status === 'not_found') {
		outcome = <Trans>That address could not be found.</Trans>
	} else if (result?.status === 'unavailable') {
		outcome = unavailableText(result.reason)
	}

	return (
		<div className="space-y-2 rounded-md border p-3" data-testid="address-check">
			<div>
				<h5 className="text-sm">
					<Trans>Address check</Trans>
				</h5>
				<p className="text-muted-foreground text-xs">
					<Trans>
						Type an address to see which zone applies. It checks the zones as
						last saved, and the address is not stored.
					</Trans>
				</p>
			</div>
			<form
				className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end"
				onSubmit={(event) => {
					event.preventDefault()
					void run()
				}}
			>
				<div className="space-y-1">
					<Label htmlFor="address-check-input" className="text-xs">
						<Trans>Address</Trans>
					</Label>
					<Input
						id="address-check-input"
						value={address}
						onChange={(event) => setAddress(event.target.value)}
						placeholder={_(msg`e.g. 233 South Wacker Drive, Chicago`)}
					/>
				</div>
				<div className="space-y-1">
					<Label htmlFor="address-check-subtotal" className="text-xs">
						<Trans>Order amount (optional)</Trans>
					</Label>
					<Input
						id="address-check-subtotal"
						type="number"
						min="0"
						step="0.50"
						value={subtotal}
						onChange={(event) => setSubtotal(event.target.value)}
					/>
				</div>
				<Button type="submit" size="sm" disabled={busy || address.trim().length < 3}>
					<Trans>Check</Trans>
				</Button>
			</form>
			{outcome ? (
				<p role="status" className="text-sm">
					{outcome}
				</p>
			) : null}
		</div>
	)
}
