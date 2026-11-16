import { i18n } from '@lingui/core'
import { t } from '@lingui/macro'
import { parseMarketingOffer } from '@repo/discounts'
import {
	buildProgramJourney,
	getProgramTemplate,
	PROGRAM_TEMPLATES,
	programAvailable,
	programLanguage,
	type ProgramCapabilities,
	type ProgramId,
	type ProgramLanguage,
	type ProgramTemplate,
} from '@repo/marketing-workflow'
import { checkJourneyOffers } from '#app/utils/discounts/marketing-offers.server.ts'
import { renderJourneyEmailNodes } from '#app/utils/email/journey-render.server.ts'
import { loadEmailRenderContext } from '#app/utils/email/render-context.server.ts'
import { resolveEmailBrandingForOrg } from '#app/utils/email-branding.server.ts'
import { loyaltyTriggersEnabled } from '#app/utils/marketing/loyalty-triggers.server.ts'
import {
	getMarketingFeatures,
	type MarketingFeatures,
} from '#app/utils/marketing/marketing-flags.server.ts'
import { reservationTriggersEnabled } from '#app/utils/marketing/reservation-triggers.server.ts'
import { type getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type FetchTenant = Awaited<
	ReturnType<typeof getOperatorTenantClient>
>['fetchTenant']

/**
 * Ready-made programs (#100) as the App serves them: which templates this
 * organization may see, whether each is off, on or customized, its 30-day
 * results, and "Turn on". Programs are never on by default: the owner turns
 * each one on. A template only appears when its trigger is available.
 */

export type ProgramStatus = 'off' | 'on' | 'customized' | 'paused'

export type ProgramCardData = {
	id: ProgramId
	version: number
	name: string
	summary: string
	channels: Array<'email' | 'sms'>
	coupon: 'optional' | 'none'
	needsReviewLink: boolean
	status: ProgramStatus
	journeyId: string | null
	/** The template changed since this journey was created (it is never rewritten). */
	newerTemplate: boolean
	results: { runs: number; messagesSent: number; ordersByGoal: number } | null
}

type JourneyRow = {
	id: string
	status: string
	version?: number
	programId?: string | null
	programVersion?: number | null
}

export async function programCapabilities(
	request: Request,
	organizationId: string,
	features?: MarketingFeatures,
): Promise<ProgramCapabilities> {
	const f = features ?? (await getMarketingFeatures(organizationId))
	return {
		// Order automations are only offered while the flag is on (restaurant
		// ordering is what they are made of).
		ordering: f.orderAutomations,
		reservations: await reservationTriggersEnabled(organizationId),
		loyalty: await loyaltyTriggersEnabled(request, organizationId),
		birthdays: f.birthdays,
		cart: f.cartReminders,
		// No listing is stored yet: the owner pastes the review link when turning
		// the program on.
		reviewLink: 'ask',
	}
}

function statusOf(journey: JourneyRow | undefined): ProgramStatus {
	if (!journey) return 'off'
	if (journey.status === 'paused') return 'paused'
	if (journey.status !== 'active') return 'off'
	return (journey.version ?? 1) > 1 ? 'customized' : 'on'
}

export async function loadProgramCards(input: {
	fetchTenant: FetchTenant
	request: Request
	organizationId: string
	features: MarketingFeatures
	language: ProgramLanguage
	/** The journeys the page already loaded (their program, status and version). */
	journeys: ReadonlyArray<Record<string, unknown>>
}): Promise<ProgramCardData[]> {
	const capabilities = await programCapabilities(
		input.request,
		input.organizationId,
		input.features,
	)
	const available = PROGRAM_TEMPLATES.filter((template) =>
		programAvailable(template, capabilities),
	)
	if (available.length === 0) return []

	const journeys = input.journeys as JourneyRow[]
	// The results are a nicety: if they cannot be read the cards still show.
	let results: Record<
		string,
		{ runs: number; messagesSent: number; ordersByGoal: number }
	> = {}
	try {
		const resultsRes = await input.fetchTenant(
			'/operator/journeys/program-results?days=30',
		)
		if (resultsRes?.ok) {
			results =
				((await resultsRes.json().catch(() => null)) as {
					results?: typeof results
				} | null)?.results ?? {}
		}
	} catch {
		results = {}
	}

	return available.map((template) => {
		// An archived journey does not count; the newest live one stands for the program.
		const journey = journeys.find(
			(candidate) =>
				candidate.programId === template.id && candidate.status !== 'archived',
		)
		return {
			id: template.id,
			version: template.version,
			name: template.name[input.language],
			summary: template.summary[input.language],
			channels: template.channels,
			coupon: template.coupon,
			needsReviewLink: template.requires.includes('review_link'),
			status: statusOf(journey),
			journeyId: journey?.id ?? null,
			newerTemplate:
				Boolean(journey) && (journey?.programVersion ?? 1) < template.version,
			results: journey ? (results[journey.id] ?? null) : null,
		}
	})
}

export type TurnOnResult =
	| { ok: true; journeyId: string }
	| {
			ok: false
			error:
				| 'program_unknown'
				| 'program_unavailable'
				| 'program_already_active'
				| 'review_link_required'
				| 'offer_invalid'
				| 'render_failed'
				| 'create_failed'
				| 'publish_failed'
			message: string
	  }

function failure(
	error: Extract<TurnOnResult, { ok: false }>['error'],
	message: string,
): TurnOnResult {
	return { ok: false, error, message }
}

function validReviewUrl(value: string | null): string | null {
	if (!value) return null
	try {
		const url = new URL(value.trim())
		return url.protocol === 'https:' ? url.toString() : null
	} catch {
		return null
	}
}

/**
 * Builds the journey from a template in the organization's branding and
 * language, wires the optional coupon, and creates it. `publish: false` leaves
 * it a draft for "Customize" (the editor opens first). Turning the same
 * program on twice is refused (`program_already_active`): tenant-api's unique
 * index is the last word, whatever raced.
 */
export async function turnOnProgram(input: {
	fetchTenant: FetchTenant
	request: Request
	organizationId: string
	userId: string
	baseUrl: string
	programId: string
	channel: 'email' | 'sms'
	discountOffer: unknown
	reviewUrl: string | null
	publish: boolean
	timeZone?: string | null
}): Promise<TurnOnResult> {
	const template: ProgramTemplate | undefined = getProgramTemplate(
		input.programId,
	)
	if (!template) {
		return failure('program_unknown', i18n._(t`That program does not exist.`))
	}
	const features = await getMarketingFeatures(input.organizationId)
	const capabilities = await programCapabilities(
		input.request,
		input.organizationId,
		features,
	)
	if (!programAvailable(template, capabilities)) {
		return failure(
			'program_unavailable',
			i18n._(t`This program is not available for your organization yet.`),
		)
	}
	const reviewUrl = validReviewUrl(input.reviewUrl)
	if (template.requires.includes('review_link') && !reviewUrl) {
		return failure(
			'review_link_required',
			i18n._(t`Paste the link to your Google review page (it starts with https://).`),
		)
	}

	const context = await loadEmailRenderContext({
		organizationId: input.organizationId,
		offer: null,
	})
	const branding = await resolveEmailBrandingForOrg(input.organizationId)
	const offer = parseMarketingOffer(input.discountOffer)
	const language = programLanguage(context.locale)
	const journey = buildProgramJourney(template, {
		organizationName: branding.organizationName ?? '',
		siteOrigin: context.siteOrigin ?? null,
		reviewUrl,
		language,
		channel: input.channel,
		withCoupon: Boolean(offer),
		timeZone: input.timeZone ?? null,
	})

	// The coupon goes on the steps that take one; the checks are the editor's.
	let nodes: unknown[] = journey.nodes.map((node) =>
		offer && journey.couponNodeIds.includes(node.id)
			? { ...node, data: { ...node.data, discountOffer: offer } }
			: node,
	)
	if (offer) {
		const checked = await checkJourneyOffers({
			userId: input.userId,
			organizationId: input.organizationId,
			nodes,
			storedNodes: [],
		})
		if (!checked.ok) {
			return failure(
				'offer_invalid',
				i18n._(t`The coupon cannot be used. Choose another one.`),
			)
		}
		nodes = checked.nodes
	}

	const rendered = await renderJourneyEmailNodes(
		input.organizationId,
		nodes as Array<Record<string, unknown>>,
		branding,
		input.baseUrl,
	)
	if (!rendered.ok) {
		return failure(
			'render_failed',
			i18n._(t`The message could not be prepared. Please try again.`),
		)
	}

	const createRes = await input.fetchTenant('/operator/journeys', {
		method: 'POST',
		body: JSON.stringify({
			name: journey.name,
			description: template.summary[language],
			triggerType: journey.triggerType,
			triggerConfig: journey.triggerConfig,
			goal: journey.goal,
			programId: journey.programId,
			programVersion: journey.programVersion,
			nodes: rendered.nodes,
			edges: journey.edges,
			graphJson: JSON.stringify({ nodes: rendered.nodes, edges: journey.edges }),
		}),
	})
	if (!createRes.ok) {
		const body = (await createRes.json().catch(() => ({}))) as {
			error?: string
		}
		if (body.error === 'program_already_active') {
			return failure(
				'program_already_active',
				i18n._(t`This program is already set up. Open it in Automations.`),
			)
		}
		return failure('create_failed', i18n._(t`The program could not be created.`))
	}
	const created = (await createRes.json()) as { journey?: { id?: string } }
	const journeyId = created.journey?.id
	if (!journeyId) {
		return failure('create_failed', i18n._(t`The program could not be created.`))
	}

	// Turning a program on brings the message limit with it (3 per guest per 7
	// days), once: an organization that never set one gets the default, and one
	// that chose "no limit" keeps that choice.
	await ensureDefaultFrequencyCap(input.fetchTenant)

	if (input.publish) {
		const publishRes = await input.fetchTenant(
			`/operator/journeys/${journeyId}/publish`,
			{ method: 'POST' },
		)
		if (!publishRes.ok) {
			return failure(
				'publish_failed',
				i18n._(t`The program was created but could not be turned on.`),
			)
		}
	}
	return { ok: true, journeyId }
}

async function ensureDefaultFrequencyCap(fetchTenant: FetchTenant) {
	try {
		const res = await fetchTenant('/operator/marketing/settings')
		if (!res.ok) return
		const settings = (await res.json()) as {
			frequencyCapConfigured?: boolean
			defaultFrequencyCap?: { limit: number; days: number }
		}
		if (settings.frequencyCapConfigured) return
		await fetchTenant('/operator/marketing/settings', {
			method: 'PUT',
			body: JSON.stringify({
				frequencyCap: settings.defaultFrequencyCap ?? { limit: 3, days: 7 },
			}),
		})
	} catch {
		// The program is on; the limit can be set on the settings page.
	}
}
