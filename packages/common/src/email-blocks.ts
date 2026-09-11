import { z } from 'zod'

/**
 * Block registry for the marketing email builder.
 *
 * An email body is an ordered list of blocks. Each block keeps its own config
 * so the editor, the React Email renderer, and the stored JSON all share one
 * shape. Content is intentionally permissive (empty strings allowed) so a block
 * being edited never fails validation; renderers skip empty text/blocks.
 */

export const EMAIL_BLOCK_TYPES = [
	'heading',
	'body',
	'paragraph',
	'image',
	'button',
] as const
export type EmailBlockType = (typeof EMAIL_BLOCK_TYPES)[number]

export const EMAIL_BLOCK_ALIGNMENTS = ['left', 'center', 'right'] as const
export type EmailBlockAlignment = (typeof EMAIL_BLOCK_ALIGNMENTS)[number]

export const EMAIL_HEADING_LEVELS = ['h1', 'h2', 'h3'] as const
export type EmailHeadingLevel = (typeof EMAIL_HEADING_LEVELS)[number]

export const EMAIL_BUTTON_VARIANTS = ['primary', 'outline'] as const
export type EmailButtonVariant = (typeof EMAIL_BUTTON_VARIANTS)[number]

/** `auto` hugs the label; `full` spans the content width of the email. */
export const EMAIL_BUTTON_WIDTHS = ['auto', 'full'] as const
export type EmailButtonWidth = (typeof EMAIL_BUTTON_WIDTHS)[number]

const emailBlockIdSchema = z
	.string()
	.min(1)
	.max(60)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

const alignmentSchema = z.enum(EMAIL_BLOCK_ALIGNMENTS).default('left')

const emailUrlSchema = z
	.string()
	.max(2_000)
	.refine(
		(value) => !value.trim() || /^https?:\/\//i.test(value.trim()),
		'URL must use HTTP or HTTPS',
	)

export const emailHeadingBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('heading'),
	config: z.object({
		text: z.string().max(300).default(''),
		level: z.enum(EMAIL_HEADING_LEVELS).default('h2'),
		align: alignmentSchema,
	}),
})

export const emailBodyBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('body'),
	config: z.object({
		text: z.string().max(10_000).default(''),
	}),
})

export const emailParagraphBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('paragraph'),
	config: z.object({
		text: z.string().max(10_000).default(''),
	}),
})

export const emailImageBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('image'),
	config: z.object({
		url: emailUrlSchema.default(''),
		alt: z.string().max(300).default(''),
		href: emailUrlSchema.default(''),
		width: z.number().min(10).max(100).default(100),
		align: z.enum(EMAIL_BLOCK_ALIGNMENTS).default('center'),
	}),
})

export const emailButtonBlockSchema = z.object({
	id: emailBlockIdSchema,
	type: z.literal('button'),
	config: z.object({
		label: z.string().max(120).default(''),
		url: emailUrlSchema.default(''),
		variant: z.enum(EMAIL_BUTTON_VARIANTS).default('primary'),
		width: z.enum(EMAIL_BUTTON_WIDTHS).default('auto'),
		align: alignmentSchema,
	}),
})

export const emailBlockSchema = z.discriminatedUnion('type', [
	emailHeadingBlockSchema,
	emailBodyBlockSchema,
	emailParagraphBlockSchema,
	emailImageBlockSchema,
	emailButtonBlockSchema,
])

