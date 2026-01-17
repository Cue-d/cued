import { StatusBar } from "expo-status-bar";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import { StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";

export default function Home() {
  return (
    <View style={styles.container}>
      <Text>PRM Mobile</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});
