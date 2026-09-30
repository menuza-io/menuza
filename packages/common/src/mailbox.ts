import { z } from 'zod'
import { publicFormFieldsSchema } from './public-form.ts'

export const mailboxItemSchema = z.object({
	id: z.string(),
	formId: z.string(),
	formName: z.string(),
	fields: publicFormFieldsSchema,
	values: z.record(z.string(), z.string()),
	createdAt: z.string().nullable(),
	isRead: z.boolean(),
})

export type MailboxItem = z.infer<typeof mailboxItemSchema>

export const mailboxListSchema = z.object({
	items: z.array(mailboxItemSchema),
	total: z.number(),
	unreadCount: z.number(),
	aiAvailable: z.boolean(),
})

export function mailboxRecipient(item: Pick<MailboxItem, 'fields' | 'values'>) {
	for (const field of item.fields) {
		if (field.type !== 'email') continue
		const value = item.values[field.id]?.trim()
		if (value && z.string().email().safeParse(value).success) return value
	}
	return null
}

export function mailboxSender(item: MailboxItem) {
	const nameField = item.fields.find((field) => field.type === 'name')
	return (
		(nameField && item.values[nameField.id]?.trim()) || mailboxRecipient(item)
	)
}

export function mailboxReplyUrl(
	recipient: string,
	subject: string,
	message: string,
) {
	if (!z.string().email().safeParse(recipient).success) return null
	return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject.replace(/[\r\n]/g, ' '))}&body=${encodeURIComponent(message.replace(/\r?\n/g, '\r\n'))}`
}
