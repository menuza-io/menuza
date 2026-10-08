import { db, eq, User } from '@repo/database'
import { data } from 'react-router'
import { z } from 'zod'
import { type StartTestCallResult } from '#app/components/phone-agent/test-call-panel.tsx'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import {
	canUpdatePhoneAgent,
	requirePhoneAgentAccess,
} from '#app/utils/phone-agent/access.server.ts'
import {
	createTestCallToken,
	getLiveKitConfig,
} from '#app/utils/phone-agent/livekit.server.ts'
import { getPublishedFlow } from '#app/utils/phone-agent/phone-agent.server.ts'
import { phoneAgentServerVertical } from '#app/utils/phone-agent/vertical.server.ts'
import {
	checkRateLimit,
	PHONE_AGENT_TEST_CALL_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'

const flowSchema = z.enum(['draft', 'published'])

export async function loadTestCallPage(
	request: Request,
	orgSlug: string | undefined,
) {
	const { orgId } = await requirePhoneAgentAccess(
		request,
		orgSlug,
		ORG_PERMISSIONS.READ_PHONE_AGENT_ANY,
	)
	const [scopes, publishedFlow, canStart] = await Promise.all([
		phoneAgentServerVertical.listScopes(orgId),
		getPublishedFlow(orgId),
		canUpdatePhoneAgent(request, orgId),
	])
	const requested = flowSchema.safeParse(
		new URL(request.url).searchParams.get('flow'),
	)
	const hasPublishedFlow = Boolean(publishedFlow)
	return {
		scopes: scopes.map(({ id, name, isDefault }) => ({ id, name, isDefault })),
		hasPublishedFlow,
		defaultFlow: requested.success
			? requested.data
			: hasPublishedFlow
				? ('published' as const)
				: ('draft' as const),
		liveKitConfigured: Boolean(getLiveKitConfig()),
		canStart,
	}
}

const startSchema = z.object({
	intent: z.literal('start'),
	scopeId: z.string().min(1).max(64).nullable(),
	flow: flowSchema,
})

const noStore = { 'Cache-Control': 'private, no-store' }

export async function startTestCall(
	request: Request,
	orgSlug: string | undefined,
) {
	// Test calls bill speech and LLM minutes, so only editors may start them.
	const { orgId, userId, dataRegion } = await requirePhoneAgentAccess(
		request,
		orgSlug,
		ORG_PERMISSIONS.UPDATE_PHONE_AGENT_ANY,
	)
	const fail = (error: string, status = 400) =>
		data<StartTestCallResult>(
			{ ok: false, error },
			{ status, headers: noStore },
		)

	const parsed = startSchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) return fail('Choose what to test and try again.')
	if (dataRegion !== 'us') {
		return fail('The phone agent is not available in your data region yet.')
	}
	if (!getLiveKitConfig()) {
		return fail('Test calls are not configured on this server.', 503)
	}
	const [scopes, publishedFlow] = await Promise.all([
		phoneAgentServerVertical.listScopes(orgId),
		parsed.data.flow === 'published' ? getPublishedFlow(orgId) : null,
	])
	const { scopeId } = parsed.data
	if (
		scopes.length
			? !scopes.some((scope) => scope.id === scopeId)
			: scopeId !== null
	) {
		return fail('That option is not available.')
	}
	if (parsed.data.flow === 'published' && !publishedFlow) {
		return fail('Publish your flow first, or test the draft.')
	}
	const rateLimit = await checkRateLimit(
		{ type: 'user', value: `${userId}:${orgId}` },
		PHONE_AGENT_TEST_CALL_RATE_LIMIT,
	)
	if (!rateLimit.allowed) {
		const minutes = Math.max(
			1,
			Math.ceil((rateLimit.resetAt.getTime() - Date.now()) / 60_000),
		)
		return fail(
			`You've started a lot of test calls in the last hour. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
			429,
		)
	}
	const [user] = await db
		.select({ name: User.name, username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	const token = await createTestCallToken({
		orgId,
		scopeId,
		flow: parsed.data.flow,
		userId,
		displayName: user?.name || user?.username || 'Operator',
	})
	return data<StartTestCallResult>({ ok: true, ...token }, { headers: noStore })
}
