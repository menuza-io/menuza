import { verifySessionStorage, requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { and, db, eq, User, UserOrganization } from '@repo/database'
import { type LoaderFunctionArgs, redirect } from 'react-router'
import { onboardingInviteTokenSessionKey } from '#app/routes/_auth+/onboarding.tsx'
import {
	validateInviteLink,
	createInvitationFromLink,
	getInvitationByToken,
} from '#app/utils/organization/invitation.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const token = params.token
	if (!token) {
		throw new Response('Not Found', { status: 404 })
	}

	try {
		const userId = await requireUserId(request)

		const [user] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, userId))
			.limit(1)

		if (!user) {
			throw new Error('User not found')
		}

		const inviteLink = await validateInviteLink(token).catch(() => null)
		if (inviteLink) {
			const [existingMember] = await db
				.select({ userId: UserOrganization.userId })
				.from(UserOrganization)
				.where(
					and(
						eq(UserOrganization.userId, userId),
						eq(UserOrganization.organizationId, inviteLink.organizationId),
					),
				)
				.limit(1)

			if (existingMember) {
				return redirectWithToast(`/${inviteLink.organization.slug}`, {
					title: 'Already a member',
					description: `You're already a member of ${inviteLink.organization.name}`,
				})
			}

			const invitation = await createInvitationFromLink(token, user.email)
			if (!invitation) {
				throw new Error('Failed to create invitation')
			}

			const inviterName =
				invitation.inviter?.name || invitation.inviter?.email || 'Someone'
			return redirectWithToast('/organizations', {
				title: 'Organization Invitation',
				description: `${inviterName} has invited you to join ${inviteLink.organization.name}. Review the invitation below.`,
			})
		}

		const invitation = await getInvitationByToken(token)
		if (invitation) {
			if (invitation.expiresAt && invitation.expiresAt < new Date()) {
				throw new Response('Invalid or expired invite link', { status: 400 })
			}
			if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
				throw new Response(
					'This invitation was not sent to your email address',
					{ status: 403 },
				)
			}
			const inviterName =
				invitation.inviter?.name || invitation.inviter?.email || 'Someone'
			return redirectWithToast('/organizations', {
				title: 'Organization Invitation',
				description: `${inviterName} has invited you to join ${invitation.organization.name}. Review the invitation below.`,
			})
		}

		throw new Response('Invalid or expired invite link', { status: 400 })
	} catch (error) {
		if (
			error instanceof Response &&
			(error.status === 302 || error.status === 301)
		) {
			const verifySession = await verifySessionStorage.getSession(
				request.headers.get('cookie'),
			)
			verifySession.set(onboardingInviteTokenSessionKey, token)
			const signupUrl = new URL('/signup', request.url)
			signupUrl.searchParams.set('redirectTo', new URL(request.url).pathname)

			return redirect(`${signupUrl.pathname}?${signupUrl.searchParams}`, {
				headers: {
					'set-cookie': await verifySessionStorage.commitSession(verifySession),
				},
			})
		}

		if (error instanceof Response) {
			throw error
		}

		console.error('Error processing invite link:', error)
		throw new Response('Invalid or expired invite link', { status: 400 })
	}
}
