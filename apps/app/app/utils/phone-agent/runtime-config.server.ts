import {
	and,
	db,
	eq,
	isNull,
	Organization,
	PhoneAgentNumber,
	PlatformPhoneNumber,
} from '@repo/database'
import {
	agentLineNumbers,
	defaultFlowFor,
	fillMessage,
	type PhoneAgentPassthrough,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentSettings,
	pickSafeTransferTarget,
	resolvePhrase,
} from '@repo/phone-agent'
import { ENV } from 'varlock/env'
import {
	getDraftFlow,
	getPhoneAgent,
	getPublishedFlow,
	listTrainingRules,
} from './phone-agent.server.ts'
import { phoneAgentServerVertical } from './vertical.server.ts'
import { businessMessageVariables, phoneAgentVertical } from './vertical.ts'

function callsPageUrl(orgSlug: string) {
	const base = ENV.BASE_URL
	if (!base) return null
	try {
		return new URL(
			`/${encodeURIComponent(orgSlug)}/phone-agent/calls`,
			base,
		).toString()
	} catch {
		return null
	}
}

export type RuntimeConfigLookup =
	| { kind: 'number'; calledNumber: string }
	| {
			kind: 'test'
			orgId: string
			scopeId: string | null
			flow: 'draft' | 'published'
	  }

export type RuntimeConfigResult =
	| { ok: true; config: PhoneAgentRuntimeConfig }
	| {
			ok: false
			status: number
			error: string
			passthrough?: PhoneAgentPassthrough
	  }

/**
 * Every number that reaches the org's agent, including lines that are not
 * verified or active yet: a business may already forward its line to the
 * agent number before verifying it.
 */
export async function listAgentLines(organizationId: string) {
	const [connected, assigned] = await Promise.all([
		db
			.select({
				e164: PhoneAgentNumber.e164,
				forwardedFrom: PhoneAgentNumber.forwardedFrom,
			})
			.from(PhoneAgentNumber)
			.where(eq(PhoneAgentNumber.organizationId, organizationId)),
		db
			.select({ e164: PlatformPhoneNumber.e164 })
			.from(PlatformPhoneNumber)
			.where(eq(PlatformPhoneNumber.assignedOrganizationId, organizationId)),
	])
	return agentLineNumbers([...connected, ...assigned])
}

function passthroughFailure(input: {
	error: string
	phone: string | null
	agentLines: string[]
	settings: PhoneAgentSettings
	business: string
}): RuntimeConfigResult {
	const { error, phone, agentLines, settings } = input
	const language = settings.languages[0] ?? 'en'
	// With nobody to hand off to, the worker plays its own apology instead.
	const message = phone
		? fillMessage(
				resolvePhrase('calling_disabled', language, settings.phrases),
				businessMessageVariables(input.business),
			)
		: null
	return {
		ok: false,
		status: 409,
		error,
		passthrough: {
			passthrough: true,
			error,
			phone,
			message,
			language,
			voiceId: settings.voiceId ?? null,
			agentLines,
		},
	}
}

const SCOPE_UNAVAILABLE_ERROR = 'This line is not in service right now'

/**
 * Assembles everything the voice worker needs for one call. Phone calls only
 * resolve when the agent is enabled; browser tests work before go-live so
 * owners can try a draft flow.
 */
