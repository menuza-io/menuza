/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'

import {
	addGroupLine,
	clearGroupSession,
	endGroup,
	groupShareLink,
	joinGroup,
	loadGroupSession,
	readGroup,
	removeGroupLine,
	saveGroupSession,
	setGroupDone,
	shareTokenFromHash,
	updateGroup,
} from './group-client.ts'

function memory() {
	const map = new Map<string, string>()
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		map,
	}
}

const SHARE = `gs1.${'a'.repeat(64)}`
const PERSON = `gp1.${'b'.repeat(64)}`

function view(overrides: Record<string, unknown> = {}) {
	return {
		id: 'g1',
		status: 'open',
		locationId: 'loc-1',
		hostFirstName: 'Hana',
		deadlineAt: null,
		perPersonLimitMinor: null,
		totalLimitMinor: null,
		totalMinor: 0,
		currency: 'USD',
		version: 1,
		people: [],
		lines: [],
		you: null,
		order: null,
		canAdd: false,
		serverNow: 1,
		...overrides,
	}
}

function stubRegion() {
	vi.stubGlobal('document', {
		documentElement: {
			dataset: { tenantApiUrl: 'https://regional.example', orgSlug: 'cafe' },
		},
	})
	const fetch = vi.fn(
		async (): Promise<{
			ok: boolean
			status: number
			json: () => Promise<unknown>
		}> => ({
			ok: true,
			status: 200,
			json: async () => view(),
		}),
	)
	vi.stubGlobal('fetch', fetch)
	return fetch
}

describe('the browser’s group session (#170)', () => {
	it('keeps a person’s token per restaurant, and forgets it', () => {
		const storage = memory()
		expect(loadGroupSession('org', storage)).toBeNull()
		saveGroupSession(
			'org',
			{ groupId: 'g1', personToken: PERSON, shareToken: SHARE, isHost: true },
			storage,
		)
		expect(loadGroupSession('org', storage)).toEqual({
			groupId: 'g1',
			personToken: PERSON,
			shareToken: SHARE,
			isHost: true,
		})
		expect(loadGroupSession('other', storage)).toBeNull()
		clearGroupSession('org', storage)
		expect(loadGroupSession('org', storage)).toBeNull()
	})

	it('reads a damaged or foreign value as no session', () => {
		const storage = memory()
		storage.setItem('menuza_group_org', '{"groupId":1}')
		expect(loadGroupSession('org', storage)).toBeNull()
		storage.setItem('menuza_group_org', 'not json')
		expect(loadGroupSession('org', storage)).toBeNull()
		expect(loadGroupSession('org', null)).toBeNull()
	})

	it('builds the share link with the token only in the fragment', () => {
		const link = groupShareLink(
			'https://cafe.example',
			'/menu/group',
			'g 1',
			SHARE,
		)
		expect(link).toBe(`https://cafe.example/menu/group?g=g%201#join=${SHARE}`)
		expect(new URL(link).search).not.toContain('gs1')
		expect(shareTokenFromHash(`#join=${SHARE}`)).toBe(SHARE)
		expect(shareTokenFromHash(`join=${SHARE}`)).toBe(SHARE)
		expect(shareTokenFromHash('#join=gs1.short')).toBeNull()
		expect(shareTokenFromHash(`#join=${PERSON}`)).toBeNull()
		expect(shareTokenFromHash('')).toBeNull()
	})
})

describe('group calls go to the region with the person’s own token (#170)', () => {
	it('sends the token in the header, the organization in the query or body, never in the path', async () => {
		const fetch = stubRegion()
		await readGroup('g1', PERSON)
		const [readUrl, readInit] = fetch.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(readUrl).toBe('https://regional.example/orders/group/g1?slug=cafe')
		expect(readInit.headers).toEqual({ 'X-Group-Token': PERSON })
		expect(readUrl).not.toContain('gp1')

		await addGroupLine('g1', PERSON, { itemId: 'i1', quantity: 1, options: [] })
		const [addUrl, addInit] = fetch.mock.calls[1] as unknown as [
			string,
			RequestInit,
		]
		expect(addUrl).toBe('https://regional.example/orders/group/g1/lines')
		expect(addInit.method).toBe('POST')
		expect(JSON.parse(String(addInit.body))).toEqual({
			line: { itemId: 'i1', quantity: 1, options: [] },
			slug: 'cafe',
		})

		await removeGroupLine('g1', PERSON, 'l 1')
		expect((fetch.mock.calls[2] as unknown as [string])[0]).toBe(
			'https://regional.example/orders/group/g1/lines/l%201?slug=cafe',
		)
		expect(
			(fetch.mock.calls[2] as unknown as [string, RequestInit])[1].method,
		).toBe('DELETE')

		await setGroupDone('g1', PERSON, true)
		expect(
			JSON.parse(
				String(
					(fetch.mock.calls[3] as unknown as [string, RequestInit])[1].body,
				),
			),
		).toEqual({ done: true, slug: 'cafe' })
		await updateGroup('g1', PERSON, { locked: true })
		expect(
			(fetch.mock.calls[4] as unknown as [string, RequestInit])[1].method,
		).toBe('PATCH')
		await endGroup('g1', PERSON)
		expect(
			(fetch.mock.calls[5] as unknown as [string, RequestInit])[1].method,
		).toBe('DELETE')
	})

	it('joins with the link’s token, and reads a refusal as an error with the region’s code', async () => {
		const fetch = stubRegion()
		fetch.mockResolvedValueOnce({
			ok: true,
			status: 201,
			json: async () => ({ groupId: 'g1', personToken: PERSON, view: view() }),
		})
		const joined = await joinGroup('g1', SHARE, 'Sam')
		expect(joined.personToken).toBe(PERSON)
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
		expect(init.headers).toMatchObject({ 'X-Group-Token': SHARE })
		expect(JSON.parse(String(init.body))).toEqual({
			firstName: 'Sam',
			slug: 'cafe',
		})
		fetch.mockResolvedValueOnce({
			ok: false,
			status: 409,
			json: async () => ({ error: 'group_locked' }),
		})
		await expect(readGroup('g1', PERSON)).rejects.toMatchObject({
			code: 'group_locked',
			status: 409,
		})
	})
})
