import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	PHOTO_TEST_MIN_DAYS,
	PHOTO_TEST_MIN_VIEWS,
	type PhotoTestOutcome,
	type PhotoVariant,
	type PhotoVariantCounts,
} from '@repo/common/photo-test'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { useEffect } from 'react'
import { useFetcher, useRevalidator } from 'react-router'
import { toast } from 'sonner'
import {
	MediaLibraryPicker,
	type MediaLibraryAsset,
} from '#app/components/media-library/media-library-picker.tsx'

export type PanelTest = {
	id: string
	imageKeyA: string
	imageKeyB: string
	startedAt: string
	endedAt: string | null
	winner: PhotoVariant | null
	endedReason: string | null
	counts: Record<PhotoVariant, PhotoVariantCounts>
	outcome: PhotoTestOutcome | null
	needs: { viewsA: number; viewsB: number; days: number }
}

type ActionData = { ok: boolean; error?: string }

const ERRORS: Record<string, ReturnType<typeof msg>> = {
	too_many_tests: msg`You can test up to 20 dishes at once. End one first.`,
	test_running: msg`This dish already has a test running.`,
	same_photo: msg`Pick a different photo from the one the dish has now.`,
	asset_not_ready: msg`That photo is not ready to use yet.`,
	photo_changed: msg`The dish photo changed since the test started.`,
	no_photo: msg`Add a photo to the dish first.`,
}

/**
 * Menu item, Photo: "Try another photo" (#192). Half of the visitors see each
 * photo; views, adds to cart and orders show per photo, and after enough data
 * the winner is named and can be kept. Ending never deletes the other photo.
 */
