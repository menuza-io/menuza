import { parseWithZod } from '@conform-to/zod'
import { invariant } from '@epic-web/invariant'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { requireUserWithRole } from '@repo/auth'
import {
	Permission,
	Role,
	_PermissionToRole,
	asc,
	db,
	eq,
	and,
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
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import { Form, Link, useLoaderData } from 'react-router'
import { z } from 'zod'
import { type Route } from './+types/system.$roleId.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const UpdateSystemRoleSchema = z.object({
	intent: z.enum([
		'update-basic',
		'add-permission',
		'remove-permission',
		'delete-role',
	]),
	name: z.string().min(1).optional(),
	description: z.string().optional(),
	permissionId: z.string().optional(),
})

export async function loader({ params }: Route.LoaderArgs) {
	invariant(params.roleId, 'Role ID is required')

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
					.map(({ permission }) => permission)
					.sort(
						(a, b) =>
							a.entity.localeCompare(b.entity) ||
							a.action.localeCompare(b.action),
					),
				_count: { users: result.roleToUsers.length },
			}
		: null

	if (!role) {
		throw new Response('Role not found', { status: 404 })
	}

	return {
		role,
		allPermissions: await db
			.select()
			.from(Permission)
			.where(eq(Permission.context, 'system'))
			.orderBy(asc(Permission.entity), asc(Permission.action)),
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	await requireUserWithRole(request, 'admin')
	invariant(params.roleId, 'Role ID is required')

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: UpdateSystemRoleSchema })

	if (submission.status !== 'success') {
		return { result: submission.reply(), success: false }
	}

	const { intent, name, description, permissionId } = submission.value

	try {
		switch (intent) {
			case 'update-basic': {
				await db
					.update(Role)
					.set({
						...(name && { name }),
						...(description && { description }),
					})
					.where(eq(Role.id, params.roleId))
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

				await db
					.insert(_PermissionToRole)
					.values({ A: permissionId, B: params.roleId })
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

				await db
					.delete(_PermissionToRole)
					.where(
						and(
							eq(_PermissionToRole.A, permissionId),
							eq(_PermissionToRole.B, params.roleId),
						),
					)
				return { result: submission.reply(), success: true }
			}

			case 'delete-role': {
				// Don't allow deletion of core system roles
				if (['admin', 'user'].includes(params.roleId)) {
					return {
						result: submission.reply({
							formErrors: ['Cannot delete core system roles'],
						}),
						success: false,
					}
				}

				await db.delete(Role).where(eq(Role.id, params.roleId))
				return Response.redirect('/roles')
			}
		}
	} catch (error) {
		console.error('Error updating system role:', error)
		return {
			result: submission.reply({ formErrors: ['Failed to update role'] }),
			success: false,
		}
	}

	return { result: submission.reply(), success: false }
}

export default function AdminSystemRoleDetailPage() {
	const { role, allPermissions } = useLoaderData<typeof loader>()
	const [selectedTab, setSelectedTab] = useState('system')
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

	const rolePermissionIds = new Set(role.permissions.map((p) => p.id))
	const isCoreRole = ['admin', 'user'].includes(role.id)

	// Extract values for lingui compliance
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
						{isCoreRole && (
							<Badge variant="default">
								<Trans>Core System Role</Trans>
							</Badge>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<div className="text-muted-foreground text-right text-sm">
						<p>
							<Trans>Key</Trans>
						</p>
						<p className="font-mono">{role.name}</p>
					</div>
					{!isCoreRole && (
						<Form method="post" className="inline">
							<input type="hidden" name="intent" value="delete-role" />
							<Button
								variant="destructive"
								size="sm"
								type="submit"
								onClick={(e) => {
									if (
										!confirm(
											_(msg`Are you sure you want to delete this system role?`),
										)
									) {
										e.preventDefault()
									}
								}}
							>
								<Trans>Delete role</Trans>
							</Button>
						</Form>
					)}
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
									disabled={isCoreRole}
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
								disabled={isCoreRole}
							/>
						</div>

						{!isCoreRole && (
							<Button type="submit" size="sm">
								<Trans>Save Changes</Trans>
							</Button>
						)}
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
					<CardDescription>
						<Trans>System-wide permissions for this role</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Tabs value={selectedTab} onValueChange={setSelectedTab}>
						<TabsList>
							<TabsTrigger value="system">
								<Trans>System permissions</Trans>
							</TabsTrigger>
						</TabsList>

						<TabsContent value="system" className="space-y-4">
							<div className="flex items-center justify-between">
								<h2 className="text-lg">
									<Trans>System permissions</Trans>
								</h2>
								{!isCoreRole && (
									<Button size="sm" variant="outline">
										<Trans>Add permission</Trans>
									</Button>
								)}
							</div>

							<div className="space-y-4">
								{Object.entries(permissionsByEntity).map(
									([entity, permissions]) => (
										<SystemPermissionGroup
											key={entity}
											entity={entity}
											permissions={permissions}
											rolePermissionIds={rolePermissionIds}
											roleId={role.id}
											disabled={isCoreRole}
										/>
									),
								)}
							</div>
						</TabsContent>
					</Tabs>
				</CardContent>
			</Card>
		</div>
	)
}

function SystemPermissionGroup({
	entity,
	permissions,
	rolePermissionIds,
	roleId: _roleId,
	disabled = false,
}: {
	entity: string
	permissions: Array<{
		id: string
		action: string
		access: string
		description: string
	}>
	rolePermissionIds: Set<string>
	roleId: string
	disabled?: boolean
}) {
	const [isOpen, setIsOpen] = useState(true)

	return (
		<div className="rounded-lg border">
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center justify-between p-4">
					<div className="flex items-center gap-2">
						<span className="font-medium capitalize">{entity}</span>
						<Badge variant="outline" className="text-xs">
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
									onChange={
										!disabled
											? (e) => {
													// Auto-submit when checkbox changes
													const form = e.currentTarget
													setTimeout(() => form.requestSubmit(), 0)
												}
											: undefined
									}
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
												id={permission.id}
												name="permission"
												checked={isChecked}
												disabled={disabled}
											/>
											<Label
												htmlFor={permission.id}
												className={`font-medium ${disabled ? 'text-muted-foreground' : ''}`}
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
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	)
}
