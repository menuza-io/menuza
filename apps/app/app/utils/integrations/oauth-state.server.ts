import { z } from 'zod'
import { createOAuthHandoff } from '#app/utils/oauth/handoff.server.ts'

/**
 * The OAuth hand-off for the note integrations (Slack, Jira, ...; see
 * `createOAuthHandoff`). `state` is the value the provider echoes to the
 * callback: its signed `state`, or Trello's request token (OAuth 1.0a).
 * For Trello the cookie also carries the request-token secret, so the
 * callback can finish on any Worker isolate. The cookie is signed and
 * HttpOnly; the secret is useless without the App's Trello consumer secret.
 */

export type IntegrationOAuthState = {
	state: string
	provider: string
	userId: string
	orgSlug: string
	requestTokenSecret?: string
}

const handoff = createOAuthHandoff<IntegrationOAuthState>({
	name: 'integrations_oauth',
	path: '/api/integrations/oauth',
	schema: z.object({
		state: z.string().min(1),
		provider: z.string().min(1),
		userId: z.string(),
		orgSlug: z.string(),
		requestTokenSecret: z.string().min(1).optional(),
	}),
})

export const setIntegrationOAuthState = handoff.set
export const readIntegrationOAuthState = handoff.read
export const clearIntegrationOAuthState = handoff.clear
export { sameState } from '#app/utils/oauth/handoff.server.ts'
