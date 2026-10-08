import { type llm } from '@livekit/agents'
import {
	businessProfileFromSettings,
	DEFAULT_PHONE_AGENT_SETTINGS,
	type CallChannel,
	type FlowEdge,
	type FlowNode,
	generalVertical,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentSettings,
	type PhoneAgentVertical,
} from '@repo/phone-agent'
import { vi } from 'vitest'
import { CallState } from './call-state.ts'
import { CallController, type VoiceSession } from './controller.ts'
import { priceFormatter } from './job-metadata.ts'
import { type TextLinkResult } from './services.ts'
import { VerbatimSpeech } from './speech.ts'
import { buildAgentTools } from './tools.ts'
import { type TransferDialer, type TransferResult } from './transfer.ts'

function node(
	id: string,
	type: FlowNode['type'],
	data: Partial<FlowNode['data']> = {},
): FlowNode {
	return { id, type, position: { x: 0, y: 0 }, data: { label: id, ...data } }
}

function edge(
	source: string,
	target: string,
	sourceHandle: string | null = null,
): FlowEdge {
	return {
		id: `${source}-${sourceHandle ?? 'next'}-${target}`,
		source,
		target,
		sourceHandle,
	}
}

/**
 * The parts of a runtime config every vertical shares, for the "Acme"
 * organization. start -> menu. Key 1 plays the hours and hangs up; key 2
 * transfers to staff and falls back to voicemail; no input hangs up with its
 * own message.
 */
export function baseConfig(
	settings: PhoneAgentRuntimeConfig['settings'],
): Omit<
	PhoneAgentRuntimeConfig,
	'scopeId' | 'business' | 'availability' | 'vertical'
> {
	return {
		organization: {
			id: 'org_1',
			name: 'Acme',
			slug: 'acme',
			currency: 'USD',
		},
		settings,
		flow: {
			versionId: 'flow_1',
			graph: {
				nodes: [
					node('start', 'start'),
					node('menu', 'keypad_menu', {
						message: 'Press 1 for hours. Press 2 to talk to our team.',
						repeat: 1,
						options: [
							{ key: '1', label: 'Hear our hours' },
							{ key: '2', label: 'Speak with our team', keywords: ['person'] },
						],
					}),
					node('hours', 'play_message', { message: 'We are open every day.' }),
					node('staff', 'transfer', {
						phone: '+15553334444',
						message: 'Please hold for the team.',
					}),
					node('vm', 'voicemail', { message: 'Leave a message.' }),
					node('bye', 'hang_up', { message: 'Goodbye.' }),
					node('silent', 'hang_up', { message: 'We did not hear a choice.' }),
				],
				edges: [
					edge('start', 'menu'),
					edge('menu', 'hours', 'key_1'),
					edge('menu', 'staff', 'key_2'),
					edge('menu', 'silent', 'no_input'),
					edge('hours', 'bye'),
					edge('staff', 'vm', 'no_answer'),
					edge('vm', 'bye'),
				],
			},
		},
		rules: [],
		fallbackPhone: '+15552345678',
		callsUrl: 'https://app.example.test/acme/phone-agent/calls',
		agentLines: ['+15552001111'],
	}
}

/**
 * A config for the general vertical: no scope, open now, and hours and
 * contact details from `settings.business`.
 */
export function testConfig(
	overrides: Partial<PhoneAgentRuntimeConfig['settings']> = {},
): PhoneAgentRuntimeConfig {
	const settings = {
		...DEFAULT_PHONE_AGENT_SETTINGS,
		enabled: true,
		recordCalls: true,
		...overrides,
	}
	return {
		...baseConfig(settings),
		scopeId: null,
		business: businessProfileFromSettings('Acme', settings),
		availability: { isOpen: true, nextOpen: null },
		vertical: { id: generalVertical.id, data: null },
	}
}

type Utterance = {
	text: string
	allowInterruptions: boolean
	done: boolean
	finish: () => void
}

/** Records what the controller says; speech finishes at once unless held. */
export class FakeSession implements VoiceSession {
	utterances: Utterance[] = []
	agents: unknown[] = []
	replies: string[] = []
	holdPlayout = false
	running = true

	get said() {
		return this.utterances.map((utterance) => utterance.text)
	}

	say(text: string, options: { allowInterruptions?: boolean } = {}) {
		if (!this.running) throw new Error('AgentSession is not running')
		let resolve!: () => void
		const playout = new Promise<void>((done) => (resolve = done))
		const utterance: Utterance = {
			text,
			allowInterruptions: options.allowInterruptions ?? true,
			done: false,
			finish: () => {
				utterance.done = true
				resolve()
			},
		}
		this.utterances.push(utterance)
		if (!this.holdPlayout) utterance.finish()
		return { waitForPlayout: () => playout }
	}

	interrupt() {
		for (const utterance of this.utterances) {
			if (utterance.allowInterruptions && !utterance.done) utterance.finish()
		}
	}

