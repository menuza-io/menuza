import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { CHAT_LIMITS, type ChatChannelDetail } from '@repo/common/chat'
import { Badge } from '@repo/ui/badge'
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
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import { Link, useFetcher, useLoaderData, useParams } from 'react-router'
import { type ChatSettingsActionResult } from '#app/utils/chat/chat-settings.ts'
import { type Route } from './+types/chat.ts'

export { action, loader } from './chat.server.ts'

type Option = { id: string; label: string }

function AudienceSummary({
	channel,
	roleName,
}: {
	channel: ChatChannelDetail
	roleName: Map<string, string>
}) {
	const { _ } = useLingui()
	const memberCount = channel.memberIds.length
	const parts = [
		...channel.roleIds.map((id) => roleName.get(id) ?? _(msg`Unknown role`)),
		memberCount > 0
			? _(plural(memberCount, { one: '# person', other: '# people' }))
			: null,
	].filter(Boolean)
	return (
		<p className="text-muted-foreground mt-1 text-xs">{parts.join(' · ')}</p>
	)
}

export default function ChatChannelsSettings() {
	const { orgSlug = '' } = useParams()
	const { channels, roles, members } =
		useLoaderData<Route.ComponentProps['loaderData']>()
	const { _ } = useLingui()
	const [editing, setEditing] = useState<ChatChannelDetail | 'new' | null>(null)
	const [deleting, setDeleting] = useState<ChatChannelDetail | null>(null)
	const roleOptions: Option[] = roles.map((role) => ({
		id: role.id,
		label: role.name,
	}))
	const memberOptions: Option[] = members.map((member) => ({
		id: member.id,
		label: member.name || member.username,
	}))
	const roleName = new Map(roleOptions.map((role) => [role.id, role.label]))

	return (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-4">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="min-w-0 flex-1">
						<h2 className="text-lg font-semibold">
							<Trans>Chat channels</Trans>
						</h2>
						<p className="text-muted-foreground text-sm text-pretty">
							<Trans>
								Create channels for your team and choose which roles or people
								can read and post in them.
							</Trans>
						</p>
					</div>
					<div className="flex shrink-0 flex-wrap gap-2">
						{channels.length > 0 ? (
							<Button
								variant="outline"
								render={
									<Link to={`/${orgSlug}/chat`}>
										<Icon name="message-square" />
										<Trans>Open team chat</Trans>
									</Link>
								}
							/>
						) : null}
						<Button type="button" onClick={() => setEditing('new')}>
							<Trans>New channel</Trans>
						</Button>
					</div>
				</div>

				{channels.length === 0 ? (
					<div className="rounded-lg border border-dashed py-4">
						<Empty>
							<EmptyHeader>
								<EmptyTitle>
									<Trans>No channels yet</Trans>
								</EmptyTitle>
								<EmptyDescription>
									<Trans>
										Your team will see channels here once you create one.
										Members open chat from the sidebar next to the logo.
									</Trans>
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button type="button" onClick={() => setEditing('new')}>
									<Trans>Create your first channel</Trans>
								</Button>
							</EmptyContent>
						</Empty>
					</div>
				) : (
					<ul className="divide-y rounded-lg border">
						{channels.map((channel) => (
							<li
								key={channel.id}
								className="flex flex-wrap items-center gap-3 p-4"
							>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="font-medium">{channel.name}</span>
										<Badge variant="secondary">
											{channel.access === 'everyone'
												? _(msg`Everyone`)
												: _(msg`Restricted`)}
										</Badge>
									</div>
									{channel.description ? (
										<p className="text-muted-foreground truncate text-sm">
											{channel.description}
										</p>
									) : null}
									{channel.access === 'restricted' ? (
										<AudienceSummary channel={channel} roleName={roleName} />
									) : null}
								</div>
								<div className="flex gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => setEditing(channel)}
									>
										<Trans>Edit</Trans>
									</Button>
									<Button
										type="button"
										variant="destructive"
										size="sm"
										onClick={() => setDeleting(channel)}
									>
										<Trans>Delete</Trans>
									</Button>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>

			{editing ? (
				<ChannelDialog
					key={editing === 'new' ? 'new' : editing.id}
					channel={editing === 'new' ? null : editing}
					roles={roleOptions}
					members={memberOptions}
					onClose={() => setEditing(null)}
				/>
			) : null}
			{deleting ? (
				<DeleteChannelDialog
					channel={deleting}
					onClose={() => setDeleting(null)}
				/>
			) : null}
		</div>
	)
}

function ChannelDialog({
	channel,
	roles,
	members,
	onClose,
}: {
	channel: ChatChannelDetail | null
	roles: Option[]
	members: Option[]
	onClose(): void
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<ChatSettingsActionResult>()
	const [name, setName] = useState(channel?.name ?? '')
	const [description, setDescription] = useState(channel?.description ?? '')
	const [access, setAccess] = useState<'everyone' | 'restricted'>(
		channel?.access ?? 'everyone',
	)
	const [roleIds, setRoleIds] = useState(new Set(channel?.roleIds ?? []))
	const [memberIds, setMemberIds] = useState(new Set(channel?.memberIds ?? []))
	const [filter, setFilter] = useState('')
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const selectedRoleCount = roleIds.size
	const selectedMemberCount = memberIds.size

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) onClose()
	}, [fetcher.state, result, onClose])

	const fieldErrors = result && !result.ok ? result.fieldErrors : undefined
	const visibleMembers = members.filter((member) =>
		member.label.toLowerCase().includes(filter.trim().toLowerCase()),
	)

	function toggle(set: Set<string>, id: string, on: boolean) {
		const next = new Set(set)
		if (on) next.add(id)
		else next.delete(id)
		return next
	}

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="max-h-dvh overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{channel ? <Trans>Edit channel</Trans> : <Trans>New channel</Trans>}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Restricted channels are visible only to the roles and people you
							choose. Being an admin does not grant access on its own.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				<form
					className="flex flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault()
						void fetcher.submit(
							{
								intent: 'save',
								...(channel ? { id: channel.id } : {}),
								name,
								description,
								access,
								roleIds: [...roleIds],
								memberIds: [...memberIds],
							},
							{ method: 'POST', encType: 'application/json' },
						)
					}}
				>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="chat-channel-name">
							<Trans>Name</Trans>
						</Label>
						<Input
							id="chat-channel-name"
							value={name}
							maxLength={CHAT_LIMITS.nameMax}
							autoFocus
							required
							aria-invalid={fieldErrors?.name ? true : undefined}
							onChange={(event) => setName(event.target.value)}
						/>
						{fieldErrors?.name ? (
							<p role="alert" className="text-destructive text-xs">
								{fieldErrors.name}
							</p>
						) : null}
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="chat-channel-description">
							<Trans>Description</Trans>
						</Label>
						<Textarea
							id="chat-channel-description"
							value={description}
							rows={2}
							maxLength={CHAT_LIMITS.descriptionMax}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>

					<fieldset className="flex flex-col gap-2">
						<legend className="mb-1 text-sm font-medium">
							<Trans>Who can access this channel?</Trans>
						</legend>
						<RadioGroup
							value={access}
							onValueChange={(value: string) =>
								setAccess(value === 'restricted' ? 'restricted' : 'everyone')
							}
							className="grid gap-2"
						>
							<label className="flex items-start gap-2 text-sm">
								<RadioGroupItem value="everyone" className="mt-0.5" />
								<span>
									<span className="font-medium">
										<Trans>Everyone on the team</Trans>
									</span>
									<span className="text-muted-foreground block text-xs">
										<Trans>Every active member can read and post.</Trans>
									</span>
								</span>
							</label>
							<label className="flex items-start gap-2 text-sm">
								<RadioGroupItem value="restricted" className="mt-0.5" />
								<span>
									<span className="font-medium">
										<Trans>Only selected roles and people</Trans>
									</span>
									<span className="text-muted-foreground block text-xs">
										<Trans>Everyone else won't see that it exists.</Trans>
									</span>
								</span>
							</label>
						</RadioGroup>
					</fieldset>

					{access === 'restricted' ? (
						<div className="flex flex-col gap-4">
							<fieldset className="flex flex-col gap-2">
								<legend className="mb-1 text-sm font-medium">
									<Trans>Roles</Trans>
								</legend>
								{roles.map((role) => (
									<label
										key={role.id}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={roleIds.has(role.id)}
											onCheckedChange={(checked) =>
												setRoleIds(toggle(roleIds, role.id, checked === true))
											}
										/>
										{role.label}
									</label>
								))}
								{fieldErrors?.roleIds ? (
									<p role="alert" className="text-destructive text-xs">
										{fieldErrors.roleIds}
									</p>
								) : null}
							</fieldset>

							<fieldset className="flex flex-col gap-2">
								<legend className="mb-1 text-sm font-medium">
									<Trans>People</Trans>
								</legend>
								<Input
									type="search"
									value={filter}
									placeholder={_(msg`Search people`)}
									aria-label={_(msg`Search people`)}
									onChange={(event) => setFilter(event.target.value)}
								/>
								<div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-md border p-2">
									{visibleMembers.length === 0 ? (
										<p className="text-muted-foreground text-xs">
											<Trans>No one matches your search.</Trans>
										</p>
									) : (
										visibleMembers.map((member) => (
											<label
												key={member.id}
												className="flex items-center gap-2 text-sm"
											>
												<Checkbox
													checked={memberIds.has(member.id)}
													onCheckedChange={(checked) =>
														setMemberIds(
															toggle(memberIds, member.id, checked === true),
														)
													}
												/>
												{member.label}
											</label>
										))
									)}
								</div>
								<p className="text-muted-foreground text-xs">
									{_(
										msg`${selectedRoleCount} roles and ${selectedMemberCount} people selected`,
									)}
								</p>
								{fieldErrors?.memberIds ? (
									<p role="alert" className="text-destructive text-xs">
										{fieldErrors.memberIds}
									</p>
								) : null}
							</fieldset>
						</div>
					) : null}

					{result && !result.ok && result.error ? (
						<p role="alert" className="text-destructive text-sm">
							{result.error}
						</p>
					) : null}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={pending || !name.trim()}>
							{channel ? (
								<Trans>Save changes</Trans>
							) : (
								<Trans>Create channel</Trans>
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

function DeleteChannelDialog({
	channel,
	onClose,
}: {
	channel: ChatChannelDetail
	onClose(): void
}) {
	const fetcher = useFetcher<ChatSettingsActionResult>()
	const pending = fetcher.state !== 'idle'
	const result = fetcher.data
	const channelName = channel.name

	useEffect(() => {
		if (fetcher.state === 'idle' && result?.ok) onClose()
	}, [fetcher.state, result, onClose])

	return (
		<Dialog
			defaultOpen
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Delete {channelName}?</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							All messages in this channel are permanently deleted for everyone.
							This can't be undone.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{result && !result.ok && result.error ? (
					<p role="alert" className="text-destructive text-sm">
						{result.error}
					</p>
				) : null}
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={() =>
							void fetcher.submit(
								{ intent: 'delete', id: channel.id },
								{ method: 'POST', encType: 'application/json' },
							)
						}
					>
						<Trans>Delete channel</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
