import { parseWithZod } from '@conform-to/zod'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { requireUserWithRole } from '@repo/auth'
import {
	OrganizationRole,
	Role,
	and,
	db,
	eq,
	isNull,
	sql,
} from '@repo/database'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
} from '@repo/ui/select'
import {
	Table,
	TableBody,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { Textarea } from '@repo/ui/textarea'
import { useState } from 'react'
import {
	Form,
	redirect,
	useActionData,
	useLoaderData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'
import { RolesTableRows } from '#app/components/roles/roles-table-rows.tsx'
import { type Route } from './+types/index.ts'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

const CreateRoleSchema = z.object({
	intent: z.literal('create-role'),
	type: z.enum(['organization', 'system']),
	name: z.string().min(1, 'Name is required'),
	description: z.string().optional(),
	level: z.coerce.number().min(1).max(10).optional(),
})

export async function loader({ request }: Route.LoaderArgs) {
	await requireUserWithRole(request, 'admin')

	// ⚡ Bolt Performance Optimization: Parallelized independent database queries to reduce overall request latency.
	// Get all organization roles and system roles with their permission counts concurrently.
	const [organizationRoles, systemRoles] = await Promise.all([
		db.query.OrganizationRole.findMany({
			where: isNull(OrganizationRole.organizationId),
			with: {
				organizationPermissionToRoles: {
					with: { permission: true },
				},
				organizations: true,
			},
			orderBy: (role, { desc }) => desc(role.level),
		}),
		db.query.Role.findMany({
			with: {
				permissionToRoles: { with: { permission: true } },
				roleToUsers: true,
			},
			orderBy: (role, { asc }) => asc(role.name),
		}),
	])

	return {
		organizationRoles: organizationRoles.map((role) => ({
			...role,
			permissions: role.organizationPermissionToRoles
				.filter(({ permission }) => permission.context === 'organization')
				.map(({ permission }) => permission),
			_count: { users: role.organizations.length },
		})),
		systemRoles: systemRoles.map((role) => ({
			...role,
			permissions: role.permissionToRoles
				.filter(({ permission }) => permission.context === 'system')
				.map(({ permission }) => permission),
			_count: { users: role.roleToUsers.length },
		})),
	}
}

export async function action({ request }: Route.ActionArgs) {
	await requireUserWithRole(request, 'admin')

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'create-role') {
		const submission = parseWithZod(formData, { schema: CreateRoleSchema })

		if (submission.status !== 'success') {
			return { result: submission.reply(), success: false }
		}

		const { type, name, description, level } = submission.value

		try {
			// Check if role already exists
			if (type === 'organization') {
				const [existingRole] = await db
					.select({ id: OrganizationRole.id, name: OrganizationRole.name })
					.from(OrganizationRole)
					.where(
						and(
							isNull(OrganizationRole.organizationId),
							sql`lower(${OrganizationRole.name}) = lower(${name})`,
						),
					)
					.limit(1)

				if (existingRole) {
					return {
						result: submission.reply({
							formErrors: [
								`An organization role with the name "${name}" already exists.`,
							],
						}),
						success: false,
					}
				}

				const [role] = await db
					.insert(OrganizationRole)
					.values({
						name,
						description: description || '',
						level: level || 1,
						organizationId: null,
					})
					.returning({ id: OrganizationRole.id })
				if (!role) throw new Error('Failed to create organization role')
				return redirect(`/roles/${role.id}`)
			} else {
				const [existingRole] = await db
					.select({ id: Role.id, name: Role.name })
					.from(Role)
					.where(eq(Role.name, name))
					.limit(1)

				if (existingRole) {
					return {
						result: submission.reply({
							formErrors: [
								`A system role with the name "${name}" already exists.`,
							],
						}),
						success: false,
					}
				}

				const [role] = await db
					.insert(Role)
					.values({
						name,
						description: description || '',
					})
					.returning({ id: Role.id })
				if (!role) throw new Error('Failed to create system role')
				return redirect(`/roles/system/${role.id}`)
			}
		} catch (error: any) {
			console.error('Error creating role:', error)

			// Handle duplicate role names
			if (error.code === 'P2002' && error.meta?.target?.includes('name')) {
				return {
					result: submission.reply({
						formErrors: [`A role with the name "${name}" already exists.`],
					}),
					success: false,
				}
			}

			return {
				result: submission.reply({
					formErrors: ['Failed to create role. Please try again.'],
				}),
				success: false,
			}
		}
	}

	return { result: null, success: false }
}

function CreateRoleDialog() {
	const [open, setOpen] = useState(false)
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const { _ } = useLingui()
	const isSubmitting =
		navigation.formAction === '/roles' && navigation.state === 'submitting'

	// Close dialog on successful submission
	if (actionData?.success && open) {
		setOpen(false)
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={
					<Button>
						<Trans>+ New Role</Trans>
					</Button>
				}
			></DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Create New Role</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Create a new role with custom permissions</Trans>
					</DialogDescription>
				</DialogHeader>

				<Form method="post" className="space-y-4">
					<input type="hidden" name="intent" value="create-role" />

					{/* Show form errors */}
					{actionData?.result?.error?.formErrors && (
						<div className="text-destructive bg-destructive/10 rounded-md p-3 text-sm">
							{actionData.result.error.formErrors.map((error, index) => (
								<div key={index}>{error}</div>
							))}
						</div>
					)}

					{/* Role Type */}
					<div className="space-y-2">
						<Label htmlFor="type">
							<Trans>Role Type</Trans>
						</Label>
						<Select
							name="type"
							defaultValue="organization"
							required
							aria-label={_(msg`Select role type`)}
						>
							<SelectTrigger>
								<Trans>Select role type</Trans>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="organization">
									<Trans>Organization Role</Trans>
								</SelectItem>
								<SelectItem value="system">
									<Trans>System Role</Trans>
								</SelectItem>
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Organization roles apply within specific organizations, while
								system roles are global.
							</Trans>
						</p>
					</div>

					{/* Role Name */}
					<div className="space-y-2">
						<Label htmlFor="name">
							<Trans>Name *</Trans>
						</Label>
						<Input
							id="name"
							name="name"
							placeholder={_(msg`e.g., editor, moderator, contributor`)}
							required
							disabled={isSubmitting}
						/>
						<p className="text-muted-foreground text-xs">
							<Trans>Use lowercase letters, numbers, and hyphens only</Trans>
						</p>
					</div>

					{/* Description */}
					<div className="space-y-2">
						<Label htmlFor="description">
							<Trans>Description</Trans>
						</Label>
						<Textarea
							id="description"
							name="description"
							placeholder={_(msg`Describe what this role can do...`)}
							rows={2}
							disabled={isSubmitting}
						/>
					</div>

					{/* Level (only for organization roles) */}
					<div className="space-y-2">
						<Label htmlFor="level">
							<Trans>Level (Organization roles only)</Trans>
						</Label>
						<Input
							id="level"
							name="level"
							type="number"
							min="1"
							max="10"
							placeholder={_(msg`1-10 (higher = more permissions)`)}
							defaultValue="1"
							disabled={isSubmitting}
						/>
						<p className="text-muted-foreground text-xs">
							<Trans>Higher level roles can manage lower level roles</Trans>
						</p>
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
							disabled={isSubmitting}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={isSubmitting}>
							{isSubmitting ? (
								<Trans>Creating...</Trans>
							) : (
								<Trans>Create Role</Trans>
							)}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	)
}

export default function AdminRolesPage() {
	const { organizationRoles, systemRoles } = useLoaderData<typeof loader>()
	const { _ } = useLingui()

	return (
		<div className="space-y-8">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-3xl font-bold">
						<Trans>Roles</Trans>
					</h1>
					<p className="text-muted-foreground mt-2">
						<Trans>Manage organization and system roles and permissions</Trans>
					</p>
				</div>
				<CreateRoleDialog />
			</div>

			{/* Organization Roles */}
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Organization Roles</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Roles that apply within specific organizations</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="p-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Role</Trans>
								</TableHead>
								<TableHead>
									<Trans>Level</Trans>
								</TableHead>
								<TableHead>
									<Trans>Users</Trans>
								</TableHead>
								<TableHead>
									<Trans>Permissions</Trans>
								</TableHead>
								<TableHead>
									<Trans>Description</Trans>
								</TableHead>
								<TableHead className="text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							<RolesTableRows
								roles={organizationRoles}
								baseUrl="/roles"
								emptyMessage={_(msg`No organization roles found`)}
								emptyColSpan={6}
								showLevel
							/>
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			{/* System Roles */}
			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>System Roles</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Global roles that apply across the entire system</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="p-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Role</Trans>
								</TableHead>
								<TableHead>
									<Trans>Users</Trans>
								</TableHead>
								<TableHead>
									<Trans>Permissions</Trans>
								</TableHead>
								<TableHead>
									<Trans>Description</Trans>
								</TableHead>
								<TableHead className="text-right">
									<Trans>Actions</Trans>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							<RolesTableRows
								roles={systemRoles}
								baseUrl="/roles/system"
								emptyMessage={_(msg`No system roles found`)}
								emptyColSpan={5}
							/>
						</TableBody>
					</Table>
				</CardContent>
			</Card>
		</div>
	)
}
