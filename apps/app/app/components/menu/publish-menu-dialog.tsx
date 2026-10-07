import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import { type MenuPublishState } from '#app/components/menu/publish-status-badge.tsx'

export interface PublishChannelOption {
	integrationId: string
	displayName: string
	/** Sticky publish-dialog selection. Null = never chosen (defaults to on). */
	selected: boolean | null
	lastStatus: 'success' | 'error' | null
	lastError: string | null
	pushedCount: number | null
	lastSyncAt: string | null
}

export interface PublishTargetResult {
	type: 'storefront' | 'channel'
	name: string
	integrationId: string | null
	status: 'success' | 'error'
	pushed: number | null
	error: string | null
}

export interface PublishMenuDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	organizationSlug: string
	menu: {
		id: string
		name: string
	}
	publishState: MenuPublishState
	channels: PublishChannelOption[]
}

function relativeTime(value: string | null) {
	if (!value) return null
	const minutes = Math.max(
		0,
		Math.floor((Date.now() - new Date(value).getTime()) / 60000),
	)
	if (minutes < 1) return t`Just now`
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	return `${Math.floor(hours / 24)}d ago`
}

/**
 * Master-menu publish dialog: picks the targets for one publish (the
 * storefront plus every connected write-capable channel), remembers the
 * selection, and reports each target's outcome.
 */
