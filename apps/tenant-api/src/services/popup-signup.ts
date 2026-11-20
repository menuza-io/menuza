import {
	customers,
	getTenantDb,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { isValidPhone, normalizePhone } from '../lib/phone.ts'
import { setCustomerSubscription } from './marketing-audience.ts'
import { requestSubscriptionConfirmation } from './subscription-confirmation.ts'

/**
 * A contact left in a website popup (#132). The contact and its consent live
 * only in the regional database: the browser calls tenant-api directly and the
 * control plane never sees it. Consent must be explicit (the checkbox is never
 * pre-ticked) and an email stays pending until its owner follows the emailed
 * link, like every other form. A customer who already verified their phone is
 * never rewritten from an anonymous popup.
 */
export const popupSignupSchema = z
	.object({
		popupId: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/),
		channel: z.enum(['email', 'phone']),
		contact: z.string().trim().min(3).max(200),
		consent: z.literal(true),
		turnstileToken: z.string().max(4000).optional(),
		website: z.string().max(200).optional(),
		slug: z.string().optional(),
		host: z.string().optional(),
	})
	.strict()

export type PopupSignupResult =
	{ ok: true } | { ok: false; error: 'invalid_contact' }

export async function recordPopupSignup(
	orgId: string,
	input: Pick<
		z.infer<typeof popupSignupSchema>,
		'popupId' | 'channel' | 'contact'
	>,
	options: { db?: TenantDatabase; now?: number } = {},
): Promise<PopupSignupResult> {
	const db = options.db ?? (await getTenantDb(orgId))
	const now = options.now ?? Date.now()
	const at = new Date(now)
	const consentTextVersion = `popup:${input.popupId}`

	if (input.channel === 'email') {
		const parsed = z.string().email().safeParse(input.contact.toLowerCase())
		if (!parsed.success) return { ok: false, error: 'invalid_contact' }
		const email = parsed.data
		const customerId = await runTenantTransaction(db, async (tx) => {
			const existing = await tx
				.select({ id: customers.id })
				.from(customers)
				.where(eq(customers.email, email))
				.limit(1)
			let id = existing[0]?.id
			if (!id) {
				const [created] = await tx
					.insert(customers)
					.values({ name: '', email, phone: null, phoneVerified: false })
					.returning({ id: customers.id })
				id = created!.id
			}
			await setCustomerSubscription(tx, {
				customerId: id,
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				source: 'form',
				now: at,
				// Typed, not proven: pending until its owner confirms.
				confirmedEmail: null,
				consentTextVersion,
			})
			return id
		})
		await requestSubscriptionConfirmation(db, {
			orgId,
			customerId,
			topic: 'marketing',
			email,
			name: '',
			now,
		})
		return { ok: true }
	}

	let phone: string
	try {
		phone = normalizePhone(input.contact)
	} catch {
		return { ok: false, error: 'invalid_contact' }
	}
	if (!isValidPhone(phone)) return { ok: false, error: 'invalid_contact' }
	await runTenantTransaction(db, async (tx) => {
		const existing = await tx
			.select({ id: customers.id, verified: customers.phoneVerified })
			.from(customers)
			.where(eq(customers.phone, phone))
			.limit(1)
		let id = existing[0]?.id
		// Anyone can type someone else's number: a verified owner is never
		// rewritten (nor subscribed) from an anonymous popup.
		if (existing[0]?.verified) return
		if (!id) {
			const [created] = await tx
				.insert(customers)
				.values({ name: '', email: null, phone, phoneVerified: false })
				.returning({ id: customers.id })
			id = created!.id
		}
		await setCustomerSubscription(tx, {
			customerId: id,
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'form',
			now: at,
			consentTextVersion,
		})
	})
	return { ok: true }
}
