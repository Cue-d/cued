/**
 * CardStack component for displaying stacked swipeable cards
 *
 * Shows up to 3 cards stacked with progressive scale/offset.
 * Only the top card is interactive.
 */

import { type ReactNode } from "react";
import { View, Text, useWindowDimensions, useColorScheme } from "react-native";
import { SymbolView } from "expo-symbols";
import { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { AnimatedView } from "@/components/animated";
import { getThemeColors } from "@/lib/utils";
import { SwipeableCard, type SwipeDirection } from "./swipeable-card";

// Number of visible cards in the stack (top card + 1 behind)
const VISIBLE_CARDS = 2;

// Scale reduction per card in stack (1 - index * SCALE_OFFSET)
const SCALE_OFFSET = 0.075;

// Vertical offset per card in stack (index * Y_OFFSET)
const Y_OFFSET = 18;

export interface CardStackItem {
  id: string;
}

export interface CardStackProps<T extends CardStackItem> {
  /** Array of action items to display */
  actions: T[];
  /** Total count of actions (may be more than visible) */
  totalCount: number;
  /** Callback when user swipes a card */
  onSwipe: (item: T, direction: SwipeDirection) => void;
  /** Render function for card content */
  renderCard: (item: T, index: number) => ReactNode;
  /** Optional trigger to programmatically swipe the top card */
  triggerSwipe?: SwipeDirection | null;
}

export function CardStack<T extends CardStackItem>({
  actions,
  totalCount,
  onSwipe,
  renderCard,
  triggerSwipe,
}: CardStackProps<T>): React.JSX.Element {
  const { width: screenWidth } = useWindowDimensions();
  const colorScheme = useColorScheme();
  const colors = getThemeColors(colorScheme === "dark");
  // Show only top VISIBLE_CARDS
  const visibleCards = actions.slice(0, VISIBLE_CARDS);

  const cardWidth = Math.min(screenWidth - 32, 400);

  const handleSwipe = (item: T, direction: SwipeDirection): void => {
    onSwipe(item, direction);
  };

  // Empty state when no actions
  if (actions.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-4">
        <AnimatedView
          entering={FadeIn.duration(300)}
          className="items-center"
        >
          <SymbolView
            name="party.popper"
            size={64}
            tintColor={colors.mutedForeground}
          />
          <Text className="text-2xl font-bold text-foreground mt-4">
            All caught up!
          </Text>
          <Text className="text-base text-muted-foreground mt-2 text-center">
            New actions will appear here
          </Text>
        </AnimatedView>
      </View>
    );
  }

  return (
    <View className="flex-1 items-center px-4 pb-3">
      <View
        className="relative flex-1"
        style={{ width: cardWidth }}
      >
        {visibleCards.map((item, index) => {
          const isTopCard = index === 0;
          const scale = 1 - index * SCALE_OFFSET;
          const translateY = index * Y_OFFSET;
          const zIndex = VISIBLE_CARDS - index;

          return (
            <AnimatedView
              key={item.id}
              className="absolute inset-0"
              style={{
                zIndex,
                transform: [{ scale }, { translateY }],
              }}
              entering={FadeIn.duration(200)}
              exiting={FadeOut.duration(200)}
              layout={LinearTransition.springify()}
            >
              <SwipeableCard
                onSwipe={(direction) => handleSwipe(item, direction)}
                disabled={!isTopCard}
                triggerSwipe={isTopCard ? triggerSwipe : null}
                className="w-full h-full"
              >
                {renderCard(item, index)}
              </SwipeableCard>
            </AnimatedView>
          );
        })}
      </View>
    </View>
  );
}
