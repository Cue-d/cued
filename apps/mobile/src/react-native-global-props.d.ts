declare module "react-native-global-props" {
  import type { TextStyle, TextInputProps } from "react-native";

  interface TextProps {
    style?: TextStyle;
  }

  export function setCustomText(customTextProps: TextProps): void;
  export function setCustomTextInput(customTextInputProps: TextInputProps): void;
}
