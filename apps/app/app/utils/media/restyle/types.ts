import { type RestyleRunStatus } from '@repo/common/media-restyle'

/** What the review pages read; no server code, so components may import it. */

export type RestyleRunSummary = {
	id: string
	status: RestyleRunStatus
	presetId: string | null
	total: number
	done: number
	failed: number
	skipped: number
	/** Dishes with a photo: what progress counts against. */
	toDo: number
	resumeAt: string | null
	createdAt: string
	/** Drafts waiting for a decision. */
	toReview: number
}

export type RestyleItemView = {
	/** The run item's id: what every decision names. */
	id: string
	itemId: string
	name: string
	status: string
	decision: string | null
	skipReason: string | null
	error: string | null
	originalUrl: string | null
	draftUrl: string | null
	/** The draft file the page shows: sent back with "Use new". */
	draftKey: string | null
	draftExpiresAt: string | null
}
