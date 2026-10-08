import { generalVertical, type PhoneAgentVertical } from '@repo/phone-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	callLookup,
	prepareCall,
	recoverFromOutage,
	runFallbackCall,
} from './call-start.ts'
import { businessLineNotice, callPhrase } from './messages.ts'
import { type RuntimeConfigResult } from './services.ts'
import { FakeSession, testConfig } from './test-fixtures.ts'
import { type TransferResult } from './transfer.ts'

const UNAVAILABLE = callPhrase('trouble', { language: 'en' })

/** The test config's agent line, also used as the number that was called. */
const AGENT_LINE = '+15552001111'

function prepare({
	load,
	startCall = vi.fn(async () => ({ callId: 'call_1' })),
	callerPhone = '+15552223333',
	calledNumber = '+15550001111',
	now,
	vertical = generalVertical,
}: {
	vertical?: PhoneAgentVertical
	load: () => Promise<RuntimeConfigResult>
	startCall?: () => Promise<{ callId: string }>
	callerPhone?: string | null
	calledNumber?: string
	now?: Date
}) {
	return prepareCall({
		lookup: { kind: 'number', calledNumber },
		loadConfig: load,
		startCall,
		channel: 'phone',
		roomName: 'room_1',
		callerPhone,
		vertical,
		now: now ? () => now : undefined,
	})
}

function passthrough(
	overrides: Partial<{ phone: string | null; message: string | null }> = {},
): RuntimeConfigResult {
	return {
		kind: 'passthrough',
		passthrough: {
			passthrough: true,
			error: 'Phone agent is off',
			phone: '(555) 234-5678',
			message: null,
			language: 'en',
			voiceId: null,
			agentLines: ['+15552001111'],
			...overrides,
		},
	}
}

