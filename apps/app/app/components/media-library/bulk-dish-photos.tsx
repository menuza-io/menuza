import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Progress } from '@repo/ui/progress'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { BulkDropZone } from '#app/components/media-library/bulk-drop-zone.tsx'
import { BulkFileList } from '#app/components/media-library/bulk-file-list.tsx'
import { BulkReviewGrid } from '#app/components/media-library/bulk-review-grid.tsx'
import {
	uploadableEntries,
	type BulkEntry,
} from '#app/utils/media/bulk/entries.ts'
import {
	acceptIntoBatch,
	markDuplicates,
	precheckFile,
	type ImageSize,
} from '#app/utils/media/bulk/precheck.ts'
import {
	confirmedPairs,
	initialReviewState,
	setConfirmed,
	setReplace,
	skipPhoto,
	swapDish,
	unmatchedAssetIds,
	type ReviewState,
} from '#app/utils/media/bulk/review-state.ts'
import {
	type BulkApplyResponse,
	type BulkProposeResponse,
	type BulkProposeResult,
} from '#app/utils/media/bulk/types.ts'
import {
	isZipFileName,
	UnzipError,
	unzipPhotos,
} from '#app/utils/media/bulk/unzip.ts'
import {
	createUploadQueue,
	type KeyValueStore,
	type QueueSnapshot,
	type UploadQueue,
	type UploadResult,
} from '#app/utils/media/bulk/upload-queue.ts'

type Phase = 'select' | 'uploading' | 'matching' | 'review' | 'done'

type AppliedSummary = {
	applied: string[]
	refused: Array<{ itemId: string; error: string }>
	/** Photos sent in the apply, by dish. */
	assetByItem: Record<string, string>
}

type Translate = ReturnType<typeof useLingui>['_']

function zipErrorMessage(_: Translate, caught: unknown, name: string) {
	const code = caught instanceof UnzipError ? caught.code : 'corrupt'
	switch (code) {
		case 'not_a_zip':
			return _(msg`${name} is not a valid zip file.`)
		case 'zip_too_large':
			return _(msg`${name} is larger than 400 MB.`)
		case 'too_many_entries':
		case 'too_many_photos':
			return _(msg`${name} holds more than 100 photos. Split it in parts.`)
		case 'batch_too_large':
			return _(msg`The photos in ${name} add up to more than 400 MB.`)
		case 'unsupported':
			return _(
				msg`${name} uses a zip format that cannot be read here. Make a new zip with your computer's Compress option.`,
			)
		case 'no_photos':
			return _(msg`No photos were found in ${name}.`)
		default:
			return _(msg`${name} looks damaged and could not be read.`)
	}
}

function applyErrorMessage(_: Translate, code: string) {
	switch (code) {
		case 'replace_not_confirmed':
			return _(
				msg`A dish got a photo while you were reviewing, so nothing was changed. Refresh the matches and review them again.`,
			)
		case 'unknown_dish':
		case 'asset_not_found':
			return _(
				msg`A dish or a photo is no longer there, so nothing was changed. Refresh the matches and review them again.`,
			)
		default:
			return _(msg`The photos could not be added. Nothing was changed.`)
	}
}

function refusalText(_: Translate, code: string) {
	switch (code) {
		case 'photo_changed':
			return _(
				msg`Its photo changed while you were reviewing, so it was left as it is.`,
			)
		case 'not_found':
			return _(msg`The dish is no longer on the menu.`)
		case 'pos_owned':
			return _(
				msg`Its photo comes from your point of sale, so it was left as it is.`,
			)
		default:
			return _(msg`The photo could not be used.`)
	}
}

function browserStorage(): KeyValueStore | null {
	try {
		return window.localStorage
	} catch {
		return null
	}
}

async function measureImage(
	file: Pick<File, 'name'>,
): Promise<ImageSize | null> {
	if (typeof createImageBitmap !== 'function') return null
	const bitmap = await createImageBitmap(file as File)
	const size = { width: bitmap.width, height: bitmap.height }
	bitmap.close()
	return size
}

/**
 * One file to the library through the existing upload, as JSON in and out.
 * The answer's error text is the server's English; the page shows its own
 * translated words from the `error` code instead.
 */
