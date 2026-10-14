import {
	type ApplicantDetail,
	type ApplicantSummary,
} from './applicant-types.ts'

/** Typed builders for the applicant screens' tests. */

export const NOW = Date.now()

export function applicant(
	overrides: Partial<ApplicantSummary> = {},
): ApplicantSummary {
	return {
		id: 'a1',
		postingId: 'p1',
		postingTitle: 'Line cook',
		scopeId: 'main',
		interestedScopeIds: ['main'],
		firstName: 'Sara',
		lastName: 'Ali',
		source: 'careers_page',
		stage: 'new',
		stageChangedAt: NOW - 3_600_000,
		screenerScore: 100,
		flagCount: 0,
		hasEmail: true,
		hasPhone: false,
		interviewAt: null,
		noteCount: 0,
		hiredStaffId: null,
		createdAt: NOW - 3_600_000,
		...overrides,
	}
}

export function detail(
	overrides: Partial<ApplicantDetail> = {},
): ApplicantDetail {
	const { id, ...base } = applicant()
	return {
		id,
		...base,
		email: 'sara@example.com',
		phone: '+14155550123',
		locale: 'en',
		positionName: 'Line cook',
		answers: [
			{
				id: 'weekends',
				kind: 'yes_no',
				prompt: 'Can you work weekends?',
				category: 'availability',
				answer: 'no',
				requiredAnswer: 'yes',
				dealbreaker: true,
			},
			{
				id: 'about',
				kind: 'open',
				prompt: 'Tell us about your experience',
				answer: 'Two years on the grill',
			},
		],
		flags: ['weekends'],
		declinedReason: null,
		declinedAt: null,
		consentAt: NOW - 3_600_000,
		consentVersion: '2026-10',
		retentionExpiresAt: null,
		declineRetentionDays: 365,
		hiredAt: null,
		notes: [],
		interviews: [],
		timeline: [
			{
				id: 'ev1',
				kind: 'applied',
				at: NOW - 3_600_000,
				actorId: null,
				fromStage: null,
				toStage: 'new',
				detail: null,
			},
		],
		...overrides,
	}
}

export function listResponse(
	applications: ApplicantSummary[],
	extra: Record<string, unknown> = {},
) {
	const counts: Record<string, number> = {
		new: 0,
		screening: 0,
		interview: 0,
		offer: 0,
		hired: 0,
		declined: 0,
	}
	for (const item of applications)
		counts[item.stage] = (counts[item.stage] ?? 0) + 1
	return {
		applications,
		counts,
		postings: [
			{ postingId: 'p1', title: 'Line cook', count: applications.length },
		],
		total: applications.length,
		...extra,
	}
}
