import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { PhoneCallsError } from '#app/hooks/use-phone-calls.ts'

const recordingLinkSchema = z.object({
	url: z.string().url(),
	expiresAt: z.string(),
})

type PlayerState =
	| { status: 'loading' }
	| { status: 'ready'; url: string }
	| { status: 'error'; message: string; retry: boolean }

/**
 * Plays a call recording from the short-lived link tenant-api signs; the audio
 * streams from the bucket straight to this browser. A link that expired while
 * the sheet stayed open is renewed once, keeping the listener's position.
 */
export function CallRecordingPlayer({
	callId,
	request,
}: {
	callId: string
	request: (path: string, init?: RequestInit) => Promise<unknown>
}) {
	const { _ } = useLingui()
	const [state, setState] = useState<PlayerState>({ status: 'loading' })
	const [attempt, setAttempt] = useState(0)
	const audioRef = useRef<HTMLAudioElement>(null)
	const resumeAt = useRef<number | null>(null)
	const renewed = useRef(false)

	useEffect(() => {
		const controller = new AbortController()
		setState((current) =>
			current.status === 'ready' ? current : { status: 'loading' },
		)
		void request(`/${encodeURIComponent(callId)}/recording`, {
			signal: controller.signal,
		})
			.then((payload) => {
				if (controller.signal.aborted) return
				const link = recordingLinkSchema.parse(payload)
				setState({ status: 'ready', url: link.url })
			})
			.catch((cause: unknown) => {
				if (controller.signal.aborted) return
				const status = cause instanceof PhoneCallsError ? cause.status : null
				setState(
					status === 404
						? {
								status: 'error',
								message: _(msg`This recording is no longer available.`),
								retry: false,
							}
						: status === 503
							? {
									status: 'error',
									message: _(
										msg`Recording playback isn't set up for your account yet.`,
									),
									retry: false,
								}
							: {
									status: 'error',
									message: _(msg`Couldn't load the recording. Try again.`),
									retry: true,
								},
				)
			})
		return () => controller.abort()
	}, [callId, request, attempt, _])

	useEffect(() => {
		renewed.current = false
		resumeAt.current = null
	}, [callId])

	const onAudioError = useCallback(() => {
		// A signed link stops working after a few minutes; get a fresh one once.
		if (renewed.current) {
			setState({
				status: 'error',
				message: _(msg`This recording couldn't be played.`),
				retry: true,
			})
			return
		}
		renewed.current = true
		resumeAt.current = audioRef.current?.currentTime ?? null
		setAttempt((value) => value + 1)
	}, [_])

	return (
		<section
			aria-labelledby="call-recording-heading"
			className="flex flex-col gap-2"
		>
			<h3
				id="call-recording-heading"
				className="flex items-center gap-2 text-sm font-medium"
			>
				<Trans>Recording</Trans>
				<Badge variant="outline">
					<Icon name="mic" />
					<Trans>Recorded</Trans>
				</Badge>
			</h3>
			{state.status === 'loading' ? (
				<Skeleton className="h-10 w-full" />
			) : state.status === 'ready' ? (
				// No captions track: the transcript below has the words.
				<audio
					ref={audioRef}
					key={state.url}
					src={state.url}
					controls
					preload="metadata"
					className="w-full"
					aria-label={_(msg`Call recording`)}
					onLoadedMetadata={(event) => {
						if (resumeAt.current !== null) {
							event.currentTarget.currentTime = resumeAt.current
							resumeAt.current = null
						}
					}}
					onPlaying={() => {
						// Playing again means the current link works; allow one more renewal.
						renewed.current = false
					}}
					onError={onAudioError}
				/>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<p role="alert" className="text-muted-foreground text-sm">
						{state.message}
					</p>
					{state.retry ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								renewed.current = false
								setAttempt((value) => value + 1)
							}}
						>
							<Trans>Try again</Trans>
						</Button>
					) : null}
				</div>
			)}
		</section>
	)
}
