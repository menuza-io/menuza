import { getVideoClipSrc, getVideoPosterSrc } from '@repo/common'
import { cn } from '@repo/ui'
import { useEffect, useState } from 'react'

export function VideoPoster({
	objectKey,
	organizationId,
	mediaTransformBaseUrl,
	alt,
	className,
	width,
	height,
}: {
	objectKey: string
	organizationId?: string
	mediaTransformBaseUrl?: string | null
	alt?: string
	className?: string
	width?: number
	height?: number
}) {
	const [isHovering, setIsHovering] = useState(false)
	const [auth, setAuth] = useState<{ sig: string; expires: string } | null>(
		null,
	)

	useEffect(() => {
		const controller = new AbortController()
		void fetch(
			`/resources/videos/ticket?objectKey=${encodeURIComponent(objectKey)}`,
			{ signal: controller.signal },
		)
			.then(async (response) => {
				if (!response.ok) return
				const body = (await response.json()) as {
					sig?: unknown
					expires?: unknown
				}
				if (typeof body.sig === 'string' && typeof body.expires === 'string') {
					setAuth({ sig: body.sig, expires: body.expires })
				}
			})
			.catch(() => {})
		return () => controller.abort()
	}, [objectKey])

	if (!auth) {
		return (
			<div className={cn('bg-muted relative overflow-hidden', className)} />
		)
	}

	const posterSrc = getVideoPosterSrc(
		objectKey,
		organizationId,
		mediaTransformBaseUrl,
		auth,
	)
	const clipSrc = getVideoClipSrc(
		objectKey,
		organizationId,
		mediaTransformBaseUrl,
		auth,
	)
	const showClip = isHovering && mediaTransformBaseUrl && clipSrc !== posterSrc

	return (
		<div
			className={cn('relative overflow-hidden', className)}
			onMouseEnter={() => setIsHovering(true)}
			onMouseLeave={() => setIsHovering(false)}
		>
			{showClip ? (
				<video
					src={clipSrc}
					className="h-full w-full object-cover"
					autoPlay
					muted
					loop
					playsInline
					width={width}
					height={height}
				/>
			) : (
				<img
					src={posterSrc}
					alt={alt ?? 'Video poster'}
					className="h-full w-full object-cover"
					width={width}
					height={height}
				/>
			)}
		</div>
	)
}
