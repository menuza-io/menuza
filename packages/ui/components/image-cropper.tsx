import React, { type SyntheticEvent } from 'react'
import ReactCrop, {
	centerCrop,
	makeAspectCrop,
	type Crop,
	type PixelCrop,
} from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'

import { Icon } from './icon'
import { Button } from './ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogTrigger,
} from './ui/dialog'

function ImageCropperProvider({ children }: { children: React.ReactNode }) {
	return <>{children}</>
}

interface ImageCropperProps {
	dialogOpen: boolean
	setDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
	selectedFile: File | null
	onCropComplete: (croppedImageBlob: Blob) => void
	children: React.ReactElement
	aspect?: number
	className?: string
}

export function ImageCropper({
	dialogOpen,
	setDialogOpen,
	selectedFile,
	onCropComplete,
	children,
	aspect = 1,
	className = '',
}: ImageCropperProps) {
	const imgRef = React.useRef<HTMLImageElement | null>(null)
	const [crop, setCrop] = React.useState<Crop>()
	const [croppedImageUrl, setCroppedImageUrl] = React.useState<string>('')
	const [imagePreviewUrl, setImagePreviewUrl] = React.useState<string>('')

	// Create preview URL when file changes
	React.useEffect(() => {
		if (selectedFile) {
			const reader = new FileReader()
			reader.onload = (e) => {
				const result = e.target?.result as string
				setImagePreviewUrl(result)
			}
			reader.readAsDataURL(selectedFile)
		}
		return () => {
			if (imagePreviewUrl) {
				URL.revokeObjectURL(imagePreviewUrl)
			}
		}
	}, [selectedFile, imagePreviewUrl])

	function onImageLoad(e: SyntheticEvent<HTMLImageElement>) {
		if (aspect) {
			const { width, height } = e.currentTarget
			setCrop(centerAspectCrop(width, height, aspect))
		}
	}

	function onCropCompleteHandler(crop: PixelCrop) {
		if (imgRef.current && crop.width && crop.height) {
			const croppedImageUrl = getCroppedImg(imgRef.current, crop)
			setCroppedImageUrl(croppedImageUrl)
		}
	}

	function getCroppedImg(image: HTMLImageElement, crop: PixelCrop): string {
		const canvas = document.createElement('canvas')
		const scaleX = image.naturalWidth / image.width
		const scaleY = image.naturalHeight / image.height

		canvas.width = crop.width * scaleX
		canvas.height = crop.height * scaleY

		const ctx = canvas.getContext('2d')

		if (ctx) {
			ctx.imageSmoothingEnabled = true
			ctx.imageSmoothingQuality = 'high'

			ctx.drawImage(
				image,
				crop.x * scaleX,
				crop.y * scaleY,
				crop.width * scaleX,
				crop.height * scaleY,
				0,
				0,
				crop.width * scaleX,
				crop.height * scaleY,
			)
		}

		return canvas.toDataURL('image/jpeg', 0.9)
	}

	async function onCrop() {
		try {
			if (croppedImageUrl) {
				// Convert data URL to blob for form submission
				const response = await fetch(croppedImageUrl)
				const blob = await response.blob()
				onCropComplete(blob)
				setDialogOpen(false)
			}
		} catch (error) {
			console.error('Error cropping image:', error)
		}
	}

	function onCancel() {
		setCroppedImageUrl('')
		setImagePreviewUrl('')
		setDialogOpen(false)
	}

	return (
		<ImageCropperProvider>
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogTrigger render={children} className={className}></DialogTrigger>
				<DialogContent className="max-w-2xl gap-0 p-0">
					<div className="size-full p-6">
						{imagePreviewUrl && (
							<ReactCrop
								crop={crop}
								onChange={(_, percentCrop) => setCrop(percentCrop)}
								onComplete={(c) => onCropCompleteHandler(c)}
								aspect={aspect}
								className="w-full"
							>
								<img
									ref={imgRef}
									className="max-h-96 w-full object-contain"
									alt="Image to crop"
									src={imagePreviewUrl}
									onLoad={onImageLoad}
								/>
							</ReactCrop>
						)}
					</div>
					<ImageCropperFooter
						onCancel={onCancel}
						onCrop={onCrop}
						disabled={!croppedImageUrl}
					/>
				</DialogContent>
			</Dialog>
		</ImageCropperProvider>
	)
}

function ImageCropperFooter({
	onCancel,
	onCrop,
	disabled,
}: {
	onCancel: () => void
	onCrop: () => void
	disabled: boolean
}) {
	return (
		<DialogFooter className="justify-center p-6 pt-0">
			<DialogClose
				render={
					<Button
						size="sm"
						type="button"
						className="w-fit"
						variant="outline"
						onClick={onCancel}
					>
						<Icon name="trash-2" className="size-4" />
						Cancel
					</Button>
				}
			></DialogClose>
			<Button
				type="button"
				size="sm"
				className="w-fit"
				onClick={onCrop}
				disabled={disabled}
			>
				<Icon name="pencil" className="size-4" />
				Apply Crop
			</Button>
		</DialogFooter>
	)
}

// Helper function to center the crop
export function centerAspectCrop(
	mediaWidth: number,
	mediaHeight: number,
	aspect: number,
): Crop {
	return centerCrop(
		makeAspectCrop(
			{
				unit: '%',
				width: 80,
				height: 80,
			},
			aspect,
			mediaWidth,
			mediaHeight,
		),
		mediaWidth,
		mediaHeight,
	)
}

export { ImageCropperProvider }
