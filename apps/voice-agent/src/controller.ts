import { type llm, voice } from '@livekit/agents'
import {
	type AgentLanguage,
	buildAgentInstructions,
	type CallChannel,
	createVerticalContext,
	describeBusiness,
	fillMessage,
	findStartNode,
	type FlowNode,
	isE164,
	LANGUAGE_NAMES,
	LinkHandoffSchema,
	linkMessageFor,
	LOW_RATING_MAX,
	matchMenuChoice,
	MAX_MENU_REPEATS,
	menuKeyHandle,
	type MenuKey,
	type MenuOption,
	messageVariablesFor,
	nextNode,
	parseMenuKey,
	type PhoneAgentRuntimeConfig,
	type PhoneAgentVertical,
	type PhraseKey,
	type PriceFormatter,
	promptContextFor,
	type ResolvedTransfer,
	resolveTransfer,
	type SendLinkInput,
	type SendLinkResult,
	transferAvailability,
	type VerticalContext,
	type VerticalTool,
	type VerticalToolContext,
	websitePathFor,
} from '@repo/phone-agent'
import { type CallState } from './call-state.ts'
import { dialRefusal, normalizeUsPhone, phoneTail } from './job-metadata.ts'
import { type SpeechLanguageControl } from './language.ts'
import {
	agentLanguage,
	callLine,
	callPhrase,
	complianceNotice,
} from './messages.ts'
import {
	LINK_MESSAGE_MAX_CHARS,
	smsBlockedExplanation,
	type TextLinkResult,
	type VoiceServices,
} from './services.ts'
import { type VerbatimSpeech } from './speech.ts'
import { buildAgentTools, TRANSFER_IN_PROGRESS } from './tools.ts'
import { type TransferDialer } from './transfer.ts'
import { phoneAgentVertical } from './vertical.ts'

/**
 * The data message the browser test page shows a texted link from. App's
 * test call panel listens for this type.
 */
export const LINK_DATA_MESSAGE_TYPE = 'link'

/** The parts of `voice.AgentSession` the controller drives. */
export type VoiceSession = {
	say(
		text: string,
		options?: { allowInterruptions?: boolean },
	): { waitForPlayout(): Promise<void> }
	interrupt(): unknown
	updateAgent(agent: voice.Agent): void
	generateReply(options: { instructions: string }): unknown
}

export type CallControllerOptions = {
	config: PhoneAgentRuntimeConfig
	/** The business type; must be the one the config was built for. */
	vertical?: PhoneAgentVertical
	state: CallState
	callId: string
	channel: CallChannel
	callerPhone: string | null
	formatPrice: PriceFormatter
	services: Pick<
		VoiceServices,
		'createRequest' | 'sendWebsiteLink' | 'createHandoff'
	>
	/** Null when there is no SIP leg; test calls only simulate transfers. */
	dialer: TransferDialer | null
	/** Ends the call for everyone. */
	hangUp: () => Promise<void>
	/** Disconnects only the agent, leaving the caller with staff. */
	leaveRoom: () => Promise<void>
	publishToRoom: (message: Record<string, unknown>) => Promise<void>
	/**
	 * Stops the call recording. Called the moment staff picks up a warm
	 * transfer: staff never heard the recording notice.
	 */
	stopRecording?: () => Promise<void>
	/** Lines registered here reach the voice without owner pronunciations. */
	verbatim?: Pick<VerbatimSpeech, 'add'>
	/** Moves speech recognition and the voice to another language. */
	speech?: SpeechLanguageControl
}

/** Pause after the last words so the caller hears them before the line drops. */
const HANG_UP_GRACE_MS = 600
/** How long a menu waits for a key or a spoken choice after its prompt. */
export const MENU_WAIT_MS = 6_000
const DEFAULT_MENU_REPEATS = 2
/** Voicemail ends after this much silence once the caller has spoken... */
const VOICEMAIL_SILENCE_MS = 4_000
/** ...or after this long if they never start. */
const VOICEMAIL_START_MS = 10_000
const VOICEMAIL_MAX_MS = 120_000
/** Guards against flows that bounce between steps without end. */
const MAX_STEPS_PER_CALL = 60
/** How long the rating question and the text offer wait for an answer. */
export const ANSWER_WAIT_MS = 8_000

type Timer = ReturnType<typeof setTimeout>

type MenuState = {
	node: FlowNode
	misses: number
	token: number
	timer: Timer | null
}

type VoicemailState = {
	node: FlowNode
	parts: string[]
	listening: boolean
	timer: Timer | null
	maxTimer: Timer | null
}

type TransferOutcome = 'connected' | 'unavailable' | 'ended'

type TransferTarget = Pick<ResolvedTransfer, 'phone' | 'retries'> & {
	contactId: string | null
}

type AnswerInput = { key: MenuKey } | { text: string }

/** A question the next key press or utterance answers, instead of the menu or the model. */
type PendingAnswer = {
	/** False when the input doesn't answer the question; it is still consumed. */
	take: (input: AnswerInput) => boolean
	cancel: () => void
}

const RATING_OPTIONS: MenuOption[] = ['1', '2', '3', '4', '5'].map((key) => ({
	key: key as MenuKey,
	label: key,
}))

function parseRating(input: AnswerInput) {
	const key =
		'key' in input ? input.key : matchMenuChoice(RATING_OPTIONS, input.text)
	const rating = key ? Number(key) : NaN
	return rating >= 1 && rating <= 5 ? rating : null
}

