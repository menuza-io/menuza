import { cn } from '@repo/ui'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'

export type UserAvatarUser = {
	name?: string | null
	username?: string | null
	email?: string | null
	image?: string | null
	avatar?: string | null
}

function getUserInitials(user: UserAvatarUser) {
	const displayName =
		user.name?.trim() || user.username?.trim() || user.email?.trim()

	if (!displayName) return '??'

	const parts = displayName.split(/\s+/).filter(Boolean)
	const initials = (
		parts.length > 1 ? parts.map((part) => part[0]) : displayName.slice(0, 2)
	) as string | string[]

	return (Array.isArray(initials) ? initials.join('') : initials).toUpperCase()
}

export function UserAvatar({
	user,
	className,
	fallbackClassName,
	alt,
}: {
	user: UserAvatarUser
	className?: string
	fallbackClassName?: string
	alt?: string
}) {
	const imageSrc = user.image ?? user.avatar ?? undefined
	const altText =
		alt ?? user.name ?? user.username ?? user.email ?? 'User avatar'

	return (
		<Avatar className={cn('size-8', className)}>
			{imageSrc ? <AvatarImage src={imageSrc} alt={altText} /> : null}
			<AvatarFallback
				className={cn(
					'bg-muted text-muted-foreground text-xs font-medium',
					// eslint-disable-next-line shadcn/require-static-classes -- callers may forward a fallback className
					fallbackClassName,
				)}
			>
				{getUserInitials(user)}
			</AvatarFallback>
		</Avatar>
	)
}
