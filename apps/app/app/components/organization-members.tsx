import { Trans, t } from '@lingui/macro'
import { getUserImgSrc } from '@repo/common'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useState } from 'react'
import { Form, Link } from 'react-router'
import {
	MemberLocationScopeEditor,
	type MemberLocationAccess,
	type MemberLocationOption,
	type MemberLocationTagOption,
} from '#app/components/member-location-scope.tsx'
import { useRoleLabels } from '#app/utils/organization/role-label.ts'

export interface OrganizationRoleOption {
	id: string
	name: string
	description: string
	isBuiltIn: boolean
}

/**
 * Present only for admins, while the Staff module is on or the organization has
 * location tags, and the org has locations.
 */
export interface StaffingLocationControl {
	locations: MemberLocationOption[]
	access: Record<string, MemberLocationAccess>
	tags: MemberLocationTagOption[]
}

interface OrganizationMember {
	userId: string
	organizationRole: {
		id: string
		name: string
		description: string
		level: number
	}
	active: boolean
	user: {
		id: string
		name: string | null
		email: string
		image?: {
			id: string
			altText: string | null
		} | null
	}
}

function OrganizationMemberRoleEditor({
	member,
	currentUserId,
	canChange,
	availableRoles,
}: {
	member: OrganizationMember
	currentUserId: string
	/** The viewer may change this member's role (an admin, or a location manager). */
	canChange: boolean
	availableRoles?: OrganizationRoleOption[]
}) {
	const { roleName, roleDescription } = useRoleLabels()
	availableRoles ??= []
	const isSelf = member.userId === currentUserId
	const [roleId, setRoleId] = useState(member.organizationRole.id)

	if (!canChange || isSelf) {
		return (
			<Badge
				variant={
					member.organizationRole.id === 'org_role_admin'
						? 'default'
						: 'secondary'
				}
				className="text-xs"
			>
				{member.organizationRole.id === 'org_role_admin' && (
					<Icon name="settings" className="mr-1 h-3 w-3" />
				)}
				{roleName(member.organizationRole)}
			</Badge>
		)
	}

	return (
		<Form method="POST" className="flex items-center gap-2">
			<input type="hidden" name="intent" value="update-member-role" />
			<input type="hidden" name="userId" value={member.userId} />
			<input type="hidden" name="roleId" value={roleId} />
			<Select
				name="roleId"
				defaultValue={member.organizationRole.id}
				value={roleId}
				onValueChange={(value) => setRoleId(value as string)}
			>
				<SelectTrigger size="sm" className="w-40">
					<SelectValue>
						{roleName(
							availableRoles.find((role) => role.id === roleId) ??
								member.organizationRole,
						)}
					</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{availableRoles.map((availableRole) => (
						<SelectItem key={availableRole.id} value={availableRole.id}>
							<div className="flex flex-col text-left">
								<span>{roleName(availableRole)}</span>
								{roleDescription(availableRole) && (
									<span className="text-muted-foreground text-xs">
										{roleDescription(availableRole)}
									</span>
								)}
							</div>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button type="submit" variant="outline" size="sm">
				<Trans>Save</Trans>
			</Button>
		</Form>
	)
}

export function OrganizationMembers({
	members = [],
	currentUserId,
	availableRoles = [],
	organizationSlug,
	canManageRoles = false,
	staffingLocations = null,
	locationNames = {},
	memberScopes = {},
	manageableUserIds,
	removableUserIds,
}: {
	members?: OrganizationMember[]
	currentUserId: string
	availableRoles?: OrganizationRoleOption[]
	organizationSlug?: string
	canManageRoles?: boolean
	staffingLocations?: StaffingLocationControl | null
	/** Location id to name, for the Locations line of each member. */
	locationNames?: Record<string, string>
	/** Each member's resolved locations; `null` is every location. */
	memberScopes?: Record<string, string[] | null>
	/** Members the viewer may change (role, locations); defaults to admin only. */
	manageableUserIds?: string[]
	/** Members the viewer may remove; defaults to everyone but the viewer. */
	removableUserIds?: string[]
}) {
	const manageable = manageableUserIds ? new Set(manageableUserIds) : null
	const removable = removableUserIds ? new Set(removableUserIds) : null
	const hasLocations = Object.keys(locationNames).length > 0
	if (members.length === 0) {
		return (
			<Card>
				<CardContent>
					<p className="text-muted-foreground text-sm">
						<Trans>No members found.</Trans>
					</p>
				</CardContent>
			</Card>
		)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>Members</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Manage your restaurant's members.</Trans>
				</CardDescription>
				{organizationSlug && canManageRoles ? (
					<CardAction>
						<Button
							variant="ghost"
							size="sm"
							className="text-muted-foreground"
							render={<Link to={`/${organizationSlug}/settings/roles`} />}
						>
							<Trans>Manage roles</Trans>
							<Icon name="arrow-right" className="rtl:rotate-180" />
						</Button>
					</CardAction>
				) : null}
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{members.map((member) => (
						<Item key={member.userId} variant="outline" size="sm">
							<ItemMedia>
								<Avatar className="h-8 w-8">
									<AvatarImage
										src={getUserImgSrc(member.user.image?.id)}
										alt={member.user.name ?? member.user.email}
									/>
									<AvatarFallback>
										{(member.user.name ?? member.user.email)
											.charAt(0)
											.toUpperCase()}
									</AvatarFallback>
								</Avatar>
							</ItemMedia>
							<ItemContent>
								<ItemTitle>
									{member.user.name || member.user.email}
									{member.userId === currentUserId && (
										<Badge variant="outline" className="text-xs">
											<Trans>You</Trans>
										</Badge>
									)}
								</ItemTitle>
								{member.user.name && (
									<ItemDescription>{member.user.email}</ItemDescription>
								)}
								{hasLocations ? (
									<ItemDescription>
										<MemberLocationsLine
											scope={memberScopes[member.userId]}
											names={locationNames}
										/>
									</ItemDescription>
								) : null}
							</ItemContent>
							<ItemActions>
								{staffingLocations &&
								member.userId !== currentUserId &&
								(manageable === null || manageable.has(member.userId)) ? (
									<MemberLocationScopeEditor
										userId={member.userId}
										memberName={member.user.name || member.user.email}
										access={
											staffingLocations.access[member.userId] ?? {
												scope: 'all',
												locationIds: [],
												tagIds: [],
											}
										}
										locations={staffingLocations.locations}
										tags={staffingLocations.tags}
									/>
								) : null}
								<OrganizationMemberRoleEditor
									member={member}
									currentUserId={currentUserId}
									canChange={
										manageable === null
											? members.some(
													(m) =>
														m.userId === currentUserId &&
														m.active &&
														m.organizationRole.id === 'org_role_admin',
												)
											: manageable.has(member.userId)
									}
									availableRoles={availableRoles}
								/>
								{member.userId !== currentUserId &&
									(removable === null || removable.has(member.userId)) && (
									<Form method="POST">
										<input type="hidden" name="intent" value="remove-member" />
										<input type="hidden" name="userId" value={member.userId} />
										<Button
											type="submit"
											variant="ghost"
											size="sm"
											className="text-destructive hover:text-destructive"
											aria-label={t`Remove member`}
										>
											<Icon name="trash-2" className="h-4 w-4" />
										</Button>
									</Form>
								)}
							</ItemActions>
						</Item>
					))}
				</div>
			</CardContent>
		</Card>
	)
}

/** "All locations" or the names of the member's locations. */
function MemberLocationsLine({
	scope,
	names,
}: {
	scope: string[] | null | undefined
	names: Record<string, string>
}) {
	if (scope === null) {
		return <Trans>All locations</Trans>
	}
	const list = (scope ?? []).map((id) => names[id]).filter(Boolean)
	if (list.length === 0) return <Trans>No locations</Trans>
	return <bdi>{list.join(', ')}</bdi>
}
