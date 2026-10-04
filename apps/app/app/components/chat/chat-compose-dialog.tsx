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
import { useFetcher, useNavigate } from 'react-router'

type Member = { id: string; label: string }

type ComposeResult =
	{ ok: true; channelId: string } | { ok: false; error?: string }

export function ChatComposeDialog({
	members,
	canCreateGroup,
	onClose,
	onCreated,
}: {
	members: Member[]
	canCreateGroup: boolean
	onClose(): void
	onCreated(channelId: string): void
}) {
	const { _ } = useLingui()
	const navigate = useNavigate()
	const fetcher = useFetcher<ComposeResult>()
	const [mode, setMode] = useState<'dm' | 'group'>('dm')
	const [targetId, setTargetId] = useState('')
	const [groupName, setGroupName] = useState('')
	const [groupMembers, setGroupMembers] = useState<Set<string>>(new Set())
	const [showHistory, setShowHistory] = useState(false)
	const [filter, setFilter] = useState('')
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const onCreatedRef = useRef(onCreated)
	onCreatedRef.current = onCreated
	const handledChannelIdRef = useRef<string | null>(null)

	useEffect(() => {
		if (result?.ok && handledChannelIdRef.current !== result.channelId) {
			handledChannelIdRef.current = result.channelId
			onCreatedRef.current(result.channelId)
			void navigate(`?channel=${result.channelId}`)
			onClose()
		}
	}, [result, navigate, onClose])

	const visible = members.filter((member) =>
		member.label.toLowerCase().includes(filter.trim().toLowerCase()),
	)

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>New message</Trans>
					</DialogTitle>
				</DialogHeader>
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant={mode === 'dm' ? 'secondary' : 'outline'}
						onClick={() => setMode('dm')}
					>
						<Trans>Direct message</Trans>
					</Button>
					{canCreateGroup ? (
						<Button
							type="button"
							size="sm"
							variant={mode === 'group' ? 'secondary' : 'outline'}
							onClick={() => setMode('group')}
						>
							<Trans>Group</Trans>
						</Button>
					) : null}
				</div>
				{mode === 'dm' ? (
					<div className="flex flex-col gap-2">
						<Label htmlFor="dm-target">
							<Trans>Team member</Trans>
						</Label>
						<Input
							id="dm-target"
							list="dm-members"
							value={filter}
							onChange={(event) => setFilter(event.target.value)}
							placeholder={_(msg`Search by name`)}
						/>
						<datalist id="dm-members">
							{visible.map((member) => (
								<option key={member.id} value={member.label} />
							))}
						</datalist>
						<select
							className="border-input bg-background rounded-md border px-3 py-2 text-sm"
							value={targetId}
							onChange={(event) => setTargetId(event.target.value)}
						>
							<option value="">{_(msg`Choose someone`)}</option>
							{visible.map((member) => (
								<option key={member.id} value={member.id}>
									{member.label}
								</option>
							))}
						</select>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div>
							<Label htmlFor="group-name">
								<Trans>Group name</Trans>
							</Label>
							<Input
								id="group-name"
								value={groupName}
								onChange={(event) => setGroupName(event.target.value)}
							/>
						</div>
						<label className="flex items-center gap-2 text-sm">
							<Checkbox
								checked={showHistory}
								onCheckedChange={(checked) => setShowHistory(checked === true)}
							/>
							<Trans>New members can read earlier messages</Trans>
						</label>
						<Input
							type="search"
							value={filter}
							placeholder={_(msg`Search people to add`)}
							onChange={(event) => setFilter(event.target.value)}
						/>
						<div className="max-h-40 overflow-y-auto rounded-md border p-2">
							{visible.map((member) => (
								<label
									key={member.id}
									className="flex items-center gap-2 py-1 text-sm"
								>
									<Checkbox
										checked={groupMembers.has(member.id)}
										onCheckedChange={(checked) => {
											const next = new Set(groupMembers)
											if (checked) next.add(member.id)
											else next.delete(member.id)
											setGroupMembers(next)
										}}
									/>
									{member.label}
								</label>
							))}
						</div>
					</div>
				)}
				{result && !result.ok && result.error ? (
					<p className="text-destructive text-sm" role="alert">
						{result.error}
					</p>
				) : null}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						disabled={pending}
						onClick={() => {
							if (mode === 'dm') {
								void fetcher.submit(
									{ intent: 'dm', targetUserId: targetId },
									{ method: 'POST', encType: 'application/json' },
								)
							} else {
								void fetcher.submit(
									{
										intent: 'createGroup',
										name: groupName,
										memberIds: [...groupMembers],
										showHistoryToNewMembers: showHistory,
									},
									{ method: 'POST', encType: 'application/json' },
								)
							}
						}}
					>
						<Trans>Start</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