const YES =
	/^(yes|yeah|yep|yup|sure|ok|okay|please|of course|s[ií]|claro|vale|por favor|نعم|ايوه|أيوه|اي|أي|ايه|طيب|تمام|اكيد|أكيد)(?![\p{L}\p{N}])/iu

/** Key 1 or a spoken yes; anything else counts as no. */
function parseYes(input: AnswerInput) {
	if ('key' in input) return input.key === '1'
	return YES.test(input.text.trim().replace(/^[^\p{L}\p{N}]+/u, ''))
}

/**
 * Runs the published phone menu. Menu steps play prompts with text-to-speech
 * and wait for a keypad press or a spoken choice; none of them use the
 * language model. The AI assistant step swaps in an LLM-backed agent that
 * handles the rest of the call on its own.
 */
export class CallController {
	readonly config: PhoneAgentRuntimeConfig
	readonly vertical: PhoneAgentVertical
	readonly state: CallState
	readonly callId: string
	readonly channel: CallChannel
	readonly callerPhone: string | null
	readonly formatPrice: PriceFormatter
	readonly services: CallControllerOptions['services']
	readonly publishToRoom: CallControllerOptions['publishToRoom']
	private readonly dialer: TransferDialer | null
	private readonly hangUpRoom: () => Promise<void>
	private readonly leaveRoom: () => Promise<void>
	private readonly stopRecording: (() => Promise<void>) | null
	private readonly verbatim: Pick<VerbatimSpeech, 'add'> | null
	private readonly speech: SpeechLanguageControl | null
	private readonly context: VerticalContext
	private callLanguage: AgentLanguage
	private session: VoiceSession | null = null
	private started = false
	private ending = false
	private disposed = false
	private inPreamble = false
	private preamblePlayed = false
	private hasSpoken = false
	private transferring = false
	private aiActive = false
	private stepCount = 0
	private menuToken = 0
	private menu: MenuState | null = null
	private voicemail: VoicemailState | null = null
	private answer: PendingAnswer | null = null
	private readonly timers = new Set<Timer>()
	private readonly cleanups: Array<() => void> = []
	/** The menu option that led to the current step, for the AI's context. */
	private menuChoice: string | null = null

	constructor(options: CallControllerOptions) {
		this.config = options.config
		this.vertical = options.vertical ?? phoneAgentVertical
		this.state = options.state
		this.callId = options.callId
		this.channel = options.channel
		this.callerPhone = options.callerPhone
		this.formatPrice = options.formatPrice
		this.services = options.services
		this.dialer = options.dialer
		this.hangUpRoom = options.hangUp
		this.leaveRoom = options.leaveRoom
		this.publishToRoom = options.publishToRoom
		this.stopRecording = options.stopRecording ?? null
		this.verbatim = options.verbatim ?? null
		this.speech = options.speech ?? null
		this.callLanguage = agentLanguage(this.config.settings.languages[0])
		this.context = createVerticalContext(this.vertical, this.config, {
			language: this.callLanguage,
			formatPrice: this.formatPrice,
		})
		if (this.state.vertical === undefined) {
			this.state.vertical = this.vertical.createCallState?.()
		}
	}

	attach(session: VoiceSession) {
		this.session = session
	}

	/** Registers teardown, such as removing an event listener, for dispose(). */
	onDispose(cleanup: () => void) {
		if (this.disposed) cleanup()
		else this.cleanups.push(cleanup)
	}

	get settings() {
		return this.config.settings
	}

	get graph() {
		return this.config.flow.graph
	}

	/** Open or closed at call start, recomputed when the call came in. */
	get isOpen() {
		return this.config.availability.isOpen
	}

	get businessName() {
		return this.config.business.name
	}

	/** Whether the AI assistant has a general staff transfer configured. */
	get escalationEnabled() {
		return Boolean(this.settings.autoEscalate && this.settings.escalationPhone)
	}

	/** Transfers allowed right now, with the safety switch and transfer hours applied. */
	get transfers() {
		return transferAvailability(this.settings, this.isOpen)
	}

	get isEnding() {
		return this.ending
	}

	/** True from the start of a transfer until it connects or fails. */
	get transferInProgress() {
		return this.transferring
	}

	/** The language the call is in now; the agent's primary one until switched. */
	get language() {
		return this.callLanguage
	}

	private get primaryLanguage() {
		return agentLanguage(this.settings.languages[0])
	}

	/**
	 * Moves the rest of the call to another of the agent's languages: speech
	 * recognition, the voice, and fixed lines. False for a language the agent
	 * isn't set up for.
	 */
	switchLanguage(language: string) {
		const next = this.settings.languages.find((entry) => entry === language)
		if (!next) return false
		if (next === this.callLanguage) return true
		try {
			this.speech?.setLanguage(next)
		} catch (error) {
			console.error('Could not switch the call language', error)
			return false
		}
		this.callLanguage = next
		this.state.language = next === this.primaryLanguage ? null : next
		return true
	}

	/** What the vertical's hooks see, as of `now` and in the call's language. */
	verticalContext(now = new Date()): VerticalContext {
		return { ...this.context, now, language: this.language }
	}

	/** Context for the vertical's tools, with the per-call state they share. */
	toolContext(): VerticalToolContext {
		return {
			...this.verticalContext(),
			state: this.state.vertical,
			channel: this.channel,
			callerPhone: this.callerPhone,
			services: { sendLink: (input) => this.sendLink(input) },
		}
	}

