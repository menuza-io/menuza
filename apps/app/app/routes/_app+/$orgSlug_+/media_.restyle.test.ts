/**
 * #146 routes: `/<org>/media/restyle` and `/<org>/media/restyle/<runId>`.
 * The guard order is swept in `restyle-guards.test.ts`; this drives the real
 * loaders and actions against the test database.
 */
import {
	db,
	eq,
	MediaRestyleRun,
	MediaRestyleRunItem,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockRestyleAdapter } from '#app/utils/media/restyle/adapter.server.ts'
import { processRestyleRun } from '#app/utils/media/restyle/process.server.ts'
import {
	startRestyleRun,
	type RestyleDeps,
} from '#app/utils/media/restyle/service.server.ts'
import type * as StorageModule from '#app/utils/storage.server.ts'
import {
	callAction,
	callLoader,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import * as runRoute from './media_.restyle.$runId.tsx'
import * as listRoute from './media_.restyle.tsx'

const PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
	),
	(char) => char.charCodeAt(0),
)

// Storage and the jobs-cron worker are outside the test: nothing leaves it.
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => ({
	...(await importOriginal<typeof StorageModule>()),
	deleteOrganizationStorageObject: vi.fn(async () => {}),
}))
vi.mock('#app/utils/media/restyle/wake.server.ts', () => ({
	wakeMediaRestyleWorkflow: vi.fn(async () => true),
}))

afterEach(() => vi.unstubAllEnvs())

async function setup(flag = true) {
	const ctx = await setupSeoOrganization()
	if (flag) await setOrgFlag(ctx.organization.id, 'media.restyle', true)
	return ctx
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function dishWithPhoto(ctx: Ctx, name: string) {
	const org = ctx.organization.id
	const [photo] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId: org,
			objectKey: `orgs/${org}/media/images/${crypto.randomUUID()}.jpg`,
			mimeType: 'image/jpeg',
			width: 1200,
			height: 1200,
		})
		.returning()
	const [dish] = await db
		.insert(OrganizationMenuItem)
		.values({
			organizationId: org,
			displayName: name,
			imageKey: photo!.objectKey,
			imageKeys: JSON.stringify([photo!.objectKey]),
		})
		.returning()
	return { photo: photo!, dish: dish! }
}

const deps: RestyleDeps = {
	adapter: createMockRestyleAdapter(),
	wake: async () => true,
	killSwitch: () => false,
	readSource: async () => ({ data: PNG, mediaType: 'image/png' }),
	store: (async (organizationId: string, file: File) => ({
		key: `orgs/${organizationId}/media/images/${crypto.randomUUID()}.png`,
		mimeType: 'image/png',
		extension: 'png',
		file,
		width: 1,
		height: 1,
	})) as never,
}

async function readyRun(ctx: Ctx, dishes = 1) {
	const made = []
	for (let i = 0; i < dishes; i++) made.push(await dishWithPhoto(ctx, `D${i}`))
	const started = await startRestyleRun(
		{
			organizationId: ctx.organization.id,
			userId: ctx.userId,
			presetId: 'clean-white',
		},
		deps,
	)
	if (!started.ok) throw new Error(started.error)
	for (let i = 0; i < 10; i++) {
		const outcome = await processRestyleRun(started.runId, deps)
		if (outcome.done) break
	}
	const rows = await db
		.select()
		.from(MediaRestyleRunItem)
		.where(eq(MediaRestyleRunItem.runId, started.runId))
	return { made, runId: started.runId, rows }
}

const listUrl = (ctx: Ctx) =>
	`http://localhost/${ctx.organization.slug}/media/restyle`

function listAction(ctx: Ctx, fields: Record<string, string | string[]>) {
	return callAction(listRoute.action as never, {
		url: listUrl(ctx),
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug },
		fields,
	})
}

function runAction(
	ctx: Ctx,
	runId: string,
	fields: Record<string, string | string[]>,
) {
	return callAction(runRoute.action as never, {
		url: `${listUrl(ctx)}/${runId}`,
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug, runId },
		fields,
	})
}

function runLoader(ctx: Ctx, runId: string) {
	return callLoader(runRoute.loader as never, {
		url: `${listUrl(ctx)}/${runId}`,
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug, runId },
	}) as Promise<Response | Record<string, any>>
}

