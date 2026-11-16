import { describe, expect, it, vi } from 'vitest'
import { buildAiDraftContext } from './ai-draft-context.ts'
import { AiDraftError } from './ai-draft-sanitize.ts'
import { createAiDraft, rewriteText } from './ai-draft.server.ts'

const context = buildAiDraftContext({
	organization: { name: 'Olive', description: 'Kitchen', siteOrigin: 'https://olive.example.com' },
	menuItems: [{ id: 'i1', name: 'Falafel', price: 12.5, currency: 'SAR' }],
	selectedItemIds: ['i1'],
	coupon: null,
})
const request = { channel: 'email', goal: 'announce_dish', tone: 'friendly', language: 'en' } as const

describe('createAiDraft (#155, mocked model)', () => {
	it('returns 3 subjects and designer blocks from a valid model answer', async () => {
		const generate = vi.fn().mockResolvedValue({
			subjects: ['One', 'Two', 'Three'],
			blocks: [
				{ type: 'heading', text: 'Falafel night' },
				{ type: 'paragraph', text: 'Hi {{firstName|there}}!' },
				{ type: 'menu_item', itemIds: ['i1'] },
				{ type: 'button', label: 'Order', url: '/menu' },
			],
		})
		const draft = await createAiDraft({ context, request, generate })
		expect(draft.channel).toBe('email')
		if (draft.channel !== 'email') return
		expect(draft.subjects).toEqual(['One', 'Two', 'Three'])
		expect(draft.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'menu_item', 'button'])
		// The model got the prompt and a schema, never guest data.
		const args = generate.mock.calls[0]![0] as { prompt: string; system: string }
		expect(args.prompt).toContain('Falafel')
	})

	it('a text message answer is trimmed to fit the footer', async () => {
		const generate = vi.fn().mockResolvedValue({ message: 'x '.repeat(200) })
		const draft = await createAiDraft({ context, request: { ...request, channel: 'sms' }, generate })
		expect(draft.channel === 'sms' && draft.message.length).toBeLessThanOrEqual(137)
	})

	it.each([
		['not an object', 'nope'],
		['no subjects', { subjects: [], blocks: [{ type: 'heading', text: 'x' }] }],
		['bad block type', { subjects: ['a'], blocks: [{ type: 'video', text: 'x' }] }],
		['only a dish block', { subjects: ['a'], blocks: [{ type: 'menu_item', itemIds: ['i1'] }] }],
	])('%s is ai_draft_invalid', async (_name, answer) => {
		const error = await createAiDraft({
			context,
			request,
			generate: vi.fn().mockResolvedValue(answer),
		}).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(AiDraftError)
		expect((error as AiDraftError).code).toBe('ai_draft_invalid')
	})
})

describe('rewriteText', () => {
	it('rewrites one block, keeps merge tags and sanitises the answer', async () => {
		const generate = vi.fn().mockResolvedValue({
			text: 'Hello {{firstName|friend}}, 50% off at https://evil.example.net',
		})
		const text = await rewriteText({ context, text: 'Hi {{firstName|there}}', instruction: 'warmer', generate })
		expect(text).toContain('{{firstName|friend}}')
		expect(text).not.toMatch(/evil|50/)
		expect((generate.mock.calls[0]![0] as { system: string }).system).toContain('warmer')
	})

	it('translates, and an empty answer is invalid', async () => {
		const ok = await rewriteText({
			context,
			text: 'Hello',
			instruction: 'arabic',
			generate: vi.fn().mockResolvedValue({ text: 'مرحبا' }),
		})
		expect(ok).toBe('مرحبا')
		await expect(
			rewriteText({ context, text: 'Hello', instruction: 'shorter', generate: vi.fn().mockResolvedValue({ text: '   ' }) }),
		).rejects.toBeInstanceOf(AiDraftError)
	})
})
