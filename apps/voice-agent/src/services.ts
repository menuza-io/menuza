import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type CallChannel,
	type CallFinishExtras,
	type CallOutcome,
	type CallPurpose,
	type CallRequestType,
	type PhoneAgentPassthrough,
	type PhoneAgentRuntimeConfig,
	SUPPORTED_AGENT_LANGUAGES,
} from '@repo/phone-agent'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { type TranscriptTurn } from './call-state.ts'

export type RuntimeConfigLookup =
	| { kind: 'number'; calledNumber: string }
	| {
			kind: 'test'
			orgId: string
			scopeId: string | null
			flow: 'draft' | 'published'
	  }

export class ServiceError extends Error {
	constructor(
		message: string,
		/** HTTP status, or 0 when the service could not be reached. */
		readonly status: number,
	) {
		super(message)
		this.name = 'ServiceError'
	}
}

const REQUEST_TIMEOUT_MS = 8_000

/**
 * The caller is waiting in silence while the config loads, and a cached copy
 * covers an App outage, so App gets much less time than tenant-api.
 */
export const CONFIG_REQUEST_TIMEOUT_MS = 2_500

function authHeaders() {
	return {
		Authorization: `Bearer ${ENV.VOICE_AGENT_TOKEN}`,
		'Content-Type': 'application/json',
	}
}

async function send(
	url: string,
	init: RequestInit,
	timeoutMs = REQUEST_TIMEOUT_MS,
) {
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch (error) {
		throw new ServiceError(
			`Could not reach ${new URL(url).origin}: ${error instanceof Error ? error.message : String(error)}`,
			0,
		)
	}
}

async function readJson<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => null)) as
		(T & { error?: string }) | null
	if (!response.ok) {
		throw new ServiceError(
			body?.error ?? `Request failed with ${response.status}`,
			response.status,
		)
	}
	if (body === null) {
		throw new ServiceError('Response was not JSON', 502)
	}
	return body as T
}

const PassthroughSchema = z.object({
	passthrough: z.literal(true),
	error: z.string(),
	phone: z.string().nullable(),
	message: z.string().nullable(),
	language: z.enum(SUPPORTED_AGENT_LANGUAGES).catch('en'),
	voiceId: z.string().nullable().catch(null),
	agentLines: z.array(z.string()).max(200).catch([]),
})

export type AppConfigResponse =
	| { kind: 'config'; config: PhoneAgentRuntimeConfig }
	| { kind: 'passthrough'; passthrough: PhoneAgentPassthrough }

/**
 * App holds agent settings, flows, rules, and the vertical's published data
 * (no PII).
 */
export async function requestRuntimeConfig(
	lookup: RuntimeConfigLookup,
): Promise<AppConfigResponse> {
	const params = new URLSearchParams(
		lookup.kind === 'number'
			? { number: lookup.calledNumber }
			: {
					orgId: lookup.orgId,
					...(lookup.scopeId ? { scopeId: lookup.scopeId } : {}),
					flow: lookup.flow,
				},
	)
	const response = await send(
		`${ENV.APP_URL}/resources/phone-agent-config?${params}`,
		{ headers: authHeaders(), redirect: 'manual' },
		CONFIG_REQUEST_TIMEOUT_MS,
	)
	if (
		response.status === 401 ||
		(response.status >= 300 && response.status < 400)
	) {
		throw new ServiceError('App rejected VOICE_AGENT_TOKEN', 401)
	}
	if (response.status === 409) {
		const parsed = PassthroughSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (parsed.success) return { kind: 'passthrough', passthrough: parsed.data }
		throw new ServiceError('Unexpected 409 from App', 409)
	}
	return {
		kind: 'config',
		config: await readJson<PhoneAgentRuntimeConfig>(response),
	}
}

export type RuntimeConfigResult =
	| { kind: 'config'; config: PhoneAgentRuntimeConfig; stale: boolean }
	| { kind: 'passthrough'; passthrough: PhoneAgentPassthrough }

export type ConfigCacheEntry = {
	fetchedAt: number
	config: PhoneAgentRuntimeConfig
}

export type ConfigCacheStore = {
	read(key: string): Promise<ConfigCacheEntry | null>
	write(key: string, entry: ConfigCacheEntry): Promise<void>
	remove(key: string): Promise<void>
}

/**
 * Every LiveKit job runs in its own process, so the cache has to live outside
 * process memory to help the next call. The config holds no caller data.
 */
