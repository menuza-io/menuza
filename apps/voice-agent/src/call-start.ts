import {
	type CallChannel,
	createVerticalContext,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentVertical,
	withCurrentAvailability,
} from '@repo/phone-agent'
import { type VoiceSession } from './controller.ts'
import {
	dialRefusal,
	isAgentLine,
	normalizeE164,
	parseTestMetadata,
	phoneTail,
} from './job-metadata.ts'
import {
	businessLineNotice,
	callPhrase,
	connectingToBusiness,
} from './messages.ts'
import {
	type RuntimeConfigLookup,
	type RuntimeConfigResult,
	type VoiceServices,
} from './services.ts'
import { type TransferDialer } from './transfer.ts'
import { phoneAgentVertical } from './vertical.ts'

export type CallStartPlan =
	| {
			kind: 'agent'
			config: PhoneAgentRuntimeConfig
			callId: string
	  }
	| {
			kind: 'fallback'
			/** `business_line` only plays a blocked call's notice; it never transfers. */
			reason:
				'passthrough' | 'config_unavailable' | 'start_failed' | 'business_line'
			/** Language for the fallback voice. */
			language: string
			voiceId: string | null
			/** Spoken before transferring, or before hanging up. */
			message: string | null
			/** Where to transfer the caller; hang up when null. */
			phone: string | null
			/** Numbers that reach the agent; never dialed. */
			agentLines: readonly string[]
	  }
	| {
			/**
			 * The caller ID reaches this org's own agent, so the agent neither
			 * answers nor dials out. `agent_line` is the agent calling itself (a
			 * transfer loop) and is hung up without a word; `business_line`
			 * is most likely staff on a business phone that forwards to the agent,
			 * who hear `message` first. `callId` is set when the call log could
			 * be opened to record it.
			 */
			kind: 'blocked'
			reason: BlockedReason
			config: PhoneAgentRuntimeConfig | null
			callId: string | null
			language: string
			voiceId: string | null
			message: string | null
	  }

export type BlockedReason = 'agent_line' | 'business_line'

/**
 * Whether a call must not reach the agent because its caller ID is one of
 * the org's own lines. `agentLines` mixes agent numbers and the business
 * lines forwarded to them without saying which is which, so only a call from
 * the number that was dialed counts as the agent calling itself; any other
 * line is treated as the business's phone.
 */
function blockedReason(
	callerPhone: string | null,
	agentLines: readonly string[],
	calledNumber: string | null,
): BlockedReason | null {
	if (!isAgentLine(callerPhone, agentLines)) return null
	return calledNumber && isAgentLine(callerPhone, [calledNumber])
		? 'agent_line'
		: 'business_line'
}

function blockedPlan(
	reason: BlockedReason,
	{
		config,
		callId,
		language,
		voiceId,
	}: {
		config: PhoneAgentRuntimeConfig | null
		callId: string | null
		language: string
		voiceId: string | null
	},
): Extract<CallStartPlan, { kind: 'blocked' }> {
	console.error(
		reason === 'agent_line'
			? 'Call from the agent line itself; hanging up'
			: 'Call from a business line that forwards to the agent; explaining and hanging up',
	)
	return {
		kind: 'blocked',
		reason,
		config,
		callId,
		language,
		voiceId,
		message: reason === 'business_line' ? businessLineNotice(language) : null,
	}
}

/**
 * Phone calls are looked up by the number that was called. Browser test
 * rooms carry App's dispatch metadata instead. Null when neither is usable.
 */
export function callLookup({
	sip,
	jobMetadata,
}: {
	/** Set for SIP participants: `sip.trunkPhoneNumber`, the number called. */
	sip: { calledNumber: string | undefined } | null
	jobMetadata: string | undefined
}): RuntimeConfigLookup | null {
	if (sip) {
		const calledNumber = normalizeE164(sip.calledNumber)
		return calledNumber ? { kind: 'number', calledNumber } : null
	}
	const metadata = parseTestMetadata(jobMetadata)
	return metadata
		? {
				kind: 'test',
				orgId: metadata.orgId,
				scopeId: metadata.scopeId,
				flow: metadata.flow,
			}
		: null
}

