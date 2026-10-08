import { llm, voice } from '@livekit/agents'
import {
	type AgentLanguage,
	DEFAULT_PHONE_AGENT_SETTINGS,
	type FlowGraph,
	generalVertical,
	resolvePhrase,
} from '@repo/phone-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_WAIT_MS, MENU_WAIT_MS } from './controller.ts'
import { setupController } from './test-fixtures.ts'
import { buildAgentTools } from './tools.ts'
import { type TransferResult } from './transfer.ts'

const toolOptions = {
	ctx: {},
	toolCallId: 'call',
	abortSignal: new AbortController().signal,
} as unknown as llm.ToolOptions

/** The agent line in the test config; dialing it would loop. */
const AGENT_LINE = '+15552001111'

function graph(
	nodes: Array<[string, FlowGraph['nodes'][number]['type'], string?]>,
	edges: Array<[string, string, string?]>,
): FlowGraph {
	return {
		nodes: nodes.map(([id, type, message]) => ({
			id,
			type,
			position: { x: 0, y: 0 },
			data: { label: id, ...(message ? { message } : {}) },
		})),
		edges: edges.map(([source, target, handle]) => ({
			id: `${source}-${target}`,
			source,
			target,
			sourceHandle: handle ?? null,
		})),
	}
}

const RING = {
	ringSeconds: DEFAULT_PHONE_AGENT_SETTINGS.transfers.ringTimeoutSeconds,
}

const flush = () => vi.advanceTimersByTimeAsync(0)

const phrase = (
	key: Parameters<typeof resolvePhrase>[0],
	language: AgentLanguage = 'en',
) =>
	resolvePhrase(key, language, [], generalVertical.phraseDefaults).replace(
		'{business}',
		'Acme',
	)

/** start -> text the website link -> hang up. */
const textLinkGraph = graph(
	[
		['start', 'start'],
		['link', 'text_link'],
		['bye', 'hang_up', 'Bye.'],
	],
	[
		['start', 'link'],
		['link', 'bye'],
	],
)

/** start -> AI assistant, so tests can drive the model-backed agent. */
const aiGraph = graph(
	[
		['start', 'start'],
		['ai', 'ai_agent'],
	],
	[['start', 'ai']],
)

type AssistantAgent = voice.Agent & {
	llmNode: (...args: Parameters<voice.Agent['llmNode']>) => Promise<unknown>
}

function userMessage(text: string) {
	return llm.ChatMessage.create({ role: 'user', content: text })
}