function makeUploader(orgSlug: string) {
	const url = `/${encodeURIComponent(orgSlug)}/media/dish-photos/upload`
	return async function uploadOne(
		file: File,
		signal: AbortSignal,
	): Promise<UploadResult> {
		const body = new FormData()
		body.set('intent', 'upload')
		body.set('imageFile', file)
		let response: Response
		try {
			response = await fetch(url, {
				method: 'POST',
				body,
				signal,
				credentials: 'same-origin',
			})
		} catch (error) {
			if (signal.aborted) {
				return { ok: false, retryable: false, error: 'cancelled' }
			}
			// A dropped connection: the queue waits for it and tries again.
			throw error
		}
		let data = null as { asset?: { id?: unknown } } | null
		try {
			data = (await response.json()) as typeof data
		} catch {
			data = null
		}
		const assetId = data?.asset?.id
		if (response.ok && typeof assetId === 'string') {
			return { ok: true, assetId }
		}
		const retryable =
			response.status >= 500 ||
			response.status === 429 ||
			response.status === 408
		return { ok: false, retryable, error: retryable ? 'server' : 'refused' }
	}
}

/**
 * Add dish photos in bulk (#316): drop photos or a zip, see the early checks,
 * upload to the library (resumable), review the proposed matches, apply the
 * confirmed pairs in one step. Nothing is attached to a dish before the
 * operator confirms it.
 */
