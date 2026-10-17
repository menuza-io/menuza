import { Plural, Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getUserImgSrc } from '@repo/common'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Separator } from '@repo/ui/separator'
import { StatusButton } from '@repo/ui/status-button'
import { Switch } from '@repo/ui/switch'
import { useState, useEffect } from 'react'
import { useFetcher } from 'react-router'

type ShareNoteButtonProps = {
	noteId: string
	noteOwnerId: string
	isPublic: boolean
	noteAccess: Array<{
		id: string
		user: {
			id: string
			name: string | null
			username: string
		}
	}>
	organizationMembers: Array<{
		userId: string
		user: {
			id: string
			name: string | null
			username: string
			image?: { objectKey: string } | null
		}
	}>
	open?: boolean
	onOpenChange?: (open: boolean) => void
	showTrigger?: boolean
}

export function ShareNoteButton({
	noteId,
	noteOwnerId,
	isPublic,
	noteAccess,
	organizationMembers,
	open: controlledOpen,
	onOpenChange,
	showTrigger = true,
}: ShareNoteButtonProps) {
	const [internalOpen, setInternalOpen] = useState(false)
	const open = controlledOpen ?? internalOpen
	const setOpen = onOpenChange ?? setInternalOpen
	const fetcher = useFetcher()
	const { _ } = useLingui()

	// Local state for form changes (not submitted yet)
	const [localIsPublic, setLocalIsPublic] = useState(isPublic)
	const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>(
		noteAccess.map((access) => access.user.id),
	)
	const [searchQuery, setSearchQuery] = useState('')

	// Reset local state when dialog opens or props change
	useEffect(() => {
		if (open) {
			setLocalIsPublic(isPublic)
			setSelectedMemberIds(noteAccess.map((access) => access.user.id))
			setSearchQuery('')
		}
	}, [open, isPublic, noteAccess])

	// Close dialog on successful submission
	useEffect(() => {
		if (fetcher.data?.result?.status === 'success') {
			setOpen(false)
		}
	}, [fetcher.data, setOpen])

	const toggleMemberSelection = (userId: string) => {
		setSelectedMemberIds((prev) =>
			prev.includes(userId)
				? prev.filter((id) => id !== userId)
				: [...prev, userId],
		)
	}

	const removeMember = (userId: string) => {
		setSelectedMemberIds((prev) => prev.filter((id) => id !== userId))
	}

	const handleSubmit = () => {
		const formData = new FormData()

		// Handle member access changes
		const currentAccessIds = new Set(noteAccess.map((access) => access.user.id))
		const newAccessIds = new Set(selectedMemberIds)

		// Members to add
		const toAdd = selectedMemberIds.filter((id) => !currentAccessIds.has(id))
		// Members to remove
		const toRemove = noteAccess
			.map((access) => access.user.id)
			.filter((id) => !newAccessIds.has(id))

		// Check if we only need to update public/private status without member changes
		const hasPublicStatusChange = localIsPublic !== isPublic
		const hasMemberChanges = toAdd.length > 0 || toRemove.length > 0

		if (hasPublicStatusChange && !hasMemberChanges) {
			// Simple public/private toggle - use the original intent
			formData.append('intent', 'update-note-sharing')
			formData.append('noteId', noteId)
			formData.append('isPublic', localIsPublic.toString())
		} else {
			// Complex changes or member changes - use batch operation
			formData.append('intent', 'batch-update-note-access')
			formData.append('noteId', noteId)
			formData.append('isPublic', localIsPublic.toString())

			// Add users to add
			toAdd.forEach((userId) => {
				formData.append('usersToAdd', userId)
			})

			// Add users to remove
			toRemove.forEach((userId) => {
				formData.append('usersToRemove', userId)
			})
		}

		void fetcher.submit(formData, { method: 'POST' })
	}

	// The owner always has access, so they are never offered as a member
	const shareableMembers = organizationMembers.filter(
		(member) => member.user.id !== noteOwnerId,
	)

	const filteredMembers = shareableMembers.filter(
		(member) =>
			(member.user.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
				member.user.username
					.toLowerCase()
					.includes(searchQuery.toLowerCase())) &&
			(!localIsPublic || !selectedMemberIds.includes(member.user.id)),
	)

	const getSelectedMemberDetails = () => {
		return shareableMembers
			.filter((member) => selectedMemberIds.includes(member.user.id))
			.map((member) => member.user)
	}

	const initialMemberIds = new Set(noteAccess.map((access) => access.user.id))
	const hasMemberChanges =
		selectedMemberIds.length !== initialMemberIds.size ||
		selectedMemberIds.some((id) => !initialMemberIds.has(id))
	const hasChanges =
		localIsPublic !== isPublic || (!localIsPublic && hasMemberChanges)

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			{showTrigger ? (
				<DialogTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							className="min-[525px]:max-md:aspect-square min-[525px]:max-md:px-0"
						>
							<Icon name="share-2" className="h-4 w-4 max-md:scale-125">
								<span className="max-md:hidden">
									<Trans>Share</Trans>
								</span>
							</Icon>
						</Button>
					}
				></DialogTrigger>
			) : null}
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Share Note</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Control who can access this note</Trans>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-6">
					{/* Public/Private Toggle */}
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="public-toggle" className="text-base">
								<Trans>Public Access</Trans>
							</Label>
							<div className="text-muted-foreground text-sm">
								{localIsPublic ? (
									<Trans>All organization members can view this note</Trans>
								) : selectedMemberIds.length === 0 ? (
									<Trans>Only you can access this note</Trans>
								) : (
									<Trans>Only selected members can access this note</Trans>
								)}
							</div>
						</div>
						<Switch
							id="public-toggle"
							checked={localIsPublic}
							onCheckedChange={setLocalIsPublic}
							disabled={fetcher.state !== 'idle'}
						/>
					</div>

					{/* Private Mode - Member Selection */}
					{!localIsPublic && (
						<>
							<Separator />

							{/* Selected Members */}
							{selectedMemberIds.length > 0 && (
								<div className="space-y-3">
									<Label className="text-sm font-medium">
										<Trans>Selected Members</Trans>
									</Label>
									<div className="flex flex-wrap gap-2">
										{getSelectedMemberDetails().map((user) => (
											<Badge
												key={user.id}
												variant="secondary"
												className="flex items-center gap-2 pr-1"
											>
												<Avatar className="h-5 w-5">
													<AvatarImage
														src={getUserImgSrc(user.image?.objectKey)}
														alt=""
													/>
													<AvatarFallback className="text-xs">
														{(user.name || user.username)
															.charAt(0)
															.toUpperCase()}
													</AvatarFallback>
												</Avatar>
												<span className="text-xs">
													{user.name || user.username}
												</span>
												<Button
													variant="ghost"
													size="sm"
													className="hover:bg-destructive hover:text-destructive-foreground h-4 w-4 p-0"
													onClick={() => removeMember(user.id)}
													aria-label={_(t`Remove`)}
												>
													<Icon name="x" className="h-3 w-3" />
												</Button>
											</Badge>
										))}
									</div>
								</div>
							)}

							{/* Member Search */}
							<div className="space-y-3">
								<Label className="text-sm font-medium">
									<Trans>Add Members</Trans>
								</Label>
								<div className="relative">
									<Icon
										name="search"
										className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform"
									/>
									<Input
										placeholder={_(t`Search team members...`)}
										value={searchQuery}
										onChange={(e) => setSearchQuery(e.target.value)}
										className="pl-9"
									/>
								</div>

								{/* Member List */}
								<div className="max-h-48 space-y-2 overflow-y-auto">
									{filteredMembers.map((member) => (
										<button
											type="button"
											key={member.userId}
											className={`flex w-full cursor-pointer items-center justify-between rounded-lg border p-2 text-left transition-colors ${
												selectedMemberIds.includes(member.user.id)
													? 'bg-primary/10 border-primary'
													: 'hover:bg-muted'
											}`}
											onClick={() => toggleMemberSelection(member.user.id)}
										>
											<div className="flex items-center gap-3">
												<Avatar className="h-8 w-8">
													<AvatarImage
														src={getUserImgSrc(member.user.image?.objectKey)}
														alt=""
													/>
													<AvatarFallback className="text-sm">
														{(member.user.name || member.user.username)
															.charAt(0)
															.toUpperCase()}
													</AvatarFallback>
												</Avatar>
												<div>
													<div className="text-sm font-medium">
														{member.user.name || member.user.username}
													</div>
													<div className="text-muted-foreground text-xs">
														@{member.user.username}
													</div>
												</div>
											</div>
											{selectedMemberIds.includes(member.user.id) && (
												<Badge variant="default" className="text-xs">
													<Trans>Selected</Trans>
												</Badge>
											)}
										</button>
									))}
									{filteredMembers.length === 0 ? (
										<p className="text-muted-foreground py-2 text-center text-sm">
											{shareableMembers.length === 0 ? (
												<Trans>No other members to share with</Trans>
											) : (
												<Trans>No members found</Trans>
											)}
										</p>
									) : null}
								</div>
							</div>
						</>
					)}

					{/* Action Buttons */}
					<div className="flex justify-end gap-2 pt-4">
						<Button
							variant="outline"
							onClick={() => setOpen(false)}
							disabled={fetcher.state !== 'idle'}
						>
							<Trans>Cancel</Trans>
						</Button>
						{hasChanges ? (
							<StatusButton
								status={fetcher.state !== 'idle' ? 'pending' : 'idle'}
								onClick={handleSubmit}
								disabled={fetcher.state !== 'idle'}
							>
								{localIsPublic ? (
									<Trans>Make Public</Trans>
								) : selectedMemberIds.length === 0 ? (
									<Trans>Make Private</Trans>
								) : (
									<Plural
										value={selectedMemberIds.length}
										one="Share with 1 member"
										other="Share with # members"
									/>
								)}
							</StatusButton>
						) : (
							<Button onClick={() => setOpen(false)}>
								<Trans>Done</Trans>
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
