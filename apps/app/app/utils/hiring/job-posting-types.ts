import {
	type JobEmploymentType,
	type JobPayType,
	type JobPostingPublishError,
	type JobPostingStatus,
	type JobPostingTranslations,
	type ScreenerQuestion,
} from '@repo/common/job-posting'

/** Shapes shared by the hiring server code and the editor screens. */

export type PostingSummary = {
	id: string
	slug: string
	title: string
	positionName: string
	status: JobPostingStatus
	employmentType: JobEmploymentType
	isGeneral: boolean
	payType: JobPayType
	payMinMinor: number | null
	payMaxMinor: number | null
	currency: string
	publishedAt: string | null
	expiresAt: string | null
	updatedAt: string
}

export type PostingDetail = PostingSummary & {
	descriptionHtml: string
	questions: ScreenerQuestion[]
	translations: JobPostingTranslations
	closesOn: string | null
}

export type PostingFailure =
	| { ok: false; error: 'not_found' }
	| { ok: false; error: 'invalid_input'; fields: string[] }
	| { ok: false; error: 'description_too_long' }
	| { ok: false; error: 'cannot_publish'; reasons: JobPostingPublishError[] }
	| { ok: false; error: 'invalid_transition' }
	| { ok: false; error: 'not_deletable' }

export type JobDraft = {
	title: string
	positionName: string
	employmentType: JobEmploymentType
	descriptionHtml: string
	questions: ScreenerQuestion[]
}

type FailureBody<T> = T extends { ok: false } ? Omit<T, 'ok'> : never

/** Why a hiring action did not do what was asked. */
export type PostingActionError =
	| FailureBody<PostingFailure>
	| {
			error: 'draft_failed'
			reason: 'rate_limited' | 'unavailable' | 'empty'
	  }
	| { error: 'bad_request' }
	| { error: 'read_only' }

/** What the editor's `fetcher` gets back from any hiring action. */
export type PostingActionData =
	| {
			ok: true
			intent: 'save' | 'publish' | 'close'
			posting: PostingDetail
	  }
	| { ok: true; intent: 'ai_draft'; draft: JobDraft }
	| ({ ok: false; intent: string } & PostingActionError)
