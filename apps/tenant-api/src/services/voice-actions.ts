import { type TenantDatabase } from '@repo/tenant-db'
import { type z } from 'zod'
import { type PublishedOrganization } from '../lib/origin.ts'

/**
 * Registry of the named actions the phone agent can ask tenant-api to run
 * during a call (`POST /api/voice/actions/:name`). The route is generic: it
 * authenticates the voice worker, resolves the organization on the server,
 * checks the call, validates input and counts the per-call cap. A business
 * type registers its actions at startup (see `restaurant/`), in both the Node
 * entry point and the Workers entry point.
 */

export type VoiceActionFailure =
	'unavailable' | 'rate_limited' | 'not_enabled' | 'invalid' | 'conflict'

export type VoiceActionResult =
	| { ok: true; data: unknown }
	| { ok: false; reason: VoiceActionFailure; explanation: string }

export type VoiceActionContext = {
	orgId: string
	organization: PublishedOrganization
	db: TenantDatabase
	/** The call row, read on the server: its channel and scope are the truth. */
	call: {
		id: string
		channel: 'phone' | 'web_test'
		callerPhone: string | null
		scopeId: string | null
	}
	/** Test calls run dry: read-only actions answer, writes are simulated. */
	dryRun: boolean
	now: number
}

export type VoiceActionDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> =
	{
		name: string
		schema: TSchema
		/** Rows in `voice_call_actions` for one call and name that use up the cap. */
		maxPerCall: number
		run(
			ctx: VoiceActionContext,
			input: z.infer<TSchema>,
		): Promise<VoiceActionResult>
	}

const actions = new Map<string, VoiceActionDefinition>()

export function registerVoiceAction<TSchema extends z.ZodTypeAny>(
	definition: VoiceActionDefinition<TSchema>,
) {
	actions.set(definition.name, definition as unknown as VoiceActionDefinition)
}

export function getVoiceAction(
	name: string,
): VoiceActionDefinition | undefined {
	return actions.get(name)
}

export function clearVoiceActionsForTest() {
	actions.clear()
	fragments.clear()
}

/**
 * A link fragment the worker may put in a texted link (`#h=<token>`). The
 * business type verifies the fragment belongs to this call before anything is
 * sent, so the worker can never text a link it did not obtain from an action.
 */
export type VoiceLinkFragmentVerifier = {
	/** Site path the fragment is allowed on, for example `/reserve`. */
	path: string
	verify(
		ctx: { orgId: string; db: TenantDatabase; callId: string; now: number },
		fragment: string,
	): Promise<boolean>
}

const fragments = new Map<string, VoiceLinkFragmentVerifier>()

export function registerVoiceLinkFragment(verifier: VoiceLinkFragmentVerifier) {
	fragments.set(verifier.path, verifier)
}

export function getVoiceLinkFragmentVerifier(path: string) {
	return fragments.get(path)
}
