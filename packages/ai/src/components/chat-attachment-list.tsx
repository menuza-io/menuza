'use client'

import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { type ChatAttachment } from './chat-attachments.js'

/** Thumbnails of the images about to be sent, each with a remove button. */
export function ChatAttachmentList({
	attachments,
	onRemove,
	className,
}: {
	attachments: ChatAttachment[]
	onRemove: (id: string) => void
	className?: string
}) {
	const { _ } = useLingui()
	if (attachments.length === 0) return null
	return (
		<ul
			aria-label={_(t`Attached images`)}
			className={className ?? 'flex flex-wrap gap-2 px-1 pt-2'}
		>
			{attachments.map((attachment) => (
				<li key={attachment.id} className="group/thumb relative">
					{/* The remove button carries the file name, so the image is decorative. */}
					<img
						src={attachment.url}
						alt=""
						className="border-border size-14 rounded-lg border object-cover"
					/>
					<button
						type="button"
						onClick={() => onRemove(attachment.id)}
						aria-label={_(t`Remove ${attachment.name}`)}
						// 24px target, always shown on touch screens (no hover there), with
						// a larger invisible hit area.
						className="bg-foreground text-background focus-visible:ring-primary/40 absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full opacity-0 transition-opacity duration-80 group-focus-within/thumb:opacity-100 group-hover/thumb:opacity-100 after:absolute after:-inset-2 after:content-[''] focus-visible:ring-2 focus-visible:outline-none pointer-coarse:opacity-100"
					>
						<Icon name="x" className="size-3.5" />
					</button>
				</li>
			))}
		</ul>
	)
}