export function BulkDishPhotos({
	orgSlug,
	canApply,
}: {
	orgSlug: string
	canApply: boolean
}) {
	const { _ } = useLingui()
	const proposeFetcher = useFetcher<BulkProposeResponse>()
	const applyFetcher = useFetcher<BulkApplyResponse>()

	const [phase, setPhase] = useState<Phase>('select')
	const [entries, setEntries] = useState<BulkEntry[]>([])
	const entriesRef = useRef<BulkEntry[]>([])
	entriesRef.current = entries
	const keyCounter = useRef(0)
	const [notices, setNotices] = useState<string[]>([])
	const [error, setError] = useState<string | null>(null)

	const queueRef = useRef<UploadQueue<File> | null>(null)
	const [queueSnapshot, setQueueSnapshot] =
		useState<QueueSnapshot<File> | null>(null)
	const [proposal, setProposal] = useState<BulkProposeResult | null>(null)
	const [review, setReview] = useState<ReviewState>({})
	const [summary, setSummary] = useState<AppliedSummary | null>(null)
	const handledPropose = useRef<unknown>(null)
	const handledApply = useRef<unknown>(null)
	const lastPairs = useRef<Record<string, string>>({})

	useEffect(() => () => queueRef.current?.stop(), [])

	/** Later copies of the same content are flagged; the first stays clean. */
	const refreshDuplicates = useCallback(() => {
		setEntries((current) =>
			markDuplicates(
				current.map((entry) => ({
					...entry,
					flags: entry.flags.filter((flag) => flag !== 'duplicate'),
				})),
			),
		)
	}, [])

	const addFiles = useCallback(
		async (picked: File[]) => {
			const messages: string[] = []
			const incoming: File[] = []
			for (const file of picked) {
				if (isZipFileName(file.name)) {
					try {
						const result = await unzipPhotos(file)
						incoming.push(...result.files)
						const skippedCount = result.skipped.length
						const fileName = file.name
						if (skippedCount > 0) {
							messages.push(
								_(
									msg`${skippedCount} files in ${fileName} were left out because they are not photos, are too large or could not be read.`,
								),
							)
						}
					} catch (caught) {
						messages.push(zipErrorMessage(_, caught, file.name))
					}
				} else {
					incoming.push(file)
				}
			}
			const { accepted, tooMany, tooBig } = acceptIntoBatch(
				entriesRef.current,
				incoming,
			)
			const tooManyCount = tooMany.length
			const tooBigCount = tooBig.length
			if (tooManyCount > 0) {
				messages.push(
					_(
						msg`A batch holds at most 100 photos. ${tooManyCount} were not added.`,
					),
				)
			}
			if (tooBigCount > 0) {
				messages.push(
					_(
						msg`A batch holds at most 400 MB of photos. ${tooBigCount} were not added.`,
					),
				)
			}
			setNotices(messages)
			if (accepted.length === 0) return

			const fresh: BulkEntry[] = accepted.map((file) => ({
				key: `e${keyCounter.current++}`,
				file,
				name: file.name,
				size: file.size,
				check: 'checking',
				hash: null,
				flags: [],
				queueId: null,
			}))
			setEntries((current) => [...current, ...fresh])
			for (const entry of fresh) {
				const result = await precheckFile(entry.file, measureImage)
				setEntries((current) =>
					current.map((candidate) =>
						candidate.key === entry.key
							? {
									...candidate,
									check: 'done',
									hash: result.hash,
									flags: result.flags,
								}
							: candidate,
					),
				)
			}
			refreshDuplicates()
		},
		[_, refreshDuplicates],
	)

	function removeEntry(key: string) {
		setEntries((current) => current.filter((entry) => entry.key !== key))
		refreshDuplicates()
	}

	const runPropose = useCallback(() => {
		const queue = queueRef.current
		if (!queue) return
		const done = queue
			.snapshot()
			.items.filter((item) => item.state === 'done' && item.assetId)
		const assetIds = [...new Set(done.map((item) => item.assetId!))]
		if (assetIds.length === 0) return
		const hashes: Record<string, string> = {}
		for (const item of done) {
			if (item.hash) hashes[item.assetId!] = item.hash
		}
		setError(null)
		setPhase('matching')
		handledPropose.current = proposeFetcher.data
		void proposeFetcher.submit(
			{
				intent: 'propose',
				assetIds: JSON.stringify(assetIds),
				hashes: JSON.stringify(hashes),
			},
			{ method: 'POST' },
		)
	}, [proposeFetcher])

	function startUpload() {
		const toUpload = uploadableEntries(entries)
		if (toUpload.length === 0) return
		queueRef.current?.stop()
		const queue = createUploadQueue<File>({
			upload: makeUploader(orgSlug),
			isOnline: () =>
				typeof navigator === 'undefined' ? true : navigator.onLine,
			onOnline: (callback) => {
				window.addEventListener('online', callback)
				return () => window.removeEventListener('online', callback)
			},
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			now: () => Date.now(),
			store: browserStorage(),
			storageKey: `menuza:bulk-dish-photos:v1:${orgSlug}`,
			onChange: setQueueSnapshot,
		})
		queueRef.current = queue
		const items = queue.add(
			toUpload.map((entry) => ({ file: entry.file, hash: entry.hash })),
		)
		const queueIds = new Map(
			toUpload.map((entry, index) => [entry.key, items[index]!.id]),
		)
		setEntries((current) =>
			current.map((entry) => ({
				...entry,
				queueId: queueIds.get(entry.key) ?? null,
			})),
		)
		setPhase('uploading')
		void queue.start().then(() => {
			const counts = queue.snapshot().counts
			// Everything went through: straight on to matching. A failed file
			// waits for the operator (retry, or go on without it).
			if (counts.failed === 0 && counts.done > 0) runPropose()
		})
	}

	// The answer to "propose".
	useEffect(() => {
		const data = proposeFetcher.data
		if (
			phase !== 'matching' ||
			proposeFetcher.state !== 'idle' ||
			!data ||
			data === handledPropose.current
		) {
			return
		}
		handledPropose.current = data
		if (data.ok) {
			queueRef.current?.forget(data.ignoredAssetIds)
			setProposal(data)
			setReview(initialReviewState(data.photos, data.dishes))
			setPhase('review')
		} else {
			setError(_(msg`The photos could not be matched. Try again.`))
		}
	}, [phase, proposeFetcher.state, proposeFetcher.data, _])

	// The answer to "apply".
	useEffect(() => {
		const data = applyFetcher.data
		if (
			phase !== 'review' ||
			applyFetcher.state !== 'idle' ||
			!data ||
			data === handledApply.current
		) {
			return
		}
		handledApply.current = data
		if (data.ok) {
			setSummary({
				applied: data.applied,
				refused: data.refused,
				assetByItem: lastPairs.current,
			})
			setPhase('done')
		} else {
			setError(applyErrorMessage(_, data.error))
		}
	}, [phase, applyFetcher.state, applyFetcher.data, _])

	const dishes = useMemo(() => proposal?.dishes ?? [], [proposal])
	const pairs = useMemo(() => confirmedPairs(review, dishes), [review, dishes])
	const replaceCount = pairs.filter((pair) => pair.replace).length

	function applyPairs() {
		if (pairs.length === 0 || !canApply) return
		setError(null)
		lastPairs.current = Object.fromEntries(
			pairs.map((pair) => [pair.itemId, pair.assetId]),
		)
		handledApply.current = applyFetcher.data
		void applyFetcher.submit(
			{ intent: 'apply', pairs: JSON.stringify(pairs) },
			{ method: 'POST' },
		)
	}

	function reset() {
		queueRef.current?.stop()
		queueRef.current = null
		setQueueSnapshot(null)
		setEntries([])
		setNotices([])
		setError(null)
		setProposal(null)
		setReview({})
		setSummary(null)
		setPhase('select')
	}

	const queueItems = useMemo(
		() =>
			queueSnapshot
				? new Map(queueSnapshot.items.map((item) => [item.id, item]))
				: null,
		[queueSnapshot],
	)
	const uploadable = uploadableEntries(entries)
	const checking = entries.some((entry) => entry.check === 'checking')
	const flagCounts = {
		notPhoto: entries.filter(
			(entry) =>
				entry.flags.includes('not_an_image') ||
				entry.flags.includes('too_large'),
		).length,
		tooSmall: entries.filter((entry) => entry.flags.includes('too_small'))
			.length,
		duplicate: entries.filter((entry) => entry.flags.includes('duplicate'))
			.length,
	}
	const counts = queueSnapshot?.counts
	const total = counts
		? counts.waiting + counts.uploading + counts.done + counts.failed
		: 0
	const settled = counts ? counts.done + counts.failed : 0
	const uploadSettled =
		Boolean(counts) && counts!.waiting + counts!.uploading === 0
	const applying = applyFetcher.state !== 'idle'
	const dishNameById = new Map(dishes.map((dish) => [dish.id, dish.name]))
	const appliedAssetIds = new Set(
		summary
			? summary.applied.flatMap((itemId) => {
					const assetId = summary.assetByItem[itemId]
					return assetId ? [assetId] : []
				})
			: [],
	)
	const staysNames = (proposal?.photos ?? [])
		.filter((photo) => !appliedAssetIds.has(photo.assetId))
		.map((photo) => photo.fileName ?? _(msg`Untitled photo`))

	return (
		<main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 md:px-8 md:py-8">
			<PageHeader
				title={<Trans>Add dish photos in bulk</Trans>}
				description={
					<Trans>
						Drop a folder of photos or a zip file. Menuza proposes which dish
						each photo belongs to, and you confirm, swap or skip every one
						before anything is added.
					</Trans>
				}
				actions={
					<Button variant="outline" render={<Link to={`/${orgSlug}/media`} />}>
						<Icon name="arrow-left" className="rtl:rotate-180" />
						<Trans>Media library</Trans>
					</Button>
				}
			/>

			{error ? (
				<Alert variant="destructive">
					<Icon name="circle-alert" />
					<AlertTitle>
						<Trans>Something went wrong</Trans>
					</AlertTitle>
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			) : null}

			{notices.length > 0 ? (
				<Alert>
					<Icon name="info" />
					<AlertTitle>
						<Trans>Some files were left out</Trans>
					</AlertTitle>
					<AlertDescription>
						<ul className="list-disc ps-4">
							{notices.map((notice) => (
								<li key={notice} className="wrap-anywhere">
									{notice}
								</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			) : null}

			{phase === 'select' ? (
				<section className="space-y-4" aria-label={_(msg`Choose photos`)}>
					<BulkDropZone onFiles={(files) => void addFiles(files)} />
					{entries.length > 0 ? (
						<>
							<div role="status" className="text-muted-foreground text-sm">
								{checking ? (
									<Trans>Checking your photos…</Trans>
								) : (
									<>
										<Plural
											value={uploadable.length}
											one="# photo ready to upload."
											other="# photos ready to upload."
										/>{' '}
										{flagCounts.notPhoto > 0 ? (
											<Plural
												value={flagCounts.notPhoto}
												one="# is not a usable photo and will be left out."
												other="# are not usable photos and will be left out."
											/>
										) : null}{' '}
										{flagCounts.tooSmall > 0 ? (
											<Plural
												value={flagCounts.tooSmall}
												one="# is small and may look soft."
												other="# are small and may look soft."
											/>
										) : null}{' '}
										{flagCounts.duplicate > 0 ? (
											<Plural
												value={flagCounts.duplicate}
												one="# duplicate will be left out."
												other="# duplicates will be left out."
											/>
										) : null}
									</>
								)}
							</div>
							<BulkFileList
								entries={entries}
								queueItems={null}
								paused={false}
								onRemove={removeEntry}
							/>
							<div className="flex flex-wrap items-center gap-2">
								<Button
									type="button"
									disabled={checking || uploadable.length === 0}
									onClick={startUpload}
								>
									<Icon name="arrow-up-from-line" />
									<Plural
										value={uploadable.length}
										one="Upload # photo and find matches"
										other="Upload # photos and find matches"
									/>
								</Button>
								<Button type="button" variant="ghost" onClick={reset}>
									<Trans>Start over</Trans>
								</Button>
							</div>
						</>
					) : null}
				</section>
			) : null}

			{phase === 'uploading' ? (
				<section className="space-y-4" aria-label={_(msg`Uploading`)}>
					{queueSnapshot?.paused ? (
						<Alert>
							<Icon name="cloud-off" />
							<AlertTitle>
								<Trans>Waiting for connection</Trans>
							</AlertTitle>
							<AlertDescription>
								<Trans>
									Uploads pause while you are offline and carry on by themselves
									when the connection is back. Photos already uploaded are kept.
								</Trans>
							</AlertDescription>
						</Alert>
					) : null}
					<Progress
						value={total > 0 ? Math.round((settled / total) * 100) : 0}
						aria-label={_(msg`Upload progress`)}
					>
						<span className="text-sm font-medium" role="status">
							<Trans>
								{settled} of {total} photos uploaded
							</Trans>
						</span>
					</Progress>
					<BulkFileList
						entries={entries}
						queueItems={queueItems}
						paused={Boolean(queueSnapshot?.paused)}
					/>
					{uploadSettled && counts!.failed > 0 ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button
								type="button"
								variant="outline"
								onClick={() => {
									void queueRef.current?.retryFailed().then(() => {
										const next = queueRef.current?.snapshot().counts
										if (next && next.failed === 0 && next.done > 0) runPropose()
									})
								}}
							>
								<Icon name="refresh-cw" />
								<Trans>Retry failed photos</Trans>
							</Button>
							{counts!.done > 0 ? (
								<Button type="button" onClick={runPropose}>
									<Plural
										value={counts!.done}
										one="Go on with # uploaded photo"
										other="Go on with # uploaded photos"
									/>
								</Button>
							) : null}
						</div>
					) : null}
				</section>
			) : null}

			{phase === 'matching' ? (
				<section
					className="flex flex-col items-center gap-3 py-12 text-center"
					role="status"
				>
					<Icon name="loader" className="size-6 animate-spin" />
					<p className="text-sm">
						<Trans>Matching your photos to dishes…</Trans>
					</p>
					{error ? (
						<Button type="button" variant="outline" onClick={runPropose}>
							<Icon name="refresh-cw" />
							<Trans>Try again</Trans>
						</Button>
					) : null}
				</section>
			) : null}

			{phase === 'review' && proposal ? (
				<section className="space-y-4" aria-label={_(msg`Review matches`)}>
					<div className="space-y-1">
						<h2 className="text-lg font-semibold">
							<Trans>Review the matches</Trans>
						</h2>
						<p className="text-muted-foreground text-sm">
							<Trans>
								Nothing is added to a dish until you apply. Photos without a
								dish stay in the library.
							</Trans>
						</p>
						{proposal.vision === 'none' ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									Photos were matched by file name only, because photo
									recognition is not set up.
								</Trans>
							</p>
						) : null}
						{proposal.visionLimited ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									Photo recognition reached its hourly limit, so some photos
									were matched by file name only.
								</Trans>
							</p>
						) : null}
						{proposal.ignoredAssetIds.length > 0 ? (
							<p className="text-muted-foreground text-sm">
								<Plural
									value={proposal.ignoredAssetIds.length}
									one="# uploaded photo is no longer in the library. Drop it again to upload it."
									other="# uploaded photos are no longer in the library. Drop them again to upload them."
								/>
							</p>
						) : null}
					</div>
					<BulkReviewGrid
						photos={proposal.photos}
						dishes={proposal.dishes}
						state={review}
						onSwap={(assetId, itemId) =>
							setReview((current) => swapDish(current, assetId, itemId))
						}
						onConfirm={(assetId, confirmed) =>
							setReview((current) =>
								setConfirmed(current, assetId, confirmed, dishes),
							)
						}
						onReplace={(assetId, replace) =>
							setReview((current) =>
								setReplace(current, assetId, replace, dishes),
							)
						}
						onSkip={(assetId) =>
							setReview((current) => skipPhoto(current, assetId))
						}
					/>
					<div className="bg-background/95 sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t px-4 py-3 backdrop-blur md:-mx-8 md:px-8">
						<Button
							type="button"
							disabled={pairs.length === 0 || !canApply || applying}
							onClick={applyPairs}
						>
							<Icon
								name={applying ? 'loader' : 'check'}
								className={applying ? 'animate-spin' : undefined}
							/>
							<Plural
								value={pairs.length}
								one="Apply # photo"
								other="Apply # photos"
							/>
						</Button>
						<Button type="button" variant="outline" onClick={runPropose}>
							<Icon name="refresh-cw" />
							<Trans>Refresh matches</Trans>
						</Button>
						<p className="text-muted-foreground text-sm" role="status">
							{!canApply ? (
								<Trans>
									You need permission to edit the menu to add photos to dishes.
								</Trans>
							) : (
								<>
									{replaceCount > 0 ? (
										<Plural
											value={replaceCount}
											one="# replaces an existing dish photo. "
											other="# replace existing dish photos. "
										/>
									) : null}
									<Plural
										value={unmatchedAssetIds(review).length}
										one="# photo stays in the library."
										other="# photos stay in the library."
									/>
								</>
							)}
						</p>
					</div>
				</section>
			) : null}

			{phase === 'done' && summary ? (
				<section className="space-y-6" aria-label={_(msg`Result`)}>
					<Alert>
						<Icon name="circle-check" />
						<AlertTitle>
							<Plural
								value={summary.applied.length}
								one="# photo added to a dish"
								other="# photos added to dishes"
							/>
						</AlertTitle>
						<AlertDescription>
							<Trans>
								The previous photo of a replaced dish stays in your media
								library.
							</Trans>
						</AlertDescription>
					</Alert>

					{summary.refused.length > 0 ? (
						<div className="space-y-2">
							<h2 className="text-base font-semibold">
								<Trans>Not changed</Trans>
							</h2>
							<ul className="divide-border bg-card divide-y rounded-xl border">
								{summary.refused.map((item) => (
									<li key={item.itemId} className="px-3 py-2 text-sm">
										<span className="font-medium wrap-anywhere">
											{dishNameById.get(item.itemId) ?? _(msg`A dish`)}
										</span>
										{': '}
										{refusalText(_, item.error)}
									</li>
								))}
							</ul>
						</div>
					) : null}

					<StaysInLibrary photos={staysNames} />

					<div className="flex flex-wrap items-center gap-2">
						<Button render={<Link to={`/${orgSlug}/menu/items`} />}>
							<Trans>View the menu</Trans>
						</Button>
						<Button type="button" variant="outline" onClick={reset}>
							<Trans>Add more photos</Trans>
						</Button>
						<Button variant="ghost" render={<Link to={`/${orgSlug}/media`} />}>
							<Trans>Media library</Trans>
						</Button>
					</div>
				</section>
			) : null}
		</main>
	)
}

function StaysInLibrary({ photos }: { photos: string[] }) {
	if (photos.length === 0) return null
	return (
		<div className="space-y-2">
			<h2 className="text-base font-semibold">
				<Trans>Stays in the library</Trans>
			</h2>
			<p className="text-muted-foreground text-sm">
				<Trans>
					These photos were uploaded but not added to a dish. You can find them
					in the media library.
				</Trans>
			</p>
			<ul className="flex flex-wrap gap-1.5">
				{photos.map((name, index) => (
					<li
						key={`${name}-${index}`}
						className="bg-muted rounded-md px-2 py-1 text-xs wrap-anywhere"
					>
						{name}
					</li>
				))}
			</ul>
		</div>
	)
}
