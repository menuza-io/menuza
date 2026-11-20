import { requireUserId } from '@repo/auth'
import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	checkSenderDomain,
	clearReplyTo,
	removeSenderDomain,
	requestReplyToCode,
	saveSenderName,
	SenderFlowError,
	startSenderDomain,
	verifyReplyToCode,
} from '#app/utils/email-sender/sender.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { checkRateLimit } from '#app/utils/rate-limit.server.ts'

/**
 * Settings, Email sending (#103): the sender name, the reply-to verified by
 * a code and the optional custom sending domain. Every change needs
 * `update:settings:any`. Errors are codes the card turns into words.
 */

const intents = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('save-sender-name'),
		senderName: z.string().max(200).default(''),
	}),
	z.object({
		intent: z.literal('request-reply-to-code'),
		address: z.string().trim().min(1).max(320),
	}),
	z.object({
		intent: z.literal('verify-reply-to-code'),
		code: z.string().trim().min(1).max(12),
	}),
	z.object({ intent: z.literal('clear-reply-to') }),
	z.object({
		intent: z.literal('start-sender-domain'),
		domain: z.string().trim().min(1).max(253),
		localPart: z.string().trim().max(64).optional(),
	}),
	z.object({ intent: z.literal('check-sender-domain') }),
	z.object({ intent: z.literal('remove-sender-domain') }),
])

export const EMAIL_SENDING_INTENTS = intents.options.map(
	(option) => option.shape.intent.value,
)

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)
	const formData = await request.formData()
	const parsed = intents.safeParse(Object.fromEntries(formData))
	if (!parsed.success) {
		return Response.json(
			{
				ok: false,
				intent: String(formData.get('intent') ?? ''),
				error: 'invalid_request',
			},
			{ status: 400 },
		)
	}
	const data = parsed.data
	const fail = (error: string, status = 422) =>
		Response.json({ ok: false, intent: data.intent, error }, { status })
	try {
		switch (data.intent) {
			case 'save-sender-name':
				await saveSenderName(organization.id, data.senderName)
				break
			case 'request-reply-to-code': {
				const limit = await checkRateLimit(
					{ type: 'org', value: organization.id },
					{ scope: 'reply-to-code', maxRequests: 6, windowMs: 60 * 60 * 1000 },
				)
				if (!limit.allowed) return fail('rate_limited', 429)
				await requestReplyToCode({ organization, address: data.address })
				break
			}
			case 'verify-reply-to-code':
				await verifyReplyToCode({
					organizationId: organization.id,
					code: data.code,
				})
				break
			case 'clear-reply-to':
				await clearReplyTo(organization.id)
				break
			case 'start-sender-domain':
				await startSenderDomain({
					organization,
					domain: data.domain,
					localPart: data.localPart,
				})
				break
			case 'check-sender-domain':
				await checkSenderDomain({ organizationId: organization.id })
				break
			case 'remove-sender-domain':
				await removeSenderDomain(organization.id)
				break
		}
		return Response.json({ ok: true, intent: data.intent })
	} catch (error) {
		if (error instanceof SenderFlowError) {
			return fail(error.code, error.code === 'feature_off' ? 404 : 422)
		}
		console.error(
			`Email sending ${data.intent} failed:`,
			error instanceof Error ? error.message : error,
		)
		return fail('unexpected', 500)
	}
}
