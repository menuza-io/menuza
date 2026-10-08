import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type AgentLanguage,
	SUPPORTED_AGENT_LANGUAGES,
} from '@repo/phone-agent'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from '@repo/ui/input-group'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Spinner } from '@repo/ui/spinner'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type VoiceListResult } from '#app/routes/_app+/$orgSlug_+/phone-agent+/voices.ts'

type Voice = Extract<VoiceListResult, { ok: true }>['voices'][number]
type Gender = NonNullable<Voice['gender']>

const SEARCH_DEBOUNCE_MS = 300
const ANY = 'any'

const LANGUAGE_LABELS: Record<AgentLanguage, MessageDescriptor> = {
	en: msg`English`,
	es: msg`Spanish`,
	ar: msg`Arabic`,
}

const GENDER_LABELS: Record<Gender, MessageDescriptor> = {
	feminine: msg`Feminine`,
	masculine: msg`Masculine`,
	gender_neutral: msg`Neutral`,
}

const GENDERS = Object.keys(GENDER_LABELS) as Gender[]

function isAgentLanguage(value: string | null): value is AgentLanguage {
	return SUPPORTED_AGENT_LANGUAGES.some((language) => language === value)
}

type PreviewContext = {
	previewUrl: string
	language: AgentLanguage
	agentName: string
	greeting: string
}

type PlaybackState = { voiceId: string; status: 'loading' | 'playing' } | null

/**
 * One `<audio>` element shared by every play button, so starting a preview
 * stops whatever was playing.
 */
function usePreviewPlayer({
	previewUrl,
	language,
	agentName,
	greeting,
}: PreviewContext) {
	const audioRef = useRef<HTMLAudioElement | null>(null)
	const [playback, setPlayback] = useState<PlaybackState>(null)
	const [failedVoiceId, setFailedVoiceId] = useState<string | null>(null)

	const stop = useCallback(() => {
		const audio = audioRef.current
		if (audio) {
			audio.pause()
			audio.removeAttribute('src')
			audio.load()
		}
		setPlayback(null)
	}, [])

	const play = useCallback(
		(voiceId: string) => {
			const audio = audioRef.current
			if (!audio) return
			if (playback?.voiceId === voiceId) {
				stop()
				return
			}
			const params = new URLSearchParams({
				voiceId,
				language,
				agentName: agentName.trim(),
				greeting: greeting.trim(),
			})
			setFailedVoiceId(null)
			setPlayback({ voiceId, status: 'loading' })
			audio.src = `${previewUrl}?${params.toString()}`
			audio.play().catch((error: unknown) => {
				// A newer play() or stop() interrupts this one; that's not a failure.
				if (error instanceof DOMException && error.name === 'AbortError') return
				setFailedVoiceId(voiceId)
				setPlayback(null)
			})
		},
		[agentName, greeting, language, playback?.voiceId, previewUrl, stop],
	)

	useEffect(() => stop, [stop])

	const element = (
		<audio
			ref={audioRef}
			preload="none"
			className="hidden"
			onPlaying={() =>
				setPlayback((current) =>
					current ? { ...current, status: 'playing' } : current,
				)
			}
			onEnded={() => setPlayback(null)}
			onError={() => {
				const audio = audioRef.current
				// Clearing src on stop fires an error with no source; ignore it.
				if (!audio?.getAttribute('src')) return
				setPlayback((current) => {
					if (current) setFailedVoiceId(current.voiceId)
					return null
				})
			}}
		/>
	)

	return { element, playback, failedVoiceId, play, stop }
}

function PlayButton({
	voice,
	player,
}: {
	voice: Voice
	player: ReturnType<typeof usePreviewPlayer>
}) {
	const { _ } = useLingui()
	const active = player.playback?.voiceId === voice.id
	const loading = active && player.playback?.status === 'loading'
	const voiceName = voice.name
	return (
		<Button
			type="button"
			variant="outline"
			size="icon-sm"
			aria-label={
				active ? _(msg`Stop preview`) : _(msg`Play preview of ${voiceName}`)
			}
			aria-pressed={active}
			onClick={() => player.play(voice.id)}
		>
			{loading ? <Spinner /> : <Icon name={active ? 'stop' : 'play'} />}
		</Button>
	)
}