export function fileConfigCache(
	dir = join(tmpdir(), 'phone-agent-config'),
): ConfigCacheStore {
	const pathFor = (key: string) =>
		join(dir, `${key.replace(/[^\w+-]/g, '_')}.json`)
	return {
		async read(key) {
			try {
				return JSON.parse(
					await readFile(pathFor(key), 'utf8'),
				) as ConfigCacheEntry
			} catch {
				return null
			}
		},
		async write(key, entry) {
			try {
				await mkdir(dir, { recursive: true })
				const temp = `${pathFor(key)}.${process.pid}.tmp`
				await writeFile(temp, JSON.stringify(entry))
				await rename(temp, pathFor(key))
			} catch (error) {
				console.warn('Could not cache the phone agent config', error)
			}
		},
		async remove(key) {
			await rm(pathFor(key), { force: true }).catch(() => undefined)
		},
	}
}

export function memoryConfigCache(): ConfigCacheStore {
	const entries = new Map<string, ConfigCacheEntry>()
	return {
		read: async (key) => entries.get(key) ?? null,
		write: async (key, entry) => void entries.set(key, entry),
		remove: async (key) => void entries.delete(key),
	}
}

/**
 * The oldest cached config the worker still answers with while App is down.
 * Safety switches flipped during an outage don't reach the worker until App
 * is back, so this keeps that window bounded.
 */
export const CONFIG_MAX_STALE_MS = 24 * 60 * 60_000

/** App could not answer: unreachable, timed out, or a server error. */
function isOutage(error: unknown) {
	return (
		!(error instanceof ServiceError) ||
		error.status === 0 ||
		error.status >= 500
	)
}

/** App looked the number up and said no, for example it is unassigned. */
function isRefusal(error: unknown) {
	return (
		error instanceof ServiceError && [403, 404, 409, 410].includes(error.status)
	)
}

/**
 * Waits between finish attempts. With REQUEST_TIMEOUT_MS per attempt, saving
 * the call log gives up within about 30 seconds, well inside the job's
 * shutdown window.
 */
export const FINISH_RETRY_DELAYS_MS = [1_000, 4_000]

/**
 * Saves the call log, retrying when tenant-api is unreachable or erroring.
 * Safe to repeat because tenant-api never overwrites a finished call. Never
 * rejects; returns whether the log was saved.
 */
