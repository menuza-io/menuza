import { cn } from '@repo/ui'
import { Img } from 'openimg/react'
import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { type ChatMessageAttachment } from '@repo/common/chat'
import { normalizeChatMessageBody } from '@repo/common/chat-markdown'

function ChatAttachments({
	attachments,
}: {
	attachments: ChatMessageAttachment[]
}) {
	if (attachments.length === 0) return null
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{attachments.map((attachment) => (
				<a
					key={attachment.objectKey}
					href={`/resources/images?objectKey=${encodeURIComponent(attachment.objectKey)}`}
					target="_blank"
					rel="noopener noreferrer"
					className="block max-w-xs overflow-hidden rounded-md border"
				>
					<Img
						src={`/resources/images?objectKey=${encodeURIComponent(attachment.objectKey)}`}
						alt=""
						className="max-h-48 w-auto object-contain"
						width={320}
						height={192}
					/>
				</a>
			))}
		</div>
	)
}

export function ChatMessageMarkdown({
	body,
	attachments = [],
	className,
}: {
	body: string
	attachments?: ChatMessageAttachment[]
	className?: string
}) {
	const plugins = useMemo(() => [remarkGfm], [])
	const markdown = useMemo(() => normalizeChatMessageBody(body), [body])
	if (!markdown.trim() && attachments.length === 0) return null
	return (
		<div className={cn('text-sm break-words', className)}>
			{markdown.trim() ? (
				<Markdown
					remarkPlugins={plugins}
					components={{
						a: ({ href, children }) => {
							if (href?.startsWith('user:')) {
								return (
									<span className="bg-primary/10 text-primary rounded px-1 py-0.5 font-medium">
										{children}
									</span>
								)
							}
							if (!href || !/^https?:/i.test(href)) {
								return <span>{children}</span>
							}
							return (
								<a
									href={href}
									target="_blank"
									rel="noopener noreferrer"
									className="text-primary underline"
								>
									{children}
								</a>
							)
						},
						p: ({ children }) => (
							<p className="whitespace-pre-wrap not-last:mb-2">{children}</p>
						),
					}}
				>
					{markdown}
				</Markdown>
			) : null}
			<ChatAttachments attachments={attachments} />
		</div>
	)
}
