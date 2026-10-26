import { msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { shortName } from './feed.ts'
import { type FreeTableOffer } from './freeTable.ts'
import { Button, IconButton } from '~/ui/primitives.tsx'

type Translate = ReturnType<typeof useLingui>['_']

/** What the offer says, in a sentence (for the bar, and for a screen reader at once). */
export function offerText(_: Translate, offer: FreeTableOffer): string {
	const label = offer.table.label
	const who =
		offer.placing.kind === 'waitlist'
			? offer.placing.entry.displayName
			: shortName(offer.placing.reservation, _(msg`Guest`))
	const size = offer.size
	const waited = offer.waitedMin
	return waited === null
		? _(msg`Table ${label} is free: ${who} (${size}, at the stand).`)
		: _(
				plural(waited, {
					one: `Table ${label} is free: ${who} (${size}, waited # min).`,
					other: `Table ${label} is free: ${who} (${size}, waited # min).`,
				}),
			)
}

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
	const words = offerText(_, offer)
	return (
		// Not a live region of its own: a region that mounts already filled is not read.
		// The stand's news region says it the moment the offer appears (see HostStand).
		<div className="bg-success/10 text-foreground flex items-center gap-3 px-4 py-2">
			<Icon
				name="armchair"
				aria-hidden
				className="text-success size-5 shrink-0"
			/>
			<p className="min-w-0 flex-1 text-sm font-medium break-words">{words}</p>
			<Button variant="primary" onClick={onSeat} className="shrink-0">
				{_(msg`Seat`)}
			</Button>
			<IconButton label={_(msg`Dismiss`)} onClick={onDismiss}>
				<Icon name="x" className="size-4" />
			</IconButton>
		</div>
	)
}
