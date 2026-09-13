import { parseWithZod } from '@conform-to/zod'
import { invariant } from '@epic-web/invariant'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { requireUserWithRole } from '@repo/auth'
import {
	OrganizationRole,
	Permission,
	Role,
	_PermissionToRole,
	_OrganizationPermissionToRole,
	and,
	asc,
	db,
	eq,
	isNull,
} from '@repo/database'
import { Badge } from '@repo/ui/badge'
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from '@repo/ui/breadcrumb'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@repo/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { Form, Link, redirect, useLoaderData } from 'react-router'
import { z } from 'zod'
import { type Route } from './+types/$roleId.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const UpdateRoleSchema = z.object({
	intent: z.enum([
		'update-basic',
		'add-permission',
		'remove-permission',
		'delete-role',
		'create-feature',
		'create-permission',
	]),
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	permissionId: z.string().optional(),
	action: z.string().optional(),
	entity: z.string().optional(),
	access: z.string().optional(),
	// New fields for feature/permission creation
	featureName: z.string().optional(),
	featureKey: z.string().optional(),
	featureDescription: z.string().optional(),
	permissionName: z.string().optional(),
	permissionKey: z.string().optional(),
	permissionDescription: z.string().optional(),
	permissionAction: z.string().optional(),
	permissionAccess: z.string().optional(),
	selectedEntity: z.string().optional(),
})

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')
	invariant(params.roleId, 'Role ID is required')

	// Determine if this is a system role or organization role
	const isSystemRole = params.roleId.startsWith('sys_')

	if (isSystemRole) {
		// Load system role
		const result = await db.query.Role.findFirst({
			where: eq(Role.id, params.roleId),
			with: {
				permissionToRoles: { with: { permission: true } },
				roleToUsers: true,
			},
		})
		const role = result
			? {
					...result,
					permissions: result.permissionToRoles
						.filter(({ permission }) => permission.context === 'system')
						.map(({ permission }) => permission),
					_count: { users: result.roleToUsers.length },
				}
			: null

		if (!role) {
			throw new Response('Role not found', { status: 404 })
		}

		return {
			role,
			roleType: 'system' as const,
			allPermissions: await db
				.select()
				.from(Permission)
				.where(eq(Permission.context, 'system'))
				.orderBy(asc(Permission.entity), asc(Permission.action)),
		}
	} else {
		// Load organization role
		const result = await db.query.OrganizationRole.findFirst({
			where: and(
				eq(OrganizationRole.id, params.roleId),
				isNull(OrganizationRole.organizationId),
			),
			with: {
				organizationPermissionToRoles: { with: { permission: true } },
				organizations: true,
			},
		})
		const role = result
			? {
					...result,
					permissions: result.organizationPermissionToRoles
						.filter(({ permission }) => permission.context === 'organization')
						.map(({ permission }) => permission),
					_count: { users: result.organizations.length },
				}
			: null

		if (!role) {
			throw new Response('Role not found', { status: 404 })
		}

		return {
			role,
			roleType: 'organization' as const,
			allPermissions: await db
				.select()
				.from(Permission)
				.where(eq(Permission.context, 'organization'))
				.orderBy(asc(Permission.entity), asc(Permission.action)),
		}
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireUserWithRole(request, 'admin')
	invariant(params.roleId, 'Role ID is required')

	// This route is reserved for shared platform organization roles. Tenant-owned
	// roles are managed from the tenant app and must never be mutable by ID here.
	if (!params.roleId.startsWith('sys_')) {
		const sharedRole = await db.query.OrganizationRole.findFirst({
			columns: { id: true },
			where: and(
				eq(OrganizationRole.id, params.roleId),
				isNull(OrganizationRole.organizationId),
			),
		})
		if (!sharedRole) {
			throw new Response('Role not found', { status: 404 })
		}
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: UpdateRoleSchema })

	if (submission.status !== 'success') {
		return { result: submission.reply(), success: false }
	}

	const {
		intent,
		name,
		description,
		permissionId,
		action: ignoredAction,
		entity: ignoredEntity,
		access: ignoredAccess,
		featureName,
		featureKey,
		featureDescription,
		permissionName: ignoredPermissionName,
		permissionKey: ignoredPermissionKey,
		permissionDescription,
		permissionAction,
		permissionAccess,
		selectedEntity,
	} = submission.value

	try {
		switch (intent) {
			case 'update-basic': {
				if (params.roleId.startsWith('sys_')) {
					await db
						.update(Role)
						.set({
							...(name && { name }),
							...(description && { description }),
						})
						.where(eq(Role.id, params.roleId))
				} else {
					await db
						.update(OrganizationRole)
						.set({
							...(name && { name }),
							...(description && { description }),
						})
						.where(
							and(
								eq(OrganizationRole.id, params.roleId),
								isNull(OrganizationRole.organizationId),
							),
						)
				}
				return { result: submission.reply(), success: true }
			}

			case 'add-permission': {
				if (!permissionId) {
					return {
						result: submission.reply({
							fieldErrors: { permissionId: ['Permission is required'] },
						}),
						success: false,
					}
				}

				if (params.roleId.startsWith('sys_')) {
					await db
						.insert(_PermissionToRole)
						.values({ A: permissionId, B: params.roleId })
				} else {
					await db
						.insert(_OrganizationPermissionToRole)
						.values({ A: params.roleId, B: permissionId })
				}
				return { result: submission.reply(), success: true }
			}

			case 'remove-permission': {
				if (!permissionId) {
					return {
						result: submission.reply({
							fieldErrors: { permissionId: ['Permission is required'] },
						}),
						success: false,
					}
				}

				if (params.roleId.startsWith('sys_')) {
					await db
						.delete(_PermissionToRole)
						.where(
							and(
								eq(_PermissionToRole.A, permissionId),
								eq(_PermissionToRole.B, params.roleId),
							),
						)
				} else {
					await db
						.delete(_OrganizationPermissionToRole)
						.where(
							and(
								eq(_OrganizationPermissionToRole.A, params.roleId),
								eq(_OrganizationPermissionToRole.B, permissionId),
							),
						)
				}
				return { result: submission.reply(), success: true }
			}

			case 'delete-role': {
				if (params.roleId.startsWith('sys_')) {
					await db.delete(Role).where(eq(Role.id, params.roleId))
				} else {
					await db
						.delete(OrganizationRole)
						.where(
							and(
								eq(OrganizationRole.id, params.roleId),
								isNull(OrganizationRole.organizationId),
							),
						)
				}
				return redirect('/roles')
			}

			case 'create-feature': {
				if (!featureName || !featureKey) {
					const fieldErrors: Record<string, string[]> = {}
					if (!featureName)
						fieldErrors.featureName = ['Feature name is required']
					if (!featureKey) fieldErrors.featureKey = ['Feature key is required']

					return {
						result: submission.reply({ fieldErrors }),
						success: false,
					}
				}

				const roleType = params.roleId.startsWith('sys_')
					? 'system'
					: 'organization'

				// Create basic permissions for the new feature
				const basicPermissions = [
					{ action: 'create', access: 'own' },
					{ action: 'read', access: 'own' },
					{ action: 'update', access: 'own' },
					{ action: 'delete', access: 'own' },
				]

				// Create permissions for this feature
				const createdPermissions = await Promise.all(
					basicPermissions.map(async (perm) => {
						const [permission] = await db
							.insert(Permission)
							.values({
								action: perm.action,
								entity: featureKey!,
								access: perm.access,
								context: roleType,
								description:
									featureDescription || `${perm.action} ${featureName!}`,
							})
							.returning()
						return permission
					}),
				)

				return { result: submission.reply(), success: true, createdPermissions }
			}

			case 'create-permission': {
				if (!permissionAction || !selectedEntity || !permissionAccess) {
					return {
						result: submission.reply({
							fieldErrors: {
								...(!permissionAction && {
									permissionAction: ['Action is required'],
								}),
								...(!selectedEntity && {
									selectedEntity: ['Entity is required'],
								}),
								...(!permissionAccess && {
									permissionAccess: ['Access level is required'],
								}),
							},
						}),
						success: false,
					}
				}

				const roleType = params.roleId.startsWith('sys_')
					? 'system'
					: 'organization'

				// Check if permission already exists
				const [existingPermission] = await db
					.select()
					.from(Permission)
					.where(
						and(
							eq(Permission.action, permissionAction!),
							eq(Permission.entity, selectedEntity!),
							eq(Permission.access, permissionAccess!),
							eq(Permission.context, roleType),
						),
					)
					.limit(1)

				if (existingPermission) {
					return {
						result: submission.reply({
							formErrors: ['This permission already exists'],
						}),
						success: false,
					}
				}

				const [createdPermission] = await db
					.insert(Permission)
					.values({
						action: permissionAction!,
						entity: selectedEntity!,
						access: permissionAccess!,
						context: roleType,
						description:
							permissionDescription ||
							`${permissionAction!} ${selectedEntity!}`,
					})
					.returning()
				if (!createdPermission) throw new Error('Could not create permission')

				return { result: submission.reply(), success: true, createdPermission }
			}
		}
	} catch (error) {
		console.error('Error updating role:', error)
		return {
			result: submission.reply({ formErrors: ['Failed to update role'] }),
			success: false,
		}
	}

	return { result: submission.reply(), success: false }
}

