import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import { type DiscountsAccess } from './access.server.ts'
import { getDiscount } from './discounts.server.ts'
import { emptyEditorState, type EditorState } from './editor-model.ts'
import { recordDiscountStatus } from './history.server.ts'
import {
	cascadeOnPause,
	pairedAutomationIdsByDiscount,
	resumePairedAutomations,
} from './message-impact.server.ts'
import { saveDiscountEditor } from './save.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(async () => true),
}))
// The calls that reach the region, and the audit log (its writer does nothing
// under test): what they were asked, and what is recorded, is under test.
vi.mock('./message-impact.server.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	cascadeOnPause: vi.fn(),
	resumePairedAutomations: vi.fn(),
	pairedAutomationIdsByDiscount: vi.fn(),
}))
vi.mock('./history.server.ts', async (importOriginal) => ({
	...(await importOriginal<object>()),
	recordDiscountStatus: vi.fn(),
}))

const NOTHING = {
	pausedAutomationIds: [],
	cancelledCampaignIds: [],
	skipped: [],
	failed: 0,
}

async function setup() {
	const { user, organization } = await setupTestOrgWithUser()
	const access: DiscountsAccess = {
		userId: user.id,
		organization: {
			id: organization.id,
			slug: organization.slug,
			dataRegion: null,
		},
		features: { enabled: true, automatic: true, coupons: true },
		canWrite: true,
		currency: 'USD',
		locationIds: null,
	}
	return { access }
}

function request(fields: Record<string, string>, state?: Partial<EditorState>) {
	const form = new FormData()
	for (const [key, value] of Object.entries(fields)) form.set(key, value)
	if (state) {
		form.set(
			'state',
			JSON.stringify({
				...emptyEditorState(),
				name: { en: 'Lunch' },
				percent: '10',
				...state,
			}),
		)
	}
	return new Request('http://localhost/x', { method: 'POST', body: form })
}

async function run(
	access: DiscountsAccess,
	discountId: string | undefined,
	fields: Record<string, string>,
	state?: Partial<EditorState>,
) {
	return saveDiscountEditor({
		request: request(fields, state),
		params: { orgSlug: access.organization.slug, discountId },
		access,
	})
}

const idOf = (result: unknown) =>
	new URL((result as Response).headers.get('Location')!, 'http://x').pathname
		.split('/')
		.pop()!

/** A live discount (created paused, then activated), returning its id. */
async function liveDiscount(
	access: DiscountsAccess,
	state: Partial<EditorState> = {},
) {
	const created = await run(
		access,
		undefined,
		{ intent: 'save', status: 'active' },
		state,
	)
	const id = idOf(created)
	await run(access, id, {
		intent: 'set-status',
		discountId: id,
		expectedVersion: '1',
		status: 'active',
	})
	return id
}

async function versionOf(access: DiscountsAccess, id: string) {
	return (await getDiscount(access.organization.id, id))!.row.version
}

async function setStatus(
	access: DiscountsAccess,
	id: string,
	status: string,
	extra: Record<string, string> = {},
) {
	return run(access, id, {
		intent: 'set-status',
		discountId: id,
		expectedVersion: String(await versionOf(access, id)),
		status,
		...extra,
	})
}

const location = (result: unknown) =>
	(result as Response).headers.get('Location')!

