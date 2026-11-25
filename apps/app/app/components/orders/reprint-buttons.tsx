import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { z } from 'zod'
import { useOperatorClient } from '#app/hooks/use-operator-client.ts'

/**
 * "Reprint" on an order (#117): sends the kitchen ticket or the receipt to the
 * location's cloud printers again. One press is one request id, so a retry of
 * the same press never prints twice. Shown only where the organization has
 * cloud printers and the member may change settings.
 */
export function ReprintButtons({
	orgSlug,
	orderId,
	locationId,
}: {
	orgSlug: string
	orderId: string
	locationId: string
}) {
	const { _ } = useLingui()
	const { request } = useOperatorClient(orgSlug, '/operator/pos/printers')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)

	const reprint = async (kind: 'kitchen' | 'receipt') => {
		setBusy(true)
		setMessage(null)
		try {
			const result = z
				.object({ queued: z.number() })
				.parse(
					await request('/reprint', {
						method: 'POST',
						body: JSON.stringify({
							source: 'online',
							orderId,
							locationId,
							kind,
							requestId: crypto.randomUUID(),
						}),
					}),
				)
			setMessage(
				result.queued > 0
					? _(t`Sent to the printer.`)
					: _(t`No printer at this location takes this ticket.`),
			)
		} catch (error) {
			setMessage(
				error instanceof Error ? error.message : _(t`Could not reprint.`),
			)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="flex flex-col gap-2" data-testid="order-reprint">
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					className="h-11 md:h-8"
					disabled={busy}
					onClick={() => void reprint('kitchen')}
				>
					<Icon name="printer" className="size-4" aria-hidden />
					<Trans>Reprint kitchen ticket</Trans>
				</Button>
				<Button
					variant="outline"
					className="h-11 md:h-8"
					disabled={busy}
					onClick={() => void reprint('receipt')}
				>
					<Icon name="printer" className="size-4" aria-hidden />
					<Trans>Reprint receipt</Trans>
				</Button>
			</div>
			{message ? (
				<p role="status" className="text-muted-foreground text-sm" data-testid="order-reprint-result">
					{message}
				</p>
			) : null}
		</div>
	)
}
