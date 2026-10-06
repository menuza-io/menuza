import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CHAT_LIMITS } from '@repo/common/chat'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@repo/ui/input-group'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Spinner } from '@repo/ui/spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useFetcher, useNavigate } from 'react-router'
import { PersonAvatar } from './chat-message.tsx'

type Member = { id: string; label: string }
type ComposeResult =
	{ ok: true; channelId: string } | { ok: false; error?: string }
type ComposeRequest =
	| { intent: 'dm'; targetUserId: string }
	| {
			intent: 'createGroup'
			name: string
			memberIds: string[]
			showHistoryToNewMembers: boolean
	  }

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
	const { _, i18n } = useLingui()
	const navigate = useNavigate()
	const fetcher = useFetcher<ComposeResult>()
	const groupNameId = useId()
	const searchId = useId()
	const peopleId = useId()
	const historyId = useId()
	const historyLabelId = useId()
	const searchInput = useRef<HTMLInputElement>(null)
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
			void navigate(`?channel=${encodeURIComponent(result.channelId)}`)
			onClose()
		}
	}, [result, navigate, onClose])

	const visible = members.filter((member) =>
		member.label
			.toLocaleLowerCase(i18n.locale)
			.includes(filter.trim().toLocaleLowerCase(i18n.locale)),
	)
	const selected = members.filter((member) =>
		mode === 'dm' ? member.id === targetId : groupMembers.has(member.id),
	)
	const selectedCount = selected.length
	const canStart =
		!pending &&
		(mode === 'dm'
			? selectedCount === 1
			: Boolean(groupName.trim()) &&
				groupName.trim().length <= CHAT_LIMITS.nameMax &&
				selectedCount > 0 &&
				selectedCount < CHAT_LIMITS.groupMembersMax)

	function submit(event: FormEvent) {
		event.preventDefault()
		if (!canStart) return
		const payload: ComposeRequest =
			mode === 'dm'
				? { intent: 'dm', targetUserId: targetId }
				: {
						intent: 'createGroup',
						name: groupName.trim(),
						memberIds: selected.map((member) => member.id),
						showHistoryToNewMembers: showHistory,
					}
		void fetcher.submit(payload, {
			method: 'POST',
			encType: 'application/json',
		})
	}

	function toggleMember(id: string, checked: boolean) {
		setGroupMembers((current) => {
			const next = new Set(current)
			if (checked) next.add(id)
			else next.delete(id)
			return next
		})
	}

	const removeLabel = (label: string) => _(msg`Remove ${label}`)

	const peoplePicker = (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<Label id={peopleId} htmlFor={searchId}>
					{mode === 'dm' ? <Trans>Team member</Trans> : <Trans>People</Trans>}
				</Label>
				{mode === 'group' ? (
					<span className="text-muted-foreground text-xs" aria-live="polite">
						{_(
							plural(selectedCount, { one: '# selected', other: '# selected' }),
						)}
					</span>
				) : null}
			</div>
			<InputGroup className="h-10">
				<InputGroupAddon>
					<Icon name="search" />
				</InputGroupAddon>
				<InputGroupInput
					ref={searchInput}
					id={searchId}
					type="search"
					value={filter}
					placeholder={_(msg`Search by name`)}
					aria-label={_(msg`Search team members`)}
					disabled={pending}
					onChange={(event) => setFilter(event.target.value)}
				/>
				{filter ? (
					<InputGroupAddon align="inline-end">
						<InputGroupButton
							aria-label={_(msg`Clear search`)}
							disabled={pending}
							size="icon-xs"
							onClick={() => {
								setFilter('')
								searchInput.current?.focus()
							}}
						>
							<Icon name="x" />
						</InputGroupButton>
					</InputGroupAddon>
				) : null}
			</InputGroup>
			{selectedCount > 0 ? (
				<div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
					{selected.map((member) => (
						<span
							key={member.id}
							className="bg-muted inline-flex max-w-full items-center gap-1.5 rounded-md py-1 ps-2.5 pe-1 text-xs"
						>
							<span className="truncate">{member.label}</span>
							<Button
								variant="ghost"
								size="icon-xs"
								disabled={pending}
								aria-label={removeLabel(member.label)}
								onClick={() =>
									mode === 'dm'
										? setTargetId('')
										: toggleMember(member.id, false)
								}
							>
								<Icon name="x" />
							</Button>
						</span>
					))}
				</div>
			) : null}
			<div className="max-h-48 overflow-y-auto overscroll-contain rounded-lg border p-1">
				{visible.length === 0 ? (
					<div
						className="flex min-h-32 flex-col items-center justify-center gap-2 p-4 text-center"
						role="status"
					>
						<Icon name="users" size="md" className="text-muted-foreground" />
						<p className="text-sm font-medium">
							{members.length === 0 ? (
								<Trans>No teammates available</Trans>
							) : (
								<Trans>No matching teammates</Trans>
							)}
						</p>
						<p className="text-muted-foreground text-xs">
							{members.length === 0 ? (
								<Trans>Add another team member to start a conversation.</Trans>
							) : (
								<Trans>Try a different name or clear your search.</Trans>
							)}
						</p>
					</div>
				) : mode === 'dm' ? (
					<RadioGroup
						value={targetId}
						onValueChange={(value) => setTargetId(String(value))}
						aria-labelledby={peopleId}
						className="gap-1"
						disabled={pending}
					>
						{visible.map((member) => (
							<label
								key={member.id}
								className={cn(
									'hover:bg-muted focus-within:bg-muted flex min-h-14 cursor-pointer items-center gap-3 rounded-md px-3 py-2',
									member.id === targetId && 'bg-accent',
								)}
							>
								<PersonAvatar
									person={{ id: member.id, name: member.label, image: null }}
								/>
								<span
									id={`${peopleId}-${member.id}`}
									className="min-w-0 flex-1 text-sm font-medium break-words"
								>
									{member.label}
								</span>
								<RadioGroupItem
									value={member.id}
									aria-labelledby={`${peopleId}-${member.id}`}
								/>
							</label>
						))}
					</RadioGroup>
				) : (
					<div role="group" aria-labelledby={peopleId} className="space-y-1">
						{visible.map((member) => (
							<label
								key={member.id}
								className={cn(
									'hover:bg-muted focus-within:bg-muted flex min-h-14 cursor-pointer items-center gap-3 rounded-md px-3 py-2',
									groupMembers.has(member.id) && 'bg-accent',
								)}
							>
								<PersonAvatar
									person={{ id: member.id, name: member.label, image: null }}
								/>
								<span
									id={`${peopleId}-${member.id}`}
									className="min-w-0 flex-1 text-sm font-medium break-words"
								>
									{member.label}
								</span>
								<Checkbox
									checked={groupMembers.has(member.id)}
									disabled={
										pending ||
										(!groupMembers.has(member.id) &&
											selectedCount >= CHAT_LIMITS.groupMembersMax - 1)
									}
									aria-labelledby={`${peopleId}-${member.id}`}
									onCheckedChange={(checked) =>
										toggleMember(member.id, checked === true)
									}
								/>
							</label>
						))}
					</div>
				)}
			</div>
		</div>
	)

	const groupFields = (
		<div className="space-y-5">
			<div className="space-y-2">
				<Label htmlFor={groupNameId}>
					<Trans>Group name</Trans>
				</Label>
				<Input
					id={groupNameId}
					value={groupName}
					maxLength={CHAT_LIMITS.nameMax}
					placeholder={_(msg`Give your group a name`)}
					disabled={pending}
					onChange={(event) => setGroupName(event.target.value)}
				/>
			</div>
			{peoplePicker}
			<label className="bg-muted/30 flex cursor-pointer items-start gap-3 rounded-lg border p-3">
				<Checkbox
					className="mt-0.5"
					checked={showHistory}
					disabled={pending}
					aria-describedby={historyId}
					aria-labelledby={historyLabelId}
					onCheckedChange={(checked) => setShowHistory(checked === true)}
				/>
				<span className="min-w-0">
					<span id={historyLabelId} className="block text-sm font-medium">
						<Trans>New members can read earlier messages</Trans>
					</span>
					<span
						id={historyId}
						className="text-muted-foreground mt-1 block text-xs leading-relaxed"
					>
						<Trans>
							Otherwise, they only see messages sent after they join.
						</Trans>
					</span>
				</span>
			</label>
		</div>
	)

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose()
			}}
		>
			<DialogContent
				initialFocus={searchInput}
				showCloseButton={!pending}
				className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
			>
				<div className="px-6 pt-6 pb-5">
					<DialogHeader className="rtl:flex-col">
						<DialogTitle>
							<Trans>New message</Trans>
						</DialogTitle>
						<DialogDescription>
							{mode === 'dm' ? (
								<Trans>Choose a teammate to start a conversation.</Trans>
							) : (
								<Trans>Bring the right people together in a group.</Trans>
							)}
						</DialogDescription>
					</DialogHeader>
				</div>
				<form
					onSubmit={submit}
					className="flex min-h-0 flex-col"
					aria-busy={pending}
				>
					<div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
						{canCreateGroup ? (
							<Tabs
								value={mode}
								onValueChange={(value) => {
									if (value === 'dm' || value === 'group') {
										setMode(value)
										setFilter('')
									}
								}}
								className="gap-5"
							>
								<TabsList className="w-full">
									<TabsTrigger value="dm" disabled={pending}>
										<Icon name="user" />
										<Trans>Direct message</Trans>
									</TabsTrigger>
									<TabsTrigger value="group" disabled={pending}>
										<Icon name="users" />
										<Trans>Group</Trans>
									</TabsTrigger>
								</TabsList>
								<TabsContent value="dm">{peoplePicker}</TabsContent>
								<TabsContent value="group">{groupFields}</TabsContent>
							</Tabs>
						) : (
							peoplePicker
						)}
						{result && !result.ok ? (
							<p
								className="bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
								role="alert"
							>
								{result.error ??
									_(msg`Could not start the conversation. Try again.`)}
							</p>
						) : null}
					</div>
					<DialogFooter className="mx-0 mb-0 shrink-0 px-6 rtl:flex-col-reverse sm:rtl:flex-row">
						<Button
							type="button"
							variant="ghost"
							onClick={onClose}
							disabled={pending}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={!canStart}>
							{pending ? (
								<span aria-hidden>
									<Spinner />
								</span>
							) : (
								<Icon name={mode === 'dm' ? 'message-square' : 'users'} />
							)}
							{pending ? (
								<Trans>Starting…</Trans>
							) : mode === 'dm' ? (
								<Trans>Start conversation</Trans>
							) : (
								<Trans>Create group</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