	verticalTools(): VerticalTool[] {
		return this.vertical.tools?.(this.verticalContext()) ?? []
	}

	/** Hours, address, and the vertical's details, for get_business_info. */
	businessSummary(now = new Date()) {
		const context = this.verticalContext(now)
		return (
			this.vertical.businessDetails?.(context) ??
			describeBusiness(this.config.business, now)
		)
	}

	private messageVariables() {
		return messageVariablesFor(this.vertical, this.verticalContext())
	}

	private fill(text: string) {
		return fillMessage(text, this.messageVariables())
	}

	/** A fixed line in the call's current language, with the owner's wording if set. */
	phrase(key: PhraseKey) {
		return callPhrase(key, {
			language: this.language,
			business: this.businessName,
			variables: this.messageVariables(),
			overrides: this.settings.phrases,
			verticalDefaults: this.vertical.phraseDefaults,
		})
	}

	/**
	 * The owner's goodbye override wins; otherwise their closing line, which
	 * is written in the primary language, so another language gets the
	 * built-in goodbye.
	 */
	private closingLine() {
		const language = this.language
		const custom = this.settings.phrases.some(
			(entry) => entry.key === 'goodbye' && entry.language === language,
		)
		return custom || language !== this.primaryLanguage
			? this.phrase('goodbye')
			: this.settings.closing
	}

	// ---- Timers and teardown ----

	/** Timers are dropped on dispose(), so none can fire into a closed session. */
	private setTimer(callback: () => unknown, ms: number) {
		const timer = setTimeout(() => {
			this.timers.delete(timer)
			if (this.disposed) return
			try {
				const result = callback()
				if (result instanceof Promise) {
					result.catch((error: unknown) =>
						console.error('Call timer failed', error),
					)
				}
			} catch (error) {
				console.error('Call timer failed', error)
			}
		}, ms)
		this.timers.add(timer)
		return timer
	}

	private clearTimer(timer: Timer | null) {
		if (!timer) return
		clearTimeout(timer)
		this.timers.delete(timer)
	}

	/** Ends the call after the business's maximum call length. */
	startCallLimit() {
		this.setTimer(
			() =>
				this.endCall(`${this.phrase('call_time_limit')} ${this.closingLine()}`),
			this.settings.maxCallMinutes * 60_000,
		)
	}

	/**
	 * Called when the session closes or the job shuts down. Stops every timer
	 * and listener; a voicemail in progress is kept for flushVoicemail().
	 */
	dispose() {
		if (this.disposed) return
		this.disposed = true
		this.ending = true
		for (const timer of this.timers) clearTimeout(timer)
		this.timers.clear()
		this.answer?.cancel()
		this.menu = null
		if (this.voicemail) {
			this.voicemail.listening = false
			this.voicemail.timer = null
			this.voicemail.maxTimer = null
		}
		this.session = null
		for (const cleanup of this.cleanups.splice(0)) {
			try {
				cleanup()
			} catch (error) {
				console.error('Call cleanup failed', error)
			}
		}
	}

	// ---- Speech ----

	/**
	 * Resolves once the words have played (or were interrupted), and never
	 * rejects. Speaks nothing once the call is ending, except the final words.
	 */
	private async speak(
		text: string,
		options: {
			interruptible?: boolean
			final?: boolean
			/** Read exactly as written, without owner pronunciations. */
			verbatim?: boolean
		} = {},
	) {
		const session = this.session
		const words = this.fill(text).trim()
		if (!session || !words || this.disposed) return false
		if (this.ending && !options.final) return false
		if (options.verbatim) this.verbatim?.add(words)
		let handle: ReturnType<VoiceSession['say']>
		try {
			handle = session.say(words, {
				allowInterruptions: options.interruptible ?? false,
			})
		} catch (error) {
			console.warn('Could not speak; the session may be closing', error)
			return false
		}
		this.hasSpoken = true
		await handle.waitForPlayout().catch(() => undefined)
		return true
	}

	private interruptSpeech() {
		try {
			this.session?.interrupt()
		} catch {
			// The session may already be closing, or the speech can't be interrupted.
		}
	}

	/**
	 * The automated-assistant and recording notice. It cannot be interrupted,
	 * and keys or speech during it are ignored.
	 */
	private async playPreamble() {
		this.inPreamble = true
		try {
			this.preamblePlayed = await this.speak(
				complianceNotice({
					business: this.businessName,
					variables: this.messageVariables(),
					language: this.language,
					overrides: this.settings.phrases,
					verticalDefaults: this.vertical.phraseDefaults,
					recording: this.settings.recordCalls,
				}),
				{ verbatim: true },
			)
		} finally {
			this.inPreamble = false
			this.hasSpoken = false
		}
	}

	// ---- Agents ----

	/** The agent the session starts with. It never calls the model. */
	createMenuAgent(): voice.Agent {
		const begin = () => this.begin()
		const onSpeech = (text: string) => this.onCallerSpeech(text)
		class PhoneMenuAgent extends voice.Agent {
			async onEnter() {
				begin()
			}
			async onUserTurnCompleted(
				ignoredChatCtx: llm.ChatContext,
				message: llm.ChatMessage,
			) {
				onSpeech(message.textContent ?? '')
				throw new voice.StopResponse()
			}
		}
		return new PhoneMenuAgent({
			id: 'phone_menu',
			instructions: 'Phone menu',
			llm: null,
		})
	}

