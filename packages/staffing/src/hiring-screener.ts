/**
 * The deterministic screener: turns an applicant's answers into stored
 * snapshots, a score and dealbreaker flags. No model, no guessing: the same
 * answers always give the same result, and a manager can see exactly why.
 *
 * Types are structural so this package does not depend on the control-plane
 * posting schema; a `ScreenerQuestion` from `@repo/common/job-posting` fits.
 *
 * A dealbreaker never rejects anyone. It raises a flag a manager sees on the
 * candidate; the decision stays with a person.
 */

export type ScreenerQuestionLike =
	| {
			id: string
			kind: 'yes_no'
			prompt: string
			category?: string
			dealbreaker?: boolean
			requiredAnswer?: 'yes' | 'no'
	  }
	| {
			id: string
			kind: 'open'
			prompt: string
			required?: boolean
			maxLength?: number
	  }

/** What is stored with the application: the question as it was asked. */
export type AnswerSnapshot =
	| {
			id: string
			kind: 'yes_no'
			prompt: string
			category: string
			answer: 'yes' | 'no'
			/** The answer the posting wanted, kept so the score never drifts. */
			requiredAnswer: 'yes' | 'no'
			dealbreaker: boolean
	  }
	| {
			id: string
			kind: 'open'
			prompt: string
			answer: string
	  }

export const OPEN_ANSWER_HARD_MAX = 2_000
export const MAX_ANSWER_KEYS = 20

export type AnswerProblem = {
	questionId: string
	code: 'missing' | 'invalid' | 'too_long' | 'unknown'
}

export type AnswerBuild =
	| { ok: true; snapshots: AnswerSnapshot[] }
	| { ok: false; problems: AnswerProblem[] }

/** Own, plain string property only: `__proto__` and inherited keys never count. */
function ownAnswer(
	answers: Readonly<Record<string, unknown>>,
	id: string,
): unknown {
	return Object.prototype.hasOwnProperty.call(answers, id)
		? answers[id]
		: undefined
}

/** Control characters other than newline and tab are never part of an answer. */
export function cleanAnswerText(value: string): string {
	return Array.from(value.replace(/\r\n?/g, '\n'))
		.filter((char) => {
			const code = char.codePointAt(0)!
			return code >= 32 || code === 10 || code === 9
		})
		.join('')
		.trim()
}

/**
 * Checks the submitted answers against the posting's questions and builds the
 * snapshots. Every question the posting asks is checked; an answer to a
 * question the posting does not ask is a problem (the form and the server can
 * never disagree about what was asked). Yes/no questions are always required;
 * an open question is required only when the posting says so.
 */
export function buildAnswerSnapshots(
	questions: readonly ScreenerQuestionLike[],
	answers: Readonly<Record<string, unknown>>,
): AnswerBuild {
	const problems: AnswerProblem[] = []
	const known = new Set(questions.map((question) => question.id))
	for (const key of Object.keys(answers)) {
		if (!known.has(key)) problems.push({ questionId: key, code: 'unknown' })
	}

	const snapshots: AnswerSnapshot[] = []
	for (const question of questions) {
		const raw = ownAnswer(answers, question.id)
		if (question.kind === 'yes_no') {
			if (raw === undefined || raw === null || raw === '') {
				problems.push({ questionId: question.id, code: 'missing' })
				continue
			}
			const normalized =
				raw === true || raw === 'yes'
					? 'yes'
					: raw === false || raw === 'no'
						? 'no'
						: null
			if (normalized === null) {
				problems.push({ questionId: question.id, code: 'invalid' })
				continue
			}
			snapshots.push({
				id: question.id,
				kind: 'yes_no',
				prompt: question.prompt,
				category: question.category ?? 'other',
				answer: normalized,
				requiredAnswer: question.requiredAnswer ?? 'yes',
				dealbreaker: question.dealbreaker === true,
			})
			continue
		}

		if (raw === undefined || raw === null) {
			if (question.required) {
				problems.push({ questionId: question.id, code: 'missing' })
			}
			continue
		}
		if (typeof raw !== 'string') {
			problems.push({ questionId: question.id, code: 'invalid' })
			continue
		}
		const text = cleanAnswerText(raw)
		if (text === '') {
			if (question.required) {
				problems.push({ questionId: question.id, code: 'missing' })
			}
			continue
		}
		const limit = Math.min(
			question.maxLength ?? OPEN_ANSWER_HARD_MAX,
			OPEN_ANSWER_HARD_MAX,
		)
		if (Array.from(text).length > limit) {
			problems.push({ questionId: question.id, code: 'too_long' })
			continue
		}
		snapshots.push({
			id: question.id,
			kind: 'open',
			prompt: question.prompt,
			answer: text,
		})
	}

	return problems.length > 0 ? { ok: false, problems } : { ok: true, snapshots }
}

export type ScreenerResult = {
	/** Percent of yes/no answers that match what the posting wanted; `null` with none. */
	score: number | null
	/** Ids of dealbreaker questions whose answer differs from the wanted one. */
	flags: string[]
}

export function scoreScreener(
	snapshots: readonly AnswerSnapshot[],
): ScreenerResult {
	let asked = 0
	let matched = 0
	const flags: string[] = []
	for (const snapshot of snapshots) {
		if (snapshot.kind !== 'yes_no') continue
		asked += 1
		if (snapshot.answer === snapshot.requiredAnswer) {
			matched += 1
		} else if (snapshot.dealbreaker) {
			flags.push(snapshot.id)
		}
	}
	return {
		score: asked === 0 ? null : Math.round((matched / asked) * 100),
		flags,
	}
}

/** Reads stored snapshots defensively; a damaged row reads as no answers. */
export function parseAnswerSnapshots(value: unknown): AnswerSnapshot[] {
	if (!Array.isArray(value)) return []
	const out: AnswerSnapshot[] = []
	for (const item of value) {
		if (!item || typeof item !== 'object') continue
		const row = item as Record<string, unknown>
		if (typeof row.id !== 'string' || typeof row.prompt !== 'string') continue
		if (
			row.kind === 'yes_no' &&
			(row.answer === 'yes' || row.answer === 'no')
		) {
			out.push({
				id: row.id,
				kind: 'yes_no',
				prompt: row.prompt,
				category: typeof row.category === 'string' ? row.category : 'other',
				answer: row.answer,
				requiredAnswer: row.requiredAnswer === 'no' ? 'no' : 'yes',
				dealbreaker: row.dealbreaker === true,
			})
		} else if (row.kind === 'open' && typeof row.answer === 'string') {
			out.push({
				id: row.id,
				kind: 'open',
				prompt: row.prompt,
				answer: row.answer,
			})
		}
	}
	return out
}