describe('prepareCall', () => {
	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('starts the agent with the config and call log', async () => {
		const config = testConfig()
		const plan = await prepare({
			load: async () => ({ kind: 'config', config, stale: false }),
		})
		expect(plan).toEqual({ kind: 'agent', config, callId: 'call_1' })
	})

	it('passes the call through to the business when the agent is off', async () => {
		const plan = await prepare({
			load: async () => passthrough({ message: 'Connecting you to Acme.' }),
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			reason: 'passthrough',
			message: 'Connecting you to Acme.',
			phone: '+15552345678',
		})
	})

	it('says it is connecting the caller when App sends no passthrough message', async () => {
		const plan = await prepare({ load: async () => passthrough() })
		expect(plan).toMatchObject({
			message: callPhrase('calling_disabled', { language: 'en' }),
			phone: '+15552345678',
		})
	})

	it("speaks the passthrough in the agent's language and voice", async () => {
		const plan = await prepare({
			load: async () => {
				const result = passthrough()
				if (result.kind !== 'passthrough') throw new Error('unreachable')
				return {
					...result,
					passthrough: {
						...result.passthrough,
						language: 'es',
						voiceId: 'voice-es',
					},
				}
			},
		})
		expect(plan).toMatchObject({
			language: 'es',
			voiceId: 'voice-es',
			message: callPhrase('calling_disabled', { language: 'es' }),
		})
	})

	it("doesn't promise a hand-off when the passthrough number is unsafe", async () => {
		const plan = await prepare({
			load: async () =>
				passthrough({ phone: '+15552001111', message: 'Connecting you.' }),
		})
		expect(plan).toMatchObject({ message: UNAVAILABLE, phone: null })
	})

	it('apologizes when a passthrough has nowhere to send the caller', async () => {
		const plan = await prepare({
			load: async () => passthrough({ phone: '(555) 123-4567' }),
		})
		expect(plan).toMatchObject({ message: UNAVAILABLE, phone: null })
	})

	it('never passes the call through to a number that reaches the agent', async () => {
		const plan = await prepare({
			load: async () => passthrough({ phone: '+1 555 200 1111' }),
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			message: UNAVAILABLE,
			phone: null,
		})
	})

	it('hangs up silently on a passthrough call from the agent line itself', async () => {
		const plan = await prepare({
			load: async () => passthrough(),
			callerPhone: AGENT_LINE,
			calledNumber: AGENT_LINE,
		})
		expect(plan).toEqual({
			kind: 'blocked',
			reason: 'agent_line',
			config: null,
			callId: null,
			language: 'en',
			voiceId: null,
			message: null,
		})
	})

	it('logs and hangs up silently on a call from the agent line itself', async () => {
		const startCall = vi.fn(async () => ({ callId: 'call_9' }))
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: testConfig(),
				stale: false,
			}),
			startCall,
			callerPhone: AGENT_LINE,
			calledNumber: AGENT_LINE,
		})
		expect(plan).toMatchObject({
			kind: 'blocked',
			reason: 'agent_line',
			callId: 'call_9',
			message: null,
		})
		expect(startCall).toHaveBeenCalledTimes(1)
	})

	it('explains before hanging up on a call from a business line that forwards to the agent', async () => {
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: testConfig({ languages: ['es', 'en'] }),
				stale: false,
			}),
			callerPhone: AGENT_LINE,
		})
		expect(plan).toMatchObject({
			kind: 'blocked',
			reason: 'business_line',
			callId: 'call_1',
			language: 'es',
			message: businessLineNotice('es'),
		})
	})

	it('explains a passthrough call from a business line in the agent language', async () => {
		const plan = await prepare({
			load: async () => passthrough(),
			callerPhone: '(555) 200-1111',
		})
		expect(plan).toMatchObject({
			kind: 'blocked',
			reason: 'business_line',
			message: businessLineNotice('en'),
		})
	})

	it('still blocks a loop call when the call log cannot be opened', async () => {
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: testConfig(),
				stale: false,
			}),
			startCall: async () => {
				throw new Error('tenant-api down')
			},
			callerPhone: AGENT_LINE,
		})
		expect(plan).toMatchObject({
			kind: 'blocked',
			reason: 'business_line',
			callId: null,
		})
	})

	it('never passes the call through to a number outside the US and Canada', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const plan = await prepare({
			load: async () =>
				passthrough({ phone: '+18095550123', message: 'Connecting you.' }),
		})
		expect(plan).toMatchObject({ message: UNAVAILABLE, phone: null })
	})

	it('does not fall back to a premium-rate number', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const config = { ...testConfig(), fallbackPhone: '+19005550123' }
		const plan = await prepare({
			load: async () => ({ kind: 'config', config, stale: false }),
			startCall: async () => {
				throw new Error('tenant-api down')
			},
		})
		expect(plan).toMatchObject({ message: UNAVAILABLE, phone: null })
	})

	const NINE_TO_FIVE = [
		'monday',
		'tuesday',
		'wednesday',
		'thursday',
		'friday',
		'saturday',
		'sunday',
	].map((day) => ({
		day: day as 'monday',
		isOpen: true,
		slots: [{ start: '09:00', end: '17:00' }],
	}))

	it('recomputes open hours at call time instead of trusting a cached snapshot', async () => {
		const config = testConfig()
		config.business.hours = NINE_TO_FIVE
		const startCall = vi.fn(async () => ({ callId: 'call_1' }))
		const plan = await prepare({
			load: async () => ({ kind: 'config', config, stale: true }),
			startCall,
			// 22:00 in New York, long after closing; the snapshot says open.
			now: new Date('2025-01-15T22:00:00-05:00'),
		})
		expect(plan).toMatchObject({
			kind: 'agent',
			config: { availability: { isOpen: false } },
		})
		expect(startCall).toHaveBeenCalledWith(
			expect.objectContaining({ scopeId: null }),
		)
	})

	it('opens the call log with the scope id', async () => {
		const startCall = vi.fn(async () => ({ callId: 'call_1' }))
		await prepare({
			load: async () => ({
				kind: 'config',
				config: { ...testConfig(), scopeId: 'scope_1' },
				stale: false,
			}),
			startCall,
		})
		expect(startCall).toHaveBeenCalledWith({
			orgId: 'org_1',
			channel: 'phone',
			roomName: 'room_1',
			scopeId: 'scope_1',
			flowVersionId: 'flow_1',
			callerPhone: '+15552223333',
		})
	})

	it('hands the caller to the business when the config is for another vertical', async () => {
		const startCall = vi.fn(async () => ({ callId: 'call_1' }))
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: {
					...testConfig(),
					vertical: { id: 'another_vertical', data: null },
				},
				stale: false,
			}),
			startCall,
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			reason: 'config_unavailable',
			phone: '+15552345678',
		})
		expect(startCall).not.toHaveBeenCalled()
	})

	it('falls back on a cached config from before verticals', async () => {
		const {
			business: ignoredBusiness,
			vertical: ignoredVertical,
			...older
		} = testConfig()
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: older as ReturnType<typeof testConfig>,
				stale: true,
			}),
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			reason: 'config_unavailable',
		})
	})

	it('treats a cached config without agent lines as having none', async () => {
		const { agentLines: ignoredAgentLines, ...older } = testConfig()
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: older as ReturnType<typeof testConfig>,
				stale: true,
			}),
			callerPhone: AGENT_LINE,
		})
		expect(plan).toMatchObject({ kind: 'agent', config: { agentLines: [] } })
	})

	it('apologizes and hangs up when App is unreachable', async () => {
		const plan = await prepare({
			load: async () => {
				throw new Error('fetch failed')
			},
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			reason: 'config_unavailable',
			message: UNAVAILABLE,
			phone: null,
		})
	})

	it('transfers to the fallback phone when tenant-api cannot start the call', async () => {
		const plan = await prepare({
			load: async () => ({
				kind: 'config',
				config: testConfig(),
				stale: false,
			}),
			startCall: async () => {
				throw new Error('tenant-api down')
			},
		})
		expect(plan).toMatchObject({
			kind: 'fallback',
			reason: 'start_failed',
			phone: '+15552345678',
			message:
				"We're having trouble with our phone assistant, so let me connect you with our team.",
		})
	})

	it('hangs up after apologizing when there is no fallback phone', async () => {
		const config = { ...testConfig(), fallbackPhone: null }
		const plan = await prepare({
			load: async () => ({ kind: 'config', config, stale: false }),
			startCall: async () => {
				throw new Error('tenant-api down')
			},
		})
		expect(plan).toMatchObject({ message: UNAVAILABLE, phone: null })
	})

	it('does not fall back to a number that reaches the agent', async () => {
		const config = { ...testConfig(), fallbackPhone: '+15552001111' }
		const plan = await prepare({
			load: async () => ({ kind: 'config', config, stale: false }),
			startCall: async () => {
				throw new Error('tenant-api down')
			},
		})
		expect(plan).toMatchObject({ message: UNAVAILABLE, phone: null })
	})
})

