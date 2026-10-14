import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState } from 'react'

/**
 * Shows a new PIN exactly once. The PIN lives only in this component's props:
 * the server stores a keyed hash and can never return it again, so the warning
 * says so plainly. Closing the panel drops the value for good.
 */
export function PinPanel({
	pin,
	scopeName,
	onDone,
}: {
	pin: string
	scopeName: string
	onDone: () => void
}) {
	const { _ } = useLingui()
	const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle')
	const copyRef = useRef<HTMLButtonElement>(null)

	// Land on Copy, not Done: a stray Enter must not dismiss a PIN that cannot be
	// shown again.
	useEffect(() => {
		copyRef.current?.focus()
	}, [])

	async function copy() {
		try {
			await navigator.clipboard.writeText(pin)
			setCopied('copied')
		} catch {
			setCopied('failed')
		}
	}

	return (
		<section
			aria-labelledby="pin-panel-title"
			className="border-border flex flex-col gap-4 rounded-lg border p-4"
		>
			<div className="flex flex-col gap-1">
				<h3 id="pin-panel-title" className="text-sm font-medium">
					<Trans>New PIN for {scopeName}</Trans>
				</h3>
				<p className="text-sm">
					<span className="font-medium">
						<Trans>Shown once.</Trans>
					</span>{' '}
					<span className="text-muted-foreground">
						<Trans>
							We do not keep a copy, so it cannot be looked up later. Give it to
							them now, then press Done.
						</Trans>
					</span>
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<output
					aria-label={_(t`New PIN`)}
					dir="ltr"
					className="bg-muted rounded-lg px-4 py-2 text-3xl font-semibold tracking-widest tabular-nums select-all"
				>
					{pin}
				</output>
				<Button
					ref={copyRef}
					type="button"
					variant="outline"
					onClick={() => void copy()}
				>
					<Icon name={copied === 'copied' ? 'check' : 'copy'} />
					{copied === 'copied' ? (
						<Trans>Copied</Trans>
					) : (
						<Trans>Copy PIN</Trans>
					)}
				</Button>
				<span className="sr-only" role="status">
					{copied === 'copied' ? _(t`PIN copied`) : ''}
				</span>
			</div>
			{copied === 'failed' ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>Could not copy. Select the PIN and copy it yourself.</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			<div>
				<Button type="button" onClick={onDone}>
					<Trans>Done</Trans>
				</Button>
			</div>
		</section>
	)
}
