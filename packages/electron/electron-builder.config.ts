import type { Configuration } from "electron-builder"

const config: Configuration = {
  appId: "com.hankun.opencodex",
  productName: "OpenCodex",
  directories: {
    output: "release",
  },
  publish: {
    provider: "github",
    owner: "ihankun",
    repo: "opencodex",
  },
  files: ["out/**/*", "assets/**/*", "package.json"],
  extraResources: [
    {
      from: ".server",
      to: "server",
    },
    {
      from: "../sandbox-runtime",
      to: "sandbox-runtime",
      filter: ["LICENSE", "UPSTREAM.md", "vendor/seccomp/**/*", "vendor/srt-win/**/*"],
    },
    {
      from: ".models-cache/api.json",
      to: "models/api.json",
    },
  ],
  protocols: {
    name: "OpenCodex",
    schemes: ["opencodex"],
  },
  asarUnpack: ["out/main/chunks/*.wasm", "node_modules/@lydell/node-pty-*/**/*"],
  mac: {
    icon: "assets/icon.icns",
    target: ["dmg", "zip"],
    artifactName: "${productName}-${version}-${arch}.${ext}",
    category: "public.app-category.developer-tools",
    identity: process.env.CSC_IDENTITY ?? "-",
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    extendInfo: {
      NSMicrophoneUsageDescription: "OpenCodex uses the microphone to convert your speech into text.",
      NSSpeechRecognitionUsageDescription: "OpenCodex uses speech recognition to transcribe voice input.",
    },
  },
  win: {
    icon: "assets/icon.ico",
    target: ["nsis", "portable"],
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  nsis: {
    artifactName: "${productName}-Setup-${version}.${ext}",
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // 安装时自动装 srt-win 沙箱的钩子，暂注释：srt-win 在部分环境（火绒等）会被拦截导致安装卡死
    // include: "build/nsis-sandbox.nsh",
  },
  linux: {
    icon: "assets/opencode-icon.png",
    target: ["AppImage", "deb", "rpm"],
    category: "Development",
  },
}

export default config