export async function finishCallWithRetry(
	finish: () => Promise<unknown>,
	{
		delays = FINISH_RETRY_DELAYS_MS,
		sleep = (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: {
		delays?: readonly number[]
		sleep?: (ms: number) => Promise<void>
	} = {},
) {
	for (let attempt = 0; ; attempt++) {
		try {
			await finish()
			return true
		} catch (error) {
			const retryable =
				isOutage(error) ||
				(error instanceof ServiceError && error.status === 429)
			const delay = delays[attempt]
			if (!retryable || delay === undefined) {
				console.error('Failed to save the call log', error)
				return false
			}
			console.warn('Could not save the call log; retrying', {
				attempt: attempt + 1,
				error: error instanceof Error ? error.message : String(error),
			})
			await sleep(delay)
		}
	}
}

/**
 * App is always asked first, so turning the agent off or pausing calls takes
 * effect on the next call. Phone-number lookups are cached only as an outage
 * fallback: the cached config answers the call when App can't be reached,
 * times out, or errors, never when App refuses the lookup. Test calls always
 * load the current draft or published flow.
 */
export function createRuntimeConfigLoader({
	request = requestRuntimeConfig,
	cache = fileConfigCache(),
	now = Date.now,
}: {
	request?: (lookup: RuntimeConfigLookup) => Promise<AppConfigResponse>
	cache?: ConfigCacheStore
	now?: () => number
} = {}) {
	return async function loadRuntimeConfig(
		lookup: RuntimeConfigLookup,
	): Promise<RuntimeConfigResult> {
		const key = lookup.kind === 'number' ? lookup.calledNumber : null
		try {
			const response = await request(lookup)
			if (key) {
				if (response.kind === 'config') {
					await cache.write(key, { fetchedAt: now(), config: response.config })
				} else {
					await cache.remove(key)
				}
			}
			return response.kind === 'config'
				? { ...response, stale: false }
				: response
		} catch (error) {
			if (!key) throw error
			if (isRefusal(error)) {
				await cache.remove(key)
				throw error
			}
			const cached = isOutage(error) ? await cache.read(key) : null
			const age = cached ? now() - cached.fetchedAt : Infinity
			if (cached && age >= 0 && age < CONFIG_MAX_STALE_MS) {
				console.warn('App is unavailable; using a cached phone agent config', {
					ageMinutes: Math.round(age / 60_000),
					error: error instanceof Error ? error.message : String(error),
				})
				return { kind: 'config', config: cached.config, stale: true }
			}
			throw error
		}
	}
}

async function tenantPost<T>(path: string, body: unknown): Promise<T> {
	const response = await send(`${ENV.TENANT_API_URL}/api/voice${path}`, {
		method: 'POST',
		headers: authHeaders(),
		body: JSON.stringify(body),
	})
	return readJson<T>(response)
}

/**
 * Only the call id is used. Any customer name tenant-api sends is ignored:
 * it would come from caller ID, which can be spoofed.
 */
const StartCallResponseSchema = z.object({ callId: z.string().min(1) })

export type SmsBlockedReason =
	| 'not_allowed_number'
	| 'call_limit'
	| 'daily_limit'
	| 'test_call'
	| 'unavailable_region'
	| 'send_failed'

export type TextLinkResult = {
	url: string
	smsSent: boolean
	smsBlockedReason?: SmsBlockedReason
}

/** Most characters tenant-api accepts for a link text's `message`. */
export const LINK_MESSAGE_MAX_CHARS = 320

/**
 * The regional tenant-api stores everything about the caller: the call log,
 * transcript, texted links, and staff requests.
 */
export const tenantApi = {
	/** Returns the existing call for a room that was already started. */
	async startCall(input: {
		orgId: string
		channel: CallChannel
		roomName: string
		scopeId: string | null
		flowVersionId: string | null
		callerPhone: string | null
	}): Promise<{ callId: string }> {
		const parsed = StartCallResponseSchema.safeParse(
			await tenantPost<unknown>('/calls', input),
		)
		if (!parsed.success) {
			throw new ServiceError('Unexpected response from tenant-api', 502)
		}
		return parsed.data
	},

	/**
	 * Idempotent; a repeat answers `alreadyFinished: true`. The follow-up
	 * extras ride flat on the same body.
	 */
	finishCall(
		callId: string,
		input: {
			orgId: string
			purpose: CallPurpose | null
			outcome: CallOutcome
			summary: string | null
			transcript: TranscriptTurn[]
			durationSeconds: number
			recordingKey: string | null
			recordingRetentionDays?: number
		} & Partial<CallFinishExtras>,
	) {
		return tenantPost<{ success: true; alreadyFinished?: boolean }>(
			`/calls/${encodeURIComponent(callId)}/finish`,
			input,
		)
	},

	/**
	 * Stores `payload` behind a token and texts the site URL for `path` with
	 * the token. `message` is the SMS body; tenant-api puts the URL where it
	 * says `{url}`.
	 */
	createHandoff(input: {
		orgId: string
		callId: string
		scopeId: string | null
		path: string
		payload: unknown
		message: string
		sendTo: string | null
	}) {
		// On a real call whose text was blocked, tenant-api deletes the handoff
		// and returns null link fields.
		return tenantPost<
			Omit<TextLinkResult, 'url'> & {
				url: string | null
				handoffId: string | null
				expiresAt: string | null
			}
		>('/handoffs', input)
	},

	/** Texts the site URL for `path`; `message` works as for createHandoff. */
	sendWebsiteLink(input: {
		orgId: string
		callId: string
		scopeId: string | null
		path: string
		message: string
		sendTo: string | null
	}) {
		return tenantPost<TextLinkResult>('/website-links', input)
	},

	createRequest(input: {
		orgId: string
		callId: string
		type: CallRequestType
		callerName: string | null
		callerPhone: string | null
		details: Record<string, string>
	}) {
		return tenantPost<{ requestId: string }>('/requests', input)
	},
}

export type VoiceServices = typeof tenantApi

/** What the caller hears when tenant-api refused to text them. */
export function smsBlockedExplanation(reason: SmsBlockedReason | undefined) {
	switch (reason) {
		case 'not_allowed_number':
			return "I can only text the number you're calling from or another US mobile number."
		case 'call_limit':
			return "I've already sent as many texts as I can on this call."
		case 'daily_limit':
			return "That number has reached today's limit for texts from us."
		case 'test_call':
			return 'This is a test call, so the link is on your screen instead of in a text.'
		case 'unavailable_region':
			return "Texting isn't available for this business right now."
		default:
			return "The text didn't go through."
	}
}
