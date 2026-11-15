import { getDefaultEmailBlock } from '@repo/common/email-blocks'
import { describe, expect, it } from 'vitest'
import {
	createAuthenticatedRequest,
	getResponseStatus,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './templates.designer.ts'

const blocks = () =>
	JSON.stringify([
		getDefaultEmailBlock('heading'),
		getDefaultEmailBlock('button'),
	])

function post(slug: string, cookie: string, fields: Record<string, string>) {
	const body = new FormData()
	for (const [key, value] of Object.entries(fields)) body.set(key, value)
	return action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/marketing/templates/designer`,
			{ method: 'POST', body },
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)
}

function list(slug: string, cookie: string) {
	return loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${slug}/marketing/templates/designer`,
			{},
			cookie,
		),
		params: { orgSlug: slug },
		context: {},
	} as never)
}

async function failure(promise: Promise<unknown>) {
	try {
		const result = await promise
		return getResponseStatus(result)
	} catch (thrown) {
		return getResponseStatus(thrown)
	}
}

describe('email template designer route', () => {
	it('saves, lists and starts from a template (a copy)', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		const saved = (await post(organization.slug, cookie, {
			intent: 'save',
			name: 'Weekly newsletter',
			blocks: blocks(),
		})) as { template: { id: string } }
		expect(saved.template.id).toBeTruthy()

		const listed = (await list(organization.slug, cookie)) as {
			templates: Array<{ name: string }>
		}
		expect(listed.templates.map((t) => t.name)).toEqual(['Weekly newsletter'])

		const started = (await post(organization.slug, cookie, {
			intent: 'start',
			id: saved.template.id,
		})) as { blocks: Array<{ id: string; type: string }> }
		expect(started.blocks.map((b) => b.type)).toEqual(['heading', 'button'])
	})

	it('answers a taken name and malformed blocks with the error codes', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await post(organization.slug, cookie, {
			intent: 'save',
			name: 'Lunch',
			blocks: blocks(),
		})
		const taken = await post(organization.slug, cookie, {
			intent: 'save',
			name: 'lunch',
			blocks: blocks(),
		})
		expect(getResponseStatus(taken)).toBe(409)
		const bad = await post(organization.slug, cookie, {
			intent: 'save',
			name: 'Bad',
			blocks: '[{"id":"x","type":"nope","config":{}}]',
		})
		expect(getResponseStatus(bad)).toBe(400)
	})

	it('never starts from, or lists, another organization’s template', async () => {
		const a = await setupTestOrgWithUser('admin')
		const b = await setupTestOrgWithUser('admin')
		const saved = (await post(a.organization.slug, a.cookie, {
			intent: 'save',
			name: 'Mine',
			blocks: blocks(),
		})) as { template: { id: string } }
		const started = await post(b.organization.slug, b.cookie, {
			intent: 'start',
			id: saved.template.id,
		})
		expect(getResponseStatus(started)).toBe(404)
		const listed = (await list(b.organization.slug, b.cookie)) as {
			templates: unknown[]
		}
		expect(listed.templates).toEqual([])
	})

	it('refuses a signed-in person outside the organization and a bare guest', async () => {
		const a = await setupTestOrgWithUser('admin')
		const outsider = await setupTestOrgWithUser('admin')
		expect(
			await failure(list(a.organization.slug, outsider.cookie)),
		).toBeGreaterThanOrEqual(400)
		const guest = await setupTestOrgWithUser('guest')
		expect(
			await failure(
				post(guest.organization.slug, guest.cookie, {
					intent: 'save',
					name: 'Nope',
					blocks: blocks(),
				}),
			),
		).toBe(403)
	})
})
