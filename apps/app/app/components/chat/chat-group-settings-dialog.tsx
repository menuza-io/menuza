import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

type Member = { id: string; label: string }

type GroupActionResult = { ok: true } | { ok: false; error?: string }

export function ChatGroupSettingsDialog({
	channelId,
	channelName,
	createdById,
	meId,
	showHistoryToNewMembers,
	members,
	rosterIds,
	onClose,
	onUpdated,
}: {
	channelId: string
	channelName: string
	createdById: string | null | undefined
	meId: string
	showHistoryToNewMembers: boolean
	members: Member[]
	rosterIds: string[]
	onClose(): void
	onUpdated(): void
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<GroupActionResult>()
	const [filter, setFilter] = useState('')
	const [history, setHistory] = useState(showHistoryToNewMembers)
	const pending = fetcher.state !== 'idle'
	const isCreator = createdById === meId
	const roster = new Set(rosterIds)

	useEffect(() => {
		setHistory(showHistoryToNewMembers)
	}, [showHistoryToNewMembers])

	const onUpdatedRef = useRef(onUpdated)
	onUpdatedRef.current = onUpdated
	useEffect(() => {
		if (fetcher.data?.ok) onUpdatedRef.current()
	}, [fetcher.data])

	const addable = members.filter(
		(member) =>
			!roster.has(member.id) &&
			member.label.toLowerCase().includes(filter.trim().toLowerCase()),
	)

	function submit(body: Record<string, unknown>) {
		void fetcher.submit(JSON.stringify(body), {
			method: 'post',
			encType: 'application/json',
		})
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{channelName}</DialogTitle>
				</DialogHeader>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label>
							<Trans>Members</Trans>
						</Label>
						<ul className="text-muted-foreground max-h-32 overflow-y-auto text-sm">
							{rosterIds.map((id) => {
								const label =
									members.find((member) => member.id === id)?.label ?? id
								return (
									<li key={id} className="truncate py-0.5">
										{label}
										{id === meId ? (
											<span className="text-foreground">
												{' '}
												<Trans>(you)</Trans>
											</span>
										) : null}
									</li>
								)
							})}
						</ul>
					</div>

					<div className="space-y-2">
						<Label htmlFor="group-add-filter">
							<Trans>Add people</Trans>
						</Label>
						<Input
							id="group-add-filter"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder={_(msg`Search team members`)}
							autoComplete="off"
						/>
						<ul className="max-h-40 space-y-1 overflow-y-auto">
							{addable.length === 0 ? (
								<li className="text-muted-foreground text-sm">
									<Trans>No one else to add.</Trans>
								</li>
							) : (
								addable.map((member) => (
									<li key={member.id}>
										<Button
											type="button"
											variant="outline"
											size="sm"
											className="w-full justify-start"
											disabled={pending}
											onClick={() =>
												submit({
													intent: 'addGroupMembers',
													channelId,
													memberIds: [member.id],
												})
											}
										>
											<Trans>Add {member.label}</Trans>
										</Button>
									</li>
								))
							)}
						</ul>
					</div>

					{isCreator ? (
						<div className="flex items-start gap-2">
							<Checkbox
								id="group-history"
								checked={history}
								disabled={pending}
								onCheckedChange={(checked) => {
									const next = checked === true
									setHistory(next)
									submit({
										intent: 'updateGroupHistory',
										channelId,
										showHistoryToNewMembers: next,
									})
								}}
							/>
							<div className="space-y-1">
								<Label htmlFor="group-history" className="font-normal">
									<Trans>New members can read earlier messages</Trans>
								</Label>
								<p className="text-muted-foreground text-xs">
									<Trans>
										When off, people only see messages from after they joined.
									</Trans>
								</p>
							</div>
						</div>
					) : null}

					{fetcher.data && !fetcher.data.ok && fetcher.data.error ? (
						<p className="text-destructive text-sm">{fetcher.data.error}</p>
					) : null}
				</div>

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Close</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