describe('CallController', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('plays the non-interruptible notice before the menu and ignores input during it', async () => {
		const { controller, session, state } = setupController()
		session.holdPlayout = true
		controller.begin()
		await flush()
		expect(session.utterances).toHaveLength(1)
		const notice = session.utterances[0]!
		expect(notice.text).toBe(
			"You've reached Acme's automated phone assistant. This call may be recorded.",
		)
		expect(notice.allowInterruptions).toBe(false)

		controller.onKeypad('1')
		controller.onCallerSpeech('hours please')
		session.interrupt()
		await flush()
		expect(notice.done).toBe(false)
		expect(session.utterances).toHaveLength(1)

		session.holdPlayout = false
		notice.finish()
		await flush()
		expect(session.said[1]).toBe(
			'Press 1 for hours. Press 2 to talk to our team.',
		)
		expect(state.menuChoices).toEqual([])
		expect(state.transcript).toEqual([])
	})

	it('leaves out the recording sentence when recording is off', async () => {
		const { controller, session } = setupController({ recordCalls: false })
		controller.begin()
		await flush()
		expect(session.said[0]).toBe(
			"You've reached Acme's automated phone assistant.",
		)
	})

	it('follows the edge for the pressed key and hangs up at the end', async () => {
		const { controller, session, state, hangUp } = setupController()
		controller.begin()
		await flush()
		controller.onKeypad('1')
		await flush()
		expect(session.said.slice(2)).toEqual([
			'We are open every day.',
			'Goodbye.',
		])
		expect(state.menuChoices).toEqual(['Hear our hours'])
		expect(state.transcript[0]?.text).toBe('Pressed 1 (Hear our hours)')
		await vi.advanceTimersByTimeAsync(1_000)
		expect(hangUp).toHaveBeenCalledTimes(1)
	})

	it('picks an option from what the caller says', async () => {
		const { controller, state, dialer } = setupController()
		controller.begin()
		await flush()
		controller.onCallerSpeech('Can I talk to a person')
		await flush()
		expect(state.menuChoices).toEqual(['Speak with our team'])
		expect(dialer.transfer).toHaveBeenCalledWith('+15553334444', RING)
	})

	it('repeats the prompt when nothing is pressed, then takes the no-input edge', async () => {
		const { controller, session } = setupController()
		controller.begin()
		await flush()
		expect(session.said).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(MENU_WAIT_MS)
		expect(session.said[2]).toBe(
			'Press 1 for hours. Press 2 to talk to our team.',
		)
		await vi.advanceTimersByTimeAsync(MENU_WAIT_MS)
		expect(session.said[3]).toBe('We did not hear a choice.')
	})

	it('follows the no-answer edge when staff does not pick up', async () => {
		const { controller, session, state, dialer, leaveRoom } = setupController()
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(dialer.transfer).toHaveBeenCalledTimes(1)
		expect(session.said).toContain('Please hold for the team.')
		expect(session.said).toContain(phrase('transfer_no_answer'))
		expect(session.said.at(-1)).toBe('Leave a message.')
		expect(state.escalated).toBe(false)
		expect(state.transferResult).toBe('no_answer')
		expect(leaveRoom).not.toHaveBeenCalled()
	})

	it('offers a text before the transfer and sends it when nobody answers', async () => {
		const { controller, session, state, dialer, services } = setupController({
			offerText: true,
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(session.said.at(-1)).toBe(phrase('transfer_text_offer'))
		expect(dialer.transfer).not.toHaveBeenCalled()
		controller.onKeypad('1')
		await flush()
		expect(dialer.transfer).toHaveBeenCalledTimes(1)
		expect(services.createRequest).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'callback' }),
		)
		expect(services.sendWebsiteLink).toHaveBeenCalledTimes(1)
		expect(session.said).toContain(phrase('transfer_text_sent'))
		expect(session.said.at(-1)).toBe('Leave a message.')
		expect(state.textsSent).toBe(1)
		expect(state.link).toBeNull()
	})

	it('transfers without texting when the caller stays silent on the offer', async () => {
		const { controller, dialer, services } = setupController({
			offerText: true,
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS)
		expect(dialer.transfer).toHaveBeenCalledTimes(1)
		expect(services.sendWebsiteLink).not.toHaveBeenCalled()
	})

	it('rings a transfer case contact again for its retries before giving up', async () => {
		const { controller, dialer, state } = setupController({
			settings: {
				contacts: [{ id: 'sam', name: 'Sam', phone: '+15558889999' }],
				transferCases: [
					{
						id: 'billing',
						contactId: 'sam',
						when: 'Billing questions',
						hours: 'always',
						retries: 1,
						isActive: true,
					},
				],
			},
		})
		controller.begin()
		await flush()
		expect(controller.transferFromAssistant('billing')).toBe(true)
		await flush()
		expect(dialer.transfer).toHaveBeenCalledTimes(2)
		expect(dialer.transfer).toHaveBeenCalledWith('+15558889999', RING)
		expect(state.transferContactId).toBe('sam')
		expect(state.transferResult).toBe('no_answer')
		expect(controller.transferFromAssistant('unknown')).toBe(false)
	})

	it('transfers to staff when the caller presses 0 in a menu', async () => {
		const { controller, dialer } = setupController({
			settings: { escalationPhone: '+15556667777' },
		})
		controller.begin()
		await flush()
		controller.onKeypad('0')
		await flush()
		expect(dialer.transfer).toHaveBeenCalledWith('+15556667777', RING)
	})

	it('treats 0 as a wrong key when transfers are turned off', async () => {
		const { controller, session, dialer } = setupController({
			settings: {
				escalationPhone: '+15556667777',
				safety: { callingDisabled: false, transfersDisabled: true },
			},
		})
		controller.begin()
		await flush()
		controller.onKeypad('0')
		await flush()
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(session.said.at(-1)).toContain("that's not one of the options")
		expect(controller.transferFromAssistant(null)).toBe(false)
	})

	it('asks for a rating before the goodbye when ratings are on', async () => {
		const { controller, session, state, hangUp } = setupController({
			settings: { csatEnabled: true },
		})
		controller.begin()
		await flush()
		controller.onKeypad('1')
		await flush()
		expect(session.said.at(-1)).toBe(phrase('csat_question'))
		controller.onKeypad('2')
		await flush()
		expect(state.rating).toBe(2)
		expect(session.said.slice(-2)).toEqual([phrase('csat_low'), 'Goodbye.'])
		await vi.advanceTimersByTimeAsync(1_000)
		expect(hangUp).toHaveBeenCalledTimes(1)
	})

	it('says goodbye without a rating when the caller does not answer', async () => {
		const { controller, session, state } = setupController({
			settings: { csatEnabled: true },
		})
		controller.begin()
		await flush()
		controller.onKeypad('1')
		await flush()
		await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS)
		expect(state.rating).toBeNull()
		expect(session.said.at(-1)).toBe('Goodbye.')
	})

	it('uses the owner wording for fixed lines', async () => {
		const { controller, session } = setupController({
			settings: {
				phrases: [
					{ key: 'menu_retry', language: 'en', text: 'Come again?' },
					{ key: 'menu_invalid', language: 'en', text: 'No such key.' },
				],
			},
			configure: (config) => {
				config.flow.graph.nodes.find((n) => n.id === 'menu')!.data.repeat = 2
			},
		})
		controller.begin()
		await flush()
		controller.onCallerSpeech('banana')
		await flush()
		expect(session.said.at(-1)).toBe(
			'Come again? Press 1 for hours. Press 2 to talk to our team.',
		)
		controller.onKeypad('7')
		await flush()
		expect(session.said.at(-1)).toBe(
			'No such key. Press 1 for hours. Press 2 to talk to our team.',
		)
	})

	it('always plays the built-in legal notice, whatever the overrides say', async () => {
		const { controller, session } = setupController({
			settings: {
				phrases: [
					{ key: 'disclosure', language: 'en', text: 'Hi from a bot.' },
					{ key: 'recording_notice', language: 'en', text: 'No notice.' },
				],
			},
		})
		controller.begin()
		await flush()
		expect(session.said[0]).toBe(
			"You've reached Acme's automated phone assistant. This call may be recorded.",
		)
	})

	it('speaks fixed lines in the call language', async () => {
		const { controller, session } = setupController({
			settings: { languages: ['es'] },
		})
		controller.begin()
		await flush()
		controller.onKeypad('9')
		await flush()
		expect(session.said[0]).toBe(
			phrase('disclosure', 'es') + ' ' + phrase('recording_notice', 'es'),
		)
		expect(session.said.at(-1)).toContain(phrase('menu_invalid', 'es'))
		const line = controller.aiOpeningLine({
			id: 'ai',
			type: 'ai_agent',
			position: { x: 0, y: 0 },
			data: { label: 'AI' },
		})
		expect(line).toBe('Soy Assistant. ¿En qué le puedo ayudar hoy?')
	})

	it('introduces the AI assistant when the notice did not play', () => {
		const { controller } = setupController()
		const line = controller.aiOpeningLine({
			id: 'ai',
			type: 'ai_agent',
			position: { x: 0, y: 0 },
			data: { label: 'AI' },
		})
		expect(line).toBe(
			`Hi, you've reached {business}. I'm Assistant, an AI assistant. ${DEFAULT_PHONE_AGENT_SETTINGS.greeting}`,
		)
	})

	it('ends a call that reaches its time limit with the limit line and goodbye', async () => {
		const { controller, session } = setupController({
			settings: { maxCallMinutes: 1 },
			configure: (config) => {
				config.flow.graph = aiGraph
			},
		})
		controller.startCallLimit()
		controller.begin()
		await flush()
		await vi.advanceTimersByTimeAsync(60_000)
		expect(session.said.at(-1)).toBe(
			`${phrase('call_time_limit')} ${DEFAULT_PHONE_AGENT_SETTINGS.closing}`,
		)
	})

	it('prompts for and confirms a voicemail with the voicemail phrases', async () => {
		const { controller, session, services } = setupController({
			configure: (config) => {
				config.flow.graph = graph(
					[
						['start', 'start'],
						['vm', 'voicemail'],
						['bye', 'hang_up', 'Bye.'],
					],
					[
						['start', 'vm'],
						['vm', 'bye'],
					],
				)
			},
		})
		controller.begin()
		await flush()
		expect(session.said.at(-1)).toBe(phrase('voicemail_prompt'))
		controller.onCallerSpeech('Please call me back')
		controller.onKeypad('#')
		await flush()
		expect(services.createRequest).toHaveBeenCalledTimes(1)
		expect(session.said.slice(-2)).toEqual([phrase('voicemail_saved'), 'Bye.'])
	})

	it('says nothing was heard when the voicemail stays silent', async () => {
		const { controller, session } = setupController()
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		controller.onKeypad('#')
		await flush()
		expect(session.said).toContain(phrase('voicemail_empty'))
	})

	it('explains with the owner-editable line when the website link cannot be texted', async () => {
		const { controller, session, services } = setupController({
			settings: {
				phrases: [
					{ key: 'text_link_blocked', language: 'en', text: 'No texts.' },
				],
			},
			configure: (config) => {
				config.flow.graph = graph(
					[
						['start', 'start'],
						['link', 'text_link'],
						['bye', 'hang_up', 'Bye.'],
					],
					[
						['start', 'link'],
						['link', 'bye'],
					],
				)
			},
		})
		services.sendWebsiteLink.mockResolvedValueOnce({
			url: 'https://x.test',
			smsSent: false,
			smsBlockedReason: 'daily_limit',
		} as never)
		controller.begin()
		await flush()
		expect(session.said.slice(-2)).toEqual(['No texts.', 'Bye.'])
	})

	it('shows the website link on screen on test calls', async () => {
		const { controller, session, publishToRoom } = setupController({
			channel: 'web_test',
			configure: (config) => {
				config.flow.graph = textLinkGraph
			},
		})
		controller.begin()
		await flush()
		expect(publishToRoom).toHaveBeenCalledWith({
			type: 'link',
			url: 'https://x.test',
		})
		expect(session.said.at(-2)).toContain('link is on your screen')
	})

	it("texts the vertical's website link from a text link step", async () => {
		const { controller, session, services, state } = setupController({
			configure: (config) => {
				config.flow.graph = textLinkGraph
			},
		})
		controller.begin()
		await flush()
		expect(services.sendWebsiteLink).toHaveBeenCalledWith({
			orgId: 'org_1',
			callId: 'call_1',
			scopeId: null,
			path: '/',
			message: 'Acme: visit us online here: {url}',
			sendTo: '+15552223333',
		})
		expect(session.said.slice(-2)).toEqual([phrase('text_link_sent'), 'Bye.'])
		expect(state.link).toEqual({ url: 'https://x.test', smsSent: true })
		expect(state.textsSent).toBe(1)
	})

	it('records a cold transfer as handed off without claiming staff answered', async () => {
		const { controller, state, leaveRoom } = setupController({
			warm: false,
			transferResult: 'referred',
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(state.escalated).toBe(true)
		expect(state.transferResult).toBe('referred')
		expect(leaveRoom).not.toHaveBeenCalled()
	})

	it('never dials a number that reaches the agent', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { controller, session, dialer } = setupController({
			settings: { escalationPhone: AGENT_LINE },
			configure: (config) => {
				const staff = config.flow.graph.nodes.find((n) => n.id === 'staff')!
				staff.data.phone = AGENT_LINE
			},
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(dialer.transfer).not.toHaveBeenCalled()
		// The transfer step's no-answer edge leads to voicemail.
		expect(session.said.at(-1)).toBe('Leave a message.')
		expect(controller.transferFromAssistant()).toBe(false)
	})

	it('treats press 0 to an agent line as unavailable', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { controller, dialer } = setupController({
			settings: { escalationPhone: AGENT_LINE },
		})
		controller.begin()
		await flush()
		controller.onKeypad('0')
		await flush()
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(warn).toHaveBeenCalledWith(
			'Not transferring to a number that reaches the agent',
			expect.anything(),
		)
	})

	it('keeps the model quiet and its tools idle while a transfer rings', async () => {
		let answer!: (result: TransferResult) => void
		const { controller, session, hangUp } = setupController({
			settings: { escalationPhone: '+15556667777' },
			transfer: () =>
				new Promise<TransferResult>((resolve) => (answer = resolve)),
			configure: (config) => {
				config.flow.graph = aiGraph
			},
		})
		controller.begin()
		await flush()
		const agent = session.agents.at(-1) as AssistantAgent
		const tools = buildAgentTools(controller) as Record<
			string,
			ReturnType<typeof llm.tool>
		>
		expect(controller.transferFromAssistant()).toBe(true)
		await flush()
		expect(controller.transferInProgress).toBe(true)

		await expect(
			agent.onUserTurnCompleted(
				llm.ChatContext.empty(),
				userMessage('Never mind, bye'),
			),
		).rejects.toBeInstanceOf(voice.StopResponse)
		await expect(
			agent.llmNode(
				llm.ChatContext.empty(),
				{} as Parameters<voice.Agent['llmNode']>[1],
				{},
			),
		).resolves.toBeNull()
		await expect(
			tools.end_call!.execute({}, toolOptions),
		).resolves.toMatchObject({ error: expect.stringContaining('transfer') })
		await expect(
			tools.transfer_to_staff!.execute({ reason: 'again' }, toolOptions),
		).resolves.toMatchObject({ error: expect.stringContaining('transfer') })
		await vi.advanceTimersByTimeAsync(60_000)
		expect(hangUp).not.toHaveBeenCalled()

		answer('no_answer')
		await flush()
		expect(controller.transferInProgress).toBe(false)
		expect(session.said).toContain(phrase('transfer_no_answer'))
		expect(session.replies).toHaveLength(1)
		await expect(
			agent.onUserTurnCompleted(
				llm.ChatContext.empty(),
				userMessage('Okay, bye'),
			),
		).resolves.toBeUndefined()
	})

	it('connects the caller and leaves the room when staff answers', async () => {
		const { controller, session, state, leaveRoom, hangUp } = setupController({
			transferResult: 'answered',
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(session.said.at(-1)).toBe(phrase('transfer_connecting'))
		expect(state.transferResult).toBe('answered')
		expect(state.escalated).toBe(true)
		expect(leaveRoom).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(hangUp).not.toHaveBeenCalled()
	})

	it('simulates no answer on test calls without dialing', async () => {
		const { controller, session, state, dialer } = setupController({
			channel: 'web_test',
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(session.said.at(-1)).toBe('Leave a message.')
		expect(state.escalated).toBe(false)
	})

	it('stops every timer and stays silent after dispose', async () => {
		const { controller, session, hangUp } = setupController()
		controller.startCallLimit()
		controller.begin()
		await flush()
		const spoken = session.said.length
		controller.dispose()
		await vi.advanceTimersByTimeAsync(60 * 60_000)
		controller.onKeypad('1')
		controller.onCallerSpeech('hours')
		controller.endCall('Bye')
		await flush()
		expect(session.said).toHaveLength(spoken)
		expect(hangUp).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('runs dispose cleanups once', () => {
		const { controller } = setupController()
		const cleanup = vi.fn()
		controller.onDispose(cleanup)
		controller.dispose()
		controller.dispose()
		expect(cleanup).toHaveBeenCalledTimes(1)
	})

	it('survives a session that closed before its timers fired', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { controller, session } = setupController()
		controller.begin()
		await flush()
		session.running = false
		await expect(
			vi.advanceTimersByTimeAsync(MENU_WAIT_MS * 3),
		).resolves.not.toThrow()
	})

	it('keeps a voicemail for flushing after dispose', async () => {
		const { controller, services } = setupController()
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		controller.onCallerSpeech('Call me back about my bill')
		controller.dispose()
		await controller.flushVoicemail()
		expect(services.createRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'callback',
				details: { message: 'Call me back about my bill' },
			}),
		)
	})

	it('does not repeat the assistant disclosure after the notice', async () => {
		const { controller } = setupController()
		controller.begin()
		await flush()
		const line = controller.aiOpeningLine({
			id: 'ai',
			type: 'ai_agent',
			position: { x: 0, y: 0 },
			data: { label: 'AI' },
		})
		expect(line).toBe("I'm Assistant. How can I help you today?")
	})

	it('marks the required notice to be read without owner pronunciations', async () => {
		const { controller, session, verbatim } = setupController()
		controller.begin()
		await flush()
		expect(verbatim.has(session.said[0]!)).toBe(true)
		expect(verbatim.has(session.said[1]!)).toBe(false)
	})

	it('never rings a transfer step outside the US and Canada', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { controller, session, dialer } = setupController({
			configure: (config) => {
				const staff = config.flow.graph.nodes.find((n) => n.id === 'staff')!
				// Jamaica: a +1 number billed at international rates.
				staff.data.phone = '+18765550123'
			},
		})
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(dialer.transfer).not.toHaveBeenCalled()
		expect(session.said.at(-1)).toBe('Leave a message.')
		expect(warn).toHaveBeenCalledWith(
			'Not transferring to a number outside the US and Canada',
			{ callId: 'call_1', phone: '***0123' },
		)
	})

	it('refuses premium and foreign contacts and staff phones from the assistant', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { controller, dialer } = setupController({
			settings: {
				escalationPhone: '+19005550123',
				contacts: [{ id: 'sam', name: 'Sam', phone: '+447700900123' }],
				transferCases: [
					{
						id: 'billing',
						contactId: 'sam',
						when: 'Billing questions',
						hours: 'always',
						retries: 0,
						isActive: true,
					},
				],
			},
			configure: (config) => {
				config.flow.graph = aiGraph
			},
		})
		controller.begin()
		await flush()
		expect(controller.transferFromAssistant()).toBe(false)
		expect(controller.transferFromAssistant('billing')).toBe(false)
		controller.onKeypad('0')
		await flush()
		expect(dialer.transfer).not.toHaveBeenCalled()
	})

	it('stops the recording as soon as staff picks up a warm transfer', async () => {
		let answer!: (result: TransferResult) => void
		const { controller, session, stopRecording } = setupController({
			transfer: () =>
				new Promise<TransferResult>((resolve) => (answer = resolve)),
		})
		controller.begin()
		await flush()
		session.holdPlayout = true
		controller.onKeypad('2')
		await flush()
		expect(stopRecording).not.toHaveBeenCalled()
		answer('answered')
		await flush()
		// Even before the hold message finishes, since staff hears its tail.
		expect(stopRecording).toHaveBeenCalledTimes(1)
		expect(session.said.at(-1)).toBe('Please hold for the team.')
		session.holdPlayout = false
		session.utterances.at(-1)!.finish()
		await flush()
		expect(session.said.at(-1)).toBe(phrase('transfer_connecting'))
		expect(stopRecording).toHaveBeenCalledTimes(1)
	})

	it('keeps recording when nobody answers the transfer', async () => {
		const { controller, stopRecording } = setupController()
		controller.begin()
		await flush()
		controller.onKeypad('2')
		await flush()
		expect(stopRecording).not.toHaveBeenCalled()
	})

	it('switches only to configured languages and speaks fixed lines in the new one', async () => {
		const { controller, state, speech } = setupController({
			settings: { languages: ['en', 'es'], csatEnabled: false },
			configure: (config) => {
				config.flow.graph = aiGraph
			},
		})
		expect(controller.switchLanguage('ar')).toBe(false)
		expect(speech.setLanguage).not.toHaveBeenCalled()
		expect(controller.switchLanguage('es')).toBe(true)
		expect(speech.setLanguage).toHaveBeenCalledWith('es')
		expect(state.language).toBe('es')
		expect(controller.phrase('transfer_no_answer')).toBe(
			phrase('transfer_no_answer', 'es'),
		)
		expect(controller.switchLanguage('en')).toBe(true)
		expect(state.language).toBeNull()
	})

	it('says goodbye in the new language instead of the primary-language closing', async () => {
		const { controller, session } = setupController({
			settings: { languages: ['en', 'es'] },
			configure: (config) => {
				config.flow.graph = aiGraph
			},
		})
		controller.begin()
		await flush()
		controller.switchLanguage('es')
		controller.endCall()
		await flush()
		expect(session.said.at(-1)).toBe(phrase('goodbye', 'es'))
	})

	it('tells the model how to switch languages and never names the caller', () => {
		const { controller } = setupController({
			settings: { languages: ['en', 'ar'] },
		})
		const instructions = controller.aiInstructions()
		expect(instructions).toContain('call switch_language')
		expect(instructions).toContain('Arabic')
		expect(instructions).not.toContain('returning customer')
		expect(setupController().controller.aiInstructions()).not.toContain(
			'switch_language',
		)
	})
})