	aiInstructions() {
		const base = buildAgentInstructions(
			promptContextFor(this.vertical, this.verticalContext(), {
				...this.transfers,
				menuChoice: this.menuChoice,
			}),
		)
		const others = this.settings.languages.filter(
			(language) => language !== this.primaryLanguage,
		)
		const extras = [
			others.length
				? `Speech recognition and your voice follow one language at a time. As soon as the caller speaks or asks for ${others.map((language) => LANGUAGE_NAMES[language]).join(' or ')}, call switch_language first, then reply in that language. If what the caller says makes no sense, they may be speaking another language: briefly ask, in each of your languages, which one they prefer.`
				: '',
			this.channel === 'web_test'
				? "This is a test call from the business's team in a browser. Behave exactly as you would with a real caller."
				: '',
			'Before ending the call, call set_call_purpose once with the main reason for the call.',
		]
		return [base, ...extras].filter(Boolean).join('\n\n')
	}

	/** The preamble already told the caller this is an automated assistant. */
	aiOpeningLine(node: FlowNode) {
		const agent = this.settings.agentName
		return [
			callLine(this.preamblePlayed ? 'ai_name' : 'ai_intro', this.language, {
				agent,
			}),
			node.data.message ||
				(this.hasSpoken
					? callLine('ai_help', this.language)
					: this.settings.greeting),
		].join(' ')
	}

	private startAiAssistant(node: FlowNode) {
		const session = this.session
		if (!session) return
		const opening = this.aiOpeningLine(node)
		const speakOpening = () => this.speak(opening, { interruptible: true })
		const takeAnswer = (text: string) => this.takeSpokenAnswer(text)
		const muted = () => this.transferring
		class AiAssistantAgent extends voice.Agent {
			async onEnter() {
				void speakOpening()
			}
			// A fixed question (the rating or the text offer) may be waiting for
			// this reply, so the model must not answer it too. While a transfer
			// rings the model stays silent, or it could talk over the hold
			// message or end the call just as staff picks up.
			async onUserTurnCompleted(
				ignoredChatCtx: llm.ChatContext,
				message: llm.ChatMessage,
			) {
				if (takeAnswer(message.textContent ?? '') || muted()) {
					throw new voice.StopResponse()
				}
			}
			// Also catches replies that don't follow a user turn, such as the
			// model's answer to a tool result.
			async llmNode(...args: Parameters<voice.Agent['llmNode']>) {
				if (muted()) return null
				return super.llmNode(...args)
			}
		}
		this.state.aiUsed = true
		this.aiActive = true
		session.updateAgent(
			new AiAssistantAgent({
				id: 'ai_assistant',
				instructions: this.aiInstructions(),
				tools: buildAgentTools(this),
			}),
		)
	}

	// ---- Flow ----

	begin() {
		if (this.started) return
		this.started = true
		void this.run().catch((error: unknown) => this.fail(error))
	}

	private async run() {
		await this.playPreamble()
		let startId: string
		try {
			startId = findStartNode(this.graph).id
		} catch (error) {
			console.error('Call flow has no start step', error)
			this.state.failed = true
			this.endCall()
			return
		}
		this.go(startId)
	}

	private fail(error: unknown) {
		console.error('Phone menu failed', error)
		this.state.failed = true
		this.endCall()
	}

	private go(nodeId: string | null) {
		void this.enter(nodeId).catch((error: unknown) => this.fail(error))
	}

	private async enter(nodeId: string | null): Promise<void> {
		if (this.ending) return
		const node = nodeId
			? this.graph.nodes.find((candidate) => candidate.id === nodeId)
			: null
		if (!node) {
			this.endCall()
			return
		}
		if (++this.stepCount > MAX_STEPS_PER_CALL) {
			console.error('Call flow exceeded the step limit; ending the call')
			this.endCall()
			return
		}
		this.state.visitedSteps.add(node.type)
		const next = (handle: string | null = null) =>
			nextNode(this.graph, node.id, handle)?.id ?? null

		switch (node.type) {
			case 'start':
				return this.enter(next())
			case 'play_message':
				await this.speak(node.data.message ?? '')
				return this.enter(next())
			case 'hours_check':
				return this.enter(next(this.isOpen ? 'open' : 'closed'))
			case 'keypad_menu':
				this.openMenu(node, 0)
				return
			case 'text_link':
				await this.textLink(node)
				return this.enter(next())
			case 'transfer': {
				const phone = isE164(node.data.phone)
					? node.data.phone
					: (this.settings.escalationPhone ?? null)
				const outcome = await this.transfer(
					phone && !this.settings.safety.transfersDisabled
						? { phone, retries: 0, contactId: null }
						: null,
					node.data.message || this.phrase('hold'),
				)
				if (outcome === 'unavailable') return this.enter(next('no_answer'))
				return
			}
			case 'voicemail':
				this.startVoicemail(node)
				return
			case 'ai_agent':
				this.startAiAssistant(node)
				return
			case 'hang_up':
				this.endCall(node.data.message, { survey: true })
				return
		}
	}

	// ---- Keypad menus ----

	private openMenu(node: FlowNode, misses: number, preface = '') {
		const token = ++this.menuToken
		const menu: MenuState = { node, misses, token, timer: null }
		this.menu = menu
		const prompt = [preface, node.data.message ?? ''].filter(Boolean).join(' ')
		void this.speak(prompt, { interruptible: true }).then(() => {
			if (this.menu?.token === token) this.armMenuTimer()
		})
	}

