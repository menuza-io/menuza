import { msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Armchair, X } from 'lucide-react'
import { shortName } from './feed.ts'
import { type FreeTableOffer } from './freeTable.ts'
import { Button, IconButton } from '~/ui/primitives.tsx'

/**
 * "Table 7 is free: Sofia (4, waited 13 min)." A calm bar under the header,
 * not a toast: it stays until the host seats them, puts it away, or the offer
 * no longer holds. Seating is one tap and never automatic.
 */
export function FreeTableBanner({
	offer,
	onSeat,
	onDismiss,
}: {
	offer: FreeTableOffer
	onSeat: () => void
	onDismiss: () => void
}) {
	const { _ } = useLingui()
	const label = offer.table.label
	const who =
		offer.placing.kind === 'waitlist'
			? offer.placing.entry.displayName
			: shortName(offer.placing.reservation, _(msg`Guest`))
	const size = offer.size
	const waited = offer.waitedMin
	const words =
		waited === null
			? _(msg`Table ${label} is free: ${who} (${size}, at the stand).`)
			: _(
					plural(waited, {
						one: `Table ${label} is free: ${who} (${size}, waited # min).`,
						other: `Table ${label} is free: ${who} (${size}, waited # min).`,
					}),
				)
	return (
		<div
			role="status"
			className="bg-success/12 text-foreground flex items-center gap-3 px-4 py-2"
		>
			<Armchair aria-hidden className="text-success size-5 shrink-0" />
			<p className="min-w-0 flex-1 text-sm font-medium break-words">{words}</p>
			<Button variant="primary" onClick={onSeat} className="shrink-0">
				{_(msg`Seat`)}
			</Button>
			<IconButton label={_(msg`Dismiss`)} onClick={onDismiss}>
				<X className="size-4" />
			</IconButton>
		</div>
	)
}
