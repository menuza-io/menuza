import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { toDataURL as qrCodeToDataURL } from 'qrcode'
import { useEffect, useState } from 'react'
import { type StaffingLocation } from '#app/utils/staffing/client.ts'

const selectClass =
	'border-input bg-background h-9 w-full rounded-md border px-2 text-sm'

export type PairingInput = {
	locationId: string
	locationName: string
	name: string
}

export type Pairing = { code: string; expiresAt: string }

/** Groups the code so it is easy to read aloud and type on a tablet. */
export function formatPairingCode(code: string) {
	return code.replace(/(.{5})(?=.)/g, '$1-')
}

export function PairKioskDialog({
	open,
	onOpenChange,
	locations,
	kioskUrl,
	onCreate,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	locations: StaffingLocation[]
	/** `/kiosk/<orgSlug>` on this App origin; the code goes in the hash. */
	kioskUrl: string
	onCreate: (input: PairingInput) => Promise<{ error: string } | Pairing>
}) {
	const { _ } = useLingui()
	const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
	const [name, setName] = useState('')
	const [pairing, setPairing] = useState<Pairing | null>(null)
	const [qr, setQr] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (!open) return
		setLocationId(locations[0]?.id ?? '')
		setName('')
		setPairing(null)
		setQr(null)
		setError(null)
	}, [open, locations])

	// The code travels in the URL fragment, which browsers never send to App.
	const link = pairing ? `${kioskUrl}#c=${pairing.code}` : ''

	useEffect(() => {
		if (!link) return
		let cancelled = false
		void qrCodeToDataURL(link, { margin: 1, width: 240 }).then((url) => {
			if (!cancelled) setQr(url)
		})
		return () => {
			cancelled = true
		}
	}, [link])

	useEffect(() => {
		if (!pairing) return
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [pairing])

	const secondsLeft = pairing
		? Math.max(
				0,
				Math.round((new Date(pairing.expiresAt).getTime() - now) / 1000),
			)
		: 0
	const minutes = Math.floor(secondsLeft / 60)
	const seconds = String(secondsLeft % 60).padStart(2, '0')
	const formattedCode = pairing ? formatPairingCode(pairing.code) : ''

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				{pairing ? (
					<div className="space-y-4">
						<DialogHeader>
							<DialogTitle>
								<Trans>Pair the tablet</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Scan the code with the tablet’s camera, or open the address
									below on the tablet and type the pairing code.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<div className="flex justify-center">
							{qr ? (
								<img
									src={qr}
									alt={_(msg`QR code that opens the time clock`)}
									className="size-60 rounded-md bg-white"
								/>
							) : (
								<div className="bg-muted size-60 rounded-md" />
							)}
						</div>
						<dl className="space-y-2 text-sm">
							<div>
								<dt className="text-muted-foreground">
									<Trans>Address</Trans>
								</dt>
								<dd className="font-mono break-all" dir="ltr">
									{kioskUrl}
								</dd>
							</div>
							<div>
								<dt className="text-muted-foreground">
									<Trans>Pairing code</Trans>
								</dt>
								<dd
									className="font-mono text-2xl tracking-widest"
									dir="ltr"
									data-testid="pairing-code"
								>
									{formattedCode}
								</dd>
							</div>
						</dl>
						<p role="status" className="text-muted-foreground text-sm">
							{secondsLeft > 0 ? (
								<Trans>
									Works once. Expires in {minutes}:{seconds}.
								</Trans>
							) : (
								<Trans>This code expired. Close and create a new one.</Trans>
							)}
						</p>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => void navigator.clipboard?.writeText(link)}
							>
								<Trans>Copy link</Trans>
							</Button>
							<Button type="button" onClick={() => onOpenChange(false)}>
								<Trans>Done</Trans>
							</Button>
						</DialogFooter>
					</div>
				) : (
					<form
						className="space-y-4"
						onSubmit={async (event) => {
							event.preventDefault()
							const location = locations.find((item) => item.id === locationId)
							if (!location) return
							setBusy(true)
							const result = await onCreate({
								locationId,
								locationName: location.name,
								name: name.trim(),
							})
							setBusy(false)
							if ('error' in result) setError(result.error)
							else {
								setError(null)
								setNow(Date.now())
								setPairing(result)
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>
								<Trans>Add a time clock</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									Turn a shared tablet at the location into a time clock. Staff
									clock in and out with their PIN.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<Label htmlFor="kiosk-location">
								<Trans>Location</Trans>
							</Label>
							<select
								id="kiosk-location"
								className={selectClass}
								value={locationId}
								onChange={(event) => setLocationId(event.target.value)}
							>
								{locations.map((location) => (
									<option key={location.id} value={location.id}>
										{location.name}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="kiosk-name">
								<Trans>Device name</Trans>
							</Label>
							<Input
								id="kiosk-name"
								required
								maxLength={60}
								placeholder={_(msg`Back office tablet`)}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						{error ? (
							<p role="alert" className="text-destructive text-sm">
								{error}
							</p>
						) : null}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" disabled={busy || !name.trim()}>
								<Trans>Create pairing code</Trans>
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	)
}