	private armMenuTimer() {
		const menu = this.menu
		if (!menu) return
		this.clearTimer(menu.timer)
		menu.timer = this.setTimer(() => this.retryMenu(''), MENU_WAIT_MS)
	}

	private leaveMenu() {
		this.clearTimer(this.menu?.timer ?? null)
		this.menu = null
	}

	/** Replays the prompt, or takes the "no input" path once repeats run out. */
	private retryMenu(apology: string) {
		const menu = this.menu
		if (!menu) return
		const repeats = Math.min(
			menu.node.data.repeat ?? DEFAULT_MENU_REPEATS,
			MAX_MENU_REPEATS,
		)
		this.leaveMenu()
		if (menu.misses < repeats) {
			this.openMenu(menu.node, menu.misses + 1, apology)
			return
		}
		const target = nextNode(this.graph, menu.node.id, 'no_input')
		if (target) {
			this.go(target.id)
		} else {
			this.endCall()
		}
	}

	private choose(key: MenuKey) {
		const menu = this.menu
		if (!menu) return
		const option = menu.node.data.options?.find((entry) => entry.key === key)
		this.interruptSpeech()
		if (!option) {
			const staff = key === '0' ? this.pressZeroTarget() : null
			if (staff) {
				this.leaveMenu()
				this.startTransfer(staff)
				return
			}
			this.retryMenu(this.phrase('menu_invalid'))
			return
		}
		this.leaveMenu()
		this.menuChoice = option.label
		this.state.menuChoices.push(option.label)
		const target = nextNode(this.graph, menu.node.id, menuKeyHandle(key))
		if (target) {
			this.go(target.id)
		} else {
			this.endCall()
		}
	}

	/** DTMF from the phone line, or from the dial pad on browser test calls. */
	onKeypad(digit: string) {
		const key = parseMenuKey(digit)
		if (!key || this.inPreamble || this.disposed) return
		if (this.answer) {
			this.state.addTurn('caller', `Pressed ${key}`)
			this.answer.take({ key })
			return
		}
		if (this.ending) return
		if (this.voicemail) {
			if (key === '#') void this.finishVoicemail()
			return
		}
		if (this.aiActive) {
			if (key !== '0' || this.transferring) return
			this.state.addTurn('caller', 'Pressed 0')
			this.interruptSpeech()
			const staff = this.pressZeroTarget()
			if (staff) this.startTransfer(staff)
			else void this.speak(this.phrase('transfer_unavailable'))
			return
		}
		const menu = this.menu
		if (!menu) return
		const option = menu.node.data.options?.find((entry) => entry.key === key)
		this.state.addTurn(
			'caller',
			option ? `Pressed ${key} (${option.label})` : `Pressed ${key}`,
		)
		this.choose(key)
	}

	/** Caller speech while the phone menu agent is active. */
	onCallerSpeech(text: string) {
		const spoken = text.trim()
		if (!spoken || this.inPreamble) return
		if (this.takeSpokenAnswer(spoken)) {
			this.state.addTurn('caller', spoken)
			return
		}
		if (this.ending) return
		this.state.addTurn('caller', spoken)
		const voicemail = this.voicemail
		if (voicemail) {
			voicemail.parts.push(spoken)
			if (voicemail.listening) this.armVoicemailTimer(VOICEMAIL_SILENCE_MS)
			return
		}
		const menu = this.menu
		if (!menu) return
		const key = matchMenuChoice(menu.node.data.options ?? [], spoken)
		if (key) {
			this.choose(key)
		} else {
			this.interruptSpeech()
			this.retryMenu(this.phrase('menu_retry'))
		}
	}

	/** Keeps menus and voicemail from timing out while the caller is talking. */
	onCallerStartedSpeaking() {
		if (this.menu?.timer) {
			this.clearTimer(this.menu.timer)
			this.menu.timer = null
		}
		if (this.voicemail?.timer) {
			this.clearTimer(this.voicemail.timer)
			this.voicemail.timer = null
		}
	}

	/** Restarts the menu wait if the caller made a sound but said nothing usable. */
	onCallerStoppedSpeaking() {
		if (this.ending) return
		if (this.menu && !this.menu.timer) this.armMenuTimer()
		if (this.voicemail?.listening && !this.voicemail.timer) {
			this.armVoicemailTimer(
				this.voicemail.parts.length ? VOICEMAIL_SILENCE_MS : VOICEMAIL_START_MS,
			)
		}
	}

	// ---- Voicemail ----

	private startVoicemail(node: FlowNode) {
		const voicemail: VoicemailState = {
			node,
			parts: [],
			listening: false,
			timer: null,
			maxTimer: null,
		}
		this.voicemail = voicemail
		void this.speak(node.data.message || this.phrase('voicemail_prompt')).then(
			() => {
				if (this.voicemail !== voicemail || this.ending) return
				voicemail.listening = true
				voicemail.maxTimer = this.setTimer(
					() => this.finishVoicemail(),
					VOICEMAIL_MAX_MS,
				)
				this.armVoicemailTimer(
					voicemail.parts.length ? VOICEMAIL_SILENCE_MS : VOICEMAIL_START_MS,
				)
			},
		)
	}

