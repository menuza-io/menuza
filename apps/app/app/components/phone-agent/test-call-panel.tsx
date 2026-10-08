import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import {
	type RemoteParticipant,
	Room,
	RoomEvent,
	type TextStreamReader,
	Track,
} from 'livekit-client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { z } from 'zod'
import {
	isMicrophoneError,
	microphoneErrorMessage,
} from './test-call-errors.ts'
import { useVerticalLabels } from './vertical-labels.ts'

export type StartTestCallResult =
	| { ok: true; serverUrl: string; roomName: string; participantToken: string }
	| { ok: false; error: string }

type TestFlow = 'draft' | 'published'
type Phase = 'idle' | 'mic' | 'starting' | 'connecting' | 'connected' | 'ended'
type TranscriptSegment = {
	id: string
	speaker: 'you' | 'agent'
	text: string
	final: boolean
}
type SentLink = { id: string; url: string }

const DIAL_PAD_KEYS = [
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'*',
	'0',
	'#',
] as const
type DialPadKey = (typeof DIAL_PAD_KEYS)[number]

/** RFC 4733 event codes, which LiveKit expects alongside the digit. */
function dtmfCode(key: DialPadKey) {
	if (key === '*') return 10
	if (key === '#') return 11
	return Number(key)
}

const AGENT_JOIN_TIMEOUT_MS = 20_000
const TRANSCRIPTION_TOPIC = 'lk.transcription'
const AGENT_DATA_TOPIC = 'phone-agent'

