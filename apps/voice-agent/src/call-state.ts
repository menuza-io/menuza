import {
	type AgentLanguage,
	type CallFinishExtras,
	type CallOutcome,
	type CallPurpose,
	type CallRequestType,
	type CallTransferResult,
	callRequestTypesFor,
	classifyCallPurpose,
	type FlowNodeType,
	LANGUAGE_NAMES,
	outcomeSummary,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentVertical,
	type PriceFormatter,
} from '@repo/phone-agent'

export type TranscriptTurn = {
	role: 'agent' | 'caller'
	text: string
	at: number
}

/** Mirrors tenant-api's cap on tags per call. */
export const MAX_TAGS_PER_CALL = 10

/** Mirrors tenant-api's cap on link texts per call. */
export const MAX_TEXTS_PER_CALL = 2

// Mirrors tenant-api's stored-transcript cap so finish bodies stay under 1 MB.
const MAX_TRANSCRIPT_TURNS = 400
const MAX_TURN_CHARS = 1000

/** Everything the worker learns during one call, in memory until the call ends. */
export class CallState {
	readonly startedAt: number
	/**
	 * What the vertical's tools remember during the call
	 * (`PhoneAgentVertical.createCallState`). Undefined for verticals without
	 * call state, and on calls the agent never answered.
	 */
	vertical: unknown = undefined
	transcript: TranscriptTurn[] = []
	visitedSteps = new Set<FlowNodeType>()
	/** Labels of the phone menu options the caller picked, in order. */
	menuChoices: string[] = []
	aiUsed = false
	toolsUsed = new Set<string>()
	declaredPurpose: CallPurpose | null = null
	requests: CallRequestType[] = []
	/** The last link texted (or shown on a test call's screen) on this call. */
	link: { url: string; smsSent: boolean } | null = null
	/** Texts delivered on this call, counted against MAX_TEXTS_PER_CALL. */
	textsSent = 0
	escalated = false
	failed = false
	recordingKey: string | null = null
	/** Tag ids from the org's tag list, in the order they were applied. */
	tags = new Set<string>()
	/** The caller's 1-5 rating from the end-of-call question. */
	rating: number | null = null
	transferResult: CallTransferResult = 'none'
	/** Hung up unanswered because the caller ID reaches this org's own agent. */
	loopBlocked = false
	/** With loopBlocked: the caller ID was a business line, not the agent's own number. */
	fromBusinessLine = false
	/** Set once the call moved away from the agent's primary language. */
	language: AgentLanguage | null = null
	/** Set when a transfer case's contact was dialed. */
	transferContactId: string | null = null
	voicemail = false

	constructor(now = Date.now()) {
		this.startedAt = now
	}

	addTurn(role: TranscriptTurn['role'], text: string, now = Date.now()) {
		const trimmed = text.trim()
		if (!trimmed || this.transcript.length >= MAX_TRANSCRIPT_TURNS) return
		this.transcript.push({
			role,
			text: trimmed.slice(0, MAX_TURN_CHARS),
			at: Math.max(0, Math.round((now - this.startedAt) / 1000)),
		})
	}

	durationSeconds(now = Date.now()) {
		return Math.max(0, Math.round((now - this.startedAt) / 1000))
	}

	canText() {
		return this.textsSent < MAX_TEXTS_PER_CALL
	}

	callerSpoke() {
		return this.transcript.some((turn) => turn.role === 'caller')
	}

	/** False when the tag is already applied or the call has its maximum. */
	addTag(tagId: string) {
		if (this.tags.has(tagId) || this.tags.size >= MAX_TAGS_PER_CALL) {
			return this.tags.has(tagId)
		}
		this.tags.add(tagId)
		return true
	}
}

/**
 * The follow-up fields sent flat with the finish body. Tenant-api has no copy
 * of the org's settings, so the ones it needs for alerts travel with the call.
 */