export default function AdminRoleDetailPage() {
	const { role, allPermissions } = useLoaderData<typeof loader>()
	const [selectedTab, setSelectedTab] = useState('feature')
	const { _ } = useLingui()

	// Group permissions by entity for better organization
	const permissionsByEntity = allPermissions.reduce(
		(acc, permission) => {
			if (!acc[permission.entity]) {
				acc[permission.entity] = []
			}
			acc[permission.entity]!.push(permission)
			return acc
		},
		{} as Record<string, typeof allPermissions>,
	)

	const rolePermissionIds = new Set(role.permissions?.map((p) => p.id) ?? [])
	const createdDate = new Date(role.createdAt).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	})
	const userCount = role._count.users

	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<Breadcrumb>
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbLink>
							<Link to="/admin">
								<Trans>Admin</Trans>
							</Link>
						</BreadcrumbLink>
					</BreadcrumbItem>
					<BreadcrumbSeparator />
					<BreadcrumbItem>
						<BreadcrumbLink>
							<Link to="/roles">
								<Trans>Roles</Trans>
							</Link>
						</BreadcrumbLink>
					</BreadcrumbItem>
					<BreadcrumbSeparator />
					<BreadcrumbPage>{role.name}</BreadcrumbPage>
				</BreadcrumbList>
			</Breadcrumb>

			{/* Header */}
			<div className="flex items-start justify-between">
				<div>
					<div className="flex items-center gap-3">
						<h1 className="text-3xl font-bold">{role.name}</h1>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<div className="text-muted-foreground text-right text-sm">
						<p>
							<Trans>Key</Trans>
						</p>
						<p className="font-mono">{role.name}</p>
					</div>
					<Form method="post" className="inline">
						<input type="hidden" name="intent" value="delete-role" />
						<Button
							variant="destructive"
							size="sm"
							type="submit"
							onClick={(e) => {
								if (
									!confirm(_(msg`Are you sure you want to delete this role?`))
								) {
									e.preventDefault()
								}
							}}
						>
							<Trans>Delete role</Trans>
						</Button>
					</Form>
				</div>
			</div>

			{/* Basic Information */}
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Basic information</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<Form method="post" className="space-y-4">
						<input type="hidden" name="intent" value="update-basic" />

						<div className="grid grid-cols-2 gap-4">
							<div className="space-y-2">
								<Label htmlFor="name">
									<Trans>Name</Trans>
								</Label>
								<Input
									id="name"
									name="name"
									defaultValue={role.name}
									placeholder={_(msg`Role name`)}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="key">
									<Trans>Key</Trans>
								</Label>
								<Input
									id="key"
									value={role.name}
									disabled
									className="font-mono"
								/>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="description">
								<Trans>Description</Trans>
							</Label>
							<Textarea
								id="description"
								name="description"
								defaultValue={role.description || ''}
								placeholder={_(msg`Role description`)}
								rows={3}
							/>
						</div>

						<Button type="submit" size="sm">
							<Trans>Save Changes</Trans>
						</Button>
					</Form>

					{/* Role Statistics */}
					<div className="mt-6 border-t pt-4">
						<div className="text-muted-foreground flex items-center justify-between text-sm">
							<span>
								<Trans>Created {createdDate}</Trans>
							</span>
							<span>
								<Trans>{userCount} users</Trans>
							</span>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Permissions */}
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Permissions</Trans>
					</CardTitle>
				</CardHeader>
				<CardContent>
					<Tabs value={selectedTab} onValueChange={setSelectedTab}>
						<TabsList>
							<TabsTrigger value="feature">
								<Trans>Feature permissions</Trans>
							</TabsTrigger>
							<TabsTrigger value="system">
								<Trans>System permissions</Trans>
							</TabsTrigger>
						</TabsList>

						<TabsContent value="feature" className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-lg font-semibold">
									<Trans>Feature permissions</Trans>
								</h2>
								<CreateFeatureDialog />
							</div>

							<div className="space-y-4">
								{Object.entries(permissionsByEntity).map(
									([entity, permissions]) => (
										<PermissionGroup
											key={entity}
											entity={entity}
											permissions={permissions}
											rolePermissionIds={rolePermissionIds}
											_roleId={role.id}
											_availableEntities={Object.keys(permissionsByEntity)}
										/>
									),
								)}
							</div>
						</TabsContent>

						<TabsContent value="system">
							<div className="text-muted-foreground py-8 text-center">
								<p>
									<Trans>System permissions management coming soon</Trans>
								</p>
							</div>
						</TabsContent>
					</Tabs>
				</CardContent>
			</Card>
		</div>
	)
}

