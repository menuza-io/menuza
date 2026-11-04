import { describe, it, expect, vi } from 'vitest'
import { db } from '@repo/database'

import {
	handleChat,
	shouldAttachWebsiteEditorContext,
	type ChatDependencies,
} from './chat'

vi.mock('@repo/database', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/database')>()
	const table = new Proxy({}, { get: (_, property) => property })
	const operator = vi.fn((...args: unknown[]) => args)
	const limit = vi
		.fn()
		.mockResolvedValue([{ id: 'note-123', organizationId: 'org-456' }])
	const where = vi.fn().mockReturnValue({ limit })
	const from = vi.fn().mockReturnValue({ where })
	return {
		...actual,
		db: { select: vi.fn().mockReturnValue({ from }) },
		OrganizationNote: table,
		NoteAccess: table,
		NoteComment: table,
		User: table,
		eq: operator,
	}
})

function streamResult() {
	return {
		toUIMessageStreamResponse: vi.fn(() => new Response('ok')),
	}
}

function baseDeps(overrides: Partial<ChatDependencies> = {}): ChatDependencies {
	return {
		requireUserId: vi.fn().mockResolvedValue('user-789'),
		requireOrgMembership: vi.fn(),
		createChatStream: vi.fn(() => streamResult()),
		buildNoteChatSystemPrompt: vi.fn(),
		brandSystemPrompt: 'system prompt',
		...overrides,
	}
}