describe('pausing, archiving and resuming with the messages that promise a discount', () => {
	beforeEach(() => {
		vi.mocked(cascadeOnPause).mockReset().mockResolvedValue(NOTHING)
		vi.mocked(resumePairedAutomations).mockReset()
		vi.mocked(recordDiscountStatus).mockReset()
		vi.mocked(pairedAutomationIdsByDiscount)
			.mockReset()
			.mockResolvedValue(new Map())
	})

	it('pauses the automations and cancels the broadcasts in the same action, and records the ids', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		vi.mocked(cascadeOnPause).mockClear()
		vi.mocked(cascadeOnPause).mockResolvedValue({
			...NOTHING,
			pausedAutomationIds: ['a-1', 'a-2'],
			cancelledCampaignIds: ['b-1'],
		})

		const result = await setStatus(access, id, 'paused', {
			pauseAutomations: '1',
			cancelBroadcasts: '1',
		})

		expect(cascadeOnPause).toHaveBeenCalledTimes(1)
		expect(vi.mocked(cascadeOnPause).mock.calls[0]![0]).toMatchObject({
			discountId: id,
			organizationId: access.organization.id,
			orgSlug: access.organization.slug,
			userId: access.userId,
			flags: { pauseAutomations: true, cancelBroadcasts: true },
		})
		expect(location(result)).toBe(
			`/${access.organization.slug}/discounts/${id}?cascade=2.1.0.0`,
		)
		// The discount is paused, and the audit row names the ids (and nothing else).
		expect((await getDiscount(access.organization.id, id))?.row.status).toBe(
			'paused',
		)
		expect(vi.mocked(recordDiscountStatus).mock.calls.at(-1)![0]).toMatchObject(
			{
				status: 'paused',
				pausedAutomationIds: ['a-1', 'a-2'],
				cancelledCampaignIds: ['b-1'],
				discountId: id,
			},
		)
	})

	it('asks nothing of the messages when the operator chose to continue without changing them', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		vi.mocked(cascadeOnPause).mockClear()
		const result = await setStatus(access, id, 'paused')
		expect(vi.mocked(cascadeOnPause).mock.calls[0]![0].flags).toEqual({
			pauseAutomations: false,
			cancelBroadcasts: false,
		})
		// No counts to report, so a plain redirect.
		expect(location(result)).toBe(
			`/${access.organization.slug}/discounts/${id}`,
		)
	})

	it('does the same on archive, and only trusts the exact flag value', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		vi.mocked(cascadeOnPause).mockClear()
		await setStatus(access, id, 'archived', {
			pauseAutomations: 'true',
			cancelBroadcasts: '1',
		})
		expect(vi.mocked(cascadeOnPause).mock.calls[0]![0].flags).toEqual({
			pauseAutomations: false,
			cancelBroadcasts: true,
		})
	})

	it('never cascades when the discount is turned on', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		await setStatus(access, id, 'paused')
		vi.mocked(cascadeOnPause).mockClear()
		await setStatus(access, id, 'active', {
			pauseAutomations: '1',
			cancelBroadcasts: '1',
		})
		expect(cascadeOnPause).not.toHaveBeenCalled()
	})

	it('on resume brings back only what the pause took with it, from the audit and not the form', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		vi.mocked(cascadeOnPause).mockResolvedValue({
			...NOTHING,
			pausedAutomationIds: ['a-1', 'a-2'],
		})
		await setStatus(access, id, 'paused', { pauseAutomations: '1' })
		// The audit log (read for the pairing) names what that pause took.
		vi.mocked(pairedAutomationIdsByDiscount).mockResolvedValue(
			new Map([[id, ['a-1', 'a-2']]]),
		)
		vi.mocked(resumePairedAutomations).mockResolvedValue({
			resumedAutomationIds: ['a-1'],
			failed: 1,
			forbidden: false,
		})

		// A forged list in the form is ignored.
		const result = await setStatus(access, id, 'active', {
			resumeAutomations: '1',
			automationIds: 'evil-1,evil-2',
		})

		expect(resumePairedAutomations).toHaveBeenCalledTimes(1)
		expect(vi.mocked(resumePairedAutomations).mock.calls[0]![0]).toMatchObject({
			automationIds: ['a-1', 'a-2'],
			organizationId: access.organization.id,
			userId: access.userId,
		})
		expect(location(result)).toContain('?cascade=0.0.1.0')
		expect(vi.mocked(recordDiscountStatus).mock.calls.at(-1)![0]).toMatchObject(
			{
				status: 'active',
				resumedAutomationIds: ['a-1'],
				discountId: id,
			},
		)
	})

	it('resumes nothing without the flag, and nothing was paired, once it was resumed', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		vi.mocked(cascadeOnPause).mockResolvedValue({
			...NOTHING,
			pausedAutomationIds: ['a-1'],
		})
		vi.mocked(pairedAutomationIdsByDiscount).mockResolvedValue(
			new Map([[id, ['a-1']]]),
		)
		await setStatus(access, id, 'paused', { pauseAutomations: '1' })

		// Without the flag the paired automations stay paused.
		await setStatus(access, id, 'active')
		expect(resumePairedAutomations).not.toHaveBeenCalled()

		// Paused again with nothing paired: a resume with the flag finds nothing.
		vi.mocked(pairedAutomationIdsByDiscount).mockResolvedValue(new Map())
		vi.mocked(cascadeOnPause).mockResolvedValue(NOTHING)
		await setStatus(access, id, 'paused')
		await setStatus(access, id, 'active', { resumeAutomations: '1' })
		expect(resumePairedAutomations).not.toHaveBeenCalled()
	})

	it('another discount’s pairing is not offered', async () => {
		const { access } = await setup()
		const one = await liveDiscount(access)
		const two = await liveDiscount(access, { name: { en: 'Other' } })
		vi.mocked(cascadeOnPause).mockResolvedValue({
			...NOTHING,
			pausedAutomationIds: ['a-1'],
		})
		await setStatus(access, one, 'paused', { pauseAutomations: '1' })
		vi.mocked(cascadeOnPause).mockResolvedValue(NOTHING)
		await setStatus(access, two, 'paused')
		await setStatus(access, two, 'active', { resumeAutomations: '1' })
		expect(resumePairedAutomations).not.toHaveBeenCalled()
	})
})

