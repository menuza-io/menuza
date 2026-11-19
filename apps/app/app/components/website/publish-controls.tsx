/**
 * Publishing controls of the website editor (#85, #180): the "Unpublished
 * changes" badge, the History sheet (preview and restore a version), Publish
 * later, Discard changes and the site design publish bar. They only talk to
 * the page editor's actions and the History loader.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { Spinner } from '@repo/ui/spinner'
import { formatDistanceToNow } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'
import { useFetcher, useRevalidator } from 'react-router'
import {
	formatSiteDateTime,
	fromDateTimeInputValue,
	toDateTimeInputValue,
} from '#app/utils/website/schedule-format.ts'

export function UnpublishedChangesBadge({ className }: { className?: string }) {
	return (
		<Badge variant="outline" className={className}>
			<span aria-hidden="true" className="size-1.5 rounded-full bg-amber-500" />
			<Trans>Unpublished changes</Trans>
		</Badge>
	)
}

type HistoryKind = 'page' | 'chrome' | 'theme'

export type VersionPreview = {
	id: string
	sections: Array<{
		id: string
		type: string
		config: string
		position: number
	}>
	theme: unknown
	missingMedia: string[]
}

type HistoryData = {
	kind: HistoryKind
	versions: Array<{
		id: string
		title: string | null
		publishedAt: string
		publishedBy: string | null
		summary: {
			added: number
			removed: number
			changed: number
			total: number
		} | null
		restoredFromId: string | null
		isLive: boolean
	}>
	draftHash: string
	preview: VersionPreview | null
}

/**
 * Lists every published version (page, header and footer, or theme) with who
 * published it. Preview shows one in the editor preview; Restore copies it
 * into the draft. Nothing here publishes.
 */