	private armVoicemailTimer(ms: number) {
		const voicemail = this.voicemail
		if (!voicemail || this.ending) return
		this.clearTimer(voicemail.timer)
		voicemail.timer = this.setTimer(() => this.finishVoicemail(), ms)
	}

	private takeVoicemail() {
		const voicemail = this.voicemail
		if (!voicemail) return null
		this.clearTimer(voicemail.timer)
		this.clearTimer(voicemail.maxTimer)
		this.voicemail = null
		return { node: voicemail.node, message: voicemail.parts.join(' ').trim() }
	}

	private async saveVoicemail(message: string) {
		try {
			await this.services.createRequest({
				orgId: this.config.organization.id,
				callId: this.callId,
				type: 'callback',
				callerName: null,
				callerPhone: this.callerPhone,
				details: { message: message.slice(0, 1000) },
			})
			this.state.requests.push('callback')
			this.state.voicemail = true
			return true
		} catch (error) {
			console.error('Failed to save voicemail', error)
			return false
		}
	}

	private async finishVoicemail() {
		const taken = this.takeVoicemail()
		if (!taken) return
		if (taken.message) {
			const saved = await this.saveVoicemail(taken.message)
			await this.speak(
				this.phrase(saved ? 'voicemail_saved' : 'voicemail_failed'),
			)
		} else {
			await this.speak(this.phrase('voicemail_empty'))
		}
		const next = nextNode(this.graph, taken.node.id)
		if (next) {
			this.go(next.id)
		} else {
			this.endCall()
		}
	}

	/** Saves a voicemail the caller left before hanging up. */
	async flushVoicemail() {
		const taken = this.takeVoicemail()
		if (taken?.message) await this.saveVoicemail(taken.message)
	}

	// ---- Links ----

	/**
	 * The SMS body for a texted link, with `{url}` left for tenant-api to
	 * fill. A very long business name is shortened to fit tenant-api's limit.
	 */
	linkMessage(kind: 'website' | 'handoff') {
		const build = (business: string) =>
			linkMessageFor(this.vertical, kind, { business, url: '{url}' })
		const message = build(this.businessName)
		if (message.length <= LINK_MESSAGE_MAX_CHARS) return message
		const short = build(this.businessName.slice(0, 40).trim())
		return short.length <= LINK_MESSAGE_MAX_CHARS
			? short
			: linkMessageFor(null, kind, { business: '', url: '{url}' }).trim()
	}

	private sendWebsiteLink(sendTo: string | null) {
		return this.services.sendWebsiteLink({
			orgId: this.config.organization.id,
			callId: this.callId,
			scopeId: this.config.scopeId,
			path: websitePathFor(this.vertical, this.config.scopeId),
			message: this.linkMessage('website'),
			sendTo,
		})
	}

	private async showLinkOnScreen(url: string) {
		await this.publishToRoom({ type: LINK_DATA_MESSAGE_TYPE, url }).catch(
			() => undefined,
		)
	}

	/**
	 * Texts the caller a link carrying data from the call, for the vertical's
	 * tools. Test calls show the link on screen instead.
	 */
	async sendLink(input: SendLinkInput): Promise<SendLinkResult> {
		if (this.transferInProgress) {
			return {
				ok: false,
				reason: 'transfer_in_progress',
				explanation: TRANSFER_IN_PROGRESS.error,
			}
		}
		const phone = input.phone?.trim()
		const requested = phone ? normalizeUsPhone(phone) : null
		if (phone && !requested) {
			return {
				ok: false,
				reason: 'invalid_phone',
				explanation: smsBlockedExplanation('not_allowed_number'),
			}
		}
		const sendTo = requested ?? this.callerPhone
		const isTest = this.channel === 'web_test'
		if (!sendTo && !isTest) {
			return {
				ok: false,
				reason: 'no_number',
				explanation: 'There is no number to text.',
			}
		}
		if (sendTo && !this.state.canText()) {
			return {
				ok: false,
				reason: 'text_limit',
				explanation: smsBlockedExplanation('call_limit'),
			}
		}
		const notSent = (explanation = smsBlockedExplanation(undefined)) =>
			({ ok: false, reason: 'not_sent', explanation }) as const
		const link = LinkHandoffSchema.safeParse({
			path: input.path,
			payload: input.payload,
		})
		const payload = this.vertical.links?.handoffPayload?.safeParse(
			input.payload,
		)
		if (!link.success || payload?.success === false) {
			console.error('A vertical tool sent an invalid link', {
				callId: this.callId,
				path: input.path,
			})
			return notSent()
		}
		let handoff: Awaited<ReturnType<VoiceServices['createHandoff']>>
		try {
			handoff = await this.services.createHandoff({
				orgId: this.config.organization.id,
				callId: this.callId,
				scopeId: this.config.scopeId,
				path: link.data.path,
				payload: payload?.success ? payload.data : input.payload,
				message: this.linkMessage('handoff'),
				sendTo,
			})
		} catch (error) {
			console.error('Failed to send the link', error)
			return notSent()
		}
		if (handoff.url) {
			this.state.link = { url: handoff.url, smsSent: handoff.smsSent }
		}
		if (handoff.smsSent) this.state.textsSent++
		if (isTest && handoff.url) {
			await this.showLinkOnScreen(handoff.url)
			return { ok: true, url: handoff.url, shownOnScreen: true }
		}
		if (!handoff.smsSent || !handoff.url) {
			return notSent(smsBlockedExplanation(handoff.smsBlockedReason))
		}
		return { ok: true, url: handoff.url, shownOnScreen: false }
	}

