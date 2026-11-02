import { z } from 'zod'
import { createOAuthHandoff } from '#app/utils/oauth/handoff.server.ts'

/**
 * The OAuth hand-off to Canva and back (see `createOAuthHandoff`): the
 * state, the PKCE verifier and who started it, sent only to the callback
 * path.
 */

export type CanvaOAuthState = {
	state: string
	verifier: string
	userId: string
	orgSlug: string
}

const handoff = createOAuthHandoff<CanvaOAuthState>({
	name: 'print_canva_oauth',
	path: '/resources/print/canva',
	schema: z.object({
		state: z.string(),
		verifier: z.string(),
		userId: z.string(),
		orgSlug: z.string(),
	}),
})

export const setCanvaOAuthState = handoff.set
export const readCanvaOAuthState = handoff.read
export const clearCanvaOAuthState = handoff.clear
export { newOAuthState, sameState } from '#app/utils/oauth/handoff.server.ts'
