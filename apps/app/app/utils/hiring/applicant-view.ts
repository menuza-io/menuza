import {
	HIRING_OPEN_STAGES,
	localParts,
	zonedLocalToUtc,
	type HiringOpenStage,
	type HiringStage,
} from '@repo/staffing'
import { type ApplicantSummary } from './applicant-types.ts'

/**
 * Pure helpers for the applicant screens: grouping, filtering and the
 * interview time maths. No React and no copy (labels live in the components,
 * where Lingui can translate them).
 */

export const BOARD_STAGES: readonly HiringOpenStage[] = HIRING_OPEN_STAGES

export function applicantName(
	person: Pick<ApplicantSummary, 'firstName' | 'lastName'>,
): string {
	return `${person.firstName} ${person.lastName}`.trim()
}

/** Open applicants grouped by stage, in the order the server sent them. */
export function groupByStage(
	applicants: readonly ApplicantSummary[],
): Record<HiringOpenStage, ApplicantSummary[]> {
	const groups: Record<HiringOpenStage, ApplicantSummary[]> = {
		new: [],
		screening: [],
		interview: [],
		offer: [],
	}
	for (const applicant of applicants) {
		if (applicant.stage in groups) {
			groups[applicant.stage as HiringOpenStage].push(applicant)
		}
	}
	return groups
}

export function isOpenStage(stage: HiringStage): stage is HiringOpenStage {
	return (BOARD_STAGES as readonly string[]).includes(stage)
}

/**
 * How well the answers matched what the job asked for, as a word the manager
 * can scan. Never a verdict: a flag only says "look at this one".
 */
export type ScoreBand = 'none' | 'low' | 'mixed' | 'strong'

export function scoreBand(score: number | null): ScoreBand {
	if (score === null) return 'none'
	if (score >= 80) return 'strong'
	if (score >= 50) return 'mixed'
	return 'low'
}

/** Whole days until `at`, never negative; `null` when there is no date. */
export function daysUntil(at: number | null, now: number): number | null {
	if (at === null) return null
	return Math.max(0, Math.ceil((at - now) / 86_400_000))
}

/**
 * A wall-clock date and time at a workplace, as an instant. Interviews are
 * entered in the workplace's own time zone, not the manager's.
 */
export function interviewInstant(
	date: string,
	time: string,
	timeZone: string,
): number | null {
	const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
	const t = /^(\d{2}):(\d{2})$/.exec(time)
	if (!d || !t) return null
	const hour = Number(t[1])
	const minute = Number(t[2])
	if (hour > 23 || minute > 59) return null
	const month = Number(d[2])
	const day = Number(d[3])
	if (month < 1 || month > 12 || day < 1 || day > 31) return null
	return zonedLocalToUtc(Number(d[1]), month, day, hour, minute, timeZone)
}

/** The inverse, for editing: `{ date: 'YYYY-MM-DD', time: 'HH:mm' }` at a workplace. */
export function interviewFields(
	ms: number,
	timeZone: string,
): { date: string; time: string } {
	const p = localParts(ms, timeZone)
	const two = (n: number) => String(n).padStart(2, '0')
	return {
		date: `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)}`,
		time: `${two(p.hour)}:${two(p.minute)}`,
	}
}

/** Applicants with the interview soonest first (cards in the interview column). */
export function bySoonestInterview(
	applicants: readonly ApplicantSummary[],
): ApplicantSummary[] {
	return [...applicants].sort((a, b) => {
		if (a.interviewAt === null && b.interviewAt === null) return 0
		if (a.interviewAt === null) return 1
		if (b.interviewAt === null) return -1
		return a.interviewAt - b.interviewAt
	})
}

/** Where an applicant would work, for a card or row. */
export function placeLabel(
	applicant: Pick<ApplicantSummary, 'scopeId'>,
	nameOf: (id: string | null) => string | null,
): string | null {
	return nameOf(applicant.scopeId)
}