export const emailBlocksSchema = z
	.array(emailBlockSchema)
	.max(50)
	.refine(
		(blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length,
		{ message: 'Block ids must be unique.' },
	)

export type EmailHeadingBlock = z.infer<typeof emailHeadingBlockSchema>
export type EmailBodyBlock = z.infer<typeof emailBodyBlockSchema>
export type EmailParagraphBlock = z.infer<typeof emailParagraphBlockSchema>
export type EmailImageBlock = z.infer<typeof emailImageBlockSchema>
export type EmailButtonBlock = z.infer<typeof emailButtonBlockSchema>
export type EmailBlock = z.infer<typeof emailBlockSchema>

export function isEmailBlockType(value: unknown): value is EmailBlockType {
	return (
		typeof value === 'string' &&
		(EMAIL_BLOCK_TYPES as readonly string[]).includes(value)
	)
}

export function createEmailBlockId(): string {
	const random = Math.random().toString(36).slice(2, 10)
	return `block-${Date.now().toString(36)}-${random}`
}

export function getDefaultEmailBlock(type: EmailBlockType): EmailBlock {
	const id = createEmailBlockId()
	switch (type) {
		case 'heading':
			return {
				id,
				type,
				config: { text: 'Heading', level: 'h2', align: 'left' },
			}
		case 'body':
			return {
				id,
				type,
				config: {
					text: 'Write your message here. Use {{firstName}} to personalize.',
				},
			}
		case 'paragraph':
			return {
				id,
				type,
				config: { text: 'Add supporting details for your readers.' },
			}
		case 'image':
			return {
				id,
				type,
				config: { url: '', alt: '', href: '', width: 100, align: 'center' },
			}
		case 'button':
			return {
				id,
				type,
				config: {
					label: 'Learn more',
					url: 'https://',
					variant: 'primary',
					width: 'auto',
					align: 'left',
				},
			}
	}
}

/** Parse stored block JSON (string or already-parsed value). Invalid input yields []. */
export function parseEmailBlocks(value: unknown): EmailBlock[] {
	let raw = value
	if (typeof value === 'string') {
		if (value.trim().length === 0) return []
		try {
			raw = JSON.parse(value)
		} catch {
			return []
		}
	}
	const parsed = emailBlocksSchema.safeParse(raw)
	return parsed.success ? parsed.data : []
}

export function serializeEmailBlocks(blocks: EmailBlock[]): string {
	return JSON.stringify(blocks)
}

export const EMAIL_BLOCK_TEMPLATE_IDS = [
	'blank',
	'welcome',
	'announcement',
	'product',
] as const
export type EmailBlockTemplateId = (typeof EMAIL_BLOCK_TEMPLATE_IDS)[number]

type EmailBlockSeed = { type: EmailBlockType; config: Record<string, unknown> }

export const EMAIL_BLOCK_TEMPLATES: ReadonlyArray<{
	id: EmailBlockTemplateId
	label: string
	description: string
	blocks: EmailBlockSeed[]
}> = [
	{
		id: 'blank',
		label: 'Blank',
		description: 'Start from scratch',
		blocks: [],
	},
	{
		id: 'welcome',
		label: 'Welcome',
		description: 'Greeting with a hero image and call to action',
		blocks: [
			{
				type: 'heading',
				config: {
					text: 'Welcome to {{organizationName}}',
					level: 'h1',
					align: 'center',
				},
			},
			{
				type: 'body',
				config: {
					text: 'Hi {{firstName}}, we are thrilled to have you here. Here are a few things to get you started.',
				},
			},
			{
				type: 'image',
				config: { url: '', alt: '', href: '', width: 100, align: 'center' },
			},
			{
				type: 'button',
				config: {
					label: 'Get started',
					url: 'https://',
					variant: 'primary',
					align: 'center',
				},
			},
		],
	},
	{
		id: 'announcement',
		label: 'Announcement',
		description: 'Short update with a single call to action',
		blocks: [
			{
				type: 'heading',
				config: { text: 'Something new is here', level: 'h2', align: 'left' },
			},
			{
				type: 'body',
				config: {
					text: 'Hi {{firstName}}, we have something exciting to share with you.',
				},
			},
			{
				type: 'paragraph',
				config: { text: 'Read the full details on our website.' },
			},
			{
				type: 'button',
				config: {
					label: 'Read more',
					url: 'https://',
					variant: 'primary',
					align: 'left',
				},
			},
		],
	},
	{
		id: 'product',
		label: 'Product',
		description: 'Feature an image with a heading and buy button',
		blocks: [
			{
				type: 'image',
				config: { url: '', alt: '', href: '', width: 100, align: 'center' },
			},
			{
				type: 'heading',
				config: {
					text: 'Meet our latest product',
					level: 'h2',
					align: 'center',
				},
			},
			{
				type: 'body',
				config: {
					text: 'Hi {{firstName}}, our newest release is now available. Take a look and see what is new.',
				},
			},
			{
				type: 'button',
				config: {
					label: 'Order now',
					url: 'https://',
					variant: 'primary',
					align: 'center',
				},
			},
		],
	},
]

export function getEmailBlockTemplate(templateId: string) {
	return EMAIL_BLOCK_TEMPLATES.find((template) => template.id === templateId)
}

/** Build template blocks with fresh ids, dropping any seed that fails the schema. */
export function buildEmailTemplateBlocks(
	templateId: EmailBlockTemplateId,
): EmailBlock[] {
	const template = getEmailBlockTemplate(templateId)
	if (!template) return []
	return template.blocks.flatMap((seed) => {
		const parsed = emailBlockSchema.safeParse({
			...seed,
			id: createEmailBlockId(),
		})
		return parsed.success ? [parsed.data] : []
	})
}