export async function buildRuntimeConfig(
	lookup: RuntimeConfigLookup,
): Promise<RuntimeConfigResult> {
	let orgId: string
	let scopeId: string | null
	if (lookup.kind === 'number') {
		const [number] = await db
			.select({
				organizationId: PhoneAgentNumber.organizationId,
				scopeId: PhoneAgentNumber.scopeId,
			})
			.from(PhoneAgentNumber)
			// A number answers only while the platform still assigns it to the
			// org, so unassigning or retiring it in Admin stops calls at once.
			.innerJoin(
				PlatformPhoneNumber,
				and(
					eq(PlatformPhoneNumber.id, PhoneAgentNumber.platformNumberId),
					eq(PlatformPhoneNumber.e164, PhoneAgentNumber.e164),
					eq(
						PlatformPhoneNumber.assignedOrganizationId,
						PhoneAgentNumber.organizationId,
					),
					isNull(PlatformPhoneNumber.retiredAt),
				),
			)
			.where(
				and(
					eq(PhoneAgentNumber.e164, lookup.calledNumber),
					eq(PhoneAgentNumber.isActive, true),
				),
			)
			.limit(1)
		if (!number)
			return { ok: false, status: 404, error: 'Number not connected' }
		orgId = number.organizationId
		// A scope saved under a vertical without scopes no longer means anything.
		scopeId = phoneAgentVertical.scope ? number.scopeId : null
	} else {
		orgId = lookup.orgId
		scopeId = phoneAgentVertical.scope ? lookup.scopeId : null
	}

	const [organization] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			siteDefaultLocale: Organization.siteDefaultLocale,
			siteLocales: Organization.siteLocales,
			dataRegion: Organization.dataRegion,
		})
		.from(Organization)
		.where(and(eq(Organization.id, orgId), eq(Organization.active, true)))
		.limit(1)
	if (!organization) {
		return { ok: false, status: 404, error: 'Organization not found' }
	}
	// The voice pipeline runs on US infrastructure; KSA callers must not reach it.
	if (organization.dataRegion !== 'us') {
		return {
			ok: false,
			status: 409,
			error: 'The AI phone agent is only available for US organizations',
		}
	}

	const [agent, agentLines, scope] = await Promise.all([
		getPhoneAgent(orgId),
		listAgentLines(orgId),
		lookup.kind === 'number' && scopeId
			? phoneAgentServerVertical.findScope(orgId, scopeId)
			: null,
	])
	const { escalationPhone } = agent.settings
	if (lookup.kind === 'number') {
		const scopeActive = !scopeId || scope?.isActive === true
		const businessPhone = scopeId
			? (scope?.phone ?? null)
			: agent.settings.business.phone
		// The business phone is often the line forwarded to the agent; sending
		// the caller there would forward them straight back, so it is skipped.
		if (!agent.settings.enabled || agent.settings.safety.callingDisabled) {
			return passthroughFailure({
				error: agent.settings.enabled
					? 'Phone agent is paused'
					: 'Phone agent is turned off',
				phone: pickSafeTransferTarget(
					[scopeActive ? businessPhone : null, escalationPhone],
					agentLines,
				),
				agentLines,
				settings: agent.settings,
				business: organization.name,
			})
		}
		if (!scopeActive) {
			return passthroughFailure({
				error: SCOPE_UNAVAILABLE_ERROR,
				phone: pickSafeTransferTarget([escalationPhone], agentLines),
				agentLines,
				settings: agent.settings,
				business: organization.name,
			})
		}
	}

	const flowRow =
		lookup.kind === 'test' && lookup.flow === 'draft'
			? await getDraftFlow(orgId)
			: await getPublishedFlow(orgId)
	const flow = flowRow
		? {
				versionId: flowRow.version === 0 ? null : flowRow.id,
				graph: flowRow.graph,
			}
		: { versionId: null, graph: defaultFlowFor(phoneAgentVertical) }

	const [built, rules] = await Promise.all([
		phoneAgentServerVertical.configParts({
			organization,
			scopeId,
			settings: agent.settings,
			now: new Date(),
			strictScope: lookup.kind === 'number' && scopeId !== null,
		}),
		listTrainingRules(orgId),
	])
	if (!built.ok) {
		if (lookup.kind === 'number') {
			return passthroughFailure({
				error: SCOPE_UNAVAILABLE_ERROR,
				phone: pickSafeTransferTarget([escalationPhone], agentLines),
				agentLines,
				settings: agent.settings,
				business: organization.name,
			})
		}
		return { ok: false, status: 404, error: 'Scope not found' }
	}
	const { parts, currency } = built

	return {
		ok: true,
		config: {
			organization: {
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				currency,
			},
			...parts,
			settings: agent.settings,
			flow,
			rules: rules.map(({ updatedAt: ignoredUpdatedAt, ...rule }) => rule),
			fallbackPhone: pickSafeTransferTarget(
				[parts.business.phone, escalationPhone],
				agentLines,
			),
			callsUrl: callsPageUrl(organization.slug),
			agentLines,
		},
	}
}
