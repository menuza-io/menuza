import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '@repo/staffing'
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
import { useEffect, useState } from 'react'

type PinOutcome = { error: string } | { pin: string } | { cleared: true }

/**
 * A PIN is shown exactly once, right after it is set; tenant-api keeps only
 * a keyed hash, so nobody can look it up later.
 */
export function PinDialog({
	open,
	onOpenChange,
	name,
	hasPin,
	onSet,
	onClear,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	name: string
	hasPin: boolean
	/** Omit the PIN to have one generated. */
	onSet: (pin?: string) => Promise<PinOutcome>
	onClear: () => Promise<PinOutcome>
}) {
	const { _ } = useLingui()
	const [custom, setCustom] = useState('')
	const [shown, setShown] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		if (!open) return
		setCustom('')
		setShown(null)
		setError(null)
	}, [open])

	const run = async (work: () => Promise<PinOutcome>) => {
		setBusy(true)
		const result = await work()
		setBusy(false)
		if ('error' in result) {
			setError(result.error)
			return
		}
		setError(null)
		if ('pin' in result) setShown(result.pin)
		else onOpenChange(false)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Time clock PIN for {name}</Trans>
					</DialogTitle>
					<DialogDescription>
						{hasPin ? (
							<Trans>
								A PIN is set. Setting a new one replaces it right away.
							</Trans>
						) : (
							<Trans>
								They need a PIN to clock in and out on a time clock tablet.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				{shown ? (
					<div className="space-y-3">
						<p
							className="text-center font-mono text-4xl tracking-widest"
							dir="ltr"
							data-testid="staff-pin"
						>
							{shown}
						</p>
						<p role="status" className="text-muted-foreground text-sm">
							<Trans>
								Share this PIN with them privately. It won’t be shown again.
							</Trans>
						</p>
						<DialogFooter>
							<Button onClick={() => onOpenChange(false)}>
								<Trans>Done</Trans>
							</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="space-y-4">
						<Button
							className="w-full"
							disabled={busy}
							onClick={() => void run(() => onSet())}
						>
							<Trans>Generate a PIN</Trans>
						</Button>
						<form
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault()
								void run(() => onSet(custom))
							}}
						>
							<Label htmlFor="staff-pin-input">
								<Trans>Or choose one</Trans>
							</Label>
							<div className="flex gap-2">
								<Input
									id="staff-pin-input"
									inputMode="numeric"
									autoComplete="off"
									dir="ltr"
									pattern={`\\d{${PIN_MIN_LENGTH},${PIN_MAX_LENGTH}}`}
									maxLength={PIN_MAX_LENGTH}
									placeholder={_(msg`4–6 digits`)}
									value={custom}
									onChange={(event) =>
										setCustom(event.target.value.replace(/\D/g, ''))
									}
								/>
								<Button
									type="submit"
									variant="outline"
									disabled={busy || custom.length < PIN_MIN_LENGTH}
								>
									<Trans>Set PIN</Trans>
								</Button>
							</div>
						</form>
						{error ? (
							<p role="alert" className="text-destructive text-sm">
								{error}
							</p>
						) : null}
						<DialogFooter>
							{hasPin ? (
								<Button
									variant="ghost"
									disabled={busy}
									onClick={() => void run(onClear)}
								>
									<Trans>Remove PIN</Trans>
								</Button>
							) : null}
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								<Trans>Cancel</Trans>
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}