export function PhotoTestPanel({
	orgSlug,
	itemId,
	tests,
	urls,
}: {
	orgSlug: string
	itemId: string
	tests: PanelTest[]
	urls: Record<string, string>
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<ActionData>()
	const revalidator = useRevalidator()
	const action = `/${orgSlug}/menu/items/${itemId}/photo-test`
	const running = tests.find((test) => !test.endedAt) ?? null
	const past = tests.filter((test) => test.endedAt).slice(0, 3)
	const busy = fetcher.state !== 'idle'

	useEffect(() => {
		if (!fetcher.data) return
		if (fetcher.data.ok) void revalidator.revalidate()
		else
			toast.error(
				fetcher.data.error && ERRORS[fetcher.data.error]
					? _(ERRORS[fetcher.data.error]!)
					: _(msg`The photo test could not be changed.`),
			)
	}, [_, fetcher.data, revalidator])

	function start(asset: MediaLibraryAsset) {
		const form = new FormData()
		form.set('intent', 'start')
		form.set('assetId', asset.id)
		void fetcher.submit(form, { method: 'POST', action })
	}
	function end(testId: string, choice: 'A' | 'B' | 'stop') {
		const form = new FormData()
		form.set('intent', 'end')
		form.set('testId', testId)
		form.set('choice', choice)
		void fetcher.submit(form, { method: 'POST', action })
	}

	return (
		<Card data-testid="photo-test-panel">
			<CardHeader>
				<CardTitle>
					<Trans>Test another photo</Trans>
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				{running ? (
					<RunningTest
						test={running}
						urls={urls}
						busy={busy}
						onEnd={(choice) => end(running.id, choice)}
					/>
				) : (
					<div className="space-y-2">
						<p className="text-muted-foreground text-sm">
							<Trans>
								Show a second photo to half of your visitors and keep the one
								that gets more orders. The photo you replace stays in your media
								library.
							</Trans>
						</p>
						<MediaLibraryPicker
							orgSlug={orgSlug}
							disabled={busy}
							triggerLabel={<Trans>Try another photo</Trans>}
							onSelect={start}
						/>
					</div>
				)}
				{past.length > 0 ? (
					<ul className="space-y-1 text-sm" aria-label={_(msg`Past tests`)}>
						{past.map((test) => (
							<li key={test.id} className="text-muted-foreground">
								{test.winner === 'B' ? (
									<Trans>Kept the new photo</Trans>
								) : test.winner === 'A' ? (
									<Trans>Kept the original photo</Trans>
								) : (
									<Trans>Stopped without a change</Trans>
								)}
								{' · '}
								{new Date(test.endedAt!).toLocaleDateString()}
							</li>
						))}
					</ul>
				) : null}
			</CardContent>
		</Card>
	)
}

function RunningTest({
	test,
	urls,
	busy,
	onEnd,
}: {
	test: PanelTest
	urls: Record<string, string>
	busy: boolean
	onEnd: (choice: 'A' | 'B' | 'stop') => void
}) {
	const { _ } = useLingui()
	const outcome = test.outcome
	const winner = outcome?.status === 'winner' ? outcome.winner : null
	const lift = outcome?.status === 'winner' ? outcome.liftPercent : null
	const decided = outcome?.status === 'winner' || outcome?.status === 'tie'
	return (
		<div className="space-y-3">
			<div className="grid grid-cols-2 gap-3">
				{(['A', 'B'] as const).map((variant) => {
					const counts = test.counts[variant]
					const key = variant === 'A' ? test.imageKeyA : test.imageKeyB
					const isWinner =
						outcome?.status === 'winner' && outcome.winner === variant
					return (
						<figure key={variant} className="space-y-2">
							<div className="bg-muted relative aspect-square overflow-hidden rounded-md border">
								{urls[key] ? (
									<img
										src={`${urls[key]}&w=320&h=320&fit=cover`}
										alt={
											variant === 'A'
												? _(msg`Photo A, the current photo`)
												: _(msg`Photo B, the new photo`)
										}
										className="size-full object-cover"
									/>
								) : null}
								<Badge
									variant={isWinner ? 'success' : 'secondary'}
									className="absolute start-2 top-2"
								>
									{variant === 'A' ? (
										<Trans>Photo A</Trans>
									) : (
										<Trans>Photo B</Trans>
									)}
								</Badge>
							</div>
							<dl className="grid grid-cols-3 gap-1 text-center text-xs">
								<div>
									<dt className="text-muted-foreground">
										<Trans>Views</Trans>
									</dt>
									<dd className="font-medium tabular-nums">{counts.views}</dd>
								</div>
								<div>
									<dt className="text-muted-foreground">
										<Trans>Adds to cart</Trans>
									</dt>
									<dd className="font-medium tabular-nums">{counts.adds}</dd>
								</div>
								<div>
									<dt className="text-muted-foreground">
										<Trans>Orders</Trans>
									</dt>
									<dd className="font-medium tabular-nums">{counts.orders}</dd>
								</div>
							</dl>
						</figure>
					)
				})}
			</div>
			<p className="text-sm font-medium" role="status">
				{outcome === null ? (
					<Trans>Results are not available right now.</Trans>
				) : outcome.status === 'winner' ? (
					lift !== null ? (
						<Trans>
							Photo {winner}: {lift}% more orders
						</Trans>
					) : (
						<Trans>Photo {winner} got more orders</Trans>
					)
				) : outcome.status === 'tie' ? (
					<Trans>Both photos got the same share of orders.</Trans>
				) : (
					<NotEnough test={test} />
				)}
			</p>
			<div className="flex flex-wrap gap-2">
				{decided ? (
					<>
						<Button type="button" disabled={busy} onClick={() => onEnd('B')}>
							<Trans>Keep B</Trans>
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => onEnd('A')}
						>
							<Trans>Keep A</Trans>
						</Button>
					</>
				) : (
					<Button
						type="button"
						variant="outline"
						disabled={busy}
						onClick={() => onEnd('stop')}
					>
						<Trans>Stop test and keep the current photo</Trans>
					</Button>
				)}
			</div>
		</div>
	)
}

function NotEnough({ test }: { test: PanelTest }) {
	const views = Math.max(test.needs.viewsA, test.needs.viewsB)
	return (
		<span>
			<Trans>Not enough data yet.</Trans>{' '}
			<span className="text-muted-foreground font-normal">
				<Trans>
					A winner needs {PHOTO_TEST_MIN_VIEWS} views of each photo and{' '}
					{PHOTO_TEST_MIN_DAYS} days.
				</Trans>{' '}
				{views > 0 ? (
					<Plural
						value={views}
						one="# more view to go."
						other="# more views to go."
					/>
				) : null}{' '}
				{test.needs.days > 0 ? (
					<Plural
						value={test.needs.days}
						one="# day to go."
						other="# days to go."
					/>
				) : null}
			</span>
		</span>
	)
}
