import { getUserId } from '@repo/auth'
import { redirect, type LoaderFunctionArgs } from 'react-router'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	canvaApi,
	CanvaError,
	exchangeCanvaCode,
} from '#app/utils/print/canva/client.server.ts'
import { saveCanvaConnection } from '#app/utils/print/canva/connection.server.ts'
import {
	clearCanvaOAuthState,
	readCanvaOAuthState,
	sameState,
} from '#app/utils/print/canva/oauth-state.server.ts'

/**
 * Canva's OAuth redirect (the one URL registered with the integration). It
 * finishes only what this browser started, for the same signed-in member,
 * who must still be allowed to design prints in that organization.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	const saved = await readCanvaOAuthState(request)
	const clear = { 'Set-Cookie': await clearCanvaOAuthState() }
	const url = new URL(request.url)
	const userId = await getUserId(request)
	if (!saved || !userId || saved.userId !== userId) {
		throw new Response('This Canva connection was not started here.', {
			status: 400,
			headers: clear,
		})
	}
	const back = `/${saved.orgSlug}/marketing/print/canva`
	const state = url.searchParams.get('state') ?? ''
	if (!state || !sameState(state, saved.state)) {
		throw new Response('This Canva connection does not match.', {
			status: 400,
			headers: clear,
		})
	}
	const code = url.searchParams.get('code')
	if (!code) {
		// The member said no in Canva (or Canva sent an error).
		return redirect(`${back}?canva=denied`, { headers: clear })
	}
	const access = await requirePrintShopAccess(request, saved.orgSlug, {
		write: true,
	})
	if (!access.features.canva) {
		throw new Response('Not Found', { status: 404, headers: clear })
	}
	try {
		const tokens = await exchangeCanvaCode({ code, verifier: saved.verifier })
		await saveCanvaConnection(
			access,
			tokens,
			await canvaApi(tokens.accessToken).profile(),
		)
	} catch (error) {
		if (error instanceof CanvaError) {
			return redirect(`${back}?canva=failed`, { headers: clear })
		}
		throw error
	}
	return redirect(`${back}?connected=1`, { headers: clear })
}
