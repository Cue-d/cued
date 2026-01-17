import { ScrollView, Text } from "@/tw";

export default function ContactsScreen() {
  return (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="p-4"
    >
      <Text className="text-sf-label text-lg">Contacts will appear here</Text>
    </ScrollView>
  );
}
