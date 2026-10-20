import { type EmulatorContext, type WebhookDelivery } from './context'
import { type MockEventRow, type MockProvider } from './store'
import { hmacSha256Hex, type Json } from './util'

const STRIPE_WEBHOOK_PATH = '/api/stripe/webhook'
const CHECKOUT_WEBHOOK_PATH = '/api/shop/webhook'

export type EventInput = {
	provider: MockProvider
	id: string
	type: string
	/** Exactly what the provider POSTs (JSON-serializable). */
	payload: Json
	connectAccount?: string | null
}

/** Stripe's `t=<ts>,v1=<hmac>` scheme, so the real SDK verifies it. */
export async function signStripePayload(
	secret: string,
	body: string,
	timestampSeconds: number,
) {
	const signature = await hmacSha256Hex(secret, `${timestampSeconds}.${body}`)
	return `t=${timestampSeconds},v1=${signature}`
}

export async function buildDelivery(
	ctx: EmulatorContext,
	row: MockEventRow,
): Promise<WebhookDelivery> {
	if (row.provider === 'checkout') {
		return {
			provider: 'checkout',
			path: CHECKOUT_WEBHOOK_PATH,
			headers: {
				'content-type': 'application/json',
				'cko-signature': await hmacSha256Hex(ctx.secrets.checkout, row.payload),
			},
			body: row.payload,
		}
	}
	const secret = row.connectAccount
		? ctx.secrets.stripeConnect
		: ctx.secrets.stripePlatform
	return {
		provider: 'stripe',
		path: STRIPE_WEBHOOK_PATH,
		headers: {
			'content-type': 'application/json',
			'stripe-signature': await signStripePayload(
				secret,
				row.payload,
				// Real wall time: the route's tolerance check uses the real clock,
				// even when the dev API has moved mock time forward.
				Math.floor(Date.now() / 1000),
			),
		},
		body: row.payload,
	}
}

/**
 * Record an event and deliver it according to `PAYMENTS_MOCK_WEBHOOKS`:
 * inline delivers before returning, deferred after a short delay (also picked
 * up by the next sweep), manual only records it.
 */
export async function emitEvent(ctx: EmulatorContext, input: EventInput) {
	const now = ctx.clock.now()
	const mode = ctx.webhookMode()
	const row: MockEventRow = {
		provider: input.provider,
		id: input.id,
		type: input.type,
		payload: JSON.stringify(input.payload),
		connectAccount: input.connectAccount ?? null,
		createdAt: now,
		deliveredAt: null,
		attempts: 0,
		lastStatus: null,
		deliverAfter: mode === 'deferred' ? now + 1000 : null,
		claimedAt: null,
	}
	await ctx.store.insertEvent(row)
	if (mode === 'inline') {
		await deliverEvent(ctx, row)
	} else if (mode === 'deferred') {
		ctx.schedule(
			new Promise<void>((resolve) => {
				setTimeout(() => {
					void deliverDue(ctx).finally(resolve)
				}, 1100)
			}),
		)
	}
	return row
}

/** One delivery attempt; false when another attempt holds the claim. */
export async function deliverEvent(
	ctx: EmulatorContext,
	row: MockEventRow,
	options: { force?: boolean } = {},
) {
	if (!ctx.transport) return false
	const claimed = await ctx.store.claimEvent(
		row.provider,
		row.id,
		ctx.clock.now(),
		options.force ? 0 : 30_000,
	)
	if (!claimed) return false
	let status = 0
	try {
		status = await ctx.transport(await buildDelivery(ctx, row))
	} catch (error) {
		ctx.log(
			`webhook delivery for ${row.type} failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
		status = 599
	}
	await ctx.store.recordDelivery({
		provider: row.provider,
		id: row.id,
		status,
		at: ctx.clock.now(),
	})
	return true
}

/** Deliver deferred events that are due. Safe to call from any request. */
export async function deliverDue(ctx: EmulatorContext) {
	if (ctx.webhookMode() !== 'deferred') return 0
	const due = await ctx.store.undeliveredEvents({
		dueBefore: ctx.clock.now(),
		limit: 25,
	})
	let delivered = 0
	for (const row of due) {
		// A never-attempted deferred event only; failures wait for flush.
		if (row.attempts > 0 || row.deliverAfter === null) continue
		if (await deliverEvent(ctx, row)) delivered++
	}
	return delivered
}

/** Deliver every undelivered or failed event, oldest first. */
export async function flushEvents(
	ctx: EmulatorContext,
	filter: { provider?: MockProvider } = {},
) {
	const rows = await ctx.store.undeliveredEvents({ ...filter, limit: 200 })
	let delivered = 0
	for (const row of rows) {
		if (await deliverEvent(ctx, row, { force: true })) delivered++
	}
	return { attempted: rows.length, delivered }
}

export async function redeliverEvent(
	ctx: EmulatorContext,
	provider: MockProvider,
	id: string,
) {
	const row = await ctx.store.getEvent(provider, id)
	if (!row) return null
	await deliverEvent(ctx, row, { force: true })
	return ctx.store.getEvent(provider, id)
}