function VoiceMeta({ voice }: { voice: Voice }) {
	const { _ } = useLingui()
	const language = isAgentLanguage(voice.language)
		? _(LANGUAGE_LABELS[voice.language])
		: voice.language?.toUpperCase()
	return (
		<span className="flex flex-wrap gap-1">
			{language ? <Badge variant="secondary">{language}</Badge> : null}
			{voice.gender ? (
				<Badge variant="outline">{_(GENDER_LABELS[voice.gender])}</Badge>
			) : null}
		</span>
	)
}

/** Loads one voice's details so the Setup page can name the saved voice. */
function useVoiceDetails(voicesUrl: string, voiceId: string, known?: Voice) {
	const [loaded, setLoaded] = useState<{
		id: string
		voice: Voice | null
	} | null>(null)

	useEffect(() => {
		if (!voiceId || known) return
		const controller = new AbortController()
		fetch(`${voicesUrl}?${new URLSearchParams({ id: voiceId }).toString()}`, {
			signal: controller.signal,
		})
			.then((response) => response.json() as Promise<VoiceListResult>)
			.then((result) =>
				setLoaded({
					id: voiceId,
					voice: result.ok ? (result.voices[0] ?? null) : null,
				}),
			)
			.catch(() => {
				if (!controller.signal.aborted) setLoaded({ id: voiceId, voice: null })
			})
		return () => controller.abort()
	}, [voicesUrl, voiceId, known])

	if (!voiceId) return { voice: null, loading: false }
	if (known) return { voice: known, loading: false }
	if (loaded?.id !== voiceId) return { voice: null, loading: true }
	return { voice: loaded.voice, loading: false }
}

type ListState = {
	voices: Voice[]
	nextCursor: string | null
	status: 'loading' | 'loading-more' | 'idle' | 'error'
}