	/** The phone menu step that texts the business's website link. */
	private async textLink(node: FlowNode) {
		const isTest = this.channel === 'web_test'
		const sendTo = this.callerPhone
		if ((!sendTo && !isTest) || !this.state.canText()) {
			await this.speak(this.phrase('text_link_blocked'))
			return
		}
		let result: TextLinkResult | null = null
		try {
			result = await this.sendWebsiteLink(sendTo)
		} catch (error) {
			console.error('Failed to send the website link', error)
		}
		if (!result) {
			await this.speak(this.phrase('text_link_blocked'))
			return
		}
		this.state.link = { url: result.url, smsSent: result.smsSent }
		if (result.smsSent) this.state.textsSent++
		if (isTest) {
			await this.showLinkOnScreen(result.url)
			await this.speak(
				`${node.data.message || this.phrase('text_link_sent')} ${callLine('test_link_on_screen', this.language)}`,
			)
			return
		}
		await this.speak(
			result.smsSent
				? node.data.message || this.phrase('text_link_sent')
				: this.phrase('text_link_blocked'),
		)
	}

	// ---- Transfers ----

	/**
	 * False for a number that reaches this org's own agent (dialing it would
	 * loop the caller back to the agent) or that is outside the US and Canada
	 * (toll fraud). Either counts as unavailable, so the flow's no-answer path
	 * or the model's take-a-message fallback runs.
	 */
	private canDial(phone: string) {
		const refusal = dialRefusal(phone, this.config.agentLines)
		if (!refusal) return true
		if (refusal === 'agent_line') {
			console.warn('Not transferring to a number that reaches the agent', {
				callId: this.callId,
			})
		} else {
			console.warn('Not transferring to a number outside the US and Canada', {
				callId: this.callId,
				phone: phoneTail(phone),
			})
		}
		return false
	}

	/** The staff line press 0 rings, or null when press 0 is off or transfers aren't available. */
	private pressZeroTarget(): TransferTarget | null {
		if (!this.settings.transfers.pressZeroForStaff) return null
		const target = resolveTransfer(this.settings, this.isOpen)
		return target && this.canDial(target.phone)
			? { ...target, contactId: null }
			: null
	}

	/**
	 * Used by the AI assistant's transfer tools and press 0. Returns false when
	 * the transfer isn't allowed right now. Transfers run after the tool call
	 * returns: waiting for speech playout inside a tool call would wait on the
	 * tool's own reply.
	 */
	transferFromAssistant(caseId?: string | null) {
		const target = resolveTransfer(this.settings, this.isOpen, caseId)
		if (!target || this.transferring || this.ending) return false
		if (!this.canDial(target.phone)) return false
		this.startTransfer({
			phone: target.phone,
			retries: target.retries,
			contactId: target.contact?.id ?? null,
		})
		return true
	}

	private startTransfer(target: TransferTarget) {
		this.leaveMenu()
		void this.transfer(target, this.phrase('hold')).then((outcome) => {
			if (outcome !== 'unavailable' || this.ending) return
			if (!this.aiActive) {
				this.endCall()
				return
			}
			try {
				this.session?.generateReply({
					instructions:
						'Nobody from the team answered the transfer, and the caller has been told. Offer to take a message so the team can call back.',
				})
			} catch (error) {
				console.warn('Could not continue after the transfer', error)
			}
		})
	}

	/** Whether the caller can be texted back if the transfer isn't answered. */
	private canOfferText() {
		return (
			this.settings.transfers.offerTextWhenNoAnswer &&
			this.state.canText() &&
			(Boolean(this.callerPhone) || this.channel === 'web_test')
		)
	}

	/**
	 * Warm transfers ring staff while the hold message plays and only count as
	 * escalated once someone answers; the agent then leaves the caller and
	 * staff to talk. Test calls always continue as if nobody answered.
	 */
	private async transfer(
		target: TransferTarget | null,
		holdMessage: string,
	): Promise<TransferOutcome> {
		if (this.ending || this.transferring) return 'ended'
		if (!target || !this.canDial(target.phone)) return 'unavailable'
		const dialer = this.dialer
		const isTest = this.channel === 'web_test'
		if (!dialer && !isTest) return 'unavailable'
		this.transferring = true
		try {
			let textOptIn = false
			if (this.canOfferText()) {
				const reply = await this.ask(this.phrase('transfer_text_offer'))
				textOptIn = reply ? parseYes(reply) : false
				if (this.ending) return 'ended'
			}
			this.state.transferContactId = target.contactId

			let result: 'answered' | 'referred' | 'no_answer' = 'no_answer'
			if (!dialer) {
				await this.speak(
					`${holdMessage} ${callLine('test_transfer', this.language, { phone: target.phone })}`,
				)
			} else {
				const hold = this.speak(holdMessage)
				if (!dialer.warm) await hold
				const ringSeconds = this.settings.transfers.ringTimeoutSeconds
				// Cold transfers can't tell whether anyone answered, so they get one try.
				const attempts = dialer.warm ? 1 + target.retries : 1
				for (let attempt = 0; attempt < attempts; attempt++) {
					if (this.ending) break
					result = await dialer
						.transfer(target.phone, { ringSeconds })
						.catch((error: unknown) => {
							console.error('Transfer failed', error)
							return 'no_answer' as const
						})
					if (result !== 'no_answer') break
				}
				// Staff is in the room from here on and never heard the notice.
				if (result === 'answered') void this.stopRecording?.()
				await hold
			}

			if (this.ending) {
				// The caller hung up while staff was ringing; don't leave staff alone.
				if (result === 'answered' && this.disposed) {
					await this.hangUpRoom().catch((error: unknown) =>
						console.error('Failed to end the call', error),
					)
				}
				return 'ended'
			}
			if (result === 'no_answer') {
				this.state.transferResult = 'no_answer'
				await this.speak(this.phrase('transfer_no_answer'))
				if (textOptIn) await this.textAfterMissedTransfer()
				return this.ending ? 'ended' : 'unavailable'
			}
			// A SIP REFER hands the caller off without telling us whether anyone
			// picks up, so it is not recorded as answered.
			this.state.transferResult =
				result === 'answered' ? 'answered' : 'referred'
			this.state.escalated = true
			this.ending = true
			this.leaveMenu()
			if (result === 'answered') {
				await this.speak(this.phrase('transfer_connecting'), { final: true })
				await this.leaveRoom().catch((error: unknown) =>
					console.error('Failed to leave the call', error),
				)
			}
			return 'connected'
		} finally {
			this.transferring = false
		}
	}

