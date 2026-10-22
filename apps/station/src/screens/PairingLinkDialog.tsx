import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useState } from 'react'
import {
	pairingHosts,
	parsePairingInput,
	serversProblem,
} from '~/lib/pairing.ts'
import { Button, Modal } from '~/ui/primitives.tsx'

/**
 * A pairing link was opened on this device (a QR code, a tapped link). It can
 * point the till at a server, and orders carry guest names and phone numbers,
 * so nothing changes until someone here has seen where it points and confirmed.
 */
export function PairingLinkDialog({
	link,
	paired: pairedNow,
	deviceLabel,
	currentApi,
	currentApp,
	needsManager,
	onSwitchUser,
	onPair,
	onClose,
}: {
	/** The fragment the link carried (`#a=…&c=…`). */
	link: string
	paired: boolean
	deviceLabel: string | null
	/** Servers already set, used by a link that carries only a code. */
	currentApi: string
	currentApp: string
	needsManager: boolean
	onSwitchUser: () => void
	/** Resolves to an error message, or null once paired. */
	onPair: (link: string) => Promise<string | null>
	onClose: () => void
}) {
	const { _ } = useLingui()
	// As it was when the link was opened: pairing changes these underneath.
	const [paired] = useState(pairedNow)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const parsed = parsePairingInput(link)
	const hosts = parsed ? pairingHosts(parsed) : null
	const api = hosts?.api ?? safeHost(currentApi)
	const app = hosts?.app ?? safeHost(currentApp)
	const problem = parsed
		? serversProblem([
				parsed.tenantApiUrl ?? currentApi,
				parsed.appUrl ?? currentApp,
			])
		: _(t`That does not look like a pairing link.`)
	const shown = error ?? problem

	const confirm = async () => {
		if (busy || problem) return
		setBusy(true)
		setError(null)
		try {
			const failed = await onPair(link)
			if (failed) setError(failed)
			else onClose()
		} finally {
			setBusy(false)
		}
	}

	return (
		<Modal
			open
			onClose={onClose}
			title={
				paired
					? _(t`Pair with a different restaurant?`)
					: _(t`Pair this terminal?`)
			}
			footer={
				<div className="grid grid-cols-2 gap-3">
					<Button variant="outline" size="lg" onClick={onClose}>
						{paired ? (
							<Trans>Keep current pairing</Trans>
						) : (
							<Trans>Cancel</Trans>
						)}
					</Button>
					{paired && needsManager && !busy ? (
						// Re-pointing a till is a manager's call, as in Settings. The link
						// stays here, so it can be confirmed once a manager has signed in.
						<Button variant="primary" size="lg" onClick={onSwitchUser}>
							<Trans>Switch to a manager</Trans>
						</Button>
					) : (
						<Button
							variant={paired ? 'danger' : 'primary'}
							size="lg"
							disabled={busy || problem !== null}
							onClick={() => void confirm()}
						>
							{busy ? (
								<Trans>Pairing…</Trans>
							) : (
								<Trans>Pair with this link</Trans>
							)}
						</Button>
					)}
				</div>
			}
		>
			<div className="space-y-4 p-5">
				<p className="text-muted-foreground">
					{paired ? (
						deviceLabel ? (
							<Trans>
								This device is already paired as {deviceLabel}. You opened a
								link that would pair it with a restaurant server. Only continue
								if a manager gave you this link. Orders already saved on this
								device stay here.
							</Trans>
						) : (
							<Trans>
								This device is already paired. You opened a link that would pair
								it with a restaurant server. Only continue if a manager gave you
								this link. Orders already saved on this device stay here.
							</Trans>
						)
					) : (
						<Trans>
							You opened a pairing link. Orders, with guest names and phone
							numbers, will be sent to the server below. Only continue if a
							manager gave you this link and you recognise the address.
						</Trans>
					)}
				</p>
				{api || app ? (
					<dl className="border-border space-y-2 rounded-xl border p-3 text-sm">
						{api ? (
							<div>
								<dt className="text-muted-foreground">
									<Trans>Orders server</Trans>
								</dt>
								<dd className="font-semibold break-all" dir="ltr">
									{api}
								</dd>
							</div>
						) : null}
						{app ? (
							<div>
								<dt className="text-muted-foreground">
									<Trans>Menu and branding</Trans>
								</dt>
								<dd className="font-semibold break-all" dir="ltr">
									{app}
								</dd>
							</div>
						) : null}
					</dl>
				) : null}
				{/* Always in the page, so a message that appears later is announced. */}
				<p
					role="alert"
					className="text-destructive text-sm font-medium empty:hidden"
				>
					{shown}
				</p>
			</div>
		</Modal>
	)
}

function safeHost(value: string): string | null {
	if (!value) return null
	try {
		return new URL(value).host
	} catch {
		return null
	}
}
