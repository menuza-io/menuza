import { db, eq, PrintDesign } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'

const bucket = vi.hoisted(() => new Map<string, Uint8Array>())

vi.mock('@repo/common/print-shop-catalog', async () => ({
	printCatalog: (await import('./test-catalog.ts')).testPrintCatalog,
}))
vi.mock('#app/utils/storage.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	uploadPrintFile: vi.fn(async (key: string, bytes: Uint8Array) => {
		bucket.set(key, bytes)
	}),
	readPrintFile: vi.fn(async (key: string) => bucket.get(key) ?? null),
}))
vi.mock('./vertical.server.ts', async () => {
	const { generalPrintVertical } = await import('./vertical-contract.server.ts')
	return {
		printVertical: {
			...generalPrintVertical,
			// The test vertical's desk codes are capabilities.
			qrTargets: { desk: { canView: async () => true } },
		},
	}
})

const {
	importCanvaArtwork,
	refreshCanvaArtwork,
	sendDesignToCanva,
	PrintArtworkError,
} = await import('./artwork.server.ts')
const { saveCanvaConnection } = await import('./canva/connection.server.ts')
const { mockCanva } = await import('./canva/mock.server.ts')
const { createPrintDesign, toDesignView } = await import('./designs.server.ts')
const { getPrintFile } = await import('./print-files.server.ts')
const { buildPrintSnapshot } = await import('./print-snapshot.server.ts')

beforeEach(() => {
	vi.stubEnv('CANVA_MOCK', 'true')
	vi.stubEnv('BASE_URL', 'http://localhost:3001')
})
afterEach(() => vi.unstubAllEnvs())

async function setup({ connected = true } = {}) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	const access = {
		userId: user.id,
		organization: {
			id: organization.id,
			slug: organization.slug,
			name: organization.name,
			siteTheme: null,
			siteIconKey: null,
			siteLocales: null,
			siteDefaultLocale: null,
			customDomain: null,
			dataRegion: 'us',
		},
		features: { enabled: true, shipping: false, canva: true },
		canWrite: true,
		canPay: false,
	}
	if (connected) {
		await saveCanvaConnection(access, mockCanva.tokens(), {
			userId: 'mock-user',
			displayName: 'Mock',
		})
	}
	return access
}

async function failure(promise: Promise<unknown>) {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(PrintArtworkError)
	return (error as InstanceType<typeof PrintArtworkError>).code
}

describe('Canva artwork', () => {
	it('imports page 1 at the print size and keeps the bleed', async () => {
		const access = await setup()
		const row = await importCanvaArtwork(access, {
			designId: 'MOCK-POSTER',
			product: 'poster',
			sizeKey: 'a3',
			name: 'Spring',
		})
		const view = toDesignView(row)
		expect(view.source).toBe('artwork')
		expect(view.status).toBe('draft')
		expect(view.artwork).toMatchObject({
			provider: 'canva',
			externalId: 'MOCK-POSTER',
			bleedMm: 3,
			pages: 1,
			widthMm: 303,
			heightMm: 426,
		})
		expect(view.artwork!.fileKey).toMatch(
			new RegExp(
				`^print/${access.organization.id}/artwork/[0-9a-f]{32}/print.pdf$`,
			),
		)
		const pdf = bucket.get(view.artwork!.fileKey)!
		expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-')
		expect(bucket.has(view.artwork!.previewKey!)).toBe(true)

		// The file prints as it is, whatever bleed was asked for.
		const snapshot = await buildPrintSnapshot({
			request: new Request('http://localhost:3001/'),
			access,
			design: view,
		})
		expect(snapshot.artwork?.fileKey).toBe(view.artwork!.fileKey)
		expect(snapshot.pieces).toHaveLength(1)
		const file = await getPrintFile({
			organizationId: access.organization.id,
			snapshot,
			format: 'pro',
			bleedMm: 5,
		})
		expect(file).toMatchObject({
			kind: 'pdf',
			objectKey: view.artwork!.fileKey,
		})
	})

	it('notes extra pages and a missing bleed', async () => {
		const access = await setup()
		const row = await importCanvaArtwork(access, {
			designId: 'MOCK-FLYER',
			product: 'flyer',
			sizeKey: 'a5',
			name: 'Weekend',
		})
		expect(toDesignView(row).artwork).toMatchObject({ pages: 2, bleedMm: 0 })
	})

	it('refuses a page of another size, and products that need a code', async () => {
		const access = await setup()
		expect(
			await failure(
				importCanvaArtwork(access, {
					designId: 'MOCK-SQUARE',
					product: 'poster',
					sizeKey: 'a3',
					name: 'Square',
				}),
			),
		).toBe('artwork_size')
		expect(
			await failure(
				importCanvaArtwork(access, {
					designId: 'MOCK-POSTER',
					product: 'desk_card',
					sizeKey: 'a6',
					name: 'Card',
				}),
			),
		).toBe('artwork_product')
		expect(
			await failure(
				importCanvaArtwork(access, {
					designId: 'MOCK-MISSING',
					product: 'poster',
					sizeKey: 'a3',
					name: 'Gone',
				}),
			),
		).toBe('canva_not_found')
	})

	it('asks to connect first', async () => {
		const access = await setup({ connected: false })
		expect(
			await failure(
				importCanvaArtwork(access, {
					designId: 'MOCK-POSTER',
					product: 'poster',
					sizeKey: 'a3',
					name: 'Spring',
				}),
			),
		).toBe('canva_not_connected')
	})

	it('updates from Canva back to a draft', async () => {
		const access = await setup()
		const row = await importCanvaArtwork(access, {
			designId: 'MOCK-POSTER',
			product: 'poster',
			sizeKey: 'a3',
			name: 'Spring',
		})
		const [approved] = await db
			.update(PrintDesign)
			.set({ status: 'approved' })
			.where(eq(PrintDesign.id, row.id))
			.returning()
		const updated = await refreshCanvaArtwork(access, approved!)
		expect(updated.status).toBe('draft')
		expect(toDesignView(updated).name).toBe('Spring')
	})

	it('sends a template print to Canva, but never private codes', async () => {
		const access = await setup()
		const template = await createPrintDesign(access, {
			name: 'Opening hours',
			product: 'poster',
			sizeKey: 'a3',
			style: 'classic',
		})
		const editUrl = await sendDesignToCanva(
			new Request('http://localhost:3001/'),
			access,
			template,
		)
		expect(editUrl).toMatch(
			/^https:\/\/www\.canva\.com\/design\/MOCK-IMPORT-\d+\/edit$/,
		)

		const [desk] = await db
			.update(PrintDesign)
			.set({
				product: 'desk_card',
				sizeKey: 'a6',
				content: {
					...(template.content as Record<string, unknown>),
					qr: { kind: 'desk', deskIds: ['d1'] },
				},
			})
			.where(eq(PrintDesign.id, template.id))
			.returning()
		expect(
			await failure(
				sendDesignToCanva(new Request('http://localhost:3001/'), access, desk!),
			),
		).toBe('codes_private')

		const artwork = await importCanvaArtwork(access, {
			designId: 'MOCK-POSTER',
			product: 'poster',
			sizeKey: 'a3',
			name: 'Spring',
		})
		expect(
			await failure(
				sendDesignToCanva(
					new Request('http://localhost:3001/'),
					access,
					artwork,
				),
			),
		).toBe('artwork_product')
	})
})
