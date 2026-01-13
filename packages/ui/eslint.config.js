import eslintConfigNext from "eslint-config-next"

const config = [
  ...eslintConfigNext,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
]

export default config