describe('handleChat', () => {
	it('only attaches website editor context on website routes or with a pageId', () => {
		expect(
			shouldAttachWebsiteEditorContext(
				{ currentPath: '/acme', orgSlug: 'acme', params: {} },
				null,
			),
		).toBe(false)
		expect(
			shouldAttachWebsiteEditorContext(
				{
					currentPath: '/acme/website/pages/home-1',
					orgSlug: 'acme',
					params: {},
				},
				null,
			),
		).toBe(true)
		expect(
			shouldAttachWebsiteEditorContext(
				{ currentPath: '/acme', orgSlug: 'acme', params: {} },
				'page-123',
			),
		).toBe(true)
	})

	it('calls requireOrgMembership before fetching full note details and comments', async () => {
		const request = new Request(
			'http://localhost/api/ai/chat?noteId=note-123',
			{
				method: 'POST',
				body: JSON.stringify({ messages: [] }),
			},
		)

		const requireOrgMembership = vi.fn().mockImplementation(async () => {
			throw new Response('Forbidden', { status: 403 })
		})

		const deps = baseDeps({ requireOrgMembership })

		await expect(
			handleChat({ request, params: {} } as any, deps),
		).rejects.toThrow()

		expect(db.select).toHaveBeenCalledTimes(1)
		expect(requireOrgMembership).toHaveBeenCalledWith(request, 'org-456')
	})

	it('does not attach website editor tools on the org dashboard', async () => {
		const request = new Request('http://localhost/api/ai/chat?orgSlug=acme', {
			method: 'POST',
			body: JSON.stringify({
				messages: [],
				currentPath: '/acme',
				params: { orgSlug: 'acme' },
			}),
		})

		const getPageEditorTools = vi.fn(() => ({ navigateToPage: {} }))
		const getWebsitePages = vi.fn().mockResolvedValue([])
		const buildPageEditorSystemPrompt = vi.fn(
			(base: string) => `${base}\nwebsite`,
		)
		const resolveOrganizationFromSlug = vi
			.fn()
			.mockResolvedValue({ id: 'org-456' })
		const createChatStream = vi.fn(() => streamResult())

		const deps = baseDeps({
			createChatStream,
			buildPageEditorSystemPrompt,
			getPageEditorTools,
			getWebsitePages,
			resolveOrganizationFromSlug,
			hasWebsiteAccess: vi.fn().mockResolvedValue(true),
		})

		const response = await handleChat({ request, params: {} } as any, deps)

		expect(response).toBeInstanceOf(Response)
		expect(getWebsitePages).not.toHaveBeenCalled()
		expect(getPageEditorTools).not.toHaveBeenCalled()
		expect(buildPageEditorSystemPrompt).not.toHaveBeenCalled()
		expect(createChatStream).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: 'system prompt',
			}),
		)
		expect(createChatStream).toHaveBeenCalledWith(
			expect.not.objectContaining({
				tools: expect.objectContaining({ navigateToPage: {} }),
			}),
		)
	})

	it('converts UI messages to ModelMessages before creating the stream', async () => {
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: JSON.stringify({
				messages: [
					{
						id: 'message-1',
						role: 'user',
						parts: [{ type: 'text', text: 'Help me get started' }],
					},
				],
			}),
		})
		const createChatStream = vi.fn(() => streamResult())
		const deps = baseDeps({ createChatStream })

		await handleChat({ request, params: {} } as any, deps)

		expect(createChatStream).toHaveBeenCalledWith({
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: 'Help me get started' }],
				},
			],
			systemPrompt: 'system prompt',
		})
	})

	it('passes an attached image through to the model', async () => {
		const image = 'data:image/jpeg;base64,/9j/4AAQ'
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: JSON.stringify({
				messages: [
					{
						id: 'message-1',
						role: 'user',
						parts: [
							{ type: 'file', mediaType: 'image/jpeg', url: image },
							{ type: 'text', text: 'What is this?' },
						],
					},
				],
			}),
		})
		const createChatStream = vi.fn(() => streamResult())

		await handleChat(
			{ request, params: {} } as any,
			baseDeps({ createChatStream }),
		)

		expect(createChatStream).toHaveBeenCalledTimes(1)
		const call = createChatStream.mock.calls[0] as unknown as [
			{ messages: Array<{ content: Array<{ type: string }> }> },
		]
		expect(call[0].messages[0]?.content.map((part) => part.type)).toContain(
			'file',
		)
	})

	it('refuses a file that is not an inline image', async () => {
		for (const part of [
			{
				type: 'file',
				mediaType: 'image/png',
				url: 'https://example.com/a.png',
			},
			{
				type: 'file',
				mediaType: 'application/pdf',
				url: 'data:application/pdf;base64,AA',
			},
		]) {
			const request = new Request('http://localhost/api/ai/chat', {
				method: 'POST',
				body: JSON.stringify({
					messages: [{ id: 'm', role: 'user', parts: [part] }],
				}),
			})
			const createChatStream = vi.fn(() => streamResult())
			const response = await handleChat(
				{ request, params: {} } as any,
				baseDeps({ createChatStream }),
			)
			expect((response as Response).status).toBe(400)
			expect(createChatStream).not.toHaveBeenCalled()
		}
	})

	it('refuses an image whose declared type does not match its data', async () => {
		for (const part of [
			{
				type: 'file',
				mediaType: 'image/png',
				url: 'data:image/svg+xml;base64,PHN2Zz4=',
			},
			{
				type: 'file',
				mediaType: 'image/png',
				url: 'data:image/png,plain-text',
			},
			{
				type: 'file',
				mediaType: 'image/jpeg',
				url: 'data:image/png;base64,AAAA',
			},
		]) {
			const request = new Request('http://localhost/api/ai/chat', {
				method: 'POST',
				body: JSON.stringify({
					messages: [{ id: 'm', role: 'user', parts: [part] }],
				}),
			})
			const createChatStream = vi.fn(() => streamResult())
			const response = await handleChat(
				{ request, params: {} } as any,
				baseDeps({ createChatStream }),
			)
			expect((response as Response).status).toBe(400)
			expect(createChatStream).not.toHaveBeenCalled()
		}
	})

	it('refuses data that is not base64 or whose bytes are not the declared type', async () => {
		for (const part of [
			// Not base64.
			{
				type: 'file',
				mediaType: 'image/jpeg',
				url: 'data:image/jpeg;base64,not base64!!',
			},
			// Valid base64 of plain text (no JPEG signature).
			{
				type: 'file',
				mediaType: 'image/jpeg',
				url: 'data:image/jpeg;base64,aGVsbG8gd29ybGQ=',
			},
			// A JPEG body declared as PNG.
			{
				type: 'file',
				mediaType: 'image/png',
				url: 'data:image/png;base64,/9j/4AAQ',
			},
		]) {
			const request = new Request('http://localhost/api/ai/chat', {
				method: 'POST',
				body: JSON.stringify({
					messages: [{ id: 'm', role: 'user', parts: [part] }],
				}),
			})
			const createChatStream = vi.fn(() => streamResult())
			const response = await handleChat(
				{ request, params: {} } as any,
				baseDeps({ createChatStream }),
			)
			expect((response as Response).status).toBe(400)
			expect(createChatStream).not.toHaveBeenCalled()
		}
	})

	it('counts the bytes that arrive when the declared length is missing or wrong', async () => {
		// A stream with no Content-Length, larger than the limit.
		const chunk = new TextEncoder().encode('x'.repeat(1_000_000))
		let sent = 0
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= 41) return controller.close()
				sent += 1
				controller.enqueue(chunk)
			},
		})
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: stream,
			// @ts-expect-error Node requires duplex for a streamed body.
			duplex: 'half',
		})
		const response = await handleChat(
			{ request, params: {} } as any,
			baseDeps(),
		)
		expect((response as Response).status).toBe(413)
		// It stopped reading well before the end of the stream.
		expect(sent).toBeLessThan(45)
	})

	it('refuses a request that declares a body larger than the limit before reading it', async () => {
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			headers: { 'content-length': '41000000' },
			body: JSON.stringify({ messages: [] }),
		})
		const response = await handleChat(
			{ request, params: {} } as any,
			baseDeps(),
		)
		expect((response as Response).status).toBe(413)
	})

	it('answers 400, not 500, to a body that is not a JSON object', async () => {
		for (const body of ['{"messages":', '', 'null', '[]', '"text"', '12']) {
			const request = new Request('http://localhost/api/ai/chat', {
				method: 'POST',
				body,
			})
			const response = await handleChat(
				{ request, params: {} } as any,
				baseDeps(),
			)
			expect((response as Response).status, `body: ${body}`).toBe(400)
		}
	})

	it('reads a body that arrives in several chunks, including a split multi-byte character', async () => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({ messages: [], note: 'caf\u00e9 \u2603' }),
		)
		// Cut inside the two-byte "\u00e9" so a per-chunk decode would corrupt it.
		const cut = bytes.indexOf(0xc3) + 1
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, cut))
				controller.enqueue(bytes.slice(cut))
				controller.close()
			},
		})
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: stream,
			// @ts-expect-error Node requires duplex for a streamed body.
			duplex: 'half',
		})
		const response = await handleChat(
			{ request, params: {} } as any,
			baseDeps(),
		)
		// Parsed and past the attachment check: it reaches the stream, not a 400.
		expect((response as Response).status).not.toBe(400)
	})

	it('drops everything but the known fields from an accepted image', async () => {
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: JSON.stringify({
				messages: [
					{
						id: 'm',
						role: 'user',
						parts: [
							{
								type: 'file',
								mediaType: 'image/jpeg',
								url: 'data:image/jpeg;base64,/9j/4AAQ',
								providerReference: { google: 'files/abc' },
								providerMetadata: { google: { x: 1 } },
							},
						],
					},
				],
			}),
		})
		const createChatStream = vi.fn(() => streamResult())
		await handleChat(
			{ request, params: {} } as any,
			baseDeps({ createChatStream }),
		)
		expect(createChatStream).toHaveBeenCalledTimes(1)
		const call = createChatStream.mock.calls[0] as unknown as [
			{ messages: Array<{ content: Array<Record<string, unknown>> }> },
		]
		const part = call[0].messages[0]?.content[0] ?? {}
		expect(JSON.stringify(part)).not.toContain('files/abc')
		expect(JSON.stringify(part)).not.toContain('providerReference')
	})

	it('refuses more than four images in one message, and a non-array body', async () => {
		const image = {
			type: 'file',
			mediaType: 'image/jpeg',
			url: 'data:image/jpeg;base64,/9j/4AAQ',
		}
		const tooMany = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: JSON.stringify({
				messages: [
					{ id: 'm', role: 'user', parts: [image, image, image, image, image] },
				],
			}),
		})
		expect(
			(
				(await handleChat(
					{ request: tooMany, params: {} } as any,
					baseDeps(),
				)) as Response
			).status,
		).toBe(413)
		const notArray = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: JSON.stringify({ messages: 'nope' }),
		})
		expect(
			(
				(await handleChat(
					{ request: notArray, params: {} } as any,
					baseDeps(),
				)) as Response
			).status,
		).toBe(400)
	})

	it('refuses an oversized image', async () => {
		const request = new Request('http://localhost/api/ai/chat', {
			method: 'POST',
			body: JSON.stringify({
				messages: [
					{
						id: 'm',
						role: 'user',
						parts: [
							{
								type: 'file',
								mediaType: 'image/jpeg',
								url: `data:image/jpeg;base64,${'A'.repeat(3_000_001)}`,
							},
						],
					},
				],
			}),
		})
		const response = await handleChat(
			{ request, params: {} } as any,
			baseDeps(),
		)
		expect((response as Response).status).toBe(413)
	})

	it('loads the currently viewed page when pageId is provided', async () => {
		const request = new Request('http://localhost/api/ai/chat?orgSlug=acme', {
			method: 'POST',
			body: JSON.stringify({ messages: [], pageId: 'about-1' }),
		})

		const currentPage = {
			id: 'about-1',
			title: 'About Us',
			slug: 'about',
			isHomePage: false,
			sections: [
				{ id: 'content-1', type: 'content', position: 0, config: '{}' },
			],
		}
		const createChatStream = vi.fn(() => streamResult())

		const deps = baseDeps({
			createChatStream,
			buildPageEditorSystemPrompt: vi.fn((base: string) => base),
			getPageEditorTools: vi.fn(() => ({})),
			getWebsitePages: vi.fn().mockResolvedValue([]),
			getPageContext: vi.fn().mockResolvedValue(currentPage),
			resolveOrganizationFromSlug: vi.fn().mockResolvedValue({ id: 'org-456' }),
		})

		await handleChat({ request, params: {} } as any, deps)

		expect(deps.getPageContext).toHaveBeenCalledWith('about-1', 'org-456')
		expect(deps.buildPageEditorSystemPrompt).toHaveBeenCalledWith(
			'system prompt',
			{
				pages: [],
				currentPageId: 'about-1',
				currentPage,
			},
		)
	})

	it('falls back to general chat when the user cannot access website tools', async () => {
		const request = new Request('http://localhost/api/ai/chat?orgSlug=acme', {
			method: 'POST',
			body: JSON.stringify({ messages: [] }),
		})
		const createChatStream = vi.fn(() => streamResult())

		const deps = baseDeps({
			createChatStream,
			getPageEditorTools: vi.fn(() => ({})),
			resolveOrganizationFromSlug: vi
				.fn()
				.mockRejectedValue(new Response('Forbidden', { status: 403 })),
		})

		await handleChat({ request, params: {} } as any, deps)

		expect(createChatStream).toHaveBeenCalledWith({
			messages: [],
			systemPrompt: 'system prompt',
		})
	})

	it('attaches app navigation tools and current location without website access', async () => {
		const request = new Request('http://localhost/api/ai/chat?orgSlug=acme', {
			method: 'POST',
			body: JSON.stringify({
				messages: [],
				currentPath: '/acme/notes',
				params: { orgSlug: 'acme' },
			}),
		})
		const navTools = { navigateToAppPage: {} }
		const routes = [
			{
				id: 'org-settings',
				title: 'Organization settings',
				description: 'Organization general settings',
				path: '/:orgSlug/settings',
			},
		]
		const createChatStream = vi.fn(() => streamResult())
		const buildNavigationSystemPrompt = vi.fn(
			(base: string) => `${base}\nnavigation`,
		)

		const deps = baseDeps({
			createChatStream,
			getNavigationTools: vi.fn(() => navTools),
			getNavigableRoutes: vi.fn(() => routes),
			buildNavigationSystemPrompt,
			hasWebsiteAccess: vi.fn().mockResolvedValue(false),
			resolveOrganizationFromSlug: vi.fn().mockResolvedValue({ id: 'org-456' }),
			getPageEditorTools: vi.fn(() => ({ navigateToPage: {} })),
		})

		await handleChat({ request, params: {} } as any, deps)

		expect(deps.hasWebsiteAccess).toHaveBeenCalledWith(
			expect.any(Request),
			'org-456',
		)
		expect(deps.getPageEditorTools).not.toHaveBeenCalled()
		expect(buildNavigationSystemPrompt).toHaveBeenCalledWith('system prompt', {
			location: {
				currentPath: '/acme/notes',
				orgSlug: 'acme',
				params: { orgSlug: 'acme' },
			},
			routes,
		})
		expect(createChatStream).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: navTools,
				systemPrompt: 'system prompt\nnavigation',
			}),
		)
	})

	it('merges navigation tools with website editor tools', async () => {
		const request = new Request('http://localhost/api/ai/chat?orgSlug=acme', {
			method: 'POST',
			body: JSON.stringify({
				messages: [],
				currentPath: '/acme/website/pages/home-1',
			}),
		})
		const navTools = { navigateToAppPage: {} }
		const pageTools = { navigateToPage: {} }
		const createChatStream = vi.fn(() => streamResult())

		const deps = baseDeps({
			createChatStream,
			getNavigationTools: vi.fn(() => navTools),
			getNavigableRoutes: vi.fn(() => []),
			getPageEditorTools: vi.fn(() => pageTools),
			getWebsitePages: vi.fn().mockResolvedValue([]),
			resolveOrganizationFromSlug: vi.fn().mockResolvedValue({ id: 'org-456' }),
			hasWebsiteAccess: vi.fn().mockResolvedValue(true),
			buildPageEditorSystemPrompt: vi.fn((base: string) => `${base}\nwebsite`),
		})

		await handleChat({ request, params: {} } as any, deps)

		expect(createChatStream).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: {
					navigateToAppPage: {},
					navigateToPage: {},
				},
				systemPrompt: 'system prompt\nwebsite',
			}),
		)
	})
})