export function buildFinishExtras(
	state: CallState,
	config: Pick<
		PhoneAgentRuntimeConfig,
		'settings' | 'availability' | 'callsUrl'
	>,
): CallFinishExtras {
	const { settings } = config
	return {
		tags: [...state.tags].slice(0, MAX_TAGS_PER_CALL),
		rating: state.rating,
		sentiment: null,
		transferResult: state.transferResult,
		transferContactId: state.transferContactId,
		voicemail: state.voicemail,
		calledWhileOpen: config.availability.isOpen,
		followUp: settings.followUp,
		importantTagIds: settings.tags
			.filter((tag) => tag.important)
			.map((tag) => tag.id),
		tagNames: Object.fromEntries(
			settings.tags.map((tag) => [tag.id, tag.name]),
		),
		notifications: settings.notifications,
		callsUrl: config.callsUrl,
	}
}

/** The call's main purpose; see `classifyCallPurpose` for the precedence. */
export function classifyPurpose(
	state: CallState,
	vertical: PhoneAgentVertical,
): CallPurpose {
	return classifyCallPurpose(vertical, {
		declaredPurpose: state.declaredPurpose,
		requests: state.requests,
		toolsUsed: state.toolsUsed,
		linkSent: Boolean(state.link),
		menuChoices: state.menuChoices,
		state: state.vertical,
	})
}

export function resolveOutcome(state: CallState): CallOutcome {
	if (state.failed) return 'failed'
	if (state.escalated) return 'escalated'
	if (state.link) return 'link_sent'
	if (state.requests.length > 0) return 'message_taken'
	if (!state.callerSpoke()) return 'abandoned'
	return 'resolved'
}

export type SummaryOptions = {
	vertical: PhoneAgentVertical
	formatPrice: PriceFormatter
}

/** The body for tenant-api's finish call. */
export function buildFinishInput(
	state: CallState,
	config: Pick<
		PhoneAgentRuntimeConfig,
		'organization' | 'settings' | 'availability' | 'callsUrl'
	>,
	options: SummaryOptions & { now?: number },
) {
	return {
		orgId: config.organization.id,
		purpose: classifyPurpose(state, options.vertical),
		outcome: resolveOutcome(state),
		summary: buildSummary(state, options),
		transcript: state.transcript,
		durationSeconds: state.durationSeconds(options.now),
		recordingKey: state.recordingKey,
		recordingRetentionDays: config.settings.recordingRetentionDays,
		...buildFinishExtras(state, config),
	}
}

function requestSummaryLabels(vertical: PhoneAgentVertical) {
	return new Map(
		callRequestTypesFor(vertical).map((definition) => [
			definition.id,
			definition.summaryLabel ?? definition.label.toLowerCase(),
		]),
	)
}

/** Short, factual summary for the call log. Built from state, not the model. */
export function buildSummary(
	state: CallState,
	{ vertical, formatPrice }: SummaryOptions,
) {
	if (state.loopBlocked) {
		return state.fromBusinessLine
			? "Not answered by the agent: the call came from one of the business's own lines that forwards to the agent, so the caller was told and the call ended."
			: "Hung up without answering: the caller ID is one of this business's own agent lines, so the call was a transfer loop."
	}
	const parts = [
		outcomeSummary(resolveOutcome(state), vertical.outcomeSummaries),
	]
	if (state.language) {
		parts.push(`The call continued in ${LANGUAGE_NAMES[state.language]}.`)
	}
	if (state.transferResult === 'referred') {
		parts.push(
			'The call was handed off without a way to tell whether staff answered.',
		)
	}
	try {
		parts.push(
			...(vertical.summarizeCall?.({ state: state.vertical, formatPrice }) ??
				[]),
		)
	} catch (error) {
		console.error('Could not summarize the call for the vertical', error)
	}
	if (state.link && !state.link.smsSent) {
		parts.push('The text message with the link could not be sent.')
	}
	if (state.requests.length) {
		const labels = requestSummaryLabels(vertical)
		parts.push(
			`Logged: ${state.requests.map((type) => labels.get(type) ?? type.replace(/_/g, ' ')).join(', ')}.`,
		)
	}
	return parts.join(' ')
}
