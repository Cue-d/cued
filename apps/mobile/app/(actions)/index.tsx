import { ScrollView, Text } from "@/tw";

export default function ActionsScreen() {
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="p-4"
    >
      <Text className="text-sf-label text-lg">Actions will appear here</Text>
    </ScrollView>
  );
}
