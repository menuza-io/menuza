import { invariantResponse } from '@epic-web/invariant'
import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { db, eq, OrganizationInvitation, User } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemGroup,
	ItemMedia,
	ItemTitle,
	ItemDescription,
} from '@repo/ui/item'
import { PageTitle } from '@repo/ui/page-title'
import { Img } from 'openimg/react'
import { useState } from 'react'
import {
	type LoaderFunctionArgs,
	type ActionFunctionArgs,
	Link,
	useLoaderData,
	Form,
	redirect,
} from 'react-router'

import { EmptyState } from '#app/components/empty-state.tsx'
import { acceptInvitationById } from '#app/utils/organization/invitation.server.ts'
import {
	type UserOrganizationWithRole,
	getUserOrganizations,
} from '#app/utils/organization/organizations.server.ts'
import { shouldBeOnWaitlist } from '#app/utils/waitlist.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)

	// Check if user should be on waitlist
	const onWaitlist = await shouldBeOnWaitlist(userId)
	if (onWaitlist) {
		throw redirect('/waitlist')
	}

	// Fetch user email first to use in parallel invitation query
	const [user] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)

	// Run organizations and pending invitations queries in parallel for better performance
	const [organizations, pendingInvitations] = await Promise.all([
		getUserOrganizations(userId),
		user?.email
			? db.query.OrganizationInvitation.findMany({
					columns: {
						id: true,
						email: true,
						organizationId: true,
						organizationRoleId: true,
						createdAt: true,
					},
					with: {
						organization: {
							columns: { id: true, name: true, slug: true },
							with: { images: { columns: { objectKey: true } } },
						},
						organizationRole: { columns: { id: true, name: true } },
						user: { columns: { name: true, email: true } },
					},
					where: (invitation, { and, eq, gte }) =>
						and(
							eq(invitation.email, user.email.toLowerCase()),
							gte(invitation.expiresAt, new Date()),
						),
					orderBy: (invitation, { desc }) => [desc(invitation.createdAt)],
				}).then((invitations) =>
					invitations.map(({ user: inviter, organization, ...invitation }) => ({
						...invitation,
						inviter,
						organization: {
							...organization,
							image: organization.images[0] ?? null,
						},
					})),
				)
			: Promise.resolve([]),
	])

	return { organizations, pendingInvitations }
}

/**
 * Validates that the user owns the invitation (email matches).
 * Throws invariantResponse errors if validation fails.
 */
async function validateInvitationOwnership(
	userId: string,
	invitationId: string,
) {
	const [user] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)

	invariantResponse(user, 'User not found', { status: 404 })

	const [invitation] = await db
		.select({
			id: OrganizationInvitation.id,
			email: OrganizationInvitation.email,
		})
		.from(OrganizationInvitation)
		.where(eq(OrganizationInvitation.id, invitationId))
		.limit(1)

	invariantResponse(invitation, 'Invitation not found', { status: 404 })

	invariantResponse(
		invitation.email.toLowerCase() === user.email.toLowerCase(),
		'This invitation was not sent to your email address',
		{ status: 403 },
	)

	return { user, invitation }
}

