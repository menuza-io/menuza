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

	interface TouchableOpacityProps {
		className?: string
	}

	interface ImageProps {
		className?: string
	}

	interface TextInputProps {
		className?: string
	}

	interface SafeAreaViewProps {
		className?: string
	}

	interface FlatListProps<ignoredItemT> {
		contentContainerClassName?: string
	}

	interface SectionListProps<ignoredItemT, ignoredSectionT> {
		contentContainerClassName?: string
	}
}
