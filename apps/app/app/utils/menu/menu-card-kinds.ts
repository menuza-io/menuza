import { type SiteContentLocale } from '@repo/common/site-locales'
import { type z } from 'zod'
import {
	type MenuCard,
	type MenuCardError,
	type MenuCardKind,
	type MenuCardOp,
	type MenuCardSettings,
} from './menu-cards.ts'
import { type MenuGraph } from './menu-graph.ts'

/**
 * The contract every review-card kind implements (`structure-suggestions.ts`
 * for #92, `polish-suggestions.ts` for #234). Kinds are pure: everything
 * they read comes through `graph` and `ctx`, so they are unit-tested with
 * `makeMenuGraph` and run the same on the server and in tests.
 *
 * How to add a kind:
 *  1. `detect` returns drafts, deterministically. A card is never made from
 *     AI alone: AI may only name, explain or confirm (see `ai`).
 *  2. `refs` lists EVERY record the plan may write (both ends of a link
 *     too, and a dish a new one is copied from), with the `updatedAt` from
 *     the graph. Accept refuses `stale_suggestion` when any of them changed,
 *     and refuses `invalid_plan` when the plan writes outside `refs`.
 *  3. `params` holds ids and cleaned text only; Accept treats them as
 *     untrusted and `plan` re-checks them against the current graph.
 *  4. `preview.before` / `preview.after` show the records as they are and
 *     as they will be: names, prices, a `change` per row, no UI sentences.
 *  5. `plan` returns the ops (`MenuCardOp`), or a refusal code. Never
 *     allergens, calories or dietary flags (the op types forbid them), never
 *     a delete: a merge hides the losers.
 */

export type MenuCardContext = {
	defaultLocale: SiteContentLocale
	locales: readonly SiteContentLocale[]
	settings: MenuCardSettings
	now: Date
}

/** A detected card before the framework adds `references`, `ai` and text. */
export type MenuCardDraft = Omit<MenuCard, 'ai' | 'references'> & {
	/**
	 * Data for this kind's AI step (`MenuCardKindImpl.ai`): menu data only
	 * (names, descriptions, option names, prices), never sales or guests.
	 */
	aiData?: Record<string, unknown>
}

export type MenuCardPlanRequest = {
	id: string
	params: Record<string, unknown>
	optionId?: string
	input?: string
}

export type MenuCardPlanResult =
	| { ok: true; ops: MenuCardOp[] }
	| { ok: false; error: MenuCardError }

export type MenuCardAiStep<Reply = unknown> = {
	/** One instruction for the model, in English, about this kind's tasks. */
	instruction: string
	/** One answer per asked card, without its `id` (the framework adds it). */
	answer: z.ZodType<Reply>
	/**
	 * Fold an answer into the draft (new name, size labels, explanation), or
	 * return null to drop the card (e.g. the model does not confirm a typo).
	 * Text from the answer must go through `sanitizeSuggestionText`.
	 */
	apply: (draft: MenuCardDraft, answer: Reply) => MenuCardDraft | null
	/**
	 * Drop the card when no answer comes back (model off, failed, or silent).
	 * Otherwise the draft is shown with its deterministic text.
	 */
	required?: boolean
}

export type MenuCardKindImpl = {
	kind: MenuCardKind
	detect: (graph: MenuGraph, ctx: MenuCardContext) => MenuCardDraft[]
	plan: (
		graph: MenuGraph,
		request: MenuCardPlanRequest,
		ctx: MenuCardContext,
	) => MenuCardPlanResult
	ai?: MenuCardAiStep<any>  
}

/** A kind that finds nothing (placeholder while a kind is being built). */
export function emptyKind(kind: MenuCardKind): MenuCardKindImpl {
	return {
		kind,
		detect: () => [],
		plan: () => ({ ok: false, error: 'not_applicable' }),
	}
}