export async function action({ request }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const formData = await request.formData()
	const intent = formData.get('intent')
	const invitationId = formData.get('invitationId') as string

	if (intent === 'accept-invitation') {
		try {
			await acceptInvitationById(invitationId, userId)
			return Response.json({ success: true })
		} catch {
			return Response.json(
				{ error: 'Failed to accept invitation' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'decline-invitation') {
		try {
			await validateInvitationOwnership(userId, invitationId)

			await db
				.delete(OrganizationInvitation)
				.where(eq(OrganizationInvitation.id, invitationId))
			return Response.json({ success: true })
		} catch {
			return Response.json(
				{ error: 'Failed to decline invitation' },
				{ status: 500 },
			)
		}
	}

	return Response.json({ error: 'Invalid intent' }, { status: 400 })
}

export default function OrganizationsPage() {
	const { organizations, pendingInvitations } = useLoaderData<typeof loader>()
	const [searchQuery, setSearchQuery] = useState('')
	const { _ } = useLingui()

	const filteredOrganizations = organizations.filter(
		(org: UserOrganizationWithRole) =>
			org.organization.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
			org.organization.slug.toLowerCase().includes(searchQuery.toLowerCase()),
	)

	function getOrgImgSrc(objectKey?: string | null) {
		return objectKey
			? `/resources/images?objectKey=${encodeURIComponent(objectKey)}`
			: '/img/user.png'
	}

	return (
		<div className="mx-auto w-full max-w-3xl py-8 md:p-8">
			<div className="mb-8 md:mb-10">
				<PageTitle
					title={_(t`Restaurants`)}
					description={_(
						t`Jump into an existing restaurant, accept pending invitations, or add a new one.`,
					)}
				/>

				<div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
					<div className="relative min-w-0 flex-1">
						<Icon
							name="search"
							className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
						/>
						<Input
							type="text"
							placeholder={_(t`Search...`)}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="bg-background pl-10"
						/>
					</div>
					<Button
						render={<Link to="/organizations/create" />}
						className="shrink-0 self-stretch sm:self-auto"
					>
						<span className="mr-1">+</span>
						<Trans>Add restaurant</Trans>
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-8">
				{/* Pending Invitations — lead when present */}
				{pendingInvitations.length > 0 && (
					<Card role="region" aria-labelledby="pending-invitations-heading">
						<CardHeader>
							<CardTitle className="flex items-center gap-2">
								<Icon name="mail" className="h-5 w-5" />
								<h2
									id="pending-invitations-heading"
									className="m-0 text-base leading-snug font-medium"
								>
									<Trans>Pending Invitations</Trans>
								</h2>
							</CardTitle>
							<p className="text-muted-foreground text-sm">
								<Trans>
									You have been invited to join the following organizations.
									Choose to accept or decline each invitation.
								</Trans>
							</p>
						</CardHeader>
						<CardContent>
							<ItemGroup>
								{pendingInvitations.map((invitation) => {
									const invitedBy =
										invitation?.inviter?.name || invitation?.inviter?.email
									return (
										<Item key={invitation.id} variant="outline">
											<ItemMedia variant="image">
												{invitation.organization.image?.objectKey ? (
													<Img
														src={getOrgImgSrc(
															invitation.organization.image.objectKey,
														)}
														alt={invitation.organization.name}
														className="h-full w-full object-cover"
														width={40}
														height={40}
													/>
												) : (
													<span>
														{invitation.organization.name
															.charAt(0)
															.toUpperCase()}
													</span>
												)}
											</ItemMedia>
											<ItemContent>
												<ItemTitle>{invitation.organization.name}</ItemTitle>
												<ItemDescription>
													<Badge variant="secondary" className="mr-2 text-xs">
														{invitation.organizationRole.name}
													</Badge>
													{invitation.inviter && (
														<span>
															<Trans>Invited by {invitedBy}</Trans>
														</span>
													)}
												</ItemDescription>
											</ItemContent>
											<ItemActions className="w-full flex-wrap justify-stretch sm:w-auto sm:justify-end">
												<Form
													method="POST"
													className="min-w-0 flex-1 sm:flex-initial"
												>
													<input
														type="hidden"
														name="intent"
														value="accept-invitation"
													/>
													<input
														type="hidden"
														name="invitationId"
														value={invitation.id}
													/>
													<Button
														type="submit"
														size="sm"
														className="w-full sm:w-auto"
													>
														<Trans>Accept</Trans>
													</Button>
												</Form>
												<Form
													method="POST"
													className="min-w-0 flex-1 sm:flex-initial"
												>
													<input
														type="hidden"
														name="intent"
														value="decline-invitation"
													/>
													<input
														type="hidden"
														name="invitationId"
														value={invitation.id}
													/>
													<Button
														type="submit"
														variant="outline"
														size="sm"
														className="w-full sm:w-auto"
													>
														<Trans>Decline</Trans>
													</Button>
												</Form>
											</ItemActions>
										</Item>
									)
								})}
							</ItemGroup>
						</CardContent>
					</Card>
				)}

				<section className="min-w-0" aria-label={_(t`Your restaurants`)}>
					<ItemGroup>
						{filteredOrganizations.map((org: UserOrganizationWithRole) => (
							<Item
								key={org.organization.id}
								render={<Link to={`/${org.organization.slug}`} />}
								variant="outline"
							>
								<ItemMedia variant="image">
									{org.organization.image?.objectKey ? (
										<Img
											src={getOrgImgSrc(org.organization.image.objectKey)}
											alt={org.organization.name}
											className="h-full w-full object-cover"
											width={40}
											height={40}
										/>
									) : (
										<span>{org.organization.name.charAt(0).toUpperCase()}</span>
									)}
								</ItemMedia>
								<ItemContent>
									<ItemTitle>{org.organization.name}</ItemTitle>
									<ItemDescription>/{org.organization.slug}</ItemDescription>
								</ItemContent>
								<ItemActions>
									<Link
										to={`/${org.organization.slug}/settings`}
										onClick={(e) => e.stopPropagation()}
										className="hover:bg-accent rounded-md p-2 transition-colors"
										title="Restaurant settings"
									>
										<Icon name="gear" className="block h-4 w-4" />
									</Link>
									<Icon
										name="chevron-right"
										className="h-4 w-4 rtl:-scale-x-100"
									/>
								</ItemActions>
							</Item>
						))}
					</ItemGroup>

					{(filteredOrganizations.length === 0 && searchQuery) ||
					organizations.length === 0 ? (
						<EmptyState
							title={_(t`No restaurant found`)}
							description={
								searchQuery
									? _(t`Adjust your search query to show more.`)
									: _(t`You haven't joined any restaurants yet.`)
							}
							icons={['folder-open']}
							action={{
								label: _(t`Add restaurant`),
								href: '/organizations/create',
							}}
						/>
					) : null}
				</section>
			</div>
		</div>
	)
}
