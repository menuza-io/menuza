import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type OrderStep } from '@repo/common/order-steps'
import { type OrderTimelineEntry } from '#app/utils/orders/order-model.ts'

const STEP_LABELS: Record<OrderStep, MessageDescriptor> = {
	placed: msg`Placed`,
	accepted: msg`Accepted`,
	declined: msg`Declined`,
	started: msg`Started`,
	ready: msg`Ready`,
	handed_over: msg`Handed over`,
	out_for_delivery: msg`Out for delivery`,
	delivered: msg`Delivered`,
}

export type ActivityEvent = {
	key: string
	label: string
	at: string | null
	detail?: string | null
}

/**
 * The recorded order steps (#243) as rows of the order's Activity list: each
 * with when it happened and who or which screen did it. A member is named from
 * the page's own list (the region keeps only an opaque id; the name never
 * travels there); Station and the guest are named by screen. A step taken
 * offline at the till says so, since its time is the till's.
 */
export function stepActivityEvents(
	entries: readonly OrderTimelineEntry[],
	memberNames: Readonly<Record<string, string>>,
	translate: (message: MessageDescriptor, values?: Record<string, string>) => string,
): ActivityEvent[] {
	return entries.map((entry) => {
		let who: string
		switch (entry.source) {
			case 'guest':
				who = translate(msg`By the guest`)
				break
			case 'payment':
				who = translate(msg`By the payment confirmation`)
				break
			case 'system':
				who = translate(msg`By Menuza, automatically`)
				break
			case 'station_kitchen':
				who = translate(msg`On the Station kitchen screen`)
				break
			case 'station_orders':
				who = translate(msg`On Station online orders`)
				break
			case 'app': {
				const name = entry.actorId ? memberNames[entry.actorId] : undefined
				who = name
					? translate(msg`By ${name} on the Orders page`, { name })
					: translate(msg`On the Orders page`)
				break
			}
		}
		const offline = entry.offline
			? ` · ${translate(msg`taken offline, at the till's time`)}`
			: ''
		return {
			key: `step:${entry.step}`,
			label: translate(STEP_LABELS[entry.step]),
			at: new Date(entry.at).toISOString(),
			detail: `${who}${offline}`,
		}
	})
}
