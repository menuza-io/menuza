import 'react-native'

declare module 'react-native' {
	interface ScrollViewProps {
		contentContainerClassName?: string
	}

	interface ViewProps {
		className?: string
	}

	interface TextProps {
		className?: string
	}

	interface PressableProps {
		className?: string
	}

	interface ImageProps {
		className?: string
	}

	interface TextInputProps {
		className?: string
		placeholderTextColorClassName?: string
	}

	interface FlatListProps<ignoredItemT> {
		contentContainerClassName?: string
	}

	interface SectionListProps<ignoredItemT, ignoredSectionT> {
		contentContainerClassName?: string
	}

	interface ActivityIndicatorProps {
		colorClassName?: string
	}

	interface SwitchProps {
		className?: string
	}
}
