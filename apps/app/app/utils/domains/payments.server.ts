import { db, eq, Organization } from '@repo/database'
import { getShopCommerce } from '#app/utils/shop.server.ts'
import { isDomainsMock } from './config.server.ts'

/**
 * Charging and refunding for domains (#183) on the platform Stripe account:
 * the card on file of the organization's existing billing, charged off
 * session. A seam, so the unit tests and the local emulator stand in for Stripe.
 */

export type ChargeInput = {
	organizationId: string
	amountCents: number
	currency: string
	idempotencyKey: string
	description: string
	metadata: Record<string, string>
}

export type ChargeResult =
	| { status: 'succeeded'; paymentIntentId: string }
	| {
			status: 'failed'
			code: 'no_card_on_file' | 'card_declined' | 'payment_failed'
	  }

export interface DomainPayments {
	hasCardOnFile(organizationId: string): Promise<boolean>
	charge(input: ChargeInput): Promise<ChargeResult>
	refund(input: {
		paymentIntentId: string
		amountCents: number
		idempotencyKey: string
	}): Promise<{ refundId: string }>
}

const stripe = () => getShopCommerce().getPlatformStripe()

async function customerFor(organizationId: string): Promise<string | null> {
	const [org] = await db
		.select({ stripeCustomerId: Organization.stripeCustomerId })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org?.stripeCustomerId ?? null
}

async function cardOf(customerId: string): Promise<string | null> {
	const customer = await stripe().customers.retrieve(customerId)
	if (customer.deleted) return null
	const preferred = customer.invoice_settings?.default_payment_method
	if (preferred) return typeof preferred === 'string' ? preferred : preferred.id
	const cards = await stripe().paymentMethods.list({
		customer: customerId,
		type: 'card',
		limit: 1,
	})
	return cards.data[0]?.id ?? null
}

export const stripeDomainPayments: DomainPayments = {
	async hasCardOnFile(organizationId) {
		const customer = await customerFor(organizationId)
		return customer ? Boolean(await cardOf(customer)) : false
	},
	async charge(input) {
		const customer = await customerFor(input.organizationId)
		const method = customer ? await cardOf(customer) : null
		if (!customer || !method)
			return { status: 'failed', code: 'no_card_on_file' }
		try {
			const intent = await stripe().paymentIntents.create(
				{
					amount: input.amountCents,
					currency: input.currency,
					customer,
					payment_method: method,
					off_session: true,
					confirm: true,
					description: input.description,
					metadata: input.metadata,
				},
				{ idempotencyKey: input.idempotencyKey },
			)
			return intent.status === 'succeeded'
				? { status: 'succeeded', paymentIntentId: intent.id }
				: { status: 'failed', code: 'payment_failed' }
		} catch (error) {
			const code = (error as { code?: string; type?: string }).code
			return {
				status: 'failed',
				code:
					code === 'card_declined' || code === 'authentication_required'
						? 'card_declined'
						: 'payment_failed',
			}
		}
	},
	async refund(input) {
		const refund = await stripe().refunds.create(
			{ payment_intent: input.paymentIntentId, amount: input.amountCents },
			{ idempotencyKey: input.idempotencyKey },
		)
		return { refundId: refund.id }
	},
}

/** The emulator: a card is always on file, and nothing real is charged. */
export class MockDomainPayments implements DomainPayments {
	readonly charges: ChargeInput[] = []
	readonly refunds: Array<{ paymentIntentId: string; amountCents: number }> = []
	cardOnFile = true
	/** The next charge is declined. */
	declineNext = false
	/** The next refund fails. */
	failRefund = false
	private counter = 0

	async hasCardOnFile() {
		return this.cardOnFile
	}

	async charge(input: ChargeInput): Promise<ChargeResult> {
		if (!this.cardOnFile) return { status: 'failed', code: 'no_card_on_file' }
		if (this.declineNext) {
			this.declineNext = false
			return { status: 'failed', code: 'card_declined' }
		}
		this.charges.push(input)
		this.counter += 1
		return { status: 'succeeded', paymentIntentId: `pi_mock_${this.counter}` }
	}

	async refund(input: { paymentIntentId: string; amountCents: number }) {
		if (this.failRefund) throw new Error('refund_failed')
		this.refunds.push({
			paymentIntentId: input.paymentIntentId,
			amountCents: input.amountCents,
		})
		return { refundId: `re_mock_${this.refunds.length}` }
	}
}

let override: DomainPayments | null = null
let mock: MockDomainPayments | null = null

export function setDomainPayments(payments: DomainPayments | null) {
	override = payments
}

export function getDomainPayments(): DomainPayments {
	if (override) return override
	if (isDomainsMock()) {
		mock ??= new MockDomainPayments()
		return mock
	}
	return stripeDomainPayments
}