function PermissionGroup({
	entity,
	permissions,
	rolePermissionIds,
	_roleId,
	_availableEntities,
}: {
	entity: string
	permissions: Array<{
		id: string
		action: string
		access: string
		description: string
	}>
	rolePermissionIds: Set<string>
	_roleId: string
	_availableEntities: string[]
}) {
	const [isOpen, setIsOpen] = useState(true)

	return (
		<div className="rounded-lg border">
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center justify-between p-4">
					<div className="flex items-center gap-2">
						<span className="font-medium capitalize">{entity}</span>
						<Badge variant="secondary" className="text-xs">
							{entity}
						</Badge>
					</div>
				</CollapsibleTrigger>
				<CollapsibleContent>
					<div className="space-y-3 p-4 pt-0">
						{permissions.map((permission) => {
							const isChecked = rolePermissionIds.has(permission.id)
							const permissionString = `${entity}:${permission.action}:${permission.access}`

							return (
								<Form
									method="post"
									key={permission.id}
									id={`form-${permission.id}`}
								>
									<input
										type="hidden"
										name="intent"
										value={isChecked ? 'remove-permission' : 'add-permission'}
									/>
									<input
										type="hidden"
										name="permissionId"
										value={permission.id}
									/>

									<div className="flex items-center justify-between">
										<div className="flex items-center space-x-2">
											<Checkbox
												id={`org_perm_${permission.action}_${entity}_${permission.access}`}
												name="permission"
												checked={isChecked}
												onCheckedChange={() => {
													const form = document.getElementById(
														`form-${permission.id}`,
													) as HTMLFormElement
													form?.requestSubmit()
												}}
											/>
											<input
												type="hidden"
												name="checked"
												value={isChecked ? 'on' : ''}
											/>
											<Label
												htmlFor={`org_perm_${permission.action}_${entity}_${permission.access}`}
												className="font-medium"
											>
												{permission.action}
											</Label>
										</div>
										<code className="bg-muted rounded px-2 py-1 text-xs">
											{permissionString}
										</code>
									</div>
								</Form>
							)
						})}

						<CreatePermissionDialog
							selectedEntity={entity}
							_availableEntities={_availableEntities}
						/>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	)
}

