import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	HERO_VIDEO_MAX_PHOTOS,
	HERO_VIDEO_MIN_PHOTOS,
	type HeroVideoStyle,
} from '@repo/common/hero-video'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

type Generation = {
	id: string
	style: string
	status: string
	durationSeconds: number
	error: string | null
	videoUrl: string | null
	posterUrl: string | null
}

type ListData = {
	rendererReady: boolean
	limit: number
	usedToday: number
	generations: Generation[]
}

type Photo = {
	id: string
	url: string
	altText: string | null
	fileName: string | null
}

const ERRORS = {
	hero_video_disabled: msg`Hero videos are not turned on for your account.`,
	renderer_not_configured: msg`Making videos is not available yet. Please try again later.`,
	invalid_style: msg`Choose a style.`,
	not_enough_photos: msg`Choose at least three photos, or let Menuza choose.`,
	too_many_photos: msg`Choose at most six photos.`,
	invalid_photos: msg`One of the photos cannot be used. Pick photos from your media library.`,
	asset_not_ready: msg`One of the photos is still being prepared.`,
	daily_limit: msg`You have reached today's limit. Try again tomorrow.`,
	already_running: msg`A video is already being made. Wait for it to finish.`,
	not_found: msg`That video is no longer there.`,
	not_ready: msg`That video is not ready.`,
} as const

/**
 * "Make a video from my photos" on the hero section (#301). The operator picks
 * 3 to 6 of the restaurant's own photos (or lets Menuza choose, preferring the
 * ones tagged Featured) and a style. A background job makes a silent, looping
 * clip; the operator is told when it is ready, watches the preview, and only
 * then accepts it. The hero on the site stays as it is until they do.
 */