describe('the start page', () => {
	it('is 404 while the flag is off, for the page and every intent', async () => {
		const ctx = await setup(false)
		const loader = (await callLoader(listRoute.loader as never, {
			url: listUrl(ctx),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as Response
		expect(loader.status).toBe(404)
		for (const intent of ['preview', 'start', 'cancel']) {
			expect((await listAction(ctx, { intent })).status).toBe(404)
		}
	})

	it('lists runs, the budget and how many dishes a run would restyle', async () => {
		const ctx = await setup()
		await dishWithPhoto(ctx, 'A')
		await dishWithPhoto(ctx, 'B')
		const data = (await callLoader(listRoute.loader as never, {
			url: listUrl(ctx),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as Record<string, any>
		expect(data).toMatchObject({
			orgSlug: ctx.organization.slug,
			runs: [],
			canStart: true,
			killed: false,
			preview: { withPhoto: 2, withoutPhoto: 0 },
		})
		const preview = await listAction(ctx, { intent: 'preview' })
		expect(await preview.json()).toMatchObject({
			ok: true,
			preview: { withPhoto: 2 },
		})
	})

	it('starts a run with the mock model and sends the person to its review page', async () => {
		vi.stubEnv('MEDIA_RESTYLE_MOCK', 'true')
		vi.stubEnv('BASE_URL', 'http://localhost:3001')
		const ctx = await setup()
		await dishWithPhoto(ctx, 'A')
		const response = await listAction(ctx, {
			intent: 'start',
			presetId: 'clean-white',
			options: JSON.stringify({ keepAngle: true }),
		})
		expect(response.status).toBeGreaterThanOrEqual(300)
		expect(response.status).toBeLessThan(400)
		const [run] = await db
			.select()
			.from(MediaRestyleRun)
			.where(eq(MediaRestyleRun.organizationId, ctx.organization.id))
		expect(response.headers.get('Location')).toBe(
			`/${ctx.organization.slug}/media/restyle/${run!.id}`,
		)
		expect(JSON.parse(run!.style)).toEqual({
			type: 'preset',
			presetId: 'clean-white',
			options: { keepAngle: true },
		})
		// A second start while it runs: 409.
		const again = await listAction(ctx, {
			intent: 'start',
			presetId: 'clean-white',
		})
		expect(again.status).toBe(409)
		expect(await again.json()).toEqual({
			ok: false,
			error: 'restyle_in_progress',
		})
	})

	it('answers 503 while the kill switch is on, and 400 for an unknown style', async () => {
		vi.stubEnv('MEDIA_RESTYLE_MOCK', 'true')
		vi.stubEnv('BASE_URL', 'http://localhost:3001')
		const ctx = await setup()
		await dishWithPhoto(ctx, 'A')
		vi.stubEnv('MEDIA_RESTYLE_ENABLED', 'false')
		const paused = await listAction(ctx, {
			intent: 'start',
			presetId: 'clean-white',
		})
		expect(paused.status).toBe(503)
		expect(await paused.json()).toEqual({ ok: false, error: 'restyle_paused' })
		vi.unstubAllEnvs()
		vi.stubEnv('MEDIA_RESTYLE_MOCK', 'true')
		vi.stubEnv('BASE_URL', 'http://localhost:3001')
		const bad = await listAction(ctx, { intent: 'start', presetId: 'nope' })
		expect(bad.status).toBe(400)
		expect((await listAction(ctx, { intent: 'start' })).status).toBe(400)
	})

	it('refuses a member without the media permission', async () => {
		const ctx = await setupSeoOrganization('viewer')
		await setOrgFlag(ctx.organization.id, 'media.restyle', true)
		const response = await listAction(ctx, {
			intent: 'start',
			presetId: 'clean-white',
		})
		expect(response.status).toBe(403)
	})
})

describe('the review page', () => {
	it('shows the run to its own organization and a 404 to another one', async () => {
		const ctx = await setup()
		const other = await setup()
		const { runId } = await readyRun(ctx)
		const own = (await runLoader(ctx, runId)) as Record<string, any>
		expect(own.run).toMatchObject({ id: runId, status: 'ready' })
		expect(own.items).toHaveLength(1)
		expect(own).toMatchObject({ canApply: true, canStart: true })
		const foreign = (await callLoader(runRoute.loader as never, {
			url: `http://localhost/${other.organization.slug}/media/restyle/${runId}`,
			cookie: other.cookie,
			params: { orgSlug: other.organization.slug, runId },
		})) as Response
		expect(foreign.status).toBe(404)
		// And no intent works on it from the other organization.
		const item = own.items[0]
		for (const intent of ['use', 'keep', 'retry', 'switchBack']) {
			const response = await callAction(runRoute.action as never, {
				url: `http://localhost/${other.organization.slug}/media/restyle/${runId}`,
				cookie: other.cookie,
				params: { orgSlug: other.organization.slug, runId },
				fields: { intent, itemRowId: item.id },
			})
			expect(`${intent}: ${response.status}`).toBe(`${intent}: 404`)
		}
		const useAll = await callAction(runRoute.action as never, {
			url: `http://localhost/${other.organization.slug}/media/restyle/${runId}`,
			cookie: other.cookie,
			params: { orgSlug: other.organization.slug, runId },
			fields: { intent: 'useAll' },
		})
		expect(useAll.status).toBe(404)
	})

	it('uses a draft, then switches back, through the actions', async () => {
		const ctx = await setup()
		const { runId, rows, made } = await readyRun(ctx)
		const row = rows[0]!
		const used = await runAction(ctx, runId, {
			intent: 'use',
			itemRowId: row.id,
			draftKey: row.draftObjectKey!,
		})
		expect(await used.json()).toEqual({ ok: true })
		const [after] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		expect(after!.imageKey).toBe(row.draftObjectKey)
		const back = await runAction(ctx, runId, {
			intent: 'switchBack',
			itemRowId: row.id,
		})
		expect(await back.json()).toEqual({ ok: true })
		const [restored] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		expect(restored!.imageKey).toBe(made[0]!.photo.objectKey)
	})

	it('answers 409 photo_changed and leaves the dish alone', async () => {
		const ctx = await setup()
		const { runId, rows, made } = await readyRun(ctx)
		await db
			.update(OrganizationMenuItem)
			.set({ imageKey: 'orgs/x/new.jpg', imageKeys: '["orgs/x/new.jpg"]' })
			.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		const response = await runAction(ctx, runId, {
			intent: 'use',
			itemRowId: rows[0]!.id,
		})
		expect(response.status).toBe(409)
		expect(await response.json()).toEqual({
			ok: false,
			error: 'photo_changed',
		})
		const [dish] = await db
			.select()
			.from(OrganizationMenuItem)
			.where(eq(OrganizationMenuItem.id, made[0]!.dish.id))
		expect(dish!.imageKey).toBe('orgs/x/new.jpg')
	})

	it('keeps using drafts while the kill switch is on, but cannot try again', async () => {
		const ctx = await setup()
		const { runId, rows } = await readyRun(ctx, 2)
		vi.stubEnv('MEDIA_RESTYLE_ENABLED', 'false')
		const retry = await runAction(ctx, runId, {
			intent: 'retry',
			itemRowId: rows[0]!.id,
		})
		expect(retry.status).toBe(503)
		expect(await retry.json()).toEqual({ ok: false, error: 'restyle_paused' })
		const loaded = (await runLoader(ctx, runId)) as Record<string, any>
		expect(loaded.killed).toBe(true)
		const useAll = await runAction(ctx, runId, { intent: 'useAll' })
		expect(await useAll.json()).toMatchObject({ ok: true, used: 2 })
	})

	it('keeps the original, and stops a run', async () => {
		const ctx = await setup()
		const { runId, rows } = await readyRun(ctx)
		const kept = await runAction(ctx, runId, {
			intent: 'keep',
			itemRowId: rows[0]!.id,
		})
		expect(await kept.json()).toEqual({ ok: true })
		// Stopping a finished run says so instead of changing it.
		const stop = await runAction(ctx, runId, { intent: 'cancel' })
		expect(stop.status).toBe(409)
		expect(await runAction(ctx, runId, { intent: 'nope' })).toMatchObject({
			status: 404,
		})
	})
})
