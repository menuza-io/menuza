import { describe, expect, it } from 'vitest'
import { messageSettingsSchema } from '#app/utils/reservations/messages-api.ts'
import { makeSettingsResponse } from '#app/utils/reservations/messages-fixtures.ts'
import {
	buildPatch,
	draftFromSettings,
	hasIssues,
	isDraftDirty,
	parseHours,
	rebaseDraft,
	validateDraft,
	visibleKinds,
} from '#app/utils/reservations/messages-view.ts'

function settings(overrides: Record<string, unknown> = {}) {
	return messageSettingsSchema.parse(makeSettingsResponse(overrides))
}

describe('messages-view', () => {
	it('builds a draft from the saved settings', () => {
		const draft = draftFromSettings(settings())
		expect(draft.kinds.confirmation).toBe(true)
		expect(draft.kinds.reconfirm_request).toBe(false)
		expect(draft.reminderHours).toBe('24')
		expect(draft.quietEnabled).toBe(true)
		expect(draft.quietStart).toBe('21:00')
		expect(draft.quietEnd).toBe('08:00')
		expect(draft.notes.confirmation).toEqual({ en: 'See you soon', ar: '' })
	})

	it('reads an empty quiet window as off and offers the default window', () => {
		const draft = draftFromSettings(
			settings({
				messaging: {
					...(makeSettingsResponse().messaging as object),
					quietHours: { startMin: 0, endMin: 0 },
				},
			}),
		)
		expect(draft.quietEnabled).toBe(false)
		expect(draft.quietStart).toBe('21:00')
		expect(draft.quietEnd).toBe('08:00')
	})

	it('has no patch and is clean when nothing changed', () => {
		const base = draftFromSettings(settings())
		expect(buildPatch({ ...base }, base, 3)).toBeNull()
		expect(isDraftDirty({ ...base }, base)).toBe(false)
	})

	it('sends only the changed values with the expected version', () => {
		const base = draftFromSettings(settings())
		const draft = {
			...base,
			kinds: { ...base.kinds, reminder: false, reconfirm_request: true },
			reminderHours: '12',
			smsEnabled: false,
			notes: {
				...base.notes,
				confirmation: { en: 'See you soon', ar: ' أهلا ' },
			},
		}
		expect(buildPatch(draft, base, 3)).toEqual({
			expectedVersion: 3,
			messaging: {
				kinds: { reminder: false },
				reconfirmEnabled: true,
				reminderHours: 12,
				smsEnabled: false,
			},
			texts: [{ kind: 'confirmation', locale: 'ar', customNote: 'أهلا' }],
		})
	})

	it('encodes switched-off quiet hours as an empty window', () => {
		const base = draftFromSettings(settings())
		const patch = buildPatch({ ...base, quietEnabled: false }, base, 3)
		expect(patch?.messaging?.quietHours).toEqual({ startMin: 0, endMin: 0 })
	})

	it('clears a note by sending an empty string', () => {
		const base = draftFromSettings(settings())
		const draft = {
			...base,
			notes: {
				...base.notes,
				confirmation: { en: '', ar: '' },
			},
		}
		expect(buildPatch(draft, base, 3)?.texts).toEqual([
			{ kind: 'confirmation', locale: 'en', customNote: '' },
		])
	})

	it('validates hours, quiet hours and note length', () => {
		const base = draftFromSettings(settings())
		expect(hasIssues(validateDraft(base, 500))).toBe(false)
		expect(parseHours('0')).toBeNull()
		expect(parseHours('169')).toBeNull()
		expect(parseHours('1.5')).toBeNull()
		expect(parseHours('')).toBeNull()
		expect(parseHours('168')).toBe(168)

		const issues = validateDraft(
			{
				...base,
				reminderHours: '',
				reconfirmHours: '999',
				quietStart: '10:00',
				quietEnd: '10:00',
				notes: { ...base.notes, reminder: { en: 'x'.repeat(501), ar: '' } },
			},
			500,
		)
		expect(issues).toEqual({
			reminderHours: true,
			reconfirmHours: true,
			quietHours: true,
			longNotes: ['reminder:en'],
		})
	})

	it('hides waitlist kinds unless the waitlist is on', () => {
		const saved = settings()
		expect(visibleKinds(saved, false).map((k) => k.kind)).toEqual([
			'confirmation',
			'reminder',
			'reconfirm_request',
		])
		expect(visibleKinds(saved, true).map((k) => k.kind)).toContain(
			'waitlist_joined',
		)
	})

	it('keeps our edits and adopts other changes when rebasing after a conflict', () => {
		const oldBase = draftFromSettings(settings())
		const draft = {
			...oldBase,
			kinds: { ...oldBase.kinds, reminder: false },
			notes: {
				...oldBase.notes,
				reminder: { en: 'Bring ID', ar: '' },
			},
		}
		const theirs = draftFromSettings(
			settings({
				version: 4,
				messaging: {
					...(makeSettingsResponse().messaging as object),
					reminderHours: 6,
					smsEnabled: false,
				},
			}),
		)
		const rebased = rebaseDraft(draft, oldBase, theirs)
		expect(rebased.kinds.reminder).toBe(false)
		expect(rebased.notes.reminder?.en).toBe('Bring ID')
		expect(rebased.reminderHours).toBe('6')
		expect(rebased.smsEnabled).toBe(false)
		expect(buildPatch(rebased, theirs, 4)).toEqual({
			expectedVersion: 4,
			messaging: { kinds: { reminder: false } },
			texts: [{ kind: 'reminder', locale: 'en', customNote: 'Bring ID' }],
		})
	})
})