export function HeroVideoMaker({
	orgSlug,
	pageId,
	sectionId,
	onAccepted,
}: {
	orgSlug: string
	pageId: string
	sectionId: string
	/** The hero section's config now uses the clip: reload it. */
	onAccepted: (video: { videoSrc: string; videoPoster: string }) => void
}) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const [mode, setMode] = useState<'pick' | 'auto'>('auto')
	const [style, setStyle] = useState<HeroVideoStyle>('slow_pans')
	const [selected, setSelected] = useState<string[]>([])
	const library = useFetcher<{ assets?: Photo[] }>()
	const list = useFetcher<ListData>()
	const actor = useFetcher<{
		ok: boolean
		error?: string
		videoSrc?: string
		videoPoster?: string
	}>()
	const base = `/${orgSlug}/website/hero-video`
	const lastAccepted = useRef<string | null>(null)

	useEffect(() => {
		if (!open) return
		void list.load(base)
		void library.load(`/${orgSlug}/media?index&picker=1`)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only when opened
	}, [open, base, orgSlug])

	const generations = list.data?.generations ?? []
	const working = generations.some(
		(generation) =>
			generation.status === 'queued' || generation.status === 'rendering',
	)
	// While a clip is being made, look again every few seconds.
	useEffect(() => {
		if (!open || !working) return
		const timer = window.setInterval(() => void list.load(base), 5000)
		return () => window.clearInterval(timer)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- list is stable enough
	}, [open, working, base])

	// An accepted clip is now in the section: hand it back to the editor once.
	useEffect(() => {
		const data = actor.data
		if (data?.ok && data.videoSrc && data.videoPoster) {
			const key = data.videoSrc
			if (lastAccepted.current === key) return
			lastAccepted.current = key
			onAccepted({ videoSrc: data.videoSrc, videoPoster: data.videoPoster })
			void list.load(base)
		} else if (data?.ok) {
			void list.load(base)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the answer only
	}, [actor.data])

	const photos = library.data?.assets ?? []
	const canStart =
		actor.state === 'idle' &&
		!working &&
		(mode === 'auto' ||
			(selected.length >= HERO_VIDEO_MIN_PHOTOS &&
				selected.length <= HERO_VIDEO_MAX_PHOTOS))
	const error =
		actor.data && !actor.data.ok && actor.data.error
			? _(
					ERRORS[
						(actor.data.error in ERRORS
							? actor.data.error
							: 'not_found') as keyof typeof ERRORS
					],
				)
			: null

	const styles: Array<{ id: HeroVideoStyle; title: string; text: string }> = [
		{
			id: 'slow_pans',
			title: _(msg`Slow pans`),
			text: _(msg`A gentle drift across each photo, blending into the next.`),
		},
		{
			id: 'quick_cuts',
			title: _(msg`Quick cuts`),
			text: _(msg`Short shots that cut from photo to photo.`),
		},
		{
			id: 'warm_fade',
			title: _(msg`Warm fade`),
			text: _(msg`Slow zooms that fade softly, with a warm tone.`),
		},
	]
	const styleName = (id: string) =>
		styles.find((entry) => entry.id === id)?.title ?? id

	return (
		<>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => setOpen(true)}
			>
				<Icon name="play" className="size-3.5" />
				<Trans>Make a video from my photos</Trans>
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							<Trans>Make a video from my photos</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								We turn your own photos into a short, silent, looping clip for
								your hero. Your site keeps its current hero until you accept the
								preview.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					{list.data && !list.data.rendererReady ? (
						<p
							role="status"
							className="text-muted-foreground bg-muted rounded-lg px-3 py-2 text-sm"
						>
							<Trans>
								Making videos is not available yet. Please try again later.
							</Trans>
						</p>
					) : null}

					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">
							<Trans>Photos</Trans>
						</legend>
						<RadioGroup
							value={mode}
							onValueChange={(value) => setMode(value as 'pick' | 'auto')}
							className="sm:grid-cols-2"
							aria-label={_(msg`How to choose photos`)}
						>
							<ChoiceCard>
								<RadioGroupItem value="auto" />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<Trans>Let Menuza choose</Trans>
									</ChoiceCardTitle>
									<ChoiceCardDescription>
										<Trans>
											Your best dish and room photos, Featured ones first.
										</Trans>
									</ChoiceCardDescription>
								</ChoiceCardContent>
							</ChoiceCard>
							<ChoiceCard>
								<RadioGroupItem value="pick" />
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<Trans>I will pick them</Trans>
									</ChoiceCardTitle>
									<ChoiceCardDescription>
										<Trans>3 to 6 photos from your media library.</Trans>
									</ChoiceCardDescription>
								</ChoiceCardContent>
							</ChoiceCard>
						</RadioGroup>
						{mode === 'pick' ? (
							<div className="space-y-2">
								<p className="text-muted-foreground text-xs" role="status">
									<ChosenLine count={selected.length} />
								</p>
								{photos.length === 0 ? (
									<p className="text-muted-foreground text-sm">
										<Trans>Your media library has no photos yet.</Trans>
									</p>
								) : (
									<ul className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
										{photos.map((photo) => {
											const chosen = selected.includes(photo.id)
											const label = photo.altText || photo.fileName || ''
											return (
												<li key={photo.id}>
													<button
														type="button"
														aria-pressed={chosen}
														aria-label={label || _(msg`Photo`)}
														disabled={
															!chosen &&
															selected.length >= HERO_VIDEO_MAX_PHOTOS
														}
														onClick={() =>
															setSelected((current) =>
																current.includes(photo.id)
																	? current.filter((id) => id !== photo.id)
																	: [...current, photo.id],
															)
														}
														className={cn(
															'bg-muted relative block aspect-square w-full overflow-hidden rounded-md border-2 disabled:opacity-40',
															chosen ? 'border-primary' : 'border-transparent',
														)}
													>
														<img
															src={photo.url}
															alt=""
															loading="lazy"
															className="size-full object-cover"
														/>
														{chosen ? (
															<span className="bg-primary text-primary-foreground absolute top-1 left-1 flex size-5 items-center justify-center rounded-full text-[10px] tabular-nums">
																{selected.indexOf(photo.id) + 1}
															</span>
														) : null}
													</button>
												</li>
											)
										})}
									</ul>
								)}
							</div>
						) : null}
					</fieldset>

					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">
							<Trans>Style</Trans>
						</legend>
						<RadioGroup
							value={style}
							onValueChange={(value) => setStyle(value as HeroVideoStyle)}
							className="sm:grid-cols-3"
							aria-label={_(msg`Video style`)}
						>
							{styles.map((entry) => (
								<ChoiceCard key={entry.id}>
									<RadioGroupItem value={entry.id} />
									<ChoiceCardContent>
										<ChoiceCardTitle>{entry.title}</ChoiceCardTitle>
										<ChoiceCardDescription>{entry.text}</ChoiceCardDescription>
									</ChoiceCardContent>
								</ChoiceCard>
							))}
						</RadioGroup>
					</fieldset>

					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}

					<div className="flex items-center justify-between gap-3">
						<p className="text-muted-foreground text-xs">
							{list.data ? (
								<UsageLine used={list.data.usedToday} limit={list.data.limit} />
							) : null}
						</p>
						<Button
							type="button"
							disabled={!canStart || list.data?.rendererReady === false}
							onClick={() => {
								const form = new FormData()
								form.set('intent', 'start')
								form.set('style', style)
								form.set('pageId', pageId)
								if (mode === 'auto') form.set('auto', 'true')
								else for (const id of selected) form.append('photoAssetIds', id)
								void actor.submit(form, { method: 'POST', action: base })
								window.setTimeout(() => void list.load(base), 600)
							}}
						>
							<Trans>Make video</Trans>
						</Button>
					</div>

					{generations.length ? (
						<section
							aria-label={_(msg`Your videos`)}
							className="space-y-4 border-t pt-4"
						>
							{generations.slice(0, 3).map((generation) => (
								<div
									key={generation.id}
									className="space-y-2"
									data-testid="hero-video-generation"
								>
									<p className="text-sm font-medium">
										{styleName(generation.style)}
										<span className="text-muted-foreground ms-2 text-xs font-normal">
											{generation.durationSeconds}s
										</span>
									</p>
									{generation.status === 'queued' ||
									generation.status === 'rendering' ? (
										<p
											role="status"
											className="text-muted-foreground flex items-center gap-2 text-sm"
										>
											<Icon name="loader" className="size-4 animate-spin" />
											<Trans>
												Making your video. We will tell you when it is ready;
												you can close this.
											</Trans>
										</p>
									) : null}
									{generation.status === 'failed' ? (
										<p role="alert" className="text-destructive text-sm">
											<Trans>
												This video could not be made. Your site did not change.
											</Trans>
										</p>
									) : null}
									{generation.status === 'ready' && generation.videoUrl ? (
										<div className="space-y-2">
											<video
												src={generation.videoUrl}
												poster={generation.posterUrl ?? undefined}
												controls
												muted
												loop
												playsInline
												className="aspect-video w-full rounded-lg bg-black"
											/>
											<p className="text-muted-foreground text-xs">
												<Trans>
													Made from your own photos. Visitors who prefer less
													motion see the still image instead.
												</Trans>
											</p>
											<div className="flex gap-2">
												<Button
													type="button"
													size="sm"
													disabled={actor.state !== 'idle'}
													onClick={() => {
														const form = new FormData()
														form.set('intent', 'accept')
														form.set('generationId', generation.id)
														form.set('sectionId', sectionId)
														void actor.submit(form, {
															method: 'POST',
															action: base,
														})
													}}
												>
													<Trans>Use this video</Trans>
												</Button>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													disabled={actor.state !== 'idle'}
													onClick={() => {
														const form = new FormData()
														form.set('intent', 'discard')
														form.set('generationId', generation.id)
														void actor.submit(form, {
															method: 'POST',
															action: base,
														})
													}}
												>
													<Trans>Discard</Trans>
												</Button>
											</div>
										</div>
									) : null}
									{generation.status === 'accepted' ? (
										<p className="text-muted-foreground text-sm">
											<Trans>In use. Publish your page to make it live.</Trans>
										</p>
									) : null}
								</div>
							))}
						</section>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							<Trans>Close</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}

function UsageLine({ used, limit }: { used: number; limit: number }) {
	return (
		<Trans>
			{used} of {limit} videos made today
		</Trans>
	)
}

function ChosenLine({ count }: { count: number }) {
	const min = HERO_VIDEO_MIN_PHOTOS
	const max = HERO_VIDEO_MAX_PHOTOS
	return (
		<Trans>
			{count} of {min} to {max} chosen
		</Trans>
	)
}