function CreateFeatureDialog() {
	const { _ } = useLingui()

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button size="sm" variant="outline" className="mt-3">
						<Icon name="plus" />
						<Trans>New feature</Trans>
					</Button>
				}
			></DialogTrigger>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>
						<Trans>New feature</Trans>
					</DialogTitle>
				</DialogHeader>

				<Form method="post" className="space-y-4">
					<input type="hidden" name="intent" value="create-feature" />

					<div className="space-y-2">
						<Label htmlFor="featureName">
							<Trans>Name</Trans>
						</Label>
						<Input
							id="featureName"
							name="featureName"
							placeholder={_(msg`Enter feature name`)}
							required
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="featureKey">
							<Trans>Key</Trans>
						</Label>
						<DialogDescription className="text-muted-foreground text-sm">
							<Trans>Use this in your codebase to refer to this feature.</Trans>
						</DialogDescription>
						<Input
							id="featureKey"
							name="featureKey"
							placeholder={_(msg`Enter feature key`)}
							required
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="featureDescription">
							<Trans>Description</Trans>
						</Label>
						<div className="mb-1 flex items-center gap-2">
							<span className="text-muted-foreground text-sm">
								<Trans>Optional</Trans>
							</span>
						</div>
						<Textarea
							id="featureDescription"
							name="featureDescription"
							placeholder={_(msg`Enter feature description`)}
							rows={3}
						/>
					</div>

					<Button type="submit" className="w-full">
						<Trans>Add feature</Trans>
					</Button>
				</Form>
			</DialogContent>
		</Dialog>
	)
}