	updateAgent(agent: unknown) {
		this.agents.push(agent)
	}

	generateReply(options: { instructions: string }) {
		this.replies.push(options.instructions)
	}
}

type ConfigFactory = (
	overrides?: Partial<PhoneAgentSettings>,
) => PhoneAgentRuntimeConfig

/**
 * A controller attached to a `FakeSession`, with fake services, dialer, and
 * room. Defaults to the general vertical and `testConfig`, whatever vertical
 * this deployment runs.
 */
export function setupController({
	channel = 'phone',
	transferResult = 'no_answer',
	warm = true,
	recordCalls = true,
	offerText = false,
	settings = {},
	transfer,
	configure,
	vertical = generalVertical,
	config: makeConfig = testConfig,
}: {
	vertical?: PhoneAgentVertical
	config?: ConfigFactory
	channel?: CallChannel
	transferResult?: TransferResult
	warm?: boolean
	recordCalls?: boolean
	offerText?: boolean
	settings?: Partial<PhoneAgentSettings>
	transfer?: TransferDialer['transfer']
	configure?: (config: PhoneAgentRuntimeConfig) => void
} = {}) {
	const session = new FakeSession()
	const state = new CallState()
	const dialer = {
		warm,
		transfer: vi.fn<TransferDialer['transfer']>(
			transfer ?? (async () => transferResult),
		),
	}
	const services = {
		createRequest: vi.fn(async () => ({ requestId: 'req_1' })),
		sendWebsiteLink: vi.fn(async () => ({
			url: 'https://x.test',
			smsSent: true,
		})),
		createHandoff: vi.fn(async () => ({
			url: 'https://x.test/o',
			smsSent: true,
			handoffId: 'h1',
			expiresAt: '',
		})),
	}
	const hangUp = vi.fn(async () => undefined)
	const leaveRoom = vi.fn(async () => undefined)
	const stopRecording = vi.fn(async () => undefined)
	const verbatim = new VerbatimSpeech()
	const speech = { setLanguage: vi.fn() }
	const config = makeConfig({
		recordCalls,
		...settings,
		transfers: {
			...DEFAULT_PHONE_AGENT_SETTINGS.transfers,
			offerTextWhenNoAnswer: offerText,
			...settings.transfers,
		},
	})
	configure?.(config)
	const publishToRoom = vi.fn(async () => undefined)
	const controller = new CallController({
		config,
		vertical,
		state,
		callId: 'call_1',
		channel,
		callerPhone: '+15552223333',
		formatPrice: priceFormatter('USD'),
		services,
		dialer: channel === 'phone' ? dialer : null,
		hangUp,
		leaveRoom,
		publishToRoom,
		stopRecording,
		verbatim,
		speech,
	})
	controller.attach(session)
	return {
		controller,
		session,
		state,
		dialer,
		services,
		hangUp,
		leaveRoom,
		stopRecording,
		verbatim,
		speech,
		publishToRoom,
	}
}

const toolOptions = {
	ctx: {},
	toolCallId: 'call',
	abortSignal: new AbortController().signal,
} as unknown as llm.ToolOptions

type Tools = Record<
	string,
	{ execute: (input: unknown, options: llm.ToolOptions) => Promise<unknown> }
>

/**
 * The assistant's tools for a call without a session, with fake services.
 * Defaults to the general vertical and `testConfig`.
 */
export function setupTools({
	settings = {},
	speech,
	handoff = { url: 'https://x.test/o', smsSent: true },
	channel = 'phone',
	vertical = generalVertical,
	config = testConfig(settings),
}: {
	settings?: Partial<PhoneAgentSettings>
	speech?: { setLanguage: (language: string) => void }
	handoff?: TextLinkResult
	channel?: 'phone' | 'web_test'
	config?: PhoneAgentRuntimeConfig
	vertical?: PhoneAgentVertical
} = {}) {
	const state = new CallState()
	const services = {
		createHandoff: vi.fn(async () => ({
			...handoff,
			handoffId: 'h1',
			expiresAt: '',
		})),
		createRequest: vi.fn(async () => ({ requestId: 'r1' })),
		sendWebsiteLink: vi.fn(async () => handoff),
	}
	const publishToRoom = vi.fn(async () => undefined)
	const controller = new CallController({
		config,
		vertical,
		state,
		callId: 'call_1',
		channel,
		callerPhone: channel === 'phone' ? '+15552223333' : null,
		formatPrice: priceFormatter('USD'),
		services,
		dialer: null,
		hangUp: async () => undefined,
		leaveRoom: async () => undefined,
		publishToRoom,
		speech,
	})
	const tools = buildAgentTools(controller) as Tools
	const run = (name: string, input: unknown = {}) =>
		tools[name]!.execute(input, toolOptions)
	return { state, tools, run, controller, services, publishToRoom }
}