export function VersionHistorySheet({
	open,
	onOpenChange,
	orgSlug,
	pageId,
	initialKind = 'page',
	onPreview,
	onRestored,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	orgSlug: string
	pageId: string
	initialKind?: HistoryKind
	/** Shows a version in the editor preview; null returns to the draft. */
	onPreview: (preview: VersionPreview | null) => void
	onRestored: () => void
}) {
	const { _ } = useLingui()
	const [kind, setKind] = useState<HistoryKind>(initialKind)
	const [confirming, setConfirming] = useState<string | null>(null)
	const [stale, setStale] = useState(false)
	const loader = useFetcher<HistoryData>()
	const restore = useFetcher<{
		status: string
		error?: string
		missingMedia?: string[]
	}>()
	const revalidator = useRevalidator()
	const base = `/${orgSlug}/website/pages/${pageId}`

	useEffect(() => {
		if (open) setKind(initialKind)
	}, [open, initialKind])

	useEffect(() => {
		if (open) void loader.load(`${base}/history?kind=${kind}`)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, kind, base])

	useEffect(() => {
		if (!restore.data) return
		if (restore.data.status === 'success') {
			setConfirming(null)
			setStale(false)
			onPreview(null)
			onRestored()
			void revalidator.revalidate()
			void loader.load(`${base}/history?kind=${kind}`)
		} else if (restore.data.error === 'stale_version') {
			setStale(true)
			setConfirming(null)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [restore.data])

	useEffect(() => {
		if (loader.data?.preview) onPreview(loader.data.preview)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [loader.data?.preview?.id])

	const data = loader.data
	const kinds: Array<{ id: HistoryKind; label: string }> = [
		{ id: 'page', label: _(msg`This page`) },
		{ id: 'chrome', label: _(msg`Header and footer`) },
		{ id: 'theme', label: _(msg`Theme`) },
	]
	const missing =
		restore.data?.missingMedia ?? data?.preview?.missingMedia ?? []

	return (
		<Sheet
			open={open}
			onOpenChange={(next) => {
				if (!next) onPreview(null)
				onOpenChange(next)
			}}
		>
			<SheetContent className="w-full sm:max-w-md">
				<SheetHeader>
					<SheetTitle>
						<Trans>History</Trans>
					</SheetTitle>
					<SheetDescription>
						<Trans>
							Every published version. Restoring one puts it in your draft; it
							goes live only when you publish.
						</Trans>
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-wrap gap-1.5 px-4">
					{kinds.map((item) => (
						<Button
							key={item.id}
							type="button"
							size="xs"
							variant={kind === item.id ? 'secondary' : 'outline'}
							onClick={() => {
								onPreview(null)
								setKind(item.id)
							}}
						>
							{item.label}
						</Button>
					))}
				</div>
				{stale ? (
					<div
						role="alert"
						className="bg-destructive/10 text-destructive mx-4 rounded-md p-3 text-xs"
					>
						<Trans>
							Someone changed the draft after you opened History, so nothing was
							restored. Reload and try again.
						</Trans>
						<Button
							type="button"
							size="xs"
							variant="outline"
							className="mt-2"
							onClick={() => {
								setStale(false)
								void revalidator.revalidate()
								void loader.load(`${base}/history?kind=${kind}`)
							}}
						>
							<Trans>Reload</Trans>
						</Button>
					</div>
				) : null}
				{missing.length > 0 ? (
					<p
						role="status"
						className="mx-4 rounded-md bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
					>
						<Trans>
							Some images in this version were deleted from your media library.
							They will show as missing until you replace them.
						</Trans>
					</p>
				) : null}
				<ScrollArea className="min-h-0 flex-1">
					<ul className="space-y-2 px-4 pb-4">
						{loader.state !== 'idle' && !data ? (
							<li className="flex justify-center p-6">
								<Spinner />
							</li>
						) : null}
						{data && data.versions.length === 0 ? (
							<li className="text-muted-foreground p-4 text-center text-sm">
								<Trans>Nothing has been published yet.</Trans>
							</li>
						) : null}
						{data?.versions.map((version) => {
							const changed = version.summary?.changed ?? 0
							const added = version.summary?.added ?? 0
							const removed = version.summary?.removed ?? 0
							const parts: string[] = []
							if (changed) parts.push(_(msg`${changed} changed`))
							if (added) parts.push(_(msg`${added} added`))
							if (removed) parts.push(_(msg`${removed} removed`))
							const previewing = data.preview?.id === version.id
							return (
								<li
									key={version.id}
									className={cn(
										'border-border rounded-lg border p-3',
										previewing && 'ring-ring ring-2',
									)}
								>
									<div className="flex items-start justify-between gap-2">
										<div className="min-w-0">
											<p className="text-sm font-medium">
												{new Date(version.publishedAt).toLocaleString()}
											</p>
											<p className="text-muted-foreground text-xs">
												{formatDistanceToNow(new Date(version.publishedAt), {
													addSuffix: true,
												})}
												{version.publishedBy ? ` · ${version.publishedBy}` : ''}
											</p>
											{parts.length > 0 ? (
												<p className="text-muted-foreground mt-1 text-xs">
													{parts.join(', ')}
												</p>
											) : null}
										</div>
										{version.isLive ? (
											<Badge variant="outline">
												<Trans>Live</Trans>
											</Badge>
										) : null}
									</div>
									<div className="mt-2 flex gap-1.5">
										<Button
											type="button"
											size="xs"
											variant="outline"
											onClick={() => {
												void loader.load(
													`${base}/history?kind=${kind}&version=${version.id}`,
												)
											}}
										>
											<Trans>Preview</Trans>
										</Button>
										{confirming === version.id ? (
											<Button
												type="button"
												size="xs"
												disabled={restore.state !== 'idle'}
												onClick={() => {
													void restore.submit(
														{
															intent: 'restore-version',
															versionId: version.id,
															expectedDraftHash: data.draftHash,
														},
														{ method: 'POST', action: base },
													)
												}}
											>
												{restore.state !== 'idle' ? <Spinner /> : null}
												<Trans>Confirm restore</Trans>
											</Button>
										) : (
											<Button
												type="button"
												size="xs"
												variant="outline"
												onClick={() => setConfirming(version.id)}
											>
												<Trans>Restore</Trans>
											</Button>
										)}
									</div>
									{confirming === version.id ? (
										<p className="text-muted-foreground mt-2 text-xs">
											<Trans>
												This replaces your draft. The live site does not change
												until you publish.
											</Trans>
										</p>
									) : null}
								</li>
							)
						})}
					</ul>
				</ScrollArea>
			</SheetContent>
		</Sheet>
	)
}

/**
 * Discard changes: drops every unpublished edit (page and site design) and
 * goes back to what is live. Never offered for a page that was never published.
 */
export function DiscardChangesDialog({
	open,
	onOpenChange,
	onConfirm,
	site = false,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
	/** Branding: only the header, footer and theme. */
	site?: boolean
}) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Discard unpublished changes?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						{site ? (
							<Trans>
								The header, footer and theme go back to what is live. This
								cannot be undone.
							</Trans>
						) : (
							<Trans>
								This page and the header, footer and theme go back to what is
								live. This cannot be undone.
							</Trans>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Keep editing</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							onConfirm()
							onOpenChange(false)
						}}
					>
						<Trans>Discard changes</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

/**
 * Publish later: a date and time in the site's time zone. What goes live is
 * the draft as it is now; later edits stay in the draft.
 */
export function SchedulePublishDialog({
	open,
	onOpenChange,
	timeZone,
	scope,
	existingRunAt,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	timeZone: string
	scope: 'page' | 'site'
	existingRunAt: string | null
}) {
	const { _, i18n } = useLingui()
	const fetcher = useFetcher<{ status: string; error?: string }>()
	const revalidator = useRevalidator()
	const [value, setValue] = useState('')
	const [error, setError] = useState<string | null>(null)
	const busy = fetcher.state !== 'idle'

	useEffect(() => {
		if (!open) return
		setError(null)
		setValue(
			existingRunAt
				? toDateTimeInputValue(existingRunAt, timeZone)
				: toDateTimeInputValue(Date.now() + 60 * 60_000, timeZone),
		)
	}, [open, existingRunAt, timeZone])

	useEffect(() => {
		if (fetcher.state !== 'idle' || !fetcher.data) return
		if (fetcher.data.status === 'success') {
			onOpenChange(false)
			void revalidator.revalidate()
		} else if (fetcher.data.error === 'invalid_schedule_time') {
			setError(_(msg`Choose a time between 5 minutes and 90 days from now.`))
		} else if (fetcher.data.error === 'nothing_to_publish') {
			setError(_(msg`There are no unpublished design changes to schedule.`))
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [fetcher.state, fetcher.data])

	const runAt = useMemo(
		() => fromDateTimeInputValue(value, timeZone),
		[value, timeZone],
	)
	const preview = runAt
		? formatSiteDateTime(runAt, timeZone, i18n.locale)
		: null

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Publish later</Trans>
					</DialogTitle>
					<DialogDescription>
						{scope === 'site' ? (
							<Trans>
								The header, footer and theme changes go live at the time you
								choose.
							</Trans>
						) : (
							<Trans>This page goes live at the time you choose.</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="schedule-publish-at">
						<Trans>Date and time ({timeZone})</Trans>
					</Label>
					<Input
						id="schedule-publish-at"
						type="datetime-local"
						value={value}
						onChange={(event) => setValue(event.currentTarget.value)}
					/>
					{preview ? (
						<p className="text-muted-foreground text-xs">
							<Trans>Goes live {preview}</Trans>
						</p>
					) : null}
					<p className="text-muted-foreground text-xs">
						<Trans>
							Your later edits are not part of the scheduled publish. Publish
							again, or schedule again, to include them.
						</Trans>
					</p>
					{error ? (
						<p role="alert" className="text-destructive text-xs">
							{error}
						</p>
					) : null}
				</div>
				<DialogFooter>
					<DialogClose render={<Button variant="outline" type="button" />}>
						<Trans>Cancel</Trans>
					</DialogClose>
					<Button
						type="button"
						disabled={busy || !runAt}
						onClick={() => {
							if (!runAt) return
							void fetcher.submit(
								{
									intent: 'schedule-publish',
									scope,
									runAt: runAt.toISOString(),
								},
								{ method: 'POST' },
							)
						}}
					>
						{busy ? <Spinner /> : null}
						<Trans>Schedule</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/** "Goes live Fri 18:00" with Cancel schedule, shown where a schedule exists. */
export function ScheduledNotice({
	runAt,
	timeZone,
	scope,
	className,
}: {
	runAt: string
	timeZone: string
	scope: 'page' | 'site'
	className?: string
}) {
	const { i18n } = useLingui()
	const fetcher = useFetcher()
	const when = formatSiteDateTime(runAt, timeZone, i18n.locale)
	return (
		<div
			className={cn(
				'bg-muted flex flex-wrap items-center gap-2 rounded-md px-3 py-2 text-xs',
				className,
			)}
		>
			<Icon name="clock" className="size-3.5" />
			<span>
				<Trans>Goes live {when}</Trans>
			</span>
			<Button
				type="button"
				size="xs"
				variant="ghost"
				disabled={fetcher.state !== 'idle'}
				onClick={() => {
					void fetcher.submit(
						{ intent: 'cancel-schedule', scope },
						{ method: 'POST' },
					)
				}}
			>
				<Trans>Cancel schedule</Trans>
			</Button>
			<span className="text-muted-foreground w-full">
				<Trans>Your later edits are not part of the scheduled publish.</Trans>
			</span>
		</div>
	)
}

/** Unpublishing a page that redirects point to: says how many, once (#248). */
export function UnpublishWarningDialog({
	open,
	onOpenChange,
	count,
	title,
	onConfirm,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	count: number
	title: string
	onConfirm: () => void
}) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Unpublish a page that redirects point to?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						{count === 1 ? (
							<Trans>
								1 redirect sends visitors to "{title}". While it is unpublished,
								they go to the home page instead, and return to this page when
								you publish it again.
							</Trans>
						) : (
							<Trans>
								{count} redirects send visitors to "{title}". While it is
								unpublished, they go to the home page instead, and return to
								this page when you publish it again.
							</Trans>
						)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => {
							onConfirm()
							onOpenChange(false)
						}}
					>
						<Trans>Unpublish</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}
