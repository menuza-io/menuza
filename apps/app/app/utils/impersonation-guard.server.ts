import { isImpersonating } from '@repo/auth'

/**
 * Impersonation substitutes the target user inside `getUserId`, so without
 * this guard an admin's 15-minute grant could do things that outlive it or act
 * in the user's name: leave credentials on the target (a password, email,
 * passkey, 2FA secret, backup codes, OAuth link), request or cancel the
 * account's erasure (which ends every session and is logged as the user's own
 * request), or download the user's full data export. Same rule as API keys and
 * MCP grants (`$orgSlug_+/mcp.tsx`): stop impersonating first.
 */
export async function refuseWhileImpersonating(
	request: Request,
	message = 'Stop impersonating before changing sign-in methods or credentials',
) {
	if (await isImpersonating(request)) {
		throw new Response(message, { status: 403 })
	}
}