export function PublishMenuDialog({
	open,
	onOpenChange,
	organizationSlug,
	menu,
	publishState,
	channels,
}: PublishMenuDialogProps) {
	const { _ } = useLingui()
	const fetcher = useFetcher<PublishResponse>()
	const [includeStorefront, setIncludeStorefront] = useState(true)
	const [selectedChannelIds, setSelectedChannelIds] = useState<Set<string>>(
		() =>
			new Set(
				channels
					.filter((channel) => channel.selected !== false)
					.map((channel) => channel.integrationId),
			),
	)
	const [result, setResult] = useState<PublishResponse | null>(null)
	useEffect(() => {
		if (!open) {
			setResult(null)
			return
		}
		// Refresh the sticky selections each time the dialog opens.
		setIncludeStorefront(true)
		setSelectedChannelIds(
			new Set(
				channels
					.filter((channel) => channel.selected !== false)
					.map((channel) => channel.integrationId),
			),
		)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open])

	const isPublishing = fetcher.state !== 'idle'
	const targetCount = (includeStorefront ? 1 : 0) + selectedChannelIds.size
	const publishButtonLabel =
		targetCount === 1
			? _(t`Publish to 1 target`)
			: _(t`Publish to ${targetCount} targets`)

	function toggleChannel(integrationId: string) {
		setSelectedChannelIds((previous) => {
			const next = new Set(previous)
			if (next.has(integrationId)) next.delete(integrationId)
			else next.add(integrationId)
			return next
		})
	}

	function handlePublish() {
		const formData = new FormData()
		formData.set('intent', 'publish-menu')
		formData.set('menuId', menu.id)
		if (includeStorefront) formData.set('includeStorefront', 'on')
		for (const integrationId of selectedChannelIds) {
			formData.append('integrationIds', integrationId)
		}
		void fetcher.submit(formData, {
			method: 'POST',
			action: `/${organizationSlug}/menu/menus/${menu.id}`,
		})
	}

	useEffect(() => {
		if (fetcher.state === 'idle' && fetcher.data) {
			if (fetcher.data.error) {
				setResult({ error: fetcher.data.error })
			} else if (fetcher.data.revision !== undefined) {
				setResult(fetcher.data)
			}
		}
	}, [fetcher.state, fetcher.data])

	const hasTargets = targetCount > 0

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{publishState === 'not-published' ? (
							<Trans>Publish menu</Trans>
						) : (
							<Trans>Publish changes</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						<span className="text-foreground font-medium">{menu.name}</span>
						{' — '}
						<Trans>
							Choose where this version goes. Publishing freezes the current
							menu for the storefront and syncs it to the selected channels.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<div className="space-y-3">
						{result.error ? (
							<p className="text-destructive text-sm">{result.error}</p>
						) : (
							<>
								<div className="flex items-center gap-2 text-sm">
									{result.status === 'succeeded' ? (
										<Icon
											name="circle-check"
											className="size-4 text-emerald-500"
										/>
									) : (
										<Icon
											name="alert-triangle"
											className="size-4 text-amber-500"
										/>
									)}
									{result.status === 'succeeded'
										? (() => {
												const targetCount = result.targets?.length ?? 0
												return targetCount === 1
													? _(t`Published to 1 target.`)
													: _(t`Published to ${targetCount} targets.`)
											})()
										: _(t`Publish finished with errors.`)}
								</div>
								<ul className="space-y-1.5">
									{(result.targets ?? []).map((target) => {
										const pushed = target.pushed
										return (
											<li
												key={`${target.type}-${target.name}`}
												className="text-muted-foreground flex items-center justify-between gap-2 text-sm"
											>
												<span className="flex items-center gap-1.5">
													<Icon
														name={
															target.status === 'success'
																? 'circle-check'
																: 'octagon-alert'
														}
														className={
															target.status === 'success'
																? 'size-3.5 text-emerald-500'
																: 'text-destructive size-3.5'
														}
													/>
													{target.name}
												</span>
												<span className="truncate">
													{target.status === 'success'
														? pushed === null || pushed === undefined
															? ''
															: pushed === 1
																? _(t`1 item pushed`)
																: _(t`${pushed} items pushed`)
														: target.error}
												</span>
											</li>
										)
									})}
								</ul>
							</>
						)}
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								<Trans>Done</Trans>
							</Button>
						</DialogFooter>
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<label className="hover:bg-muted/50 flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3">
								<span className="flex flex-col gap-0.5">
									<span className="flex items-center gap-1.5 text-sm font-medium">
										<Icon name="monitor" className="size-4" />
										<Trans>Your website</Trans>
									</span>
									<span className="text-muted-foreground text-xs">
										{publishState === 'not-published' ? (
											<Trans>
												Customers see live edits until the first publish.
											</Trans>
										) : (
											<Trans>
												Customers only see published versions of the menu.
											</Trans>
										)}
									</span>
								</span>
								<input
									type="checkbox"
									className="accent-primary size-4"
									checked={includeStorefront}
									onChange={(event) =>
										setIncludeStorefront(event.target.checked)
									}
								/>
							</label>

							{channels.length === 0 ? (
								<p className="text-muted-foreground px-1 text-xs">
									<Trans>
										No connected channels yet. Connect a POS or delivery
										platform in Settings → Integrations to publish to it.
									</Trans>
								</p>
							) : (
								channels.map((channel) => {
									const checked = selectedChannelIds.has(channel.integrationId)
									return (
										<label
											key={channel.integrationId}
											className="hover:bg-muted/50 flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3"
										>
											<span className="flex flex-col gap-0.5">
												<span className="text-sm font-medium">
													{channel.displayName}
												</span>
												<span className="text-muted-foreground text-xs">
													{channel.lastStatus === 'success' &&
													channel.lastSyncAt ? (
														relativeTime(channel.lastSyncAt)
													) : channel.lastStatus === 'error' ? (
														(channel.lastError ?? _(t`Sync failed`))
													) : (
														<Trans>Never synced</Trans>
													)}
												</span>
											</span>
											<input
												type="checkbox"
												className="accent-primary size-4"
												checked={checked}
												onChange={() => toggleChannel(channel.integrationId)}
											/>
										</label>
									)
								})
							)}
						</div>

						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
								disabled={isPublishing}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								onClick={handlePublish}
								disabled={isPublishing || !hasTargets}
							>
								{isPublishing ? <Trans>Publishing…</Trans> : publishButtonLabel}
							</Button>{' '}
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}

interface PublishResponse {
	revision?: number
	status?: 'succeeded' | 'partial' | 'failed'
	targets?: PublishTargetResult[]
	error?: string
}
