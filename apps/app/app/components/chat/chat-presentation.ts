import { type ChatMessage } from '@repo/common/chat'

const GROUP_GAP_MS = 5 * 60 * 1000

export function isSameMessageDay(first: number, second: number) {
	return new Date(first).toDateString() === new Date(second).toDateString()
}

export function showMessageHeader(
	message: ChatMessage,
	previous: ChatMessage | undefined,
) {
	return (
		!previous ||
		previous.deleted ||
		previous.author !== message.author ||
		!isSameMessageDay(previous.createdAt, message.createdAt) ||
		message.createdAt - previous.createdAt > GROUP_GAP_MS
	)
}
