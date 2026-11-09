import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type KdsTicket } from '@repo/common/kds'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { StockApiError } from '../stock/api.ts'
import { stockApiFor } from '../stock/sync.ts'
import { type PosSettings } from '~/lib/config.ts'
import { type Session } from '~/lib/signin.ts'
import { Button } from '~/ui/primitives.tsx'

/**
 * The dishes a cook had already started on a ticket (anything past "New").
 * Dishes nobody touched are not waste.
 */
export function startedDishes(ticket: KdsTicket) {
	const started = new Map<
		string,
		{ itemId: string; variantId: string | null; quantity: number }
	>()
	for (const line of ticket.lines) {
		if (line.stage === 'new') continue
		const key = `${line.itemId}\u0000${line.variantId ?? ''}`
		const found = started.get(key)
		if (found) found.quantity += line.quantity
		else {
			started.set(key, {
				itemId: line.itemId,
				variantId: line.variantId,
				quantity: line.quantity,
			})
		}
	}
	return [...started.values()].map((line) => ({
		...line,
		// The region takes at most 50 of a dish at once.
		quantity: Math.min(line.quantity, 50),
	}))
}

/** One id per ticket, so a second tap (or a second tablet) answers the first result. */
export function ticketWasteClientId(ticket: KdsTicket): string {
	const base = `kw-${ticket.source}-${ticket.id}`.replace(
		/[^A-Za-z0-9_-]/g,
		'_',
	)
	return base.slice(0, 64)
}

type State = 'idle' | 'sending' | 'logged' | 'failed'

/**
 * "Log it as waste?" on a cancelled ticket: one tap records the dishes already
 * started as waste ("Cancelled after cooking"). Never automatic, because the
 * cook knows whether the food was saved. Online only, and never replayed
 * blindly: the same ticket always sends the same id, so trying again after an
 * uncertain answer cannot count the food twice.
 */
export function TicketWaste({
	ticket,
	settings,
	session,
	online,
}: {
	ticket: KdsTicket
	settings: PosSettings
	session: Session | null
	online: boolean
}) {
	const { _ } = useLingui()
	const [state, setState] = useState<State>('idle')
	const dishes = startedDishes(ticket)
	if (
		!ticket.cancelled ||
		!settings.apps.inventory ||
		!settings.locationId ||
		dishes.length === 0
	) {
		return null
	}
	const locationId = settings.locationId

	async function log() {
		setState('sending')
		try {
			await stockApiFor(settings, session).dishWaste({
				clientId: ticketWasteClientId(ticket),
				locationId,
				lines: dishes,
			})
			setState('logged')
		} catch (error) {
			// A refusal that will not change (no recipes, inventory off) reads as
			// nothing to log, so the button does not keep inviting a retry.
			setState(
				error instanceof StockApiError && error.code === 'inventory_disabled'
					? 'logged'
					: 'failed',
			)
		}
	}

	return (
		<div className="flex flex-wrap items-center gap-3 px-4 pb-3">
			{state === 'logged' ? (
				<p role="status" className="text-muted-foreground text-sm">
					<Icon name="check" aria-hidden className="me-1 inline size-4" />
					<Trans>Logged as waste.</Trans>
				</p>
			) : (
				<>
					<Button
						variant="outline"
						disabled={!online && !settings.demo ? true : state === 'sending'}
						onClick={() => void log()}
					>
						<Icon name="trash-2" className="size-4" />
						<Trans>Log it as waste?</Trans>
					</Button>
					{state === 'failed' ? (
						<p role="alert" className="text-destructive text-sm">
							{_(t`We could not log it. Try again.`)}
						</p>
					) : null}
				</>
			)}
		</div>
	)
}
