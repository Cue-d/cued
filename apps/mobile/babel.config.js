/** @type {import("@babel/core").ConfigFunction} */
module.exports = (api) => {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      [
        "module-resolver",
        {
          root: ["."],
          alias: {
            "@/widgets": "./widgets",
            "@": "./src",
          },
        },
      ],
      // "react-native-reanimated/plugin",
    ],
  };
};