describe('callLookup', () => {
	it('looks phone calls up by the number that was called', () => {
		expect(
			callLookup({
				sip: { calledNumber: '+15550001111' },
				jobMetadata: undefined,
			}),
		).toEqual({ kind: 'number', calledNumber: '+15550001111' })
		expect(
			callLookup({ sip: { calledNumber: undefined }, jobMetadata: '{}' }),
		).toBeNull()
	})

	it('reads browser test calls from the dispatch metadata', () => {
		const jobMetadata = JSON.stringify({
			channel: 'web_test',
			orgId: 'org_1',
			scopeId: 'scope_1',
			flow: 'draft',
		})
		expect(callLookup({ sip: null, jobMetadata })).toEqual({
			kind: 'test',
			orgId: 'org_1',
			scopeId: 'scope_1',
			flow: 'draft',
		})
		expect(callLookup({ sip: null, jobMetadata: 'not json' })).toBeNull()
	})
})

describe('runFallbackCall', () => {
	function run(
		phone: string | null,
		result: TransferResult,
		agentLines: string[] = [],
	) {
		const session = new FakeSession()
		const dialer = { warm: true, transfer: vi.fn(async () => result) }
		const hangUp = vi.fn(async () => undefined)
		const leaveRoom = vi.fn(async () => undefined)
		const done = runFallbackCall({
			session,
			plan: {
				kind: 'fallback',
				reason: 'passthrough',
				language: 'en',
				voiceId: null,
				message: 'Please hold.',
				phone,
				agentLines,
			},
			dialer,
			hangUp,
			leaveRoom,
		})
		return { done, session, dialer, hangUp, leaveRoom }
	}

	it('hands the caller to staff who answer', async () => {
		const { done, session, hangUp, leaveRoom } = run('+15552345678', 'answered')
		await expect(done).resolves.toBe(true)
		expect(session.utterances[0]).toMatchObject({
			text: 'Please hold.',
			allowInterruptions: false,
		})
		expect(leaveRoom).toHaveBeenCalled()
		expect(hangUp).not.toHaveBeenCalled()
	})

	it('apologizes and hangs up when nobody answers', async () => {
		const { done, session, hangUp } = run('+15552345678', 'no_answer')
		await expect(done).resolves.toBe(false)
		expect(session.said).toEqual(['Please hold.', UNAVAILABLE])
		expect(hangUp).toHaveBeenCalled()
	})

	it('counts a cold transfer as handed off', async () => {
		const { done, hangUp, leaveRoom } = run('+15552345678', 'referred')
		await expect(done).resolves.toBe(true)
		expect(leaveRoom).not.toHaveBeenCalled()
		expect(hangUp).not.toHaveBeenCalled()
	})

	it('never dials a number that reaches the agent', async () => {
		const { done, dialer, hangUp } = run('+15552001111', 'answered', [
			'+15552001111',
		])
		await expect(done).resolves.toBe(false)
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(hangUp).toHaveBeenCalled()
	})

	it('hangs up without dialing when there is no phone', async () => {
		const { done, dialer, hangUp } = run(null, 'answered')
		await done
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(hangUp).toHaveBeenCalled()
	})

	it('never dials a number outside the US and Canada', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { done, dialer, hangUp } = run('+447700900123', 'answered')
		await expect(done).resolves.toBe(false)
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(hangUp).toHaveBeenCalled()
		vi.restoreAllMocks()
	})
})