	/**
	 * Logs a callback request so the team follows up, and texts the caller the
	 * website link so they have a way to reach the business meanwhile.
	 */
	private async textAfterMissedTransfer() {
		let requestSaved = false
		try {
			await this.services.createRequest({
				orgId: this.config.organization.id,
				callId: this.callId,
				type: 'callback',
				callerName: null,
				callerPhone: this.callerPhone,
				details: {
					message:
						'Nobody answered the transfer. The caller asked to be texted back.',
				},
			})
			this.state.requests.push('callback')
			requestSaved = true
		} catch (error) {
			console.error('Failed to save the callback request', error)
		}
		let result: TextLinkResult | null = null
		try {
			result = await this.sendWebsiteLink(this.callerPhone)
		} catch (error) {
			console.error('Failed to send the follow-up text', error)
		}
		if (result?.smsSent) this.state.textsSent++
		if (this.channel === 'web_test' && result) {
			await this.showLinkOnScreen(result.url)
		}
		const sent = result?.smsSent || (this.channel === 'web_test' && result)
		await this.speak(
			this.phrase(
				sent
					? 'transfer_text_sent'
					: requestSaved
						? 'transfer_text_failed'
						: 'text_link_blocked',
			),
		)
	}

	// ---- Questions ----

	/**
	 * Asks a fixed question and resolves with the next key press or utterance,
	 * or null after ANSWER_WAIT_MS of silence or when the call ends.
	 */
	private ask(
		question: string,
		options: { final?: boolean } = {},
	): Promise<AnswerInput | null> {
		this.answer?.cancel()
		return new Promise((resolve) => {
			let timer: Timer | null = null
			const settle = (value: AnswerInput | null) => {
				if (this.answer !== pending) return
				this.answer = null
				this.clearTimer(timer)
				if (value) this.interruptSpeech()
				resolve(value)
			}
			const pending: PendingAnswer = {
				take: (input) => {
					settle(input)
					return true
				},
				cancel: () => settle(null),
			}
			this.answer = pending
			void this.speak(question, {
				interruptible: true,
				final: options.final,
			}).then((spoken) => {
				if (this.answer !== pending) return
				if (!spoken) settle(null)
				else timer = this.setTimer(() => settle(null), ANSWER_WAIT_MS)
			})
		})
	}

	/** Routes speech to a waiting question; false when nothing is waiting. */
	private takeSpokenAnswer(text: string) {
		const answer = this.answer
		const spoken = text.trim()
		if (!answer || !spoken) return false
		answer.take({ text: spoken })
		return true
	}

	/** The end-of-call rating question, when the business turned it on. */
	private async askRating() {
		const reply = await this.ask(this.phrase('csat_question'), { final: true })
		const rating = reply ? parseRating(reply) : null
		if (rating == null) return
		this.state.rating = rating
		await this.speak(
			this.phrase(rating <= LOW_RATING_MAX ? 'csat_low' : 'csat_thanks'),
			{ final: true },
		)
	}

	// ---- Ending ----

	/**
	 * `survey` marks a normal goodbye (a hang-up step or the assistant ending
	 * the call), the only time the rating question is asked.
	 */
	endCall(message?: string, options: { survey?: boolean } = {}) {
		if (this.ending) return
		this.ending = true
		this.leaveMenu()
		if (this.voicemail) {
			this.clearTimer(this.voicemail.timer)
			this.clearTimer(this.voicemail.maxTimer)
			this.voicemail.timer = null
			this.voicemail.maxTimer = null
			this.voicemail.listening = false
		}
		const survey =
			options.survey &&
			this.settings.csatEnabled &&
			!this.state.failed &&
			this.state.rating == null
		void (async () => {
			if (survey) await this.askRating()
			await this.speak(message || this.closingLine(), { final: true })
			await this.hangUp()
		})().catch((error: unknown) => {
			console.error('Failed to end the call', error)
		})
	}

	private async hangUp() {
		if (this.disposed) return
		await new Promise<void>((resolve) =>
			this.setTimer(resolve, HANG_UP_GRACE_MS),
		)
		await this.hangUpRoom().catch((error: unknown) => {
			console.error('Failed to end the call', error)
		})
	}
}
