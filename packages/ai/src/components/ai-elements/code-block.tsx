'use client'

import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { IconSwap } from '@repo/ui/icon-swap'
import {
	type ComponentProps,
	type HTMLAttributes,
	type ReactNode,
	createContext,
	useContext,
	useState,
} from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark'
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light'

import { cn } from '@repo/ui'

type CodeBlockContextType = {
	code: string
}

const CodeBlockContext = createContext<CodeBlockContextType>({
	code: '',
})

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
	code: string
	language: string
	showLineNumbers?: boolean
	children?: ReactNode
}

export const CodeBlock = ({
	code,
	language,
	showLineNumbers = false,
	className,
	children,
	...props
}: CodeBlockProps) => (
	<CodeBlockContext.Provider value={{ code }}>
		<div
			className={cn(
				'bg-background text-foreground relative w-full overflow-hidden rounded-md border',
				className,
			)}
			{...props}
		>
			<div className="relative">
				<SyntaxHighlighter
					language={language}
					style={oneLight}
					customStyle={{
						margin: 0,
						padding: '1rem',
						fontSize: '0.875rem',
						background: 'hsl(var(--background))',
						color: 'hsl(var(--foreground))',
					}}
					showLineNumbers={showLineNumbers}
					lineNumberStyle={{
						color: 'hsl(var(--muted-foreground))',
						paddingRight: '1rem',
						minWidth: '2.5rem',
					}}
					codeTagProps={{
						className: 'font-mono text-sm',
					}}
					className="overflow-hidden dark:hidden"
				>
					{code}
				</SyntaxHighlighter>
				<SyntaxHighlighter
					language={language}
					style={oneDark}
					customStyle={{
						margin: 0,
						padding: '1rem',
						fontSize: '0.875rem',
						background: 'hsl(var(--background))',
						color: 'hsl(var(--foreground))',
					}}
					showLineNumbers={showLineNumbers}
					lineNumberStyle={{
						color: 'hsl(var(--muted-foreground))',
						paddingRight: '1rem',
						minWidth: '2.5rem',
					}}
					codeTagProps={{
						className: 'font-mono text-sm',
					}}
					className="hidden overflow-hidden dark:block"
				>
					{code}
				</SyntaxHighlighter>
				{children && (
					<div className="absolute top-2 right-2 flex items-center gap-2">
						{children}
					</div>
				)}
			</div>
		</div>
	</CodeBlockContext.Provider>
)

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	onCopy?: () => void
	onError?: (error: Error) => void
	timeout?: number
}

export const CodeBlockCopyButton = ({
	onCopy,
	onError,
	timeout = 2000,
	children,
	className,
	...props
}: CodeBlockCopyButtonProps) => {
	const [isCopied, setIsCopied] = useState(false)
	const { code } = useContext(CodeBlockContext)
	const { _ } = useLingui()

	const copyToClipboard = async () => {
		if (typeof window === 'undefined' || !navigator.clipboard.writeText) {
			onError?.(new Error('Clipboard API not available'))
			return
		}

		try {
			await navigator.clipboard.writeText(code)
			setIsCopied(true)
			onCopy?.()
			setTimeout(() => setIsCopied(false), timeout)
		} catch (error) {
			onError?.(error as Error)
		}
	}

	return (
		<Button
			aria-label={_(t`Copy code`)}
			className={cn('shrink-0', className)}
			onClick={copyToClipboard}
			size="icon"
			variant="ghost"
			{...props}
		>
			{children ?? (
				<IconSwap
					from="copy"
					to="check"
					swapped={isCopied}
					className="size-3.5"
				/>
			)}
		</Button>
	)
}
