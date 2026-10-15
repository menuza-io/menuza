import { getRequestDocumentPath, logout, requireUserId } from '@repo/auth'
import { db, eq, User } from '@repo/database'
import { redirect } from 'react-router'
import { type Route } from './+types/me.ts'

export async function loader({ request }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const [user] = await db
		.select({ username: User.username })
		.from(User)
		.where(eq(User.id, userId))
		.limit(1)
	if (!user) {
		const loginParams = new URLSearchParams([
			['redirectTo', getRequestDocumentPath(request)],
		])
		const redirectTo = `/login?${loginParams}`
		await logout({ request, redirectTo })
		return redirect(redirectTo)
	}
	return redirect(`/users/${user.username}`)
}
