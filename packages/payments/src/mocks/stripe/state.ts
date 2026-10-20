import { type EmulatorContext } from '../context'
import { emitEvent } from '../events'
import { stripeId } from '../ids'
import { type MockObjectRow, updateObject } from '../store'
import { clone, type Json } from '../util'
import { noSuchResource, STRIPE_API_VERSION } from './errors'

export type StripeType =
	| 'account'
	| 'account_link'
	| 'customer'
	| 'payment_method'
	| 'payment_intent'
	| 'setup_intent'
	| 'checkout.session'
	| 'checkout.attempt'
	| 'charge'
	| 'transfer'
	| 'application_fee'
	| 'transfer_reversal'
	| 'fee_refund'
	| 'refund'
	| 'dispute'

export const seconds = (ms: number) => Math.floor(ms / 1000)

/** Strip internal bookkeeping before an object leaves the emulator. */
export function publicObject<T extends Json>(doc: T): T {
	const copy = clone(doc)
	delete copy.__mock
	delete copy.__rev
	return copy
}

export async function insertStripeObject(
	ctx: EmulatorContext,
	type: StripeType,
	doc: Json,
	options: { parentId?: string | null; transitionAt?: number | null } = {},
) {
	const now = ctx.clock.now()
	const inserted = await ctx.store.insertObject({
		provider: 'stripe',
		id: String(doc.id),
		type,
		parentId: options.parentId ?? null,
		json: doc,
		transitionAt: options.transitionAt ?? null,
		createdAt: now,
		updatedAt: now,
	})
	if (!inserted) throw new Error(`duplicate stripe id ${String(doc.id)}`)
	return doc
}

export async function findStripeObject(
	ctx: EmulatorContext,
	id: string,
	type?: StripeType,
): Promise<MockObjectRow | null> {
	const row = await ctx.store.getObject('stripe', id)
	if (!row || (type && row.type !== type)) return null
	return row
}

export async function requireStripeObject(
	ctx: EmulatorContext,
	id: string,
	type: StripeType,
	label: string,
	param?: string,
) {
	const row = await findStripeObject(ctx, id, type)
	if (!row) throw noSuchResource(label, id, param)
	return row
}

export async function mutateStripeObject<T = void>(
	ctx: EmulatorContext,
	id: string,
	mutate: (json: Json, row: MockObjectRow) => T,
	transitionAt?: (json: Json) => number | null,
) {
	return updateObject(
		ctx.store,
		{ provider: 'stripe', id, now: ctx.clock.now(), transitionAt },
		mutate,
	)
}

export async function emitStripeEvent(
	ctx: EmulatorContext,
	type: string,
	object: Json,
	options: { account?: string } = {},
) {
	const id = stripeId('evt_')
	return emitEvent(ctx, {
		provider: 'stripe',
		id,
		type,
		connectAccount: options.account ?? null,
		payload: {
			id,
			object: 'event',
			api_version: STRIPE_API_VERSION,
			created: seconds(ctx.clock.now()),
			data: { object: publicObject(object) },
			livemode: false,
			pending_webhooks: 1,
			request: { id: null, idempotency_key: null },
			type,
			...(options.account ? { account: options.account } : {}),
		},
	})
}

export function listEnvelope(data: Json[], url: string) {
	return { object: 'list', data, has_more: false, url }
}
