import { Text as NativeText, type TextProps } from 'react-native'

/** The type scale; colors come from the organization's theme tokens. */
export type TextVariant =
	| 'display'
	| 'title'
	| 'heading'
	| 'body'
	| 'label'
	| 'muted'
	| 'caption'
	| 'error'
	| 'code'

export const TEXT_VARIANT_CLASSES: Record<TextVariant, string> = {
	display: 'text-4xl font-bold text-foreground',
	title: 'text-3xl font-bold text-foreground',
	heading: 'text-xl font-semibold text-foreground',
	body: 'text-base text-foreground',
	label: 'text-sm font-medium text-foreground',
	muted: 'text-sm text-muted-foreground',
	caption: 'text-xs text-muted-foreground',
	error: 'text-sm text-destructive',
	/** Codes a person reads aloud or types: wide, never wrapped mid-group. */
	code: 'text-3xl font-semibold tracking-widest text-foreground',
}

export function Text({
	variant = 'body',
	className,
	...props
}: TextProps & { variant?: TextVariant; className?: string }) {
	return (
		<NativeText
			className={`${TEXT_VARIANT_CLASSES[variant]}${className ? ` ${className}` : ''}`}
			{...props}
		/>
	)
}
