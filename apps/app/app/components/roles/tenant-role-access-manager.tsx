import { Trans, t } from '@lingui/macro'
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
import { Checkbox } from '@repo/ui/checkbox'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useState } from 'react'
import { Form, Link, useNavigation } from 'react-router'

export type TenantRole = {
	id: string
	name: string
	description: string
	isBuiltIn: boolean
	permissionIds: string[]
	memberCount: number
}

type PermissionOption = {
	id: string
	label: string
	description: string
	warning?: string
}

export type PermissionGroup = {
	title: string
	description: string
	permissions: PermissionOption[]
}

export function getPermissionGroups(): PermissionGroup[] {
	return [
		{
			title: t`Notes & Documents`,
			description: t`Access to personal and shared team notes.`,
			permissions: [
				{
					id: 'org_perm_create_note_own',
					label: t`Create notes`,
					description: t`Draft and create new notes in the organization.`,
				},
				{
					id: 'org_perm_read_note_own',
					label: t`View own notes`,
					description: t`Open and view notes created by this user.`,
				},
				{
					id: 'org_perm_read_note_org',
					label: t`View team notes`,
					description: t`Open and view notes created by any organization teammate.`,
				},
				{
					id: 'org_perm_update_note_own',
					label: t`Edit own notes`,
					description: t`Make modifications to notes created by this user.`,
				},
				{
					id: 'org_perm_update_note_org',
					label: t`Edit team notes`,
					description: t`Modify notes created by other team members.`,
					warning: t`Can edit teammate notes`,
				},
				{
					id: 'org_perm_delete_note_own',
					label: t`Delete own notes`,
					description: t`Permanently delete notes created by this user.`,
				},
				{
					id: 'org_perm_delete_note_org',
					label: t`Delete team notes`,
					description: t`Permanently delete notes created by any teammate.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Team & Members`,
			description: t`Collaborator visibility and access control.`,
			permissions: [
				{
					id: 'org_perm_read_member_any',
					label: t`View team members`,
					description: t`See teammate names, emails, and assigned roles.`,
				},
				{
					id: 'org_perm_create_member_any',
					label: t`Invite new members`,
					description: t`Send invitations to join the organization workspace.`,
				},
				{
					id: 'org_perm_delete_member_any',
					label: t`Remove team members`,
					description: t`Revoke workspace access and remove non-admin members.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Organization Settings`,
			description: t`Organization details and configuration.`,
			permissions: [
				{
					id: 'org_perm_read_settings_any',
					label: t`View organization settings`,
					description: t`Read organization details, verified domain, and storage status.`,
				},
				{
					id: 'org_perm_update_settings_any',
					label: t`Modify organization settings`,
					description: t`Update organization name, slug, and general preferences.`,
					warning: t`High impact`,
				},
			],
		},
		{
			title: t`Website & Publishing`,
			description: t`Website editor and public pages.`,
			permissions: [
				{
					id: 'org_perm_read_website_any',
					label: t`View website workspace`,
					description: t`Open pages and themes in the site builder.`,
				},
				{
					id: 'org_perm_update_website_any',
					label: t`Edit website content`,
					description: t`Create, update, and publish web pages and announcements.`,
					warning: t`High impact`,
				},
			],
		},
	]
}

export function getPresets() {
	return [
		{
			name: t`Content editor`,
			description: t`Notes & website`,
			permissionIds: [
				'org_perm_create_note_own',
				'org_perm_read_note_own',
				'org_perm_read_note_org',
				'org_perm_update_note_own',
				'org_perm_update_website_any',
				'org_perm_read_website_any',
			],
		},
		{
			name: t`Team manager`,
			description: t`Members & invites`,
			permissionIds: [
				'org_perm_read_member_any',
				'org_perm_create_member_any',
				'org_perm_delete_member_any',
				'org_perm_read_note_org',
			],
		},
		{
			name: t`Viewer`,
			description: t`Read-only`,
			permissionIds: [
				'org_perm_read_note_org',
				'org_perm_read_member_any',
				'org_perm_read_website_any',
			],
		},
		{
			name: t`Blank`,
			description: t`Zero permissions`,
			permissionIds: [],
		},
	]
}

export function RoleAccessForm({
	role,
	cancelHref,
	error,
}: {
	role?: TenantRole
	cancelHref: string
	error?: string
	orgSlug?: string
}) {
	const navigation = useNavigation()
	const isSubmitting = navigation.state === 'submitting'
	const permissionGroups = getPermissionGroups()
	const presets = getPresets()

	const [selectedPermissionIds, setSelectedPermissionIds] = useState<string[]>(
		role ? role.permissionIds : (presets[0]?.permissionIds ?? []),
	)
	const [activePreset, setActivePreset] = useState<string | null>(
		role ? null : (presets[0]?.name ?? null),
	)

	const togglePermission = (id: string, checked: boolean) => {
		setActivePreset(null)
		setSelectedPermissionIds((prev) =>
			checked ? [...prev, id] : prev.filter((p) => p !== id),
		)
	}

	const applyPreset = (preset: (typeof presets)[number]) => {
		setActivePreset(preset.name)
		setSelectedPermissionIds(preset.permissionIds)
	}

	return (
		<div className="space-y-6">
			{error && (
				<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm">
					{error}
				</div>
			)}

			<Form method="POST" id="role-access-form" className="space-y-6">
				{/* Role Details Frame */}
				<Frame className="w-full">
					<FrameHeader>
						<FrameTitle className="text-base">
							{role ? (
								<Trans>Edit Custom Role</Trans>
							) : (
								<Trans>Create Custom Role</Trans>
							)}
						</FrameTitle>
						<FrameDescription>
							{role
								? t`Update this role’s name, description, and permissions.`
								: t`Define role details and select what permissions members receive.`}
						</FrameDescription>
					</FrameHeader>
					<FramePanel className="space-y-6">
						<div className="grid gap-5 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="role-name" className="text-sm font-medium">
									<Trans>Role name</Trans>{' '}
									<span className="text-destructive">*</span>
								</Label>
								<Input
									id="role-name"
									name="name"
									defaultValue={role?.name}
									required
									maxLength={80}
									placeholder="e.g. Content Editor"
									disabled={isSubmitting}
									className="h-10 text-sm"
								/>
							</div>
							<div className="space-y-2">
								<Label
									htmlFor="role-description"
									className="text-sm font-medium"
								>
									<Trans>Description</Trans>
								</Label>
								<Input
									id="role-description"
									name="description"
									defaultValue={role?.description}
									maxLength={280}
									placeholder="e.g. Can edit content but cannot change settings."
									disabled={isSubmitting}
									className="h-10 text-sm"
								/>
							</div>
						</div>

						{!role && (
							<div className="border-border/60 space-y-3 border-t pt-4">
								<Label className="text-foreground block text-sm font-medium">
									<Trans>Start from a template</Trans>
								</Label>
								<div className="flex flex-wrap gap-2.5">
									{presets.map((preset) => {
										const isSelected = activePreset === preset.name
										return (
											<button
												key={preset.name}
												type="button"
												onClick={() => applyPreset(preset)}
												disabled={isSubmitting}
												className={cn(
													'rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-all',
													isSelected
														? 'bg-foreground text-background border-foreground shadow-xs'
														: 'bg-card text-muted-foreground border-border hover:text-foreground hover:bg-muted/40',
												)}
											>
												{preset.name}
											</button>
										)
									})}
								</div>
							</div>
						)}
					</FramePanel>
				</Frame>

				{/* Framed Tables for Each Permission Group */}
				<div className="space-y-6">
					{permissionGroups.map((group) => {
						const groupPermissionIds = group.permissions.map((p) => p.id)
						const selectedInGroup = group.permissions.filter((p) =>
							selectedPermissionIds.includes(p.id),
						).length
						const allGroupSelected =
							selectedInGroup === group.permissions.length

						const toggleGroup = () => {
							setActivePreset(null)
							if (allGroupSelected) {
								setSelectedPermissionIds((prev) =>
									prev.filter((id) => !groupPermissionIds.includes(id)),
								)
							} else {
								setSelectedPermissionIds((prev) =>
									Array.from(new Set([...prev, ...groupPermissionIds])),
								)
							}
						}

						return (
							<Frame key={group.title} className="w-full">
								<FrameHeader>
									<div className="flex items-center gap-2">
										<FrameTitle className="text-base">{group.title}</FrameTitle>
										<Badge variant="outline" className="text-xs font-normal">
											{selectedInGroup} of {group.permissions.length} selected
										</Badge>
									</div>
									<FrameDescription>{group.description}</FrameDescription>
									<FrameAction>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={toggleGroup}
											disabled={isSubmitting}
											className="text-muted-foreground hover:text-foreground text-xs font-medium"
										>
											{allGroupSelected ? (
												<Trans>Deselect all</Trans>
											) : (
												<Trans>Select all</Trans>
											)}
										</Button>
									</FrameAction>
								</FrameHeader>

								<Table variant="card">
									<TableHeader>
										<TableRow>
											<TableHead className="w-12 text-center">
												<Checkbox
													checked={allGroupSelected}
													onCheckedChange={toggleGroup}
													disabled={isSubmitting}
													aria-label={`Select all ${group.title}`}
												/>
											</TableHead>
											<TableHead className="w-1/3">
												<Trans>Permission</Trans>
											</TableHead>
											<TableHead>
												<Trans>Description</Trans>
											</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{group.permissions.map((permission) => {
											const id = `permission-${permission.id}`
											const isChecked = selectedPermissionIds.includes(
												permission.id,
											)

											return (
												<TableRow
													key={permission.id}
													className="hover:bg-muted/30 cursor-pointer transition-colors"
													onClick={() =>
														togglePermission(permission.id, !isChecked)
													}
												>
													<TableCell
														className="pt-4 text-center align-top"
														onClick={(e) => e.stopPropagation()}
													>
														<Checkbox
															id={id}
															checked={isChecked}
															onCheckedChange={(checked) =>
																togglePermission(
																	permission.id,
																	checked === true,
																)
															}
															disabled={isSubmitting}
														/>
														{isChecked ? (
															<input
																type="hidden"
																name="permissionIds"
																value={permission.id}
															/>
														) : null}
													</TableCell>
													<TableCell className="text-foreground pt-3.5 align-top font-medium">
														<div className="flex flex-wrap items-center gap-2">
															<span className="text-sm font-medium">
																{permission.label}
															</span>
															{permission.warning && (
																<span className="text-xs font-normal text-amber-600 dark:text-amber-400">
																	· {permission.warning}
																</span>
															)}
														</div>
													</TableCell>
													<TableCell className="text-muted-foreground pt-3.5 align-top text-sm leading-relaxed">
														{permission.description}
													</TableCell>
												</TableRow>
											)
										})}
									</TableBody>
								</Table>
							</Frame>
						)
					})}
				</div>

				{/* Sticky/Bottom Actions Frame */}
				<Frame className="w-full">
					<FrameFooter className="flex flex-row items-center justify-between p-4">
						<span className="text-muted-foreground text-sm">
							<strong className="text-foreground">
								{selectedPermissionIds.length}
							</strong>{' '}
							<Trans>permissions selected</Trans>
						</span>
						<div className="flex items-center gap-3">
							<Button
								variant="outline"
								render={<Link to={cancelHref} />}
								disabled={isSubmitting}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" disabled={isSubmitting}>
								{isSubmitting ? (
									<Trans>Saving…</Trans>
								) : role ? (
									<Trans>Save changes</Trans>
								) : (
									<Trans>Create role</Trans>
								)}
							</Button>
						</div>
					</FrameFooter>
				</Frame>
			</Form>
		</div>
	)
}

export function ReadOnlyRoleView({
	role,
	editHref,
}: {
	role: TenantRole
	editHref?: string
	orgSlug?: string
}) {
	const permissionGroups = getPermissionGroups()
	const grantedCount = role.permissionIds.length
	const totalCount = permissionGroups.reduce(
		(sum, g) => sum + g.permissions.length,
		0,
	)

	return (
		<div className="space-y-6" aria-label="Role permissions overview">
			{/* Role Overview Frame */}
			<Frame className="w-full">
				<FrameHeader>
					<div className="flex items-center gap-2.5">
						<FrameTitle className="text-lg font-semibold">
							{role.name}
						</FrameTitle>
						<Badge variant="secondary" className="text-xs font-normal">
							{role.isBuiltIn ? <Trans>Built-in</Trans> : <Trans>Custom</Trans>}
						</Badge>
					</div>
					<FrameDescription>
						{role.description || (
							<span className="italic">
								<Trans>Standard system role.</Trans>
							</span>
						)}{' '}
						· {role.memberCount}{' '}
						{role.memberCount === 1 ? t`member` : t`members`} · {grantedCount}{' '}
						of {totalCount} <Trans>permissions granted</Trans>
					</FrameDescription>
					{editHref && (
						<FrameAction>
							<Button
								variant="outline"
								size="sm"
								render={<Link to={editHref} />}
							>
								<Trans>Edit role</Trans>
							</Button>
						</FrameAction>
					)}
				</FrameHeader>
			</Frame>

			{/* Framed Tables for Each Permission Group */}
			<div className="space-y-6">
				{permissionGroups.map((group) => {
					const allowedInGroup = group.permissions.filter((p) =>
						role.permissionIds.includes(p.id),
					).length

					return (
						<Frame key={group.title} className="w-full">
							<FrameHeader>
								<div className="flex items-center gap-2">
									<FrameTitle className="text-base">{group.title}</FrameTitle>
									<Badge variant="outline" className="text-xs font-normal">
										{allowedInGroup} of {group.permissions.length} allowed
									</Badge>
								</div>
								<FrameDescription>{group.description}</FrameDescription>
							</FrameHeader>

							<Table variant="card">
								<TableHeader>
									<TableRow>
										<TableHead className="w-1/3">
											<Trans>Permission</Trans>
										</TableHead>
										<TableHead className="w-1/2">
											<Trans>Description</Trans>
										</TableHead>
										<TableHead className="w-1/6 text-right">
											<Trans>Status</Trans>
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{group.permissions.map((permission) => {
										const isAllowed = role.permissionIds.includes(permission.id)

										return (
											<TableRow key={permission.id}>
												<TableCell className="text-foreground pt-3.5 align-top font-medium">
													<div className="flex flex-wrap items-center gap-2">
														<span className="text-sm font-medium">
															{permission.label}
														</span>
														{isAllowed && permission.warning && (
															<span className="text-xs font-normal text-amber-600 dark:text-amber-400">
																· {permission.warning}
															</span>
														)}
													</div>
												</TableCell>
												<TableCell className="text-muted-foreground pt-3.5 align-top text-sm leading-relaxed">
													{permission.description}
												</TableCell>
												<TableCell className="pt-3.5 text-right align-top">
													{isAllowed ? (
														<Badge
															variant="outline"
															className="border-emerald-500/30 bg-emerald-500/10 text-xs font-medium text-emerald-700 dark:text-emerald-400"
														>
															<Trans>Allowed</Trans>
														</Badge>
													) : (
														<span className="text-muted-foreground text-xs">
															<Trans>Not allowed</Trans>
														</span>
													)}
												</TableCell>
											</TableRow>
										)
									})}
								</TableBody>
							</Table>
						</Frame>
					)
				})}
			</div>
		</div>
	)
}

export function TenantRoleAccessManager({
	roles,
	orgSlug,
	message,
	error,
}: {
	roles: TenantRole[]
	orgSlug: string
	message?: string
	error?: string
}) {
	const navigation = useNavigation()
	const [roleToDelete, setRoleToDelete] = useState<TenantRole | null>(null)

	const isDeleting =
		navigation.state === 'submitting' &&
		navigation.formData?.get('intent') === 'delete-role'

	const customRoles = roles.filter((role) => !role.isBuiltIn)
	const builtInRoles = roles.filter((role) => role.isBuiltIn)
	const basePath = `/${orgSlug}/settings/roles`
	const roleNameToDelete = roleToDelete?.name ?? ''

	return (
		<div className="space-y-8">
			{/* Notifications */}
			{message && (
				<div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-200">
					{message}
				</div>
			)}
			{error && (
				<div className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm">
					{error}
				</div>
			)}

			{/* Custom Roles Framed Table */}
			<Frame className="w-full">
				<FrameHeader>
					<FrameTitle className="text-base">
						<Trans>Custom Roles</Trans> ({customRoles.length})
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Tailored roles specific to your organization with configured
							permissions.
						</Trans>
					</FrameDescription>
					<FrameAction>
						<Button
							size="sm"
							render={<Link to={`${basePath}/new`} />}
							className="gap-1.5"
						>
							<Icon name="plus" className="size-3.5" />
							<Trans>Create role</Trans>
						</Button>
					</FrameAction>
				</FrameHeader>

				{customRoles.length === 0 ? (
					<FramePanel className="text-muted-foreground py-10 text-center text-sm">
						<p>
							<Trans>No custom roles created yet.</Trans>
						</p>
						<p className="text-muted-foreground mt-1 text-xs">
							<Trans>
								Create a custom role to assign specific permissions to
								teammates.
							</Trans>
						</p>
					</FramePanel>
				) : (
					<Table variant="card">
						<TableHeader>
							<TableRow>
								<TableHead className="w-1/4">
									<Trans>Role</Trans>
								</TableHead>
								<TableHead className="w-1/3">
									<Trans>Description</Trans>
								</TableHead>
								<TableHead className="text-center">
									<Trans>Members</Trans>
								</TableHead>
								<TableHead className="text-center">
									<Trans>Permissions</Trans>
								</TableHead>
								<TableHead className="text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{customRoles.map((role) => (
								<TableRow key={role.id}>
									<TableCell className="text-foreground align-middle">
										{role.name}
									</TableCell>
									<TableCell className="text-muted-foreground max-w-md truncate align-middle text-sm">
										{role.description || '—'}
									</TableCell>
									<TableCell className="text-muted-foreground text-center align-middle text-sm">
										{role.memberCount}
									</TableCell>
									<TableCell className="text-muted-foreground text-center align-middle text-sm">
										{role.permissionIds.length}
									</TableCell>
									<TableCell className="text-right align-middle">
										<div className="flex items-center justify-end gap-1">
											<Button
												variant="ghost"
												size="sm"
												render={<Link to={`${basePath}/${role.id}`} />}
												className="text-muted-foreground hover:text-foreground text-xs"
											>
												<Trans>View</Trans>
											</Button>
											<Button
												variant="ghost"
												size="sm"
												render={<Link to={`${basePath}/${role.id}/edit`} />}
												className="text-muted-foreground hover:text-foreground text-xs"
											>
												<Trans>Edit</Trans>
											</Button>
											<Button
												variant="ghost"
												size="sm"
												type="button"
												className="text-muted-foreground hover:text-destructive text-xs"
												disabled={isDeleting}
												onClick={() => setRoleToDelete(role)}
											>
												<Trans>Delete</Trans>
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</Frame>

			{/* Built-in Roles Framed Table */}
			<Frame className="w-full">
				<FrameHeader>
					<FrameTitle className="text-base">
						<Trans>Built-in Roles</Trans> ({builtInRoles.length})
					</FrameTitle>
					<FrameDescription>
						<Trans>
							Standard platform roles. Click any role to review its active
							permissions.
						</Trans>
					</FrameDescription>
				</FrameHeader>

				<Table variant="card">
					<TableHeader>
						<TableRow>
							<TableHead className="w-1/4">
								<Trans>Role</Trans>
							</TableHead>
							<TableHead className="w-1/2">
								<Trans>Description</Trans>
							</TableHead>
							<TableHead className="text-center">
								<Trans>Members</Trans>
							</TableHead>
							<TableHead className="text-right">
								<Trans>Access</Trans>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{builtInRoles.map((role) => (
							<TableRow key={role.id} className="group cursor-pointer">
								<TableCell className="text-foreground group-hover:text-primary align-middle transition-colors">
									<Link to={`${basePath}/${role.id}`} className="block py-1">
										{role.name}
									</Link>
								</TableCell>
								<TableCell className="text-muted-foreground align-middle text-sm">
									<Link to={`${basePath}/${role.id}`} className="block py-1">
										{role.description || t`Platform-provided role.`}
									</Link>
								</TableCell>
								<TableCell className="text-muted-foreground text-center align-middle text-sm">
									<Link to={`${basePath}/${role.id}`} className="block py-1">
										{role.memberCount}
									</Link>
								</TableCell>
								<TableCell className="text-right align-middle">
									<Button
										variant="ghost"
										size="sm"
										render={<Link to={`${basePath}/${role.id}`} />}
										className="text-muted-foreground group-hover:text-foreground gap-1 text-xs"
									>
										<Trans>Inspect</Trans>
										<Icon name="arrow-right" className="size-3.5" />
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Frame>

			{/* Delete Role Confirmation Dialog */}
			<AlertDialog
				open={roleToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setRoleToDelete(null)
				}}
			>
				<AlertDialogContent>
					<Form method="POST">
						<input type="hidden" name="intent" value="delete-role" />
						{roleToDelete && (
							<input type="hidden" name="roleId" value={roleToDelete.id} />
						)}
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Delete custom role</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription className="text-sm">
								<Trans>
									Are you sure you want to delete “{roleNameToDelete}”? This
									action cannot be undone.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isDeleting}>
								<Trans>Cancel</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								type="submit"
								variant="destructive"
								disabled={isDeleting}
							>
								{isDeleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
							</AlertDialogAction>
						</AlertDialogFooter>
					</Form>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
