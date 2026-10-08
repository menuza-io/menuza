import 'varlock/auto-load'
import { fileURLToPath } from 'node:url'
import {
	cli,
	defineAgent,
	type JobContext,
	llm,
	ServerOptions,
	voice,
} from '@livekit/agents'
import {
	ParticipantKind,
	type RemoteParticipant,
	RoomEvent,
} from '@livekit/rtc-node'
import { PHONE_AGENT_DISPATCH_NAME } from '@repo/phone-agent'
import { ENV } from 'varlock/env'
import { watchBridgedCall } from './bridge.ts'
import {
	callLookup,
	type CallStartPlan,
	prepareCall,
	recoverFromOutage,
	runFallbackCall,
} from './call-start.ts'
import { buildFinishInput, CallState } from './call-state.ts'
import { CallController } from './controller.ts'
import { normalizeE164, priceFormatter } from './job-metadata.ts'
import { callPhrase } from './messages.ts'
import { assertUsDataRegion, createModels, createTts } from './models.ts'
import { assertProductionConfig } from './production-config.ts'
import { createCallRecording } from './recording.ts'
import {
	createRuntimeConfigLoader,
	finishCallWithRetry,
	tenantApi,
} from './services.ts'
import { pronunciationTransform, VerbatimSpeech } from './speech.ts'
import { createSipTransferDialer } from './transfer.ts'
import { phoneAgentVertical } from './vertical.ts'

assertUsDataRegion(ENV.DATA_REGION)
assertProductionConfig(ENV)

const DATA_TOPIC = 'phone-agent'
const loadRuntimeConfig = createRuntimeConfigLoader()

async function deleteRoom(ctx: JobContext) {
	await ctx.deleteRoom().catch((error: unknown) => {
		console.error('Failed to end the call', error)
	})
}

/**
 * After a warm transfer the agent stops listening and speaking but stays in
 * the room, so the bridged call ends when caller or staff hangs up, or at
 * the hard time limit, instead of running on unattended.
 */
function bridgeToStaff(
	ctx: JobContext,
	session: { close(): Promise<void> } | null,
) {
	const room = ctx.room
	const stopWatching = watchBridgedCall({
		parties: () =>
			[...room.remoteParticipants.values()].filter(
				(participant) => participant.kind === ParticipantKind.SIP,
			).length,
		onPartyLeft: (listener) => {
			room.on(RoomEvent.ParticipantDisconnected, listener)
			return () => {
				room.off(RoomEvent.ParticipantDisconnected, listener)
			}
		},
		endCall: async (reason) => {
			await deleteRoom(ctx)
			ctx.shutdown(`transferred call ended: ${reason}`)
		},
	})
	const onDisconnected = () => {
		stopWatching()
		ctx.shutdown('room closed')
	}
	room.once(RoomEvent.Disconnected, onDisconnected)
	ctx.addShutdownCallback(async () => {
		stopWatching()
		room.off(RoomEvent.Disconnected, onDisconnected)
	})
	if (session) {
		void session.close().catch((error: unknown) => {
			console.warn('Could not close the voice session', error)
		})
	}
}

/** Speaks a short message and transfers or hangs up, without the agent. */
async function runFallback(
	ctx: JobContext,
	plan: Extract<CallStartPlan, { kind: 'fallback' }>,
	options: { roomName: string; sipIdentity: string | null },
) {
	console.warn('Answering with the fallback path', { reason: plan.reason })
	const session = new voice.AgentSession({
		tts: createTts(plan.language, plan.voiceId),
	})
	let bridged = false
	try {
		await session.start({
			agent: new voice.Agent({ instructions: 'Fallback', llm: null }),
			room: ctx.room,
			record: false,
		})
		const handedOff = await runFallbackCall({
			session,
			plan,
			dialer: options.sipIdentity
				? createSipTransferDialer({
						roomName: options.roomName,
						callId: options.roomName,
						sipParticipantIdentity: options.sipIdentity,
					})
				: null,
			hangUp: () => deleteRoom(ctx),
			leaveRoom: async () => {
				bridged = true
				bridgeToStaff(ctx, session)
			},
		})
		// A REFER took the caller out of the room; nothing is left to do.
		if (handedOff && !bridged) ctx.shutdown('referred to the business')
	} catch (error) {
		console.error('Fallback call failed', error)
		await deleteRoom(ctx)
	}
}

