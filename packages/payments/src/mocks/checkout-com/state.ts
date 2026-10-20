import { type EmulatorContext } from '../context'
import { emitEvent } from '../events'
import { checkoutId } from '../ids'
import { type MockObjectRow, updateObject } from '../store'
import { clone, type Json } from '../util'

export type CheckoutType =
	| 'entity'
	| 'hpp'
	| 'payment'
	| 'source'
	| 'session'
	| 'action'
	| 'attempt'
	| 'payment_session'

/** Host the SDK is pointed at; `_links` use it like the real API does. */
export const CHECKOUT_LINK_HOST = 'https://checkout-com.mock.invalid'

export const isoNow = (ctx: EmulatorContext) =>
	new Date(ctx.clock.now()).toISOString()

export function publicObject<T extends Json>(doc: T): T {
	const copy = clone(doc)
	delete copy.__mock
	delete copy.__rev
	return copy
}

export async function insertCheckoutObject(
	ctx: EmulatorContext,
	type: CheckoutType,
	doc: Json,
	options: { parentId?: string | null; transitionAt?: number | null } = {},
) {
	const now = ctx.clock.now()
	const inserted = await ctx.store.insertObject({
		provider: 'checkout',
		id: String(doc.id),
		type,
		parentId: options.parentId ?? null,
		json: doc,
		transitionAt: options.transitionAt ?? null,
		createdAt: now,
		updatedAt: now,
	})
	if (!inserted) throw new Error(`duplicate checkout id ${String(doc.id)}`)
	return doc
}

export async function findCheckoutObject(
	ctx: EmulatorContext,
	id: string,
	type?: CheckoutType,
): Promise<MockObjectRow | null> {
	const row = await ctx.store.getObject('checkout', id)
	if (!row || (type && row.type !== type)) return null
	return row
}

export function mutateCheckoutObject<T = void>(
	ctx: EmulatorContext,
	id: string,
	mutate: (json: Json, row: MockObjectRow) => T,
	transitionAt?: (json: Json) => number | null,
) {
	return updateObject(
		ctx.store,
		{ provider: 'checkout', id, now: ctx.clock.now(), transitionAt },
		mutate,
	)
}

export async function emitCheckoutEvent(
	ctx: EmulatorContext,
	type: string,
	data: Json,
) {
	const id = checkoutId('evt_')
	return emitEvent(ctx, {
		provider: 'checkout',
		id,
		type,
		payload: {
			id,
			type,
			version: '1.0.0',
			created_on: isoNow(ctx),
			data,
			_links: {
				self: { href: `${CHECKOUT_LINK_HOST}/workflows/events/${id}` },
			},
		},
	})
}