function useVoiceSearch(
	voicesUrl: string,
	filters: { query: string; language: string; gender: string },
) {
	const [state, setState] = useState<ListState>({
		voices: [],
		nextCursor: null,
		status: 'loading',
	})
	const requestRef = useRef<AbortController | null>(null)

	const load = useCallback(
		(cursor: string | null) => {
			requestRef.current?.abort()
			const controller = new AbortController()
			requestRef.current = controller
			const params = new URLSearchParams()
			if (filters.query.trim()) params.set('q', filters.query.trim())
			if (filters.language !== ANY) params.set('language', filters.language)
			if (filters.gender !== ANY) params.set('gender', filters.gender)
			if (cursor) params.set('cursor', cursor)
			setState((current) =>
				cursor
					? { ...current, status: 'loading-more' }
					: { voices: [], nextCursor: null, status: 'loading' },
			)
			fetch(`${voicesUrl}?${params.toString()}`, { signal: controller.signal })
				.then((response) => response.json() as Promise<VoiceListResult>)
				.then((result) => {
					if (!result.ok) throw new Error(result.error)
					setState((current) => ({
						voices: cursor
							? [
									...current.voices,
									...result.voices.filter(
										(voice) =>
											!current.voices.some((seen) => seen.id === voice.id),
									),
								]
							: result.voices,
						nextCursor: result.nextCursor,
						status: 'idle',
					}))
				})
				.catch(() => {
					if (controller.signal.aborted) return
					setState((current) => ({ ...current, status: 'error' }))
				})
		},
		[voicesUrl, filters.query, filters.language, filters.gender],
	)

	useEffect(() => {
		const timer = setTimeout(() => load(null), SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [load])

	useEffect(() => () => requestRef.current?.abort(), [])

	return { ...state, load }
}

function VoiceLibraryDialog({
	voicesUrl,
	selectedId,
	defaultLanguage,
	canPreview,
	player,
	onSelect,
	onClose,
}: {
	voicesUrl: string
	selectedId: string
	defaultLanguage: AgentLanguage
	canPreview: boolean
	player: ReturnType<typeof usePreviewPlayer>
	onSelect: (voice: Voice) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [query, setQuery] = useState('')
	const [language, setLanguage] = useState<string>(defaultLanguage)
	const [gender, setGender] = useState<string>(ANY)
	const search = useVoiceSearch(voicesUrl, { query, language, gender })
	const { stop } = player

	const languageItems = [
		{ value: ANY, label: _(msg`Any language`) },
		...SUPPORTED_AGENT_LANGUAGES.map((value) => ({
			value,
			label: _(LANGUAGE_LABELS[value]),
		})),
	]
	const genderItems = [
		{ value: ANY, label: _(msg`Any voice type`) },
		...GENDERS.map((value) => ({ value, label: _(GENDER_LABELS[value]) })),
	]

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) {
					stop()
					onClose()
				}
			}}
		>
			<DialogContent className="flex max-h-dvh flex-col sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						<Trans>Choose a voice</Trans>
					</DialogTitle>
					<DialogDescription>
						{canPreview ? (
							<Trans>
								Press play to hear each voice read your greeting, then pick the
								one you like.
							</Trans>
						) : (
							<Trans>Browse the voices your agent can use.</Trans>
						)}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-2 sm:flex-row">
					<InputGroup className="sm:flex-1">
						<InputGroupAddon>
							<Icon name="search" />
						</InputGroupAddon>
						<InputGroupInput
							type="search"
							value={query}
							maxLength={100}
							placeholder={_(msg`Search voices`)}
							aria-label={_(msg`Search voices`)}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</InputGroup>
					<Select
						value={language}
						items={languageItems}
						onValueChange={(value) => {
							if (value) setLanguage(String(value))
						}}
					>
						<SelectTrigger
							aria-label={_(msg`Language`)}
							className="w-full sm:w-40"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{languageItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={gender}
						items={genderItems}
						onValueChange={(value) => {
							if (value) setGender(String(value))
						}}
					>
						<SelectTrigger
							aria-label={_(msg`Voice type`)}
							className="w-full sm:w-40"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{genderItems.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<ScrollArea className="min-h-0 flex-1">
					<div
						className="flex min-h-64 flex-col gap-3 pe-3"
						aria-busy={search.status === 'loading'}
					>
						{search.status === 'loading' ? (
							<div className="flex flex-1 items-center justify-center py-10">
								<Spinner />
								<span className="sr-only">
									<Trans>Loading voices</Trans>
								</span>
							</div>
						) : search.status === 'error' && search.voices.length === 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyTitle>
										<Trans>Couldn't load voices</Trans>
									</EmptyTitle>
									<EmptyDescription>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => search.load(null)}
										>
											<Trans>Try again</Trans>
										</Button>
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : search.voices.length === 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyTitle>
										<Trans>No voices match</Trans>
									</EmptyTitle>
									<EmptyDescription>
										<Trans>Try another search or clear the filters.</Trans>
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : (
							<ItemGroup className="gap-2">
								{search.voices.map((voice) => {
									const selected = voice.id === selectedId
									return (
										<Item
											key={voice.id}
											variant={selected ? 'muted' : 'outline'}
											size="sm"
										>
											<ItemContent>
												<ItemTitle>
													{voice.name}
													<VoiceMeta voice={voice} />
												</ItemTitle>
												{voice.description || voice.tagline ? (
													<ItemDescription>
														{voice.description ?? voice.tagline}
													</ItemDescription>
												) : null}
												{player.failedVoiceId === voice.id ? (
													<p role="alert" className="text-destructive text-xs">
														<Trans>This preview couldn't play.</Trans>
													</p>
												) : null}
											</ItemContent>
											<ItemActions>
												{canPreview ? (
													<PlayButton voice={voice} player={player} />
												) : null}
												<Button
													type="button"
													size="sm"
													variant={selected ? 'secondary' : 'default'}
													aria-pressed={selected}
													onClick={() => {
														stop()
														onSelect(voice)
													}}
												>
													{selected ? (
														<>
															<Icon name="check" />
															<Trans>Selected</Trans>
														</>
													) : (
														<Trans>Use this voice</Trans>
													)}
												</Button>
											</ItemActions>
										</Item>
									)
								})}
							</ItemGroup>
						)}

						{search.voices.length > 0 && search.nextCursor ? (
							<div className="flex flex-col items-center gap-1 pb-1">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={search.status === 'loading-more'}
									onClick={() => search.load(search.nextCursor)}
								>
									{search.status === 'loading-more' ? <Spinner /> : null}
									<Trans>Load more voices</Trans>
								</Button>
								{search.status === 'error' ? (
									<p role="alert" className="text-destructive text-xs">
										<Trans>Couldn't load more voices. Try again.</Trans>
									</p>
								) : null}
							</div>
						) : null}
					</div>
				</ScrollArea>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							stop()
							onClose()
						}}
					>
						<Trans>Close</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/**
 * Lets owners hear voices from Cartesia's library (reading their own greeting)
 * and pick one. `voiceId` is empty for the default voice.
 */
