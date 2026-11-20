import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type CampaignStatus } from '@repo/marketing'
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useState } from 'react'
import { Link, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'

/** A re-send to non-openers waits this long after the broadcast finished. */
const RETARGET_WAIT_MS = 48 * 60 * 60 * 1000

export type CampaignActionTarget = {
	id: string
	status: CampaignStatus
	channel: 'email' | 'sms' | 'push'
	/** When it last changed; for a finished broadcast, when it finished. */
	updatedAt?: string | Date | null
	/** The re-send already made from it, if any. */
	retargetedByCampaignId?: string | null
}

/**
 * What an operator can do with a broadcast (#101): edit, cancel, delete,
 * duplicate, send a test, re-send to non-openers. Which of them apply follows
 * the status, as tenant-api enforces it. Needs `update:campaign:any`; people
 * who can only read see nothing. The actions post to the broadcast's route, so
 * the list's overflow menu and the detail page share them.
 */
export function CampaignActions({
	orgSlug,
	campaign,
	variant,
	onChanged,
}: {
	orgSlug: string
	campaign: CampaignActionTarget
	variant: 'buttons' | 'menu'
	/** Called after an action that changed the broadcast without leaving the page. */
	onChanged?: () => void
}) {
	const { _ } = useLingui()
	const hasPermission = useHasPermission()
	const fetcher = useFetcher<{
		ok?: boolean
		message?: string
		error?: string
	}>()
	const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null)
	const [retargetOpen, setRetargetOpen] = useState(false)
	const [subject, setSubject] = useState('')

	const path = `/${orgSlug}/marketing/campaigns/${campaign.id}`
	const busy = fetcher.state !== 'idle'

	useEffect(() => {
		const result = fetcher.data
		if (!result) return
		if (result.ok) {
			if (result.message) toast.success(result.message)
			setConfirm(null)
			onChanged?.()
		} else if (result.error) {
			toast.error(result.error)
			setConfirm(null)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- once per answer
	}, [fetcher.data])

	if (!hasPermission('update:campaign:any')) return null

	const submit = (values: Record<string, string>) =>
		fetcher.submit(values, { method: 'post', action: path })

	const editable =
		campaign.status === 'Draft' || campaign.status === 'Scheduled'
	const deletable =
		campaign.status === 'Draft' || campaign.status === 'Cancelled'
	const canTest = campaign.channel === 'email'
	const finishedAt = campaign.updatedAt
		? new Date(campaign.updatedAt).getTime()
		: null
	const retargetable =
		campaign.status === 'Completed' &&
		campaign.channel === 'email' &&
		!campaign.retargetedByCampaignId
	const retargetReadyAt =
		finishedAt === null ? null : new Date(finishedAt + RETARGET_WAIT_MS)
	const retargetWaiting =
		retargetReadyAt !== null && retargetReadyAt.getTime() > Date.now()
	const readyAtText = retargetReadyAt?.toLocaleString() ?? ''

	const items = [
		editable && {
			key: 'edit',
			label: _(msg`Edit`),
			icon: 'pencil' as const,
			to: `${path}/edit`,
		},
		canTest && {
			key: 'test',
			label: _(msg`Send a test`),
			icon: 'mail' as const,
			onSelect: () => submit({ intent: 'test' }),
		},
		{
			key: 'duplicate',
			label: _(msg`Duplicate`),
			icon: 'copy' as const,
			onSelect: () => submit({ intent: 'duplicate' }),
		},
		retargetable && {
			key: 'retarget',
			label: _(msg`Re-send to non-openers`),
			icon: 'send' as const,
			onSelect: () => setRetargetOpen(true),
		},
		editable && {
			key: 'cancel',
			label: _(msg`Cancel`),
			icon: 'ban' as const,
			onSelect: () => setConfirm('cancel'),
		},
		deletable && {
			key: 'delete',
			label: _(msg`Delete`),
			icon: 'trash-2' as const,
			destructive: true,
			onSelect: () => setConfirm('delete'),
		},
	].filter(Boolean) as Array<{
		key: string
		label: string
		icon: 'pencil' | 'mail' | 'copy' | 'send' | 'ban' | 'trash-2'
		to?: string
		destructive?: boolean
		onSelect?: () => void
	}>

	return (
		<>
			{variant === 'menu' ? (
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={_(msg`Broadcast actions`)}
								onClick={(event) => {
									// The row is a link; opening the menu must not follow it.
									event.preventDefault()
									event.stopPropagation()
								}}
							/>
						}
					>
						<Icon name="ellipsis" className="size-4" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{items.map((item) =>
							item.to ? (
								<DropdownMenuItem
									key={item.key}
									render={<Link to={item.to} />}
									onClick={(event) => event.stopPropagation()}
								>
									<Icon name={item.icon} className="size-4" />
									{item.label}
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem
									key={item.key}
									variant={item.destructive ? 'destructive' : 'default'}
									disabled={busy}
									onClick={(event) => {
										event.stopPropagation()
										item.onSelect?.()
									}}
								>
									<Icon name={item.icon} className="size-4" />
									{item.label}
								</DropdownMenuItem>
							),
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					{items.map((item) =>
						item.to ? (
							<Button
								key={item.key}
								variant="outline"
								size="sm"
								render={<Link to={item.to} />}
							>
								<Icon name={item.icon} className="size-3.5" />
								{item.label}
							</Button>
						) : (
							<Button
								key={item.key}
								type="button"
								variant="outline"
								size="sm"
								className={item.destructive ? 'text-destructive' : undefined}
								disabled={busy}
								onClick={item.onSelect}
							>
								<Icon name={item.icon} className="size-3.5" />
								{item.label}
							</Button>
						),
					)}
				</div>
			)}

			<AlertDialog
				open={confirm !== null}
				onOpenChange={(open) => !open && setConfirm(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirm === 'delete' ? (
								<Trans>Delete this broadcast?</Trans>
							) : (
								<Trans>Cancel this broadcast?</Trans>
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm === 'delete' ? (
								<Trans>
									It is removed for good. A broadcast that was already sent
									cannot be deleted.
								</Trans>
							) : (
								<Trans>
									It will not be sent. You can still duplicate it later. This
									cannot be undone once it has started sending.
								</Trans>
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							disabled={busy}
							onClick={() => submit({ intent: confirm ?? '' })}
						>
							{confirm === 'delete' ? (
								<Trans>Delete</Trans>
							) : (
								<Trans>Cancel broadcast</Trans>
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<Dialog open={retargetOpen} onOpenChange={setRetargetOpen}>
				<DialogContent className="gap-4 sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Re-send to non-openers</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Makes a new draft for the people who got this broadcast, did not
								open or click it, and are still subscribed when you send it.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Opens are not always counted. Some mail apps open messages by
							themselves or hide the open from senders (Apple Mail Privacy
							Protection, for example), so a few people who read it may get it
							again. A broadcast can be re-sent once.
						</Trans>
					</p>
					{/* Always mounted, so a screen reader announces the text when it appears. */}
					<p role="status" className="text-sm font-medium">
						{retargetWaiting && retargetReadyAt ? (
							<Trans>
								You can do this from {readyAtText}, 48 hours after it finished.
							</Trans>
						) : null}
					</p>
					<div className="space-y-2">
						<Label htmlFor={`retarget-subject-${campaign.id}`}>
							<Trans>New subject (optional)</Trans>
						</Label>
						<Input
							id={`retarget-subject-${campaign.id}`}
							value={subject}
							maxLength={300}
							onChange={(event) => setSubject(event.target.value)}
							placeholder={_(msg`Keep the same subject`)}
						/>
					</div>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
						<Button
							type="button"
							disabled={busy || retargetWaiting}
							onClick={() => submit({ intent: 'retarget', subject })}
						>
							<Trans>Create the re-send draft</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}
