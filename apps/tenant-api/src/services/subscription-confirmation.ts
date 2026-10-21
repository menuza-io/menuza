import { and, eq } from 'drizzle-orm'
import {
	customers,
	customerSubscriptions,
	type CustomerSubscriptionTopic,
	type TenantDatabase,
	type TenantTransaction,
} from '@repo/tenant-db'
import {
	confirmTokenExpiry,
	consentBaseUrl,
	signConsentToken,
} from '../lib/email-consent.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { emailConsentHash } from './marketing-audience.ts'

/** Least time between two confirmation emails for one subscription. */
export const RESEND_INTERVAL_MS = 3 * 60 * 1000

/**
 * The emailed double opt-in confirmation for one customer + topic. Shared by
 * the customer's own subscription route and the booking-form consent of the
 * reservations module, so there is one wording, one token and one link.
 * Returns whether the email actually went out (never throws).
 */
export async function sendConfirmationEmail(
	/** Origin of the request, used only as a local-development fallback. */
	requestOrigin: string | undefined,
	params: {
		orgId: string
		customerId: string
		topic: string
		email: string
		name: string
	},
): Promise<boolean> {
	const token = signConsentToken({
		k: 'confirm',
		o: params.orgId,
		c: params.customerId,
		t: params.topic,
		e: emailConsentHash(params.email),
		x: confirmTokenExpiry(),
	})
	const baseUrl = consentBaseUrl(requestOrigin)
	if (!baseUrl) {
		// Never fall back to the request origin here: the link carries a signed
		// token. Ids only, no address and no token.
		console.error('Email confirmation skipped: TENANT_API_URL is not set', {
			orgId: params.orgId,
			customerId: params.customerId,
		})
		return false
	}
	const link = `${baseUrl}/subscriptions/confirm?token=${encodeURIComponent(token)}`
	try {
		const result = await sendTenantEmail({
			to: params.email,
			toName: params.name,
			subject: 'Confirm your email subscription',
			text: `Someone asked to send marketing email to this address. To confirm, open: ${link}\n\nIf this was not you, ignore this message and you will not receive anything.`,
			html: `<p>Someone asked to send marketing email to this address.</p><p><a href="${link}">Confirm my subscription</a></p><p>If this was not you, ignore this message and you will not receive anything.</p>`,
			capture: { orgId: params.orgId, messageKind: 'email-confirmation' },
		})
		if (result.status === 'success') return true
		// Ids and a status only: never the address or the provider's message.
		console.error('Email confirmation was not sent', {
			orgId: params.orgId,
			customerId: params.customerId,
			status: result.status,
			statusCode:
				result.status === 'error' ? result.error.statusCode : undefined,
		})
	} catch (error) {
		console.error('Email confirmation failed', {
			orgId: params.orgId,
			customerId: params.customerId,
			error: error instanceof Error ? error.name : 'unknown',
		})
	}
	return false
}

/**
 * Sends the confirmation link for a pending email subscription, at most once
 * per `RESEND_INTERVAL_MS` for the same address, and records when it went out
 * (the same markers the subscription route uses). A subscription that is
 * already confirmed for this address, or opted out, sends nothing. Never throws.
 */
export async function requestSubscriptionConfirmation(
	db: TenantDatabase | TenantTransaction,
	params: {
		orgId: string
		customerId: string
		topic: CustomerSubscriptionTopic
		email: string
		name: string
		now?: number
	},
): Promise<boolean> {
	try {
		const now = params.now ?? Date.now()
		const addressHash = emailConsentHash(params.email)
		const row = await db
			.select()
			.from(customerSubscriptions)
			.where(
				and(
					eq(customerSubscriptions.customerId, params.customerId),
					eq(customerSubscriptions.topic, params.topic),
					eq(customerSubscriptions.channel, 'email'),
				),
			)
			.get()
		if (!row || row.unsubscribedAt) return false
		if (row.confirmedEmailHash === addressHash) return false
		// The link confirms the address ON FILE, so it goes only to that one.
		const customer = await db
			.select({ email: customers.email })
			.from(customers)
			.where(eq(customers.id, params.customerId))
			.get()
		if (customer?.email?.trim().toLowerCase() !== params.email.trim().toLowerCase()) {
			return false
		}
		if (
			row.confirmationSentHash === addressHash &&
			row.confirmationSentAt &&
			now - row.confirmationSentAt.getTime() < RESEND_INTERVAL_MS
		) {
			return false
		}
		const sent = await sendConfirmationEmail(undefined, {
			orgId: params.orgId,
			customerId: params.customerId,
			topic: params.topic,
			email: params.email,
			name: params.name,
		})
		if (sent) {
			await db
				.update(customerSubscriptions)
				.set({
					confirmationSentAt: new Date(now),
					confirmationSentHash: addressHash,
				})
				.where(eq(customerSubscriptions.id, row.id))
				.run()
		}
		return sent
	} catch (error) {
		console.error('Subscription confirmation failed', {
			orgId: params.orgId,
			customerId: params.customerId,
			error: error instanceof Error ? error.name : 'unknown',
		})
		return false
	}
}
