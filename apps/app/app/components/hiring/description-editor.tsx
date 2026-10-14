import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect, useRef, type ReactNode } from 'react'

/**
 * The job description: a small rich-text field limited to what a posting
 * shows (paragraphs, one heading size, bold, italic, bullet and numbered
 * lists, links). Whatever is typed or pasted is sanitized again on the server,
 * so this only keeps the toolbar honest. `dir="auto"` lets an Arabic
 * description run right to left inside an English screen and the reverse.
 */
export function DescriptionEditor({
	labelId,
	value,
	onChange,
	error,
	describedBy,
}: {
	labelId: string
	value: string
	onChange: (html: string) => void
	error?: string | null
	describedBy?: string
}) {
	const { _ } = useLingui()
	const lastEmitted = useRef(value)

	const editor = useEditor({
		immediatelyRender: false,
		extensions: [
			StarterKit.configure({
				heading: { levels: [3] },
				blockquote: false,
				code: false,
				codeBlock: false,
				horizontalRule: false,
				strike: false,
				link: {
					openOnClick: false,
					protocols: ['http', 'https', 'mailto', 'tel'],
				},
			}),
		],
		content: value,
		editorProps: {
			attributes: {
				role: 'textbox',
				'aria-multiline': 'true',
				'aria-labelledby': labelId,
				dir: 'auto',
				class:
					'prose prose-sm dark:prose-invert text-foreground max-w-none min-h-48 px-3 py-2.5 outline-none [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:ps-5 [&_ol]:ps-5',
			},
		},
		onUpdate: ({ editor: current }) => {
			const html = current.isEmpty ? '' : current.getHTML()
			lastEmitted.current = html
			onChange(html)
		},
	})

	// Replace the content when it changes from outside (an AI draft), but never
	// while the change came from this editor.
	useEffect(() => {
		if (!editor || editor.isDestroyed) return
		if (value === lastEmitted.current) return
		lastEmitted.current = value
		editor.commands.setContent(value, { emitUpdate: false })
	}, [editor, value])

	return (
		<div
			className={cn(
				'border-input dark:bg-input/30 w-full rounded-lg border bg-transparent',
				'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-3',
				error && 'border-destructive',
			)}
		>
			<Toolbar editor={editor} label={_(t`Formatting`)} />
			<EditorContent editor={editor} aria-describedby={describedBy} />
		</div>
	)
}

function Toolbar({ editor, label }: { editor: Editor | null; label: string }) {
	const { _ } = useLingui()
	if (!editor) return <div aria-hidden="true" className="h-12 border-b" />
	const items: Array<{
		key: string
		label: ReactNode
		name: string
		active: boolean
		run: () => void
	}> = [
		{
			key: 'bold',
			label: <span className="font-bold">B</span>,
			name: _(t`Bold`),
			active: editor.isActive('bold'),
			run: () => editor.chain().focus().toggleBold().run(),
		},
		{
			key: 'italic',
			label: <span className="italic">I</span>,
			name: _(t`Italic`),
			active: editor.isActive('italic'),
			run: () => editor.chain().focus().toggleItalic().run(),
		},
		{
			key: 'heading',
			label: _(t`Heading`),
			name: _(t`Heading`),
			active: editor.isActive('heading'),
			run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
		},
		{
			key: 'bullets',
			label: _(t`Bullets`),
			name: _(t`Bulleted list`),
			active: editor.isActive('bulletList'),
			run: () => editor.chain().focus().toggleBulletList().run(),
		},
		{
			key: 'numbers',
			label: _(t`Numbers`),
			name: _(t`Numbered list`),
			active: editor.isActive('orderedList'),
			run: () => editor.chain().focus().toggleOrderedList().run(),
		},
	]
	return (
		<div
			role="toolbar"
			aria-label={label}
			className="flex flex-wrap items-center gap-1 border-b p-1"
		>
			{items.map((item) => (
				<Button
					key={item.key}
					type="button"
					variant={item.active ? 'secondary' : 'ghost'}
					aria-pressed={item.active}
					aria-label={item.name}
					className="h-11 min-w-11 px-3 md:min-w-8"
					onMouseDown={(event) => event.preventDefault()}
					onClick={item.run}
				>
					{item.label}
				</Button>
			))}
		</div>
	)
}
