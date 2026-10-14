import { isImpersonating } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { data, redirect } from 'react-router'
import { requireStaffingAccess } from '#app/utils/staffing/access.server.ts'
import { HIRING_WRITE_REQUIREMENT } from '#app/utils/staffing/sections.ts'
import { generateJobDraft } from './job-draft.server.ts'
import { POSTING_STEPS, type PostingStep } from './job-posting-form.ts'
import {
	type PostingActionData,
	type PostingActionError,
} from './job-posting-types.ts'
import {
	changeJobPostingStatus,
	createJobPosting,
	deleteJobPosting,
	generalApplicationInput,
	updateJobPosting,
	type PostingActorScope,
	type PostingFailure,
} from './job-postings.server.ts'

export type { PostingActionData }

const MAX_PAYLOAD_CHARS = 120_000
const MAX_PROMPT_CHARS = 2_000

function failure(intent: string, error: PostingActionError, status = 400) {
	return data({ ok: false, intent, ...error } as PostingActionData, {
		status,
	})
}

function statusFor(error: PostingFailure['error']) {
	if (error === 'not_found') return 404
	if (error === 'invalid_transition' || error === 'not_deletable') return 409
	return 400
}

function readPayload(form: FormData): unknown {
	const raw = form.get('payload')
	if (typeof raw !== 'string' || raw.length > MAX_PAYLOAD_CHARS)
		return undefined
	try {
		return JSON.parse(raw) as unknown
	} catch {
		return undefined
	}
}

function readStep(form: FormData): PostingStep {
	const step = form.get('step')
	return (POSTING_STEPS as readonly string[]).includes(String(step))
		? (step as PostingStep)
		: 'role'
}

/** The resolved write access every hiring action starts from. */
export async function requirePostingWriter(
	request: Request,
	orgSlug: string | undefined,
) {
	const access = await requireStaffingAccess(
		request,
		orgSlug,
		HIRING_WRITE_REQUIREMENT,
	)
	// Support sessions look; they never post or close jobs for an organization.
	if (await isImpersonating(request)) {
		throw new Response('Forbidden: read-only while impersonating', {
			status: 403,
		})
	}
	const scope: PostingActorScope = {
		organizationId: access.organizationId,
		userId: access.userId,
		request,
	}
	return { access, scope }
}

/**
 * One action for the new and edit screens. Intents: `save`, `publish` (save,
 * then go live or reopen), `close`, `delete` and `ai_draft`. Every one needs
 * `update:hiring:any` and the `staffing.hiring` flag, resolved before anything
 * is read from the form.
 */
export async function runPostingAction({
	request,
	orgSlug,
	postingId,
}: {
	request: Request
	orgSlug: string | undefined
	postingId: string | null
}) {
	const { access, scope } = await requirePostingWriter(request, orgSlug)
	const form = await request.formData()
	const intent = String(form.get('intent') ?? '')
	const base = `/${orgSlug}/staff/hiring`

	if (intent === 'ai_draft') {
		const prompt = form.get('prompt')
		if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
			return failure(intent, { error: 'bad_request' })
		}
		const [organization] = await db
			.select({ name: Organization.name })
			.from(Organization)
			.where(eq(Organization.id, access.organizationId))
			.limit(1)
		const result = await generateJobDraft({
			organizationId: access.organizationId,
			organizationName: organization?.name ?? '',
			userId: access.userId,
			prompt,
		})
		if (!result.ok) {
			return failure(
				intent,
				{ error: 'draft_failed', reason: result.error },
				result.error === 'rate_limited' ? 429 : 400,
			)
		}
		return data({
			ok: true,
			intent: 'ai_draft',
			draft: result.draft,
		} satisfies PostingActionData)
	}

	if (intent === 'add_general') {
		const created = await createJobPosting(
			scope,
			generalApplicationInput(String(form.get('currency') ?? 'USD')),
			{ general: true },
		)
		if (!created.ok) return failure(intent, created, statusFor(created.error))
		throw redirect(`${base}/${created.value.id}?step=review`)
	}

	if (intent === 'delete') {
		if (!postingId) return failure(intent, { error: 'bad_request' })
		const result = await deleteJobPosting(scope, postingId)
		if (!result.ok) return failure(intent, result, statusFor(result.error))
		throw redirect(base)
	}

	if (intent === 'close') {
		if (!postingId) return failure(intent, { error: 'bad_request' })
		const result = await changeJobPostingStatus(scope, postingId, 'closed')
		if (!result.ok) return failure(intent, result, statusFor(result.error))
		return data({
			ok: true,
			intent: 'close',
			posting: result.value,
		} satisfies PostingActionData)
	}

	if (intent !== 'save' && intent !== 'publish') {
		return failure(intent, { error: 'bad_request' })
	}
	const payload = readPayload(form)
	if (payload === undefined) return failure(intent, { error: 'bad_request' })

	const saved = postingId
		? await updateJobPosting(scope, postingId, payload)
		: await createJobPosting(scope, payload)
	if (!saved.ok) return failure(intent, saved, statusFor(saved.error))

	let posting = saved.value
	if (intent === 'publish' && posting.status !== 'published') {
		// The content, closing date included, is saved first, so a reopened job
		// takes the date the manager just chose.
		const live = await changeJobPostingStatus(scope, posting.id, 'published')
		// The content stays saved even when going live is refused.
		if (!live.ok) return failure(intent, live, statusFor(live.error))
		posting = live.value
	}

	if (!postingId) {
		throw redirect(
			`${base}/${posting.id}?step=${intent === 'publish' ? 'review' : readStep(form)}`,
		)
	}
	return data({
		ok: true,
		intent,
		posting,
	} satisfies PostingActionData)
}