function CreatePermissionDialog({
	selectedEntity,
	_availableEntities,
}: {
	selectedEntity: string
	_availableEntities: string[]
}) {
	const { _ } = useLingui()

	return (
		<Dialog>
			<DialogTrigger
				render={
					<Button size="sm" variant="outline" className="mt-3">
						<Icon name="plus" />
						<Trans>Add permission</Trans>
					</Button>
				}
			></DialogTrigger>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>
						<Trans>New permission</Trans>
					</DialogTitle>
					<div className="text-muted-foreground flex items-center gap-2 text-sm">
						<span className="inline-flex items-center gap-1">
							<svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
								<path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
							</svg>
							<Trans>Feature: {selectedEntity}</Trans>
						</span>
					</div>
				</DialogHeader>

				<Form method="post" className="space-y-4">
					<input type="hidden" name="intent" value="create-permission" />
					<input type="hidden" name="selectedEntity" value={selectedEntity} />

					<div className="space-y-2">
						<Label htmlFor="permissionName">
							<Trans>Name</Trans>
						</Label>
						<Input
							id="permissionName"
							name="permissionName"
							placeholder={_(msg`Enter permission name`)}
							required
						/>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="permissionAction">
								<Trans>Action</Trans>
							</Label>
							<Input
								id="permissionAction"
								name="permissionAction"
								placeholder={_(msg`e.g. create, read, approve, publish`)}
								required
							/>
						</div>

						<div className="space-y-2">
							<Label htmlFor="permissionAccess">
								<Trans>Access Level</Trans>
							</Label>
							<Select
								name="permissionAccess"
								required
								aria-label={_(msg`Select access level`)}
							>
								<SelectTrigger>
									<Trans>Select access level</Trans>
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="own">
										<Trans>own - User's own resources</Trans>
									</SelectItem>
									<SelectItem value="org">
										<Trans>org - Organization resources</Trans>
									</SelectItem>
									<SelectItem value="any">
										<Trans>any - Any resources</Trans>
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="permissionDescription">
							<Trans>Description</Trans>
						</Label>
						<div className="mb-1 flex items-center gap-2">
							<span className="text-muted-foreground text-sm">
								<Trans>Optional</Trans>
							</span>
						</div>
						<Textarea
							id="permissionDescription"
							name="permissionDescription"
							placeholder={_(msg`Enter permission description`)}
							rows={3}
						/>
					</div>

					<Button type="submit" className="w-full">
						<Trans>Add permission</Trans>
					</Button>
				</Form>
			</DialogContent>
		</Dialog>
	)
}
