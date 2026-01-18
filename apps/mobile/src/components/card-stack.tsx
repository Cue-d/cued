/**
 * CardStack component for displaying stacked swipeable cards
 *
 * Shows up to 3 cards stacked with progressive scale/offset.
 * Only the top card is interactive.
 */

import { type ReactNode } from "react";
import { FadeIn, FadeOut, Layout } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { SwipeableCard, type SwipeDirection } from "./swipeable-card";
import { View, Text, useWindowDimensions } from "react-native";
import { AnimatedView, AnimatedText } from "@/components/animated";

// Number of visible cards in the stack
const VISIBLE_CARDS = 3;

// Scale reduction per card in stack (1 - index * SCALE_OFFSET)
const SCALE_OFFSET = 0.04;

// Vertical offset per card in stack (index * Y_OFFSET)
const Y_OFFSET = 8;

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
  // Show only top VISIBLE_CARDS
  const visibleCards = actions.slice(0, VISIBLE_CARDS);
  
  // Calculate card dimensions (3:4 aspect ratio, with padding)
  const cardWidth = Math.min(screenWidth - 32, 400); // max-w-md ~= 400px
  const cardHeight = (cardWidth * 4) / 3;

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
            tintColor="#8E8E93"
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
    <View className="flex-1 items-center justify-center px-4">
      {/* Header with count */}
      {totalCount > 0 && (
        <View className="absolute top-4 left-4 z-50">
          <AnimatedText
            className="text-lg font-semibold text-foreground"
            entering={FadeIn}
            exiting={FadeOut}
          >
            {totalCount} Left
          </AnimatedText>
        </View>
      )}

      {/* Card stack */}
      <View 
        className="relative"
        style={{ width: cardWidth, height: cardHeight }}
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
              layout={Layout.springify()}
            >
              <SwipeableCard
                onSwipe={(direction) => handleSwipe(item, direction)}
                disabled={!isTopCard}
                triggerSwipe={isTopCard ? triggerSwipe : null}
                className="w-full h-full bg-card rounded-2xl shadow-lg overflow-hidden"
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