/**
 * A number to hand the caller to, unless it would loop back to the agent or
 * is outside the US and Canada.
 */
export function handOffNumber(
	phone: string | null,
	agentLines: readonly string[],
) {
	const number = normalizeE164(phone)
	if (!number) return null
	const refusal = dialRefusal(number, agentLines)
	if (refusal === 'agent_line') {
		console.error(
			'The fallback number reaches the agent itself; not transferring',
		)
		return null
	}
	if (refusal) {
		console.warn(
			'The fallback number is outside the US and Canada; not transferring',
			{ phone: phoneTail(number) },
		)
		return null
	}
	return number
}

/**
 * Whether the vertical can run this config: App built it for the same
 * vertical, in the current shape (a config cached before an upgrade may
 * not be).
 */
function fitsVertical(
	config: PhoneAgentRuntimeConfig,
	vertical: PhoneAgentVertical,
) {
	try {
		createVerticalContext(vertical, config)
		return Boolean(config.business?.name)
	} catch (error) {
		console.error('The phone agent config does not fit this worker', error)
		return false
	}
}

/**
 * Loads the agent config and opens the call log. Anything that goes wrong
 * becomes a fallback plan, so the caller always hears something before the
 * line drops or is handed to the business.
 */
export async function prepareCall({
	lookup,
	loadConfig,
	startCall,
	channel,
	roomName,
	callerPhone,
	vertical = phoneAgentVertical,
	now = () => new Date(),
}: {
	lookup: RuntimeConfigLookup
	loadConfig: (lookup: RuntimeConfigLookup) => Promise<RuntimeConfigResult>
	startCall: VoiceServices['startCall']
	channel: CallChannel
	roomName: string
	callerPhone: string | null
	vertical?: PhoneAgentVertical
	now?: () => Date
}): Promise<CallStartPlan> {
	const verticalDefaults = vertical.phraseDefaults
	let result: RuntimeConfigResult
	try {
		result = await loadConfig(lookup)
	} catch (error) {
		console.error('Could not load the phone agent config', error)
		return {
			kind: 'fallback',
			reason: 'config_unavailable',
			language: 'en',
			voiceId: null,
			message: callPhrase('trouble', { language: 'en', verticalDefaults }),
			phone: null,
			agentLines: [],
		}
	}
	const calledNumber = lookup.kind === 'number' ? lookup.calledNumber : null

	if (result.kind === 'passthrough') {
		const { passthrough } = result
		const agentLines = passthrough.agentLines ?? []
		const blocked = blockedReason(callerPhone, agentLines, calledNumber)
		if (blocked) {
			return blockedPlan(blocked, {
				config: null,
				callId: null,
				language: passthrough.language,
				voiceId: passthrough.voiceId,
			})
		}
		const phone = handOffNumber(passthrough.phone, agentLines)
		return {
			kind: 'fallback',
			reason: 'passthrough',
			language: passthrough.language,
			voiceId: passthrough.voiceId,
			// App's message is for handing off; without a number, apologize.
			message:
				(phone ? passthrough.message?.trim() : null) ||
				callPhrase(phone ? 'calling_disabled' : 'trouble', {
					language: passthrough.language,
					verticalDefaults,
				}),
			phone,
			agentLines,
		}
	}

	const loaded = {
		...result.config,
		agentLines: result.config.agentLines ?? [],
	}
	const fits = fitsVertical(loaded, vertical)
	// Availability is recomputed for `now`, because the config may be cached.
	const config = fits
		? withCurrentAvailability(loaded, vertical, now())
		: loaded
	const language = config.settings.languages[0] ?? 'en'
	const voiceId = config.settings.voiceId ?? null
	const blocked = blockedReason(callerPhone, config.agentLines, calledNumber)
	const trouble = () =>
		callPhrase('trouble', {
			language,
			business: config.business?.name ?? config.organization.name,
			overrides: config.settings.phrases,
			verticalDefaults,
		})
	if (!fits) {
		if (blocked) {
			return blockedPlan(blocked, {
				config: null,
				callId: null,
				language,
				voiceId,
			})
		}
		const phone = handOffNumber(config.fallbackPhone, config.agentLines)
		return {
			kind: 'fallback',
			reason: 'config_unavailable',
			language,
			voiceId,
			message: phone ? connectingToBusiness(language) : trouble(),
			phone,
			agentLines: config.agentLines,
		}
	}
	try {
		const started = await startCall({
			orgId: config.organization.id,
			channel,
			roomName,
			scopeId: config.scopeId,
			flowVersionId: config.flow.versionId,
			callerPhone,
		})
		if (blocked) {
			return blockedPlan(blocked, {
				config,
				callId: started.callId,
				language,
				voiceId,
			})
		}
		return { kind: 'agent', config, callId: started.callId }
	} catch (error) {
		if (blocked) {
			return blockedPlan(blocked, { config, callId: null, language, voiceId })
		}
		console.error('Could not start the call log', error)
		const phone = handOffNumber(config.fallbackPhone, config.agentLines)
		return {
			kind: 'fallback',
			reason: 'start_failed',
			language,
			voiceId,
			message: phone ? connectingToBusiness(language) : trouble(),
			phone,
			agentLines: config.agentLines,
		}
	}
}

