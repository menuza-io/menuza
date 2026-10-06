import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type ChatMessageAttachment } from '@repo/common/chat'
import { normalizeChatMessageBody } from '@repo/common/chat-markdown'
import { cn } from '@repo/ui'
import { Img } from 'openimg/react'
import { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

function ChatAttachments({
	attachments,
}: {
	attachments: ChatMessageAttachment[]
}) {
	const { _ } = useLingui()
	if (attachments.length === 0) return null
	return (
		<div className="mt-2 flex flex-wrap gap-2">
			{attachments.map((attachment) => (
				<a
					key={attachment.objectKey}
					href={`/resources/images?objectKey=${encodeURIComponent(attachment.objectKey)}`}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={_(msg`Open image attachment`)}
					className="focus-visible:ring-ring block max-w-xs min-w-0 overflow-hidden rounded-lg border outline-none focus-visible:ring-2"
				>
					<Img
						src={`/resources/images?objectKey=${encodeURIComponent(attachment.objectKey)}`}
						alt=""
						className="max-h-48 max-w-full object-contain"
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
		<div
			className={cn(
				'text-sm leading-relaxed [overflow-wrap:anywhere] break-words',
				className,
			)}
		>
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
									className="text-foreground decoration-primary underline underline-offset-4"
								>
									{children}
								</a>
							)
						},
						p: ({ children }) => (
							<p className="whitespace-pre-wrap not-last:mb-2">{children}</p>
						),
						ul: ({ children }) => (
							<ul className="my-2 list-disc space-y-1 ps-5">{children}</ul>
						),
						ol: ({ children }) => (
							<ol className="my-2 list-decimal space-y-1 ps-5">{children}</ol>
						),
						blockquote: ({ children }) => (
							<blockquote className="text-muted-foreground my-2 border-s ps-3">
								{children}
							</blockquote>
						),
						pre: ({ children }) => (
							<pre className="bg-muted my-2 max-w-full overflow-x-auto rounded-lg p-3 text-xs">
								{children}
							</pre>
						),
						code: ({ children }) => (
							<code className="bg-muted rounded px-1 py-0.5 text-xs">
								{children}
							</code>
						),
						table: ({ children }) => (
							<div className="my-2 overflow-x-auto">
								<table className="w-full text-start text-xs [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_th]:text-start">
									{children}
								</table>
							</div>
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
