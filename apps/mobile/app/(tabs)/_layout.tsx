import {
  NativeTabs,
  NativeTabTrigger,
  Icon,
  Label,
  Badge,
} from "expo-router/unstable-native-tabs";
import { usePendingActionCount } from "@/hooks/usePendingActionCount";

export default function TabsLayout() {
  const count = usePendingActionCount();

  return (
    <NativeTabs minimizeBehavior="onScrollDown">
      <NativeTabTrigger name="(actions)">
        <Icon sf={{ default: "tray", selected: "tray.fill" }} />
        <Label>Actions</Label>
        <Badge hidden={count === 0}>{count > 0 ? String(count) : undefined}</Badge>
      </NativeTabTrigger>

      <NativeTabTrigger name="(contacts)">
        <Icon sf={{ default: "person.2", selected: "person.2.fill" }} />
        <Label>Contacts</Label>
      </NativeTabTrigger>

      <NativeTabTrigger name="(agent)">
        <Icon sf={{ default: "sparkles", selected: "sparkles" }} />
        <Label>Agent</Label>
      </NativeTabTrigger>

      <NativeTabTrigger name="(search)" role="search">
        <Label>Search</Label>
      </NativeTabTrigger>
    </NativeTabs>
  );
}
