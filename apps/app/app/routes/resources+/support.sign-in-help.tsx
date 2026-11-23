import { recordNumberCheck, recordSignInCodeDelivery } from '@repo/auth'
import { SMS_OPT_OUT_PHRASE } from '@repo/common/sms-compliance'
import { brand } from '@repo/config/brand'
import {
	Organization,
	OrderAlertRecipient,
	User,
	UserOrganization,
	and,
	db,
	desc,
	eq,
	isNotNull,
	isNull,
} from '@repo/database'
import { ForgotPasswordEmail } from '@repo/email'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { prepareVerification } from '#app/routes/_auth+/verify.server.tsx'
import {
	alertTextsAvailable,
	getAlertTextProvider,
} from '#app/utils/alerts/text.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'
import { getPhoneLookupProvider } from '#app/utils/phone-lookup.server.ts'
import {
	checkRateLimit,
	SIGN_IN_HELP_RESEND_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import { sendCodeEmail } from '#app/utils/sign-in-delivery.server.ts'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const bodySchema = z.discriminatedUnion('intent', [
	z.strictObject({
		intent: z.literal('check_phone'),
		phone: z.string().min(8).max(20),
	}),
	z.strictObject({
		intent: z.literal('resend'),
		userId: z.string().min(1).max(64),
		channel: z.enum(['email', 'sms']),
	}),
])

/** The operator's own verified mobile number: a contact they added for order alerts. */
async function findOperatorPhone(userId: string) {
	const [row] = await db
		.select({
			address: OrderAlertRecipient.address,
			organizationId: OrderAlertRecipient.organizationId,
			dataRegion: Organization.dataRegion,
		})
		.from(OrderAlertRecipient)
		.innerJoin(
			Organization,
			eq(Organization.id, OrderAlertRecipient.organizationId),
		)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.organizationId, OrderAlertRecipient.organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.where(
			and(
				eq(OrderAlertRecipient.createdBy, userId),
				eq(OrderAlertRecipient.kind, 'phone'),
				isNotNull(OrderAlertRecipient.verifiedAt),
				isNull(OrderAlertRecipient.stoppedAt),
			),
		)
		.orderBy(desc(OrderAlertRecipient.verifiedAt))
		.limit(1)
	return row ?? null
}

/**
 * `POST /resources/support/sign-in-help`: what Admin's Sign-in help (#246) asks
 * the App to do, because the App owns the senders. Internal token only.
 *
 * - `check_phone`: the text provider's lookup for a number (valid, line type,
 *   carrier), remembered on that number's recent log rows.
 * - `resend`: a fresh one-time code to the operator by `email` or by `sms` (to a
 *   verified mobile number they added themselves). The code goes only to the
 *   operator; nothing in the answer, the log or the audit trail holds it.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	try {
		await requireInternalCommandAuth(request)
	} catch (error) {
		if (error instanceof Response && error.status === 401) return error
		throw error
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) {
		return Response.json(
			{ error: 'invalid_request' },
			{ status: 400, headers: NO_STORE },
		)
	}
	const input = parsed.data

	if (input.intent === 'check_phone') {
		const check = await getPhoneLookupProvider().lookup(input.phone)
		if (!check) {
			return Response.json({ status: 'unavailable' }, { headers: NO_STORE })
		}
		await recordNumberCheck({ phone: input.phone, check })
		return Response.json({ status: 'ok', check }, { headers: NO_STORE })
	}

	const [user] = await db
		.select({ id: User.id, email: User.email })
		.from(User)
		.where(eq(User.id, input.userId))
		.limit(1)
	if (!user) {
		return Response.json(
			{ status: 'not_found' },
			{ status: 404, headers: NO_STORE },
		)
	}
	const limit = await checkRateLimit(
		{ type: 'user', value: user.id },
		SIGN_IN_HELP_RESEND_RATE_LIMIT,
	)
	if (!limit.allowed) {
		return Response.json(
			{ status: 'rate_limited' },
			{ status: 429, headers: NO_STORE },
		)
	}

	if (input.channel === 'email') {
		const { verifyUrl, otp } = await prepareVerification({
			period: 10 * 60,
			request,
			type: 'reset-password',
			target: user.email,
		})
		const result = await sendCodeEmail({
			purpose: 'sign_in_help',
			userId: user.id,
			to: user.email,
			subject: brand.email.passwordReset,
			react: (
				<ForgotPasswordEmail onboardingUrl={verifyUrl.toString()} otp={otp} />
			),
		})
		return Response.json(
			{
				status: result.status === 'success' ? 'sent' : 'failed',
				channel: 'email',
			},
			{ headers: NO_STORE },
		)
	}

	const phone = await findOperatorPhone(user.id)
	if (!phone) {
		return Response.json({ status: 'no_phone_on_file' }, { headers: NO_STORE })
	}
	if (!alertTextsAvailable(phone.dataRegion)) {
		return Response.json({ status: 'unavailable' }, { headers: NO_STORE })
	}
	const { otp } = await prepareVerification({
		period: 10 * 60,
		request,
		type: 'reset-password',
		target: user.email,
	})
	const provider = getAlertTextProvider()
	const sent = await provider.send({
		orgId: phone.organizationId,
		to: phone.address,
		text: `Your ${brand.name} sign-in code is ${otp}. ${SMS_OPT_OUT_PHRASE}`,
	})
	await recordSignInCodeDelivery({
		userId: user.id,
		organizationId: phone.organizationId,
		purpose: 'sign_in_help',
		channel: 'sms',
		destination: phone.address,
		provider: provider.name === 'mock' ? 'mock' : 'twilio',
		providerMessageId: sent.ok ? (sent.providerMessageId ?? null) : null,
		status: sent.ok ? 'sent' : 'failed',
		failureReason: sent.ok ? null : sent.code,
	})
	return Response.json(
		{ status: sent.ok ? 'sent' : 'failed', channel: 'sms' },
		{ headers: NO_STORE },
	)
}