async function entry(ctx: JobContext) {
	await ctx.connect()
	const participant = await ctx.waitForParticipant()
	const isSip = participant.kind === ParticipantKind.SIP
	const roomName = ctx.room.name ?? ctx.job.room?.name ?? ''
	const sipIdentity = isSip ? participant.identity : null

	// Browser test rooms are dispatched by App with signed metadata.
	const lookup = callLookup({
		sip: isSip
			? { calledNumber: participant.attributes['sip.trunkPhoneNumber'] }
			: null,
		jobMetadata: ctx.job.metadata,
	})
	if (!lookup) {
		if (isSip) {
			console.error('SIP call without a called number')
			await runFallback(
				ctx,
				{
					kind: 'fallback',
					reason: 'config_unavailable',
					language: 'en',
					voiceId: null,
					message: callPhrase('trouble', {
						language: 'en',
						verticalDefaults: phoneAgentVertical.phraseDefaults,
					}),
					phone: null,
					agentLines: [],
				},
				{ roomName, sipIdentity },
			)
		} else {
			console.error('Room has no phone or test-call metadata; leaving')
			ctx.shutdown('unsupported room')
		}
		return
	}

	const channel = isSip ? 'phone' : 'web_test'
	const callerPhone = isSip
		? normalizeE164(participant.attributes['sip.phoneNumber'])
		: null
	const plan = await prepareCall({
		lookup,
		loadConfig: loadRuntimeConfig,
		startCall: (input) => tenantApi.startCall(input),
		channel,
		roomName,
		callerPhone,
		vertical: phoneAgentVertical,
	})
	if (plan.kind === 'fallback') {
		await runFallback(ctx, plan, { roomName, sipIdentity })
		return
	}
	if (plan.kind === 'blocked') {
		const { config: blockedConfig, callId: blockedCallId } = plan
		if (blockedConfig && blockedCallId) {
			const state = new CallState()
			state.failed = true
			state.loopBlocked = true
			state.fromBusinessLine = plan.reason === 'business_line'
			const input = buildFinishInput(state, blockedConfig, {
				vertical: phoneAgentVertical,
				formatPrice: priceFormatter(blockedConfig.organization.currency),
			})
			// Deleting the room ends the job, so the log is saved on shutdown.
			ctx.addShutdownCallback(async () => {
				await finishCallWithRetry(() =>
					tenantApi.finishCall(blockedCallId, input),
				)
			})
		}
		// No dialer: the explanation must never turn into a transfer.
		if (plan.message) {
			await runFallback(
				ctx,
				{
					kind: 'fallback',
					reason: 'business_line',
					language: plan.language,
					voiceId: plan.voiceId,
					message: plan.message,
					phone: null,
					agentLines: [],
				},
				{ roomName, sipIdentity: null },
			)
		} else {
			await deleteRoom(ctx)
		}
		ctx.shutdown('call from an agent line')
		return
	}

	const { config, callId } = plan
	const state = new CallState()
	const formatPrice = priceFormatter(config.organization.currency)
	const verbatim = new VerbatimSpeech()
	let models: ReturnType<typeof createModels> | null = null
	let session: voice.AgentSession | null = null
	let handedOff = false
	const recording = createCallRecording({
		roomName,
		orgId: config.organization.id,
		callId,
		// Kept even when the egress started too late to record anything: the
		// call log names the object so tenant-api can expire or delete it.
		onLateStart: (key) => {
			state.recordingKey = key
		},
	})
	const controller = new CallController({
		config,
		vertical: phoneAgentVertical,
		state,
		callId,
		channel,
		callerPhone,
		formatPrice,
		services: tenantApi,
		dialer: sipIdentity
			? createSipTransferDialer({
					roomName,
					callId,
					sipParticipantIdentity: sipIdentity,
				})
			: null,
		hangUp: () => ctx.deleteRoom(),
		leaveRoom: async () => {
			handedOff = true
			void recording.stop()
			bridgeToStaff(ctx, session)
		},
		publishToRoom: async (message) => {
			await ctx.room.localParticipant?.publishData(
				new TextEncoder().encode(JSON.stringify(message)),
				{ reliable: true, topic: DATA_TOPIC },
			)
		},
		stopRecording: () => recording.stop(),
		verbatim,
		speech: {
			setLanguage: (language) => models?.speech.setLanguage(language),
		},
	})

	let finishing: Promise<void> | null = null
	const finish = () => {
		finishing ??= (async () => {
			controller.dispose()
			void recording.stop()
			await controller.flushVoicemail()
			const input = buildFinishInput(state, config, {
				vertical: phoneAgentVertical,
				formatPrice,
			})
			await finishCallWithRetry(() => tenantApi.finishCall(callId, input))
		})()
		return finishing
	}
	ctx.addShutdownCallback(finish)

	/**
	 * The agent can't talk anymore, so the caller goes to the business
	 * with a REFER; the room is only torn down when that isn't possible.
	 */
	let recovering = false
	const recover = async (reason: string) => {
		if (recovering) return
		recovering = true
		state.failed = true
		const ending = controller.isEnding
		const handedOver = await recoverFromOutage({
			phone: ending ? null : config.fallbackPhone,
			agentLines: config.agentLines,
			referDialer: sipIdentity
				? createSipTransferDialer({
						roomName,
						callId,
						sipParticipantIdentity: sipIdentity,
						referOnly: true,
					})
				: null,
			hangUp: () => deleteRoom(ctx),
			saveLog: async (referred) => {
				if (referred) state.transferResult = 'referred'
				await finish()
			},
		})
		ctx.shutdown(handedOver ? `${reason}; handed to the business` : reason)
	}

	try {
		models = createModels(config, phoneAgentVertical)
		const { speech: ignoredSpeech, ...sessionModels } = models
		session = new voice.AgentSession({
			...sessionModels,
			maxToolSteps: 5,
			// The pronunciation transform goes first: it relies on say() text
			// arriving as one chunk to leave the required notices untouched.
			ttsTextTransforms: [
				pronunciationTransform(config.settings.pronunciations, verbatim),
				'filter_markdown',
				'filter_emoji',
			],
			turnHandling: {
				interruption: { enabled: true },
			},
		})
		controller.attach(session)

		const onItem = (event: voice.ConversationItemAddedEvent) => {
			const item = event.item
			if (!(item instanceof llm.ChatMessage)) return
			const text = item.textContent
			if (!text) return
			if (item.role === 'user') state.addTurn('caller', text)
			else if (item.role === 'assistant') state.addTurn('agent', text)
		}
		const onUserState = (event: voice.UserStateChangedEvent) => {
			if (event.newState === 'speaking') controller.onCallerStartedSpeaking()
			else if (event.oldState === 'speaking')
				controller.onCallerStoppedSpeaking()
		}
		// Phone keypads send DTMF over SIP; the test page's dial pad sends the same.
		const onDtmf = (
			ignoredCode: number,
			digit: string,
			sender: RemoteParticipant,
		) => {
			if (sender.identity === participant.identity) controller.onKeypad(digit)
		}
		const onError = (event: voice.ErrorEvent) => {
			console.error('Voice session error', event.error)
		}
		const onClose = (event: voice.CloseEvent) => {
			// After a warm transfer the bridge watcher owns the room and the job.
			if (handedOff) {
				void finish()
				return
			}
			if (event.error) {
				void recover('voice session failed')
				return
			}
			void finish().then(() => ctx.shutdown('session closed'))
		}
		session.on(voice.AgentSessionEventTypes.ConversationItemAdded, onItem)
		session.on(voice.AgentSessionEventTypes.UserStateChanged, onUserState)
		session.on(voice.AgentSessionEventTypes.Error, onError)
		session.on(voice.AgentSessionEventTypes.Close, onClose)
		ctx.room.on(RoomEvent.DtmfReceived, onDtmf)
		controller.onDispose(() => {
			session?.off(voice.AgentSessionEventTypes.ConversationItemAdded, onItem)
			session?.off(voice.AgentSessionEventTypes.UserStateChanged, onUserState)
			session?.off(voice.AgentSessionEventTypes.Error, onError)
			ctx.room.off(RoomEvent.DtmfReceived, onDtmf)
		})

		await session.start({
			agent: controller.createMenuAgent(),
			room: ctx.room,
			// Recording goes through Egress so it lands in our storage, not LiveKit Cloud.
			record: false,
		})
		controller.startCallLimit()

		if (config.settings.recordCalls) {
			const key = await recording.start()
			if (key) state.recordingKey = key
		}
	} catch (error) {
		console.error('Could not start the voice session', error)
		await recover('session failed')
	}
}

export default defineAgent({ entry })

cli.runApp(
	new ServerOptions({
		agent: fileURLToPath(import.meta.url),
		agentName: PHONE_AGENT_DISPATCH_NAME,
	}),
)
