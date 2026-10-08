import {
	data,
	redirect,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	canUpdatePhoneAgent,
	requirePhoneAgentAccess,
	requirePhoneAgentSectionAccess,
} from '#app/utils/phone-agent/access.server.ts'
import { LINE_VERIFICATION_CODE_PATTERN } from '#app/utils/phone-agent/line-verification.server.ts'
import {
	addPhoneNumber,
	getPhoneAgent,
	listAssignablePlatformNumbers,
	listPhoneNumbers,
	listTrainingRules,
	PhoneNumberInputSchema,
	removePhoneNumber,
	sendLineVerificationCode,
	verifyLineVerificationCode,
} from '#app/utils/phone-agent/phone-agent.server.ts'
import { settingsError } from '#app/utils/phone-agent/settings-errors.ts'
import {
	patchPhoneAgentSettings,
	settingsVersions,
	toFieldErrors,
} from '#app/utils/phone-agent/settings-patch.server.ts'
import { phoneAgentServerVertical } from '#app/utils/phone-agent/vertical.server.ts'
import { cartesiaConfigured } from '#app/utils/phone-agent/voices.server.ts'
import {
	checkRateLimit,
	PHONE_LINE_VERIFICATION_CHECK_RATE_LIMIT,
	PHONE_LINE_VERIFICATION_SEND_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

export type PhoneAgentSetupActionResult =
	| { ok: true }
	| { ok: false; error?: string; fieldErrors?: Record<string, string> }

const NumberId = z.string().min(1).max(64)

const intentSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('save-settings'),
		patch: z.unknown(),
		versions: z.unknown(),
	}),
	z.object({ intent: z.literal('add-number'), number: z.unknown() }),
	z.object({ intent: z.literal('remove-number'), id: NumberId }),
	z.object({
		intent: z.literal('send-line-code'),
		id: NumberId,
		method: z.enum(['sms', 'call']),
	}),
	z.object({
		intent: z.literal('verify-line-code'),
		id: NumberId,
		code: z.string().trim().regex(LINE_VERIFICATION_CODE_PATTERN),
	}),
])

function retryMinutes(resetAt: Date) {
	return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 60_000))
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const section = await requirePhoneAgentSectionAccess(request, params.orgSlug)
	if (!section.canReadAgent) {
		throw redirect(`/${params.orgSlug}/phone-agent/calls`)
	}
	const { orgId } = section
	const [agent, numbers, assignableNumbers, scopes, rules, canUpdate] =
		await Promise.all([
			getPhoneAgent(orgId),
			listPhoneNumbers(orgId),
			listAssignablePlatformNumbers(orgId),
			phoneAgentServerVertical.listScopes(orgId),
			listTrainingRules(orgId),
			canUpdatePhoneAgent(request, orgId),
		])
	return data(
		{
			settings: agent.settings,
			versions: settingsVersions(agent.settings),
			publishedFlowVersionId: agent.publishedFlowVersionId ?? null,
			numbers,
			assignableNumbers,
			scopes: scopes.map(({ id, name, isDefault }) => ({
				id,
				name,
				isDefault,
			})),
			activeRuleCount: rules.filter((rule) => rule.isActive).length,
			canUpdate,
			voiceLibraryAvailable: cartesiaConfigured(),
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

export async function action({
	request,
	params,
}: ActionFunctionArgs): Promise<PhoneAgentSetupActionResult> {
	const { orgId, userId } = await requirePhoneAgentAccess(
		request,
		params.orgSlug,
		ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
	)
	const actor = { userId, request }
	const body: unknown = await request.json().catch(() => null)
	const parsedIntent = intentSchema.safeParse(body)
	if (!parsedIntent.success) {
		const codeIssue = parsedIntent.error.issues.find(
			(issue) => issue.path[0] === 'code',
		)
		return codeIssue
			? { ok: false, fieldErrors: { code: settingsError('code_format') } }
			: { ok: false, error: settingsError('invalid_request') }
	}
	const input = parsedIntent.data

	if (input.intent === 'save-settings') {
		const result = await patchPhoneAgentSettings({
			organizationId: orgId,
			userId,
			request,
			patch: input.patch,
			versions: input.versions,
		})
		return result.ok ? { ok: true } : result
	}

	if (input.intent === 'add-number') {
		const parsed = PhoneNumberInputSchema.safeParse(input.number)
		if (!parsed.success) {
			const fieldErrors = toFieldErrors(parsed.error)
			// The schema's only custom check: forwarding needs the business line.
			if (
				parsed.error.issues.some(
					(issue) =>
						issue.code === z.ZodIssueCode.custom &&
						issue.path[0] === 'forwardedFrom',
				)
			) {
				fieldErrors.forwardedFrom = settingsError('required')
			}
			return { ok: false, fieldErrors }
		}
		const result = await addPhoneNumber(orgId, parsed.data, actor)
		return result.ok ? { ok: true } : { ok: false, error: result.error }
	}

	if (input.intent === 'send-line-code') {
		const rateLimit = await checkRateLimit(
			{ type: 'user', value: `${userId}:${orgId}` },
			PHONE_LINE_VERIFICATION_SEND_RATE_LIMIT,
		)
		if (!rateLimit.allowed) {
			return {
				ok: false,
				error: settingsError(
					'rate_limited_send',
					retryMinutes(rateLimit.resetAt),
				),
			}
		}
		const result = await sendLineVerificationCode(
			orgId,
			input.id,
			input.method,
			actor,
		)
		return result.ok ? { ok: true } : { ok: false, error: result.error }
	}

	if (input.intent === 'verify-line-code') {
		const rateLimit = await checkRateLimit(
			{ type: 'user', value: `${userId}:${orgId}` },
			PHONE_LINE_VERIFICATION_CHECK_RATE_LIMIT,
		)
		if (!rateLimit.allowed) {
			return {
				ok: false,
				error: settingsError(
					'rate_limited_check',
					retryMinutes(rateLimit.resetAt),
				),
			}
		}
		const result = await verifyLineVerificationCode(
			orgId,
			input.id,
			input.code,
			actor,
		)
		return result.ok ? { ok: true } : { ok: false, error: result.error }
	}

	await removePhoneNumber(orgId, input.id, actor)
	return { ok: true }
}
