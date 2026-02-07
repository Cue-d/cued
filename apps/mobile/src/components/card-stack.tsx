/**
 * CardStack component for displaying stacked swipeable cards
 *
 * Shows up to 3 cards stacked with progressive scale/offset.
 * Only the top card is interactive.
 */

import { type ReactNode, useEffect, useRef } from "react";
import { View, Text, useWindowDimensions, useColorScheme } from "react-native";
import { SymbolView } from "expo-symbols";
import { FadeIn } from "react-native-reanimated";
import { AnimatedView } from "@/components/animated";
import { getThemeColors } from "@/lib/utils";
import { SwipeableCard, type SwipeDirection } from "./swipeable-card";

// Scale reduction per card in stack (1 - index * SCALE_OFFSET)
const SCALE_OFFSET = 0.075;
const BOTTOM_SCALE = 1 - SCALE_OFFSET;
const BOTTOM_SIZE_PERCENT = `${BOTTOM_SCALE * 100}%`;
const BOTTOM_LEFT_PERCENT = `${(SCALE_OFFSET * 100) / 2}%`;

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
  const topItem = actions[0];
  const bottomItem = actions[1];
  const prevTopIdRef = useRef<string | undefined>(topItem?.id);
  const prevBottomIdRef = useRef<string | undefined>(bottomItem?.id);
  const hasRenderedRef = useRef(false);

  const cardWidth = Math.min(screenWidth - 32, 400);

  const handleSwipe = (item: T, direction: SwipeDirection): void => {
    onSwipe(item, direction);
  };

  const shouldAnimateTopContent =
    hasRenderedRef.current && !!topItem && prevTopIdRef.current !== topItem.id;
  const shouldAnimateBottomContent =
    hasRenderedRef.current &&
    !!bottomItem &&
    prevBottomIdRef.current !== bottomItem.id;

  useEffect(() => {
    hasRenderedRef.current = true;
    prevTopIdRef.current = topItem?.id;
    prevBottomIdRef.current = bottomItem?.id;
  }, [topItem?.id, bottomItem?.id]);

  // Empty state when no actions
  if (actions.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-4">
        <AnimatedView entering={FadeIn.duration(300)} className="items-center">
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
      <View className="relative flex-1" style={{ width: cardWidth }}>
        {topItem ? (
          <View
            key="stack-slot-top"
            className="absolute inset-0"
            style={{
              zIndex: 2,
              transform: [{ scale: 1 }, { translateY: 0 }],
            }}
          >
            <AnimatedView
              key={topItem.id}
              className="w-full h-full"
              entering={
                shouldAnimateTopContent
                  ? FadeIn.duration(180).withInitialValues({
                      opacity: 0.9,
                      transform: [
                        { scale: 1 - SCALE_OFFSET },
                        { translateY: Y_OFFSET },
                      ],
                    })
                  : undefined
              }
            >
              <SwipeableCard
                onSwipe={(direction) => handleSwipe(topItem, direction)}
                disabled={false}
                triggerSwipe={triggerSwipe}
                className="w-full h-full"
              >
                {renderCard(topItem, 0)}
              </SwipeableCard>
            </AnimatedView>
          </View>
        ) : null}

        {bottomItem ? (
          <View
            key="stack-slot-bottom"
            className="absolute"
            style={{
              zIndex: 1,
              top: Y_OFFSET,
              left: BOTTOM_LEFT_PERCENT,
              width: BOTTOM_SIZE_PERCENT,
              height: BOTTOM_SIZE_PERCENT,
            }}
          >
            <AnimatedView
              key={bottomItem.id}
              className="w-full h-full"
              entering={
                shouldAnimateBottomContent
                  ? FadeIn.duration(140).withInitialValues({
                      opacity: 0,
                    })
                  : undefined
              }
            >
              <SwipeableCard
                onSwipe={(direction) => handleSwipe(bottomItem, direction)}
                disabled={true}
                triggerSwipe={null}
                className="w-full h-full"
              >
                {renderCard(bottomItem, 1)}
              </SwipeableCard>
            </AnimatedView>
          </View>
        ) : null}
      </View>
    </View>
  );
}