describe('saving a discount that messages promise', () => {
	beforeEach(() => {
		vi.mocked(cascadeOnPause).mockReset().mockResolvedValue(NOTHING)
	})

	async function save(
		access: DiscountsAccess,
		id: string,
		state: Partial<EditorState>,
		extra: Record<string, string> = {},
	) {
		return run(
			access,
			id,
			{
				intent: 'save',
				status: 'active',
				expectedVersion: String(await versionOf(access, id)),
				pauseAutomations: '1',
				cancelBroadcasts: '1',
				...extra,
			},
			state,
		)
	}

	it('acts on the messages when the end date moves earlier', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access, { endsAt: '2027-01-31T23:59' })
		vi.mocked(cascadeOnPause).mockClear()
		await save(access, id, { endsAt: '2026-12-01T23:59' })
		expect(cascadeOnPause).toHaveBeenCalledTimes(1)
		expect(vi.mocked(cascadeOnPause).mock.calls[0]![0].flags).toEqual({
			pauseAutomations: true,
			cancelBroadcasts: true,
		})
	})

	it('acts on them when an end date is added, the amount changes, or a code goes', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access)
		vi.mocked(cascadeOnPause).mockClear()
		await save(access, id, { endsAt: '2027-01-31T23:59' })
		expect(cascadeOnPause).toHaveBeenCalledTimes(1)
		await save(access, id, { endsAt: '2027-01-31T23:59', percent: '15' })
		expect(cascadeOnPause).toHaveBeenCalledTimes(2)
	})

	it('leaves the messages alone when the end moves later, or nothing that was promised changed', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access, { endsAt: '2027-01-31T23:59' })
		vi.mocked(cascadeOnPause).mockClear()
		// A later end promises nothing less; the same offer renamed promises nothing else.
		await save(access, id, { endsAt: '2027-06-01T23:59' })
		await save(access, id, {
			endsAt: '2027-06-01T23:59',
			name: { en: 'Lunch renamed' },
		})
		expect(cascadeOnPause).not.toHaveBeenCalled()
	})

	it('reports what it did on the page it goes back to', async () => {
		const { access } = await setup()
		const id = await liveDiscount(access, { endsAt: '2027-01-31T23:59' })
		vi.mocked(cascadeOnPause).mockResolvedValue({
			...NOTHING,
			pausedAutomationIds: ['a-1'],
			cancelledCampaignIds: ['b-1', 'b-2'],
		})
		const result = await save(access, id, { endsAt: '2026-12-01T23:59' })
		expect(location(result)).toBe(
			`/${access.organization.slug}/discounts/${id}?saved=1&cascade=1.2.0.0`,
		)
	})
})