/**
 * Plays the fallback message, then hands the caller to the business or
 * hangs up. Returns whether the caller was handed off.
 */
export async function runFallbackCall({
	session,
	plan,
	dialer,
	hangUp,
	leaveRoom,
}: {
	session: VoiceSession
	plan: Extract<CallStartPlan, { kind: 'fallback' }>
	dialer: TransferDialer | null
	hangUp: () => Promise<void>
	leaveRoom: () => Promise<void>
}) {
	const say = async (text: string | null) => {
		if (!text) return
		try {
			await session
				.say(text, { allowInterruptions: false })
				.waitForPlayout()
				.catch(() => undefined)
		} catch (error) {
			console.warn('Could not play the fallback message', error)
		}
	}

	await say(plan.message)
	const phone = plan.phone ? handOffNumber(plan.phone, plan.agentLines) : null
	if (phone && dialer) {
		const result = await dialer
			.transfer(phone)
			.catch(() => 'no_answer' as const)
		if (result === 'answered') {
			await leaveRoom()
			return true
		}
		if (result === 'referred') return true
		await say(
			callPhrase('trouble', {
				language: plan.language,
				verticalDefaults: phoneAgentVertical.phraseDefaults,
			}),
		)
	}
	await hangUp()
	return false
}

/**
 * After speech recognition, the model, or the voice fails mid-call, the
 * agent can no longer talk, so the caller is handed to the business with a
 * SIP REFER (which needs no audio from us). The room is only torn down when
 * there is no safe number or the REFER fails. The call log is saved without
 * holding up the hand-off. Returns whether the caller was handed off.
 */
export async function recoverFromOutage({
	phone,
	agentLines,
	referDialer,
	hangUp,
	saveLog,
}: {
	/** The config's fallback phone: the business phone, else the staff phone. */
	phone: string | null
	agentLines: readonly string[]
	/** A REFER-only dialer; null when there is no SIP caller (browser tests). */
	referDialer: TransferDialer | null
	hangUp: () => Promise<void>
	saveLog: (handedOff: boolean) => Promise<unknown>
}) {
	const target = referDialer ? handOffNumber(phone, agentLines) : null
	let handedOff = false
	if (target && referDialer) {
		const result = await referDialer
			.transfer(target)
			.catch(() => 'no_answer' as const)
		handedOff = result !== 'no_answer'
	}
	const saving = saveLog(handedOff).catch((error: unknown) =>
		console.error('Failed to save the call log', error),
	)
	if (!handedOff) await hangUp()
	await saving
	return handedOff
}
