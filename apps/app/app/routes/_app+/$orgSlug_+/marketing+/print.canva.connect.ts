import {
	redirect,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { requirePrintShopAccess } from '#app/utils/print/access.server.ts'
import {
	canvaApi,
	canvaAuthorizeUrl,
	createPkce,
	exchangeCanvaCode,
} from '#app/utils/print/canva/client.server.ts'
import { saveCanvaConnection } from '#app/utils/print/canva/connection.server.ts'
import {
	isCanvaConfigured,
	isCanvaMock,
} from '#app/utils/print/canva/env.server.ts'
import {
	newOAuthState,
	setCanvaOAuthState,
} from '#app/utils/print/canva/oauth-state.server.ts'

/**
 * Starts connecting the member's Canva account (OAuth with PKCE): Canva
 * sends them back to `/resources/print/canva/callback`. Only a POST from the
 * Import from Canva page starts it (the session cookie is SameSite=Lax, so
 * another site cannot post here as the member), and a link opened elsewhere
 * cannot replace a hand-off in progress. The local emulator connects at once.
 */

/** A plain visit goes back to the page with the Connect button. */
export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	if (!access.features.canva || !isCanvaConfigured()) {
		throw new Response('Not Found', { status: 404 })
	}
	return redirect(`/${access.organization.slug}/marketing/print/canva`)
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requirePrintShopAccess(request, params.orgSlug, {
		write: true,
	})
	if (!access.features.canva || !isCanvaConfigured()) {
		throw new Response('Not Found', { status: 404 })
	}
	const back = `/${access.organization.slug}/marketing/print/canva`
	if (isCanvaMock()) {
		const tokens = await exchangeCanvaCode({ code: 'mock', verifier: 'mock' })
		await saveCanvaConnection(
			access,
			tokens,
			await canvaApi(tokens.accessToken).profile(),
		)
		return redirect(`${back}?connected=1`)
	}
	const { verifier, challenge } = createPkce()
	const state = newOAuthState()
	return redirect(canvaAuthorizeUrl({ state, challenge }), {
		headers: {
			'Set-Cookie': await setCanvaOAuthState({
				state,
				verifier,
				userId: access.userId,
				orgSlug: access.organization.slug,
			}),
		},
	})
}