export function VoicePicker({
	base,
	voiceId,
	onChange,
	disabled,
	canPreview,
	language,
	agentName,
	greeting,
	error,
}: {
	/** `/${orgSlug}/phone-agent` */
	base: string
	voiceId: string
	onChange: (voiceId: string) => void
	disabled: boolean
	canPreview: boolean
	language: AgentLanguage
	agentName: string
	greeting: string
	error?: string
}) {
	const voicesUrl = `${base}/voices`
	const [open, setOpen] = useState(false)
	const [picked, setPicked] = useState<Voice | null>(null)
	const player = usePreviewPlayer({
		previewUrl: `${base}/voice-preview`,
		language,
		agentName,
		greeting,
	})
	const known = picked?.id === voiceId ? picked : undefined
	const current = useVoiceDetails(voicesUrl, voiceId, known)

	return (
		<div className="flex flex-col gap-1.5">
			{player.element}
			<Label id="phone-agent-voice-label">
				<Trans>Voice</Trans>
			</Label>
			<Item
				variant="outline"
				size="sm"
				aria-labelledby="phone-agent-voice-label"
				role="group"
			>
				<ItemContent>
					<ItemTitle>
						{!voiceId ? (
							<Trans>Default voice</Trans>
						) : current.loading ? (
							<Trans>Loading voice…</Trans>
						) : current.voice ? (
							<>
								{current.voice.name}
								<VoiceMeta voice={current.voice} />
							</>
						) : (
							<Trans>Custom voice</Trans>
						)}
					</ItemTitle>
					<ItemDescription>
						{!voiceId ? (
							<Trans>The standard voice for your agent's language.</Trans>
						) : current.voice ? (
							(current.voice.description ?? current.voice.tagline ?? voiceId)
						) : (
							voiceId
						)}
					</ItemDescription>
					{voiceId && player.failedVoiceId === voiceId && !open ? (
						<p role="alert" className="text-destructive text-xs">
							<Trans>This preview couldn't play.</Trans>
						</p>
					) : null}
				</ItemContent>
				<ItemActions>
					{canPreview && voiceId && current.voice ? (
						<PlayButton voice={current.voice} player={player} />
					) : null}
					{voiceId ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={disabled}
							onClick={() => {
								player.stop()
								onChange('')
							}}
						>
							<Trans>Use default</Trans>
						</Button>
					) : null}
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={disabled}
						onClick={() => {
							player.stop()
							setOpen(true)
						}}
					>
						<Icon name="mic" />
						{voiceId ? (
							<Trans>Change voice</Trans>
						) : (
							<Trans>Choose voice</Trans>
						)}
					</Button>
				</ItemActions>
			</Item>
			{error ? (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			) : null}
			{open ? (
				<VoiceLibraryDialog
					voicesUrl={voicesUrl}
					selectedId={voiceId}
					defaultLanguage={language}
					canPreview={canPreview}
					player={player}
					onSelect={(voice) => {
						setPicked(voice)
						onChange(voice.id)
						setOpen(false)
					}}
					onClose={() => setOpen(false)}
				/>
			) : null}
		</div>
	)
}
