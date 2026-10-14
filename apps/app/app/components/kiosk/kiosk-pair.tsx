import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { ScreenTitle } from '#app/components/kiosk/kiosk-screens.tsx'
import { type PairOutcome } from '#app/hooks/use-kiosk-runtime.ts'
import { parsePairingFragment } from '#app/utils/staffing/kiosk-pairing.ts'

/**
 * What to show when this tablet is not paired: the three steps, and a box to
 * paste the pairing link (or the bare code) from the manager's screen.
 */
export function KioskUnpaired({
	removed,
	onPair,
}: {
	removed: boolean
	onPair: (code: string, region?: 'us' | 'ksa') => Promise<PairOutcome>
}) {
	return (
		<div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col justify-center gap-6 p-6">
			<div className="flex flex-col gap-2">
				<ScreenTitle>
					{removed ? (
						<Trans>This tablet was disconnected</Trans>
					) : (
						<Trans>Set up this tablet</Trans>
					)}
				</ScreenTitle>
				<p className="text-muted-foreground text-lg text-balance">
					{removed ? (
						<Trans>
							A manager removed it, or it was reset. Pair it again to keep using
							it.
						</Trans>
					) : (
						<Trans>
							Once it is paired, your team can clock in with a PIN. This takes
							about a minute.
						</Trans>
					)}
				</p>
			</div>
			<ol className="flex list-decimal flex-col gap-2 ps-6 text-lg">
				<li>
					<Trans>
						In your manager account, open Staff, Time clock, then Tablets.
					</Trans>
				</li>
				<li>
					<Trans>Choose Pair a tablet and create a code.</Trans>
				</li>
				<li>
					<Trans>
						Scan the code with this tablet's camera, or paste the link below.
					</Trans>
				</li>
			</ol>
			<PairForm onPair={onPair} />
		</div>
	)
}

export function PairForm({
	onPair,
	initialErrorCode,
}: {
	onPair: (code: string, region?: 'us' | 'ksa') => Promise<PairOutcome>
	/** A refusal from an automatic attempt (the QR link), shown straight away. */
	initialErrorCode?: string | null
}) {
	const { _ } = useLingui()
	const [value, setValue] = useState('')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(
		initialErrorCode ? pairingMessage(initialErrorCode, _) : null,
	)

	async function submit() {
		setError(null)
		const trimmed = value.trim()
		if (!trimmed) {
			setError(_(t`Paste the pairing link or code first.`))
			return
		}
		// A pasted link carries the region in its fragment; a bare code does not.
		let code = trimmed
		let region: 'us' | 'ksa' | undefined
		const hashIndex = trimmed.indexOf('#')
		if (hashIndex >= 0) {
			const parsed = parsePairingFragment(trimmed.slice(hashIndex))
			if (!parsed) {
				setError(_(t`That link is not a pairing link. Copy it again.`))
				return
			}
			code = parsed.code
			region = parsed.region
		}
		setPending(true)
		try {
			const result = await onPair(code, region)
			if (!result.ok) setError(pairingMessage(result.code, _))
		} finally {
			setPending(false)
		}
	}

	return (
		<form
			noValidate
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault()
				void submit()
			}}
		>
			<Field data-invalid={error ? true : undefined}>
				<FieldLabel htmlFor="pairing-code" className="text-base">
					<Trans>Pairing link or code</Trans>
				</FieldLabel>
				<Textarea
					id="pairing-code"
					dir="ltr"
					rows={3}
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					value={value}
					onChange={(event) => setValue(event.target.value)}
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? 'pairing-code-error' : 'pairing-code-hint'}
					className="min-h-24 text-base"
				/>
				{error ? (
					<FieldError id="pairing-code-error">{error}</FieldError>
				) : (
					<FieldDescription id="pairing-code-hint">
						<Trans>The code works once and expires after ten minutes.</Trans>
					</FieldDescription>
				)}
			</Field>
			<Button
				type="submit"
				disabled={pending}
				className="h-14 touch-manipulation rounded-2xl text-xl"
			>
				{pending ? (
					<Trans>Pairing…</Trans>
				) : (
					<>
						<Icon name="link-2" />
						<Trans>Pair this tablet</Trans>
					</>
				)}
			</Button>
		</form>
	)
}

function pairingMessage(code: string, _: ReturnType<typeof useLingui>['_']) {
	switch (code) {
		case 'network_unavailable':
			return _(
				t`Could not reach the time clock. Check the connection and try again.`,
			)
		case 'storage_unavailable':
			return _(
				t`This browser will not keep the pairing. Turn off private browsing and try again.`,
			)
		case 'kiosk_disabled':
			return _(
				t`Tablet time clocks are switched off right now. Ask your manager.`,
			)
		case 'backoff':
			return _(t`Too many tries. Wait a minute and try again.`)
		default:
			return _(t`That code did not work. It may have expired. Make a new one.`)
	}
}