const agentMessageSchema = z.object({
	type: z.literal('link'),
	url: z
		.string()
		.url()
		.refine((value) => /^https?:\/\//i.test(value)),
})

function findAgent(room: Room): RemoteParticipant | undefined {
	const participants = [...room.remoteParticipants.values()]
	return (
		participants.find((participant) => participant.isAgent) ?? participants[0]
	)
}

export function TestCallPanel({
	orgSlug,
	scopes,
	hasPublishedFlow,
	defaultFlow,
	canStart,
	regionSupported,
}: {
	orgSlug: string
	/** Empty for verticals without scopes. */
	scopes: Array<{ id: string; name: string; isDefault: boolean }>
	hasPublishedFlow: boolean
	defaultFlow: TestFlow
	canStart: boolean
	regionSupported: boolean
}) {
	const { _ } = useLingui()
	const labels = useVerticalLabels()
	const fetcher = useFetcher<StartTestCallResult>()
	const [scopeId, setScopeId] = useState(scopes[0]?.id ?? '')
	const needsScope = Boolean(labels.scope)
	const [flow, setFlow] = useState<TestFlow>(defaultFlow)
	const [phase, setPhase] = useState<Phase>('idle')
	const [error, setError] = useState<string | null>(null)
	const [muted, setMuted] = useState(false)
	const [audioBlocked, setAudioBlocked] = useState(false)
	const [agentPresent, setAgentPresent] = useState(false)
	const [agentState, setAgentState] = useState<string | null>(null)
	const [agentSpeaking, setAgentSpeaking] = useState(false)
	const [segments, setSegments] = useState<TranscriptSegment[]>([])
	const [sentLinks, setSentLinks] = useState<SentLink[]>([])
	const roomRef = useRef<Room | null>(null)
	const audioContainerRef = useRef<HTMLDivElement>(null)
	const transcriptRef = useRef<HTMLDivElement>(null)
	const handledResult = useRef<StartTestCallResult | null>(null)
	// Timestamps can repeat for quick presses, and a reused segment id would
	// replace the earlier press in the transcript.
	const dtmfSequence = useRef(0)
	const endedByUser = useRef(false)

	const upsertSegment = useCallback((segment: TranscriptSegment) => {
		setSegments((current) => {
			const index = current.findIndex((entry) => entry.id === segment.id)
			if (index === -1) return [...current, segment]
			const next = [...current]
			next[index] = segment
			return next
		})
	}, [])

	const connect = useCallback(
		async ({
			serverUrl,
			participantToken,
		}: {
			serverUrl: string
			participantToken: string
		}) => {
			const room = new Room()
			roomRef.current = room

			const syncAgent = () => {
				const agent = findAgent(room)
				setAgentPresent(Boolean(agent))
				setAgentState(agent?.attributes['lk.agent.state'] ?? null)
				setAgentSpeaking(Boolean(agent?.isSpeaking))
			}
			const readTranscription = async (
				reader: TextStreamReader,
				identity: string,
			) => {
				const attributes = reader.info.attributes ?? {}
				const id = attributes['lk.segment_id'] ?? reader.info.id
				const speaker =
					identity === room.localParticipant.identity ? 'you' : 'agent'
				const final = attributes['lk.transcription_final'] === 'true'
				// Each stream carries one version of a segment: interim caller
				// transcripts resend the whole text in a new stream, while agent
				// speech arrives as deltas within a single stream.
				let text = ''
				for await (const chunk of reader) {
					if (roomRef.current !== room) return
					text += chunk
					upsertSegment({ id, speaker, text, final: false })
				}
				// Agent streams close when the utterance is done; caller streams
				// close per interim version, so trust their final flag.
				if (roomRef.current === room) {
					upsertSegment({
						id,
						speaker,
						text,
						final: final || speaker === 'agent',
					})
				}
			}

			room.on(RoomEvent.ParticipantConnected, syncAgent)
			room.on(RoomEvent.ParticipantAttributesChanged, syncAgent)
			room.on(RoomEvent.ActiveSpeakersChanged, syncAgent)
			room.on(RoomEvent.ParticipantDisconnected, (participant) => {
				// The agent leaving means it hung up; end the call on our side too.
				if (participant.isAgent) void room.disconnect()
				else syncAgent()
			})
			room.on(RoomEvent.TrackSubscribed, (track) => {
				if (track.kind !== Track.Kind.Audio) return
				const element = track.attach()
				audioContainerRef.current?.appendChild(element)
			})
			room.on(RoomEvent.TrackUnsubscribed, (track) => {
				track.detach().forEach((element) => element.remove())
			})
			room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
				setAudioBlocked(!room.canPlaybackAudio)
			})
			room.on(
				RoomEvent.DataReceived,
				(payload, ignoredParticipant, ignoredKind, topic) => {
					if (topic !== AGENT_DATA_TOPIC) return
					let message: unknown
					try {
						message = JSON.parse(new TextDecoder().decode(payload))
					} catch {
						return
					}
					const parsed = agentMessageSchema.safeParse(message)
					if (!parsed.success) return
					setSentLinks((current) => [
						...current,
						{ id: `${Date.now()}-${current.length}`, url: parsed.data.url },
					])
				},
			)
			room.on(RoomEvent.Disconnected, () => {
				for (const participant of room.remoteParticipants.values()) {
					for (const publication of participant.audioTrackPublications.values()) {
						publication.track?.detach().forEach((element) => element.remove())
					}
				}
				if (roomRef.current !== room) return
				roomRef.current = null
				setPhase('ended')
				setAgentPresent(false)
				setAgentSpeaking(false)
				setAgentState(null)
				setAudioBlocked(false)
			})
			room.registerTextStreamHandler(
				TRANSCRIPTION_TOPIC,
				(reader, participantInfo) => {
					void readTranscription(reader, participantInfo.identity).catch(
						() => {},
					)
				},
			)

			await room.connect(serverUrl, participantToken)
			if (roomRef.current !== room) return
			setPhase('connected')
			await room.localParticipant.setMicrophoneEnabled(true)
			await room.startAudio().catch(() => {})
			setAudioBlocked(!room.canPlaybackAudio)
			syncAgent()
		},
		[upsertSegment],
	)

	useEffect(() => {
		const result = fetcher.data
		if (fetcher.state !== 'idle' || !result || handledResult.current === result)
			return
		handledResult.current = result
		if (phase !== 'starting') return
		if (!result.ok) {
			setError(result.error)
			setPhase('idle')
			return
		}
		setPhase('connecting')
		void connect(result).catch((connectError: unknown) => {
			const room = roomRef.current
			roomRef.current = null
			void room?.disconnect()
			// Ending the call while it connects aborts the connection; that is
			// a normal hang-up, not a failure.
			if (endedByUser.current) {
				setPhase('ended')
				return
			}
			// Keep a more specific error, such as the join timeout, if one is set.
			setError(
				(current) =>
					current ??
					(isMicrophoneError(connectError)
						? _(microphoneErrorMessage(connectError))
						: _(
								msg`Couldn't connect to the test call. Make sure the voice agent is running and try again.`,
							)),
			)
			setPhase('idle')
		})
	}, [fetcher.state, fetcher.data, phase, connect, _])

	const waitingForAgent =
		(phase === 'connecting' || phase === 'connected') && !agentPresent
	useEffect(() => {
		if (!waitingForAgent) return
		const timer = setTimeout(() => {
			const room = roomRef.current
			roomRef.current = null
			void room?.disconnect()
			setAgentPresent(false)
			setAgentSpeaking(false)
			setAgentState(null)
			setAudioBlocked(false)
			setError(
				_(
					msg`Your agent didn't join the call. Make sure the voice agent is running and try again.`,
				),
			)
			setPhase('idle')
		}, AGENT_JOIN_TIMEOUT_MS)
		return () => clearTimeout(timer)
	}, [waitingForAgent, _])

	useEffect(
		() => () => {
			const room = roomRef.current
			roomRef.current = null
			void room?.disconnect()
		},
		[],
	)

	useEffect(() => {
		const container = transcriptRef.current
		if (container) container.scrollTop = container.scrollHeight
	}, [segments])

	const start = async () => {
		setError(null)
		endedByUser.current = false
		setPhase('mic')
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			stream.getTracks().forEach((track) => track.stop())
		} catch (micError) {
			setError(_(microphoneErrorMessage(micError)))
			setPhase('idle')
			return
		}
		setSegments([])
		setSentLinks([])
		setMuted(false)
		setPhase('starting')
		void fetcher.submit(
			{ intent: 'start', scopeId: needsScope ? scopeId : null, flow },
			{
				method: 'POST',
				encType: 'application/json',
				action: `/${orgSlug}/phone-agent/test`,
			},
		)
	}

	const pressKey = useCallback(
		(key: DialPadKey) => {
			const room = roomRef.current
			if (!room) return
			void room.localParticipant.publishDtmf(dtmfCode(key), key).catch(() => {
				setError(_(msg`Couldn't send that key press. Try again.`))
			})
			dtmfSequence.current += 1
			upsertSegment({
				id: `dtmf-${dtmfSequence.current}`,
				speaker: 'you',
				text: _(msg`Pressed ${key}`),
				final: true,
			})
		},
		[_, upsertSegment],
	)

	useEffect(() => {
		if (phase !== 'connected') return
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target
			if (
				// Holding a key auto-repeats; each deliberate press still sends.
				event.repeat ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				(target instanceof HTMLElement &&
					(target.isContentEditable ||
						['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))
			) {
				return
			}
			const key = DIAL_PAD_KEYS.find((candidate) => candidate === event.key)
			if (key) pressKey(key)
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [phase, pressKey])

	const toggleMute = async () => {
		const room = roomRef.current
		if (!room) return
		const nextMuted = !muted
		try {
			await room.localParticipant.setMicrophoneEnabled(!nextMuted)
		} catch (muteError) {
			if (roomRef.current !== room) return
			setError(
				nextMuted
					? _(msg`Couldn't mute your microphone. Try again.`)
					: _(microphoneErrorMessage(muteError)),
			)
			return
		}
		setMuted(nextMuted)
	}

	const endCall = () => {
		const room = roomRef.current
		if (!room) return
		endedByUser.current = true
		void room.disconnect()
	}

	const inCall =
		phase === 'mic' ||
		phase === 'starting' ||
		phase === 'connecting' ||
		phase === 'connected'
	const speaking = agentState === 'speaking' || agentSpeaking
	const statusLabel =
		phase === 'mic'
			? _(msg`Waiting for microphone permission…`)
			: phase === 'starting' || phase === 'connecting'
				? _(msg`Connecting…`)
				: phase === 'connected'
					? !agentPresent
						? _(msg`Waiting for your agent to join…`)
						: speaking
							? _(msg`Agent speaking`)
							: agentState === 'thinking'
								? _(msg`Thinking…`)
								: agentState === 'initializing'
									? _(msg`Agent is getting ready…`)
									: _(msg`Listening`)
					: phase === 'ended'
						? _(msg`Call ended`)
						: _(msg`Ready to call`)

	const scopeItems = scopes.map((scope) => ({
		value: scope.id,
		label: scope.name,
	}))
	const flowItems = [
		{ value: 'published', label: _(msg`Published`) },
		{ value: 'draft', label: _(msg`Draft`) },
	]
	const startDisabled =
		!canStart ||
		!regionSupported ||
		(needsScope && !scopeId) ||
		inCall ||
		fetcher.state !== 'idle'

	return (
		<div className="grid gap-6 lg:grid-cols-5">
			<section
				aria-label={_(msg`Call controls`)}
				className="flex flex-col gap-6 rounded-lg border p-6 lg:col-span-2"
			>
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
					{labels.scope ? (
						<div className="flex flex-col gap-2">
							<Label htmlFor="test-call-scope">{labels.scope.label}</Label>
							<Select
								items={scopeItems}
								value={scopeId || null}
								disabled={inCall || scopes.length === 0}
								onValueChange={(value) => {
									if (value) setScopeId(value)
								}}
							>
								<SelectTrigger id="test-call-scope" className="w-full">
									<SelectValue placeholder={_(msg`Choose one`)} />
								</SelectTrigger>
								<SelectContent>
									{scopeItems.map((item) => (
										<SelectItem key={item.value} value={item.value}>
											{item.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}
					<div className="flex flex-col gap-2">
						<Label htmlFor="test-call-flow">
							<Trans>Flow</Trans>
						</Label>
						<Select
							items={flowItems}
							value={flow}
							disabled={inCall}
							onValueChange={(value) => {
								if (value === 'draft' || value === 'published') setFlow(value)
							}}
						>
							<SelectTrigger id="test-call-flow" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="published" disabled={!hasPublishedFlow}>
									<Trans>Published</Trans>
								</SelectItem>
								<SelectItem value="draft">
									<Trans>Draft</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
						{!hasPublishedFlow ? (
							<p className="text-muted-foreground text-xs">
								<Trans>Your flow isn't published yet, so test the draft.</Trans>
							</p>
						) : null}
					</div>
				</div>

				<div
					className="flex flex-col items-center gap-4 py-4 text-center"
					role="status"
					aria-live="polite"
				>
					<div
						className={cn(
							'flex size-24 items-center justify-center rounded-full border transition-colors',
							phase === 'connected' && speaking
								? 'bg-primary text-primary-foreground animate-pulse'
								: phase === 'connected'
									? 'bg-muted'
									: 'bg-background text-muted-foreground',
						)}
						aria-hidden="true"
					>
						<Icon
							name={
								phase === 'ended'
									? 'phone-off'
									: phase === 'connected' && speaking
										? 'bot'
										: phase === 'connected' && muted
											? 'mic-off'
											: phase === 'connecting' ||
												  phase === 'starting' ||
												  phase === 'mic'
												? 'loader'
												: 'mic'
							}
							className={cn(
								'size-10',
								(phase === 'connecting' ||
									phase === 'starting' ||
									phase === 'mic') &&
									'animate-spin',
							)}
						/>
					</div>
					<p className="text-lg font-medium">{statusLabel}</p>
					{phase === 'connected' && muted ? (
						<p className="text-muted-foreground text-sm">
							<Trans>You're muted.</Trans>
						</p>
					) : null}
				</div>

				{phase === 'connected' ? (
					<div className="flex flex-col items-center gap-2">
						<div
							role="group"
							aria-label={_(msg`Dial pad`)}
							className="grid w-full max-w-56 grid-cols-3 gap-2"
						>
							{DIAL_PAD_KEYS.map((key) => (
								<Button
									key={key}
									type="button"
									variant="outline"
									size="lg"
									className="font-mono text-lg"
									aria-label={_(msg`Press ${key}`)}
									onClick={() => pressKey(key)}
								>
									{key}
								</Button>
							))}
						</div>
						<p className="text-muted-foreground text-xs">
							<Trans>You can also type keys on your keyboard.</Trans>
						</p>
					</div>
				) : null}

				{error ? (
					<p role="alert" className="text-destructive text-sm">
						{error}
					</p>
				) : null}

				{audioBlocked ? (
					<Button
						variant="outline"
						onClick={() => {
							const room = roomRef.current
							if (room)
								void room
									.startAudio()
									.then(() => setAudioBlocked(!room.canPlaybackAudio))
						}}
					>
						<Icon name="play" />
						<Trans>Enable audio</Trans>
					</Button>
				) : null}

				<div className="flex flex-wrap justify-center gap-2">
					{phase === 'connected' || phase === 'connecting' ? (
						<>
							<Button
								variant="outline"
								size="lg"
								disabled={phase !== 'connected'}
								aria-pressed={muted}
								aria-label={
									muted ? _(msg`Unmute microphone`) : _(msg`Mute microphone`)
								}
								onClick={() => void toggleMute()}
							>
								<Icon name={muted ? 'mic-off' : 'mic'} />
								{muted ? <Trans>Unmute</Trans> : <Trans>Mute</Trans>}
							</Button>
							<Button variant="destructive" size="lg" onClick={endCall}>
								<Icon name="phone-off" />
								<Trans>End call</Trans>
							</Button>
						</>
					) : (
						<Button
							size="lg"
							disabled={startDisabled}
							onClick={() => void start()}
						>
							<Icon name="phone" />
							{phase === 'ended' ? (
								<Trans>Start another call</Trans>
							) : (
								<Trans>Start call</Trans>
							)}
						</Button>
					)}
				</div>

				{phase === 'ended' ? (
					<p className="text-muted-foreground text-center text-sm">
						<Trans>
							This call will appear in{' '}
							<Link
								to={`/${orgSlug}/phone-agent/calls`}
								className="text-foreground underline underline-offset-4"
							>
								Calls
							</Link>{' '}
							shortly, marked as a test.
						</Trans>
					</p>
				) : null}
				{!canStart ? (
					<p className="text-muted-foreground text-center text-sm">
						<Trans>
							Only people who can edit the phone agent can start test calls.
						</Trans>
					</p>
				) : null}
				{labels.scope && scopes.length === 0 ? (
					<p className="text-muted-foreground text-center text-sm">
						{labels.scope.missing}
					</p>
				) : null}
				<div ref={audioContainerRef} hidden />
			</section>

			<section
				aria-labelledby="test-call-transcript-heading"
				className="flex min-h-80 flex-col gap-4 rounded-lg border p-6 lg:col-span-3"
			>
				<h2 id="test-call-transcript-heading" className="font-medium">
					<Trans>Live transcript</Trans>
				</h2>
				<div
					ref={transcriptRef}
					className="flex max-h-96 min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
					aria-live="polite"
					aria-relevant="additions text"
				>
					{segments.length === 0 ? (
						<p className="text-muted-foreground m-auto text-center text-sm">
							{inCall ? (
								<Trans>
									The conversation and your key presses will appear here.
								</Trans>
							) : (
								<Trans>
									Start a call to see what you and your agent say in real time.
								</Trans>
							)}
						</p>
					) : (
						segments.map((segment) => (
							<div
								key={segment.id}
								className={cn(
									'flex max-w-[85%] flex-col gap-1 rounded-lg px-3 py-2 text-sm',
									segment.speaker === 'agent'
										? 'bg-muted self-start'
										: 'bg-primary text-primary-foreground self-end',
									!segment.final && 'opacity-70',
								)}
							>
								<span className="text-xs opacity-70">
									{segment.speaker === 'agent' ? (
										<Trans>Agent</Trans>
									) : (
										<Trans>You</Trans>
									)}
								</span>
								<span className="leading-relaxed whitespace-pre-wrap">
									{segment.text}
								</span>
							</div>
						))
					)}
				</div>
				{sentLinks.map((link) => (
					<div
						key={link.id}
						className="bg-muted/50 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
						role="status"
					>
						<div className="flex items-center gap-2 text-sm font-medium">
							<Icon name="link-2" className="size-4" />
							<Trans>Link created</Trans>
						</div>
						<Button
							variant="outline"
							size="sm"
							render={<a href={link.url} target="_blank" rel="noreferrer" />}
							nativeButton={false}
						>
							<Icon name="external-link" />
							<Trans>Open link</Trans>
						</Button>
					</div>
				))}
			</section>
		</div>
	)
}