describe('recoverFromOutage', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	function recover({
		phone = '+15552345678' as string | null,
		result = 'referred' as TransferResult,
		withDialer = true,
	} = {}) {
		const order: string[] = []
		const referDialer = {
			warm: false,
			transfer: vi.fn(async () => {
				order.push('refer')
				return result
			}),
		}
		const hangUp = vi.fn(async () => {
			order.push('hang_up')
		})
		const saveLog = vi.fn(async (handedOff: boolean) => {
			order.push(`save:${handedOff}`)
		})
		const done = recoverFromOutage({
			phone,
			agentLines: ['+15552001111'],
			referDialer: withDialer ? referDialer : null,
			hangUp,
			saveLog,
		})
		return { done, order, referDialer, hangUp, saveLog }
	}

	it('refers the caller to the business, then saves the log, keeping the room', async () => {
		const { done, order, referDialer, hangUp } = recover()
		await expect(done).resolves.toBe(true)
		expect(referDialer.transfer).toHaveBeenCalledWith('+15552345678')
		expect(order).toEqual(['refer', 'save:true'])
		expect(hangUp).not.toHaveBeenCalled()
	})

	it('hangs up when the REFER fails', async () => {
		const { done, order } = recover({ result: 'no_answer' })
		await expect(done).resolves.toBe(false)
		expect(order).toEqual(['refer', 'save:false', 'hang_up'])
	})

	it('hangs up without dialing when there is no safe fallback number', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		for (const phone of [null, '+15552001111', '+18765550123']) {
			const { done, referDialer, hangUp } = recover({ phone })
			await expect(done).resolves.toBe(false)
			expect(referDialer.transfer).not.toHaveBeenCalled()
			expect(hangUp).toHaveBeenCalledTimes(1)
		}
	})

	it('hangs up browser test calls, which have no phone line to refer', async () => {
		const { done, hangUp, saveLog } = recover({ withDialer: false })
		await expect(done).resolves.toBe(false)
		expect(hangUp).toHaveBeenCalledTimes(1)
		expect(saveLog).toHaveBeenCalledWith(false)
	})

	it('still hands off when saving the log fails', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
		const { done, saveLog } = recover()
		saveLog.mockRejectedValueOnce(new Error('tenant-api down'))
		await expect(done).resolves.toBe(true)
	})
})
