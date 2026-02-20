import { useEffect, useState } from "react";
import {
  View,
  Text,
  type ViewStyle,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { Image } from "expo-image";

interface ContactAvatarProps {
  initials: string;
  avatarUrl?: string | null;
  size: number;
  className?: string;
  containerStyle?: StyleProp<ViewStyle>;
  fallbackTextClassName?: string;
  fallbackTextStyle?: StyleProp<TextStyle>;
  transition?: number;
}

export function ContactAvatar({
  initials,
  avatarUrl,
  size,
  className = "bg-muted items-center justify-center",
  containerStyle,
  fallbackTextClassName = "text-muted-foreground font-semibold",
  fallbackTextStyle,
  transition = 120,
}: ContactAvatarProps): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  const radius = size / 2;

  return (
    <View
      className={className}
      style={[
        { width: size, height: size, borderRadius: radius },
        containerStyle,
      ]}
    >
      {avatarUrl && !imageFailed ? (
        <Image
          source={{ uri: avatarUrl }}
          style={{ width: size, height: size, borderRadius: radius }}
          contentFit="cover"
          cachePolicy="memory-disk"
          transition={transition}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <Text className={fallbackTextClassName} style={fallbackTextStyle}>
          {initials}
        </Text>
      )}
    </View>
  );
}
