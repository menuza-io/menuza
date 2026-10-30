import { getUserId } from '@repo/auth'
import { redirect, type LoaderFunctionArgs } from 'react-router'
import { requireSocialAccess } from '#app/utils/social/access.server.ts'
import { saveSocialAccounts } from '#app/utils/social/accounts.server.ts'
import { SocialError } from '#app/utils/social/errors.ts'
import {
	exchangeMetaCode,
	listMetaAccounts,
} from '#app/utils/social/meta.server.ts'
import {
	clearMetaOAuthState,
	readMetaOAuthState,
	sameState,
} from '#app/utils/social/oauth-state.server.ts'

/**
 * Meta's OAuth redirect (the one URL registered with the Meta app). It
 * finishes only what this browser started, for the same signed-in member, who
 * must still be allowed to manage marketing in that organization.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const saved = await readMetaOAuthState(request)
	const clear = { 'Set-Cookie': await clearMetaOAuthState() }
	const url = new URL(request.url)
	const userId = await getUserId(request)
	if (!saved || !userId || saved.userId !== userId) {
		throw new Response('This connection was not started here.', {
			status: 400,
			headers: clear,
		})
	}
	const state = url.searchParams.get('state') ?? ''
	if (!state || !sameState(state, saved.state)) {
		throw new Response('This connection does not match.', {
			status: 400,
			headers: clear,
		})
	}
	const back = `/${saved.orgSlug}/marketing/social/accounts`
	const code = url.searchParams.get('code')
	if (!code) {
		// The member said no in Facebook (or Meta sent an error).
		return redirect(`${back}?meta=denied`, { headers: clear })
	}
	const access = await requireSocialAccess(request, saved.orgSlug, {
		write: true,
	})
	try {
		const userToken = await exchangeMetaCode(code)
		const accounts = await listMetaAccounts(userToken, saved.platform)
		if (accounts.length === 0) {
			return redirect(`${back}?meta=none&platform=${saved.platform}`, {
				headers: clear,
			})
		}
		await saveSocialAccounts(access, accounts)
	} catch (error) {
		if (error instanceof SocialError) {
			return redirect(`${back}?meta=failed`, { headers: clear })
		}
		throw error
	}
	return redirect(`${back}?connected=${saved.platform}`, { headers: clear })
}
