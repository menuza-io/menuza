import { Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import { useFetcher, useRevalidator } from 'react-router'
import {
	type RestyleItemView,
	type RestyleRunSummary,
} from '#app/utils/media/restyle/types.ts'
import { RestyleItemCard, RestyleSkippedRow } from './restyle-item-card.tsx'
import { isRestyleErrorCode, RESTYLE_ERROR_MESSAGES } from './restyle-labels.ts'
import { RestyleRunStatus } from './restyle-run-status.tsx'

type UseAllData = {
	ok?: boolean
	error?: string
	used?: number
	remaining?: number
	refused?: Array<{ itemId: string; error: string }>
}

const POLL_MS = 5_000

/**
 * The review page of one run (#146): its progress, then the original next to
 * the draft for every dish. Live photos change only when the operator chooses.
 * While the run works the page reads it again every five seconds.
 */
export function RestyleReview({
	run,
	items,
	canApply,
	canStart,
	killed,
}: {
	run: RestyleRunSummary
	items: RestyleItemView[]
	canApply: boolean
	canStart: boolean
	killed: boolean
}) {
	const { _ } = useLingui()
	const revalidator = useRevalidator()
	const cancelFetcher = useFetcher()
	const useAllFetcher = useFetcher<UseAllData>()
	const [confirming, setConfirming] = useState(false)

	const working = run.status === 'pending' || run.status === 'running'
	useEffect(() => {
		if (!working) return
		const timer = window.setInterval(() => {
			if (
				document.visibilityState === 'visible' &&
				revalidator.state === 'idle'
			) {
				void revalidator.revalidate()
			}
		}, POLL_MS)
		return () => window.clearInterval(timer)
	}, [working, revalidator])

	const toReview = items.filter(
		(item) => item.status === 'drafted' && item.decision === null,
	)
	const decided = items.filter(
		(item) => item.status === 'drafted' && item.decision !== null,
	)
	const waiting = items.filter((item) => item.status === 'pending')
	const failed = items.filter((item) => item.status === 'failed')
	const skipped = items.filter((item) => item.status === 'skipped')
	const active =
		run.status === 'pending' ||
		run.status === 'running' ||
		run.status === 'paused'
	const useAllData = useAllFetcher.data
	const remaining = useAllData?.remaining ?? 0
	const useAllBusy = useAllFetcher.state !== 'idle'

	return (
		<div className="space-y-8">
			<section className="bg-card space-y-3 rounded-xl border p-4">
				<RestyleRunStatus run={run} />
				{killed ? (
					<Alert>
						<AlertDescription>
							{_(RESTYLE_ERROR_MESSAGES.restyle_paused)}
						</AlertDescription>
					</Alert>
				) : null}
				{active ? (
					<Button
						size="sm"
						variant="outline"
						disabled={cancelFetcher.state !== 'idle'}
						onClick={() => {
							const data = new FormData()
							data.set('intent', 'cancel')
							void cancelFetcher.submit(data, { method: 'POST' })
						}}
					>
						<Trans>Stop this run</Trans>
					</Button>
				) : null}
			</section>

			{useAllData ? (
				<Alert
					variant={
						useAllData.ok === false || (useAllData.refused?.length ?? 0) > 0
							? 'destructive'
							: 'default'
					}
					aria-live="polite"
				>
					<AlertDescription>
						{useAllData.ok === false ? (
							isRestyleErrorCode(useAllData.error) ? (
								_(RESTYLE_ERROR_MESSAGES[useAllData.error])
							) : (
								_(RESTYLE_ERROR_MESSAGES.not_found)
							)
						) : (
							<>
								<Plural
									value={useAllData.used ?? 0}
									one="Used # new photo."
									other="Used # new photos."
								/>{' '}
								{(useAllData.refused?.length ?? 0) > 0 ? (
									<Plural
										value={useAllData.refused?.length ?? 0}
										one="# dish was left alone because its photo changed or the draft changed."
										other="# dishes were left alone because their photo changed or the draft changed."
									/>
								) : null}{' '}
								{remaining > 0 ? (
									<Trans>{remaining} more are waiting: use all again.</Trans>
								) : null}
							</>
						)}
					</AlertDescription>
				</Alert>
			) : null}

			{toReview.length > 0 ? (
				<section className="space-y-4" aria-labelledby="restyle-review">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<h2 id="restyle-review" className="text-lg font-semibold">
							<Trans>To review</Trans>{' '}
							<span className="text-muted-foreground text-sm font-normal">
								({toReview.length})
							</span>
						</h2>
						<AlertDialog open={confirming} onOpenChange={setConfirming}>
							<AlertDialogTrigger
								render={
									<Button
										variant="outline"
										size="sm"
										disabled={!canApply || useAllBusy}
									>
										<Icon name="check" aria-hidden />
										<Trans>Use all remaining</Trans>
									</Button>
								}
							/>
							<AlertDialogContent>
								<AlertDialogHeader>
									<AlertDialogTitle>
										<Trans>Use all the new photos?</Trans>
									</AlertDialogTitle>
									<AlertDialogDescription>
										<Plural
											value={toReview.length}
											one="This replaces the main photo of # dish with its new photo. Dishes whose photo changed since are left alone. Every original stays in your library and you can switch back."
											other="This replaces the main photo of # dishes with their new photos. Dishes whose photo changed since are left alone. Every original stays in your library and you can switch back."
										/>
									</AlertDialogDescription>
								</AlertDialogHeader>
								<AlertDialogFooter>
									<AlertDialogCancel>
										<Trans>Cancel</Trans>
									</AlertDialogCancel>
									<AlertDialogAction
										onClick={() => {
											setConfirming(false)
											const data = new FormData()
											data.set('intent', 'useAll')
											void useAllFetcher.submit(data, { method: 'POST' })
										}}
									>
										<Trans>Use all</Trans>
									</AlertDialogAction>
								</AlertDialogFooter>
							</AlertDialogContent>
						</AlertDialog>
					</div>
					<ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{toReview.map((item) => (
							<RestyleItemCard
								key={item.id}
								item={item}
								canApply={canApply}
								canStart={canStart}
								killed={killed}
							/>
						))}
					</ul>
				</section>
			) : working || waiting.length > 0 ? (
				<p className="text-muted-foreground text-sm">
					<Trans>New photos show up here as they are made.</Trans>
				</p>
			) : null}

			{waiting.length > 0 && toReview.length > 0 ? (
				<p className="text-muted-foreground text-sm">
					<Plural
						value={waiting.length}
						one="# more dish is still waiting to be restyled."
						other="# more dishes are still waiting to be restyled."
					/>
				</p>
			) : null}

			{decided.length > 0 ? (
				<section className="space-y-4" aria-labelledby="restyle-decided">
					<h2 id="restyle-decided" className="text-lg font-semibold">
						<Trans>Decided</Trans>{' '}
						<span className="text-muted-foreground text-sm font-normal">
							({decided.length})
						</span>
					</h2>
					<ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{decided.map((item) => (
							<RestyleItemCard
								key={item.id}
								item={item}
								canApply={canApply}
								canStart={canStart}
								killed={killed}
							/>
						))}
					</ul>
				</section>
			) : null}

			{failed.length > 0 ? (
				<section className="space-y-4" aria-labelledby="restyle-failed">
					<h2 id="restyle-failed" className="text-lg font-semibold">
						<Trans>Could not be restyled</Trans>{' '}
						<span className="text-muted-foreground text-sm font-normal">
							({failed.length})
						</span>
					</h2>
					<ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
						{failed.map((item) => (
							<RestyleItemCard
								key={item.id}
								item={item}
								canApply={canApply}
								canStart={canStart}
								killed={killed}
							/>
						))}
					</ul>
				</section>
			) : null}

			{skipped.length > 0 ? (
				<section className="space-y-2" aria-labelledby="restyle-skipped">
					<h2 id="restyle-skipped" className="text-lg font-semibold">
						<Trans>Skipped dishes</Trans>{' '}
						<span className="text-muted-foreground text-sm font-normal">
							({skipped.length})
						</span>
					</h2>
					<ul className="divide-y rounded-xl border px-3">
						{skipped.map((item) => (
							<RestyleSkippedRow key={item.id} item={item} />
						))}
					</ul>
				</section>
			) : null}
		</div>
	)
}
