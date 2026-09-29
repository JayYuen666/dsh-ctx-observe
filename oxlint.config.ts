import { definePluginConfig } from "@jayyuen666/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包真实用到的同步写盘 API —— node/no-sync 的包内例外。
  // 基线只放只读那一组（D13：写盘类谁用谁声明），所以这一条是可独立 review 的声明而不是全局豁免表。
  syncWrites: ["appendFileSync", "mkdirSync", "mkdtempSync", "rmSync", "writeFileSync"],
  titlePrefixes: ["Config", "DSH_HOME", "HOME", "UsageWatch"],
});
