// test/profile-bundle.ts —— 卡片槽位 key 的漂移针（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景（这一条就是本轮查出来的真缺陷）：`plugins.bundle.config` 是**按 bundle 包名**
// keyed 的槽位，宿主派发时拿注册项的 key 与该 bundle 的包名做精确相等匹配：
//   installed dsh-client-ui-plugin-manager/lib/client.js:1821
//     renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
//   installed dsh-client-ui-renderer/lib/client.js:1154
//     host.entriesOfSlot(slotKey).find((e) => e.options.key === opts?.entryKey)
//   同插件页 :2698 的「这个 bundle 有没有配置卡」位 = ledger.bundles.has(openPkg.name)，
//   而 ledger.bundles 就是上面那批注册 key 的集合（:51 `keysOf("plugins.bundle.config")`）
//   installed dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:96-100
//     —— "keyed by the bundle's package name"，key 必填
//   首方先例 installed dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661
//     —— key 写的就是 bundle 包名
// key 写成 loader 的裸条目 id（cordis.patch.yml 的 `- id:`）时，宿主拿包名找不到这个
// 键，`configured` 也是 false → 插件页上永不出卡（本文件存在的理由）。
//
// 两个标识**各管各的**，本模块把两侧真源都读出来，防止「一改全改」把另一边带坏：
//   - 槽位 key = bundle 包名，真源是本包自己的 package.json（宿主派发 entryKey 用的就是
//     被装 bundle 的包名，与装法无关）；profile 只在这台开发机上存在，装了才顺手钉一道
//     「清单里确有这一条」的机器侧漂移针；
//   - configForms.get(entryId) 的入参（= 0.1.7 隐式 settings 命名空间）= 裸条目 id，
//     真源本包 cordis.patch.yml（installed dsh-client-ui-settings/lib/client.js:1309-1315
//     把 entryId 原样当命名空间用）。
// 所以这里**不写任何包名/条目 id 字面量**：测试里抄一份常量，正是本缺陷当初漏网的原因。

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本包根目录：helper 与 client-freshness.ts 同放 test/，据此定位包内文件。 */
const PKG_DIR = path.resolve(import.meta.dirname, "..");

/** unknown → Record 的窄化判据。刻意手抄：test/ 不引运行时依赖，真源见
 *  shared/lib/record.ts（本包 client 半那份已回删，别再往这里加判据）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 读一份 JSON 文件并投影为 Record（形状不对即抛，不静默兜成空对象）。 */
function readJson(file: string): Record<string, unknown> {
  assert.ok(existsSync(file), `读不到 ${file}`);
  const text = readFileSync(file, "utf8");
  const parsed: unknown = JSON.parse(text);
  assert.ok(isRecord(parsed), `${file} 的顶层不是 JSON 对象`);
  return parsed;
}

/** profile 清单路径：`~/.dsh/profiles/web/package.json`（DSH_PROFILE_PACKAGE_JSON 可改指）。 */
function profileManifestPath(): string {
  const override = process.env["DSH_PROFILE_PACKAGE_JSON"] ?? "";
  return override === ""
    ? path.join(os.homedir(), ".dsh", "profiles", "web", "package.json")
    : override;
}

/** profile 的 `dsh.profile.bundles` 清单；没装 profile 的环境（CI、消费者克隆）回 null。 */
function profileBundleListOrNull(): string[] | null {
  const file = profileManifestPath();
  if (!existsSync(file)) {
    return null;
  }
  const dshSection = readJson(file)["dsh"];
  const profileSection = isRecord(dshSection) ? dshSection["profile"] : {};
  const listed = isRecord(profileSection) ? profileSection["bundles"] : [];
  assert.ok(Array.isArray(listed), `${file} 的 dsh.profile.bundles 不是数组`);
  const items: unknown[] = listed;
  return items.filter((item): item is string => typeof item === "string");
}

/**
 * 本包在 profile 里那条 bundle 的包名 —— `plugins.bundle.config` 的 key 必须是它。
 * 取的是本包自己的 `package.json.name`：宿主派发的 `entryKey` 就是**被装的那个 bundle**
 * 的包名，所以对任何装法（registry / link / 本机 profile）它都是那个值。
 * profile 只存在在这台开发机上，装了才加一道机器侧针（清单里确有这一条）。
 */
export function profileBundleName(): string {
  const own = readJson(path.join(PKG_DIR, "package.json"))["name"];
  assert.equal(typeof own, "string", "本包 package.json 没有 name");
  const name = typeof own === "string" ? own : "";
  const listed = profileBundleListOrNull();
  if (listed !== null) {
    assert.ok(
      listed.includes(name),
      `${name} 不在 profile 的 dsh.profile.bundles 里：没有 bundle 行就没有配置卡`,
    );
  }
  return name;
}

/**
 * cordis.patch.yml 里的裸条目 id —— 0.1.7 的隐式 settings 命名空间与
 * `configForms.get(entryId)` 的入参都取它，与 bundle 包名是两回事。
 */
export function patchEntryId(): string {
  const yml = readFileSync(path.join(PKG_DIR, "cordis.patch.yml"), "utf8");
  const line = yml.split("\n").find((item) => /^\s*-\s+id:\s*\S+\s*$/u.test(item)) ?? "";
  const id = line.replace(/^\s*-\s+id:\s*/u, "").trim();
  assert.notEqual(id, "", "cordis.patch.yml 里没有裸 `- id:` 条目");
  return id;
}

/** 产物里 `const <name> = "<字面量>"` 的值；取不到即抛（漂移针不许静默放过）。 */
function constLiteral(text: string, name: string): string {
  const pattern = new RegExp(`const ${name} = "(?<value>[^"]*)"`, "u");
  const value = pattern.exec(text)?.groups?.["value"] ?? "";
  assert.notEqual(value, "", `产物里找不到 const ${name} = "…" 的字面量声明`);
  return value;
}

/** 取产物里 `plugins.bundle.config` 那次 register 的 key（字面量或常量标识符都解析）。 */
function registeredSlotKey(text: string): string {
  const marker = text.indexOf('name: "plugins.bundle.config"');
  assert.notEqual(marker, -1, "产物里没有 plugins.bundle.config 的注册");
  // 只看注册点之后的一小段：产物里别处也有 `key:`（React list key），不能全局抓。
  const nearby = text.slice(marker, marker + 500);
  const groups =
    /key:\s*(?:"(?<literal>[^"]*)"|(?<ident>[A-Za-z_$][A-Za-z0-9_$]*))/u.exec(nearby)?.groups ?? {};
  const literal = groups["literal"] ?? "";
  if (literal !== "") {
    return literal;
  }
  const ident = groups["ident"] ?? "";
  assert.notEqual(ident, "", "产物里读不到 slot 注册 desc 的 key（既不是字面量也不是标识符）");
  return constLiteral(text, ident);
}

/** 取产物里 `ctx.configForms.get(<入参>)` 实际用到的条目 id（同样兼容字面量/常量）。 */
function configFormsEntryId(text: string): string {
  const arg = /configForms\.get\((?<arg>[^)]*)\)/u.exec(text)?.groups?.["arg"] ?? "";
  assert.notEqual(arg, "", "产物里没有 ctx.configForms.get(…) 调用");
  const inline = /^"(?<value>[^"]*)"$/u.exec(arg)?.groups?.["value"] ?? "";
  if (inline !== "") {
    return inline;
  }
  return constLiteral(text, arg);
}

/**
 * 漂移针：当期构建（buildClient()，纯函数）的 client 产物里
 *   1. `plugins.bundle.config` 的 key === profile `dsh.profile.bundles` 中本包那条包名；
 *   2. `configForms.get()` 的入参 === cordis.patch.yml 的裸条目 id
 *      （**没有**被顺手一起改成包名 —— 那会把 client 半的写入面再次弄坏）；
 *   3. 两个标识不同值（相等就说明本包恰好条目 id == 包名，那这一层的混用钉不住，直接红）。
 * 用法（test/build-client.test.ts 的用例里断言一次）：
 *   assert.deepEqual(await bundleSlotPinProblems(), []);
 * helper 交回**问题清单**而不是自己登记用例：登记只能发生在用例文件的 describe/用例体内，
 * 且断言得写在那个体内才看得见（vitest require-hook + expect-expect，同 client-freshness.ts）。
 * 产物结构本身读不出来时仍直接抛（漂移针不许静默放过）。
 */
export async function bundleSlotPinProblems(): Promise<string[]> {
  const { buildClient } = (await import(path.join(PKG_DIR, "build-client.mjs"))) as {
    buildClient: () => Promise<string>;
  };
  const out = await buildClient();
  const bundle = profileBundleName();
  const entryId = patchEntryId();
  const problems: string[] = [];
  if (bundle === entryId) {
    problems.push(
      "bundle 包名与裸条目 id 相同 → 这两个标识无从区分，漂移针失效，需人工确认宿主派发键",
    );
  }
  const slotKey = registeredSlotKey(out);
  if (slotKey !== bundle) {
    problems.push(
      `plugins.bundle.config 的 key 必须是 bundle 包名 ${bundle}（宿主按包名派发），写成裸条目 id ${entryId} 就是永不出卡`,
    );
  }
  const configFormsArg = configFormsEntryId(out);
  if (configFormsArg !== entryId) {
    problems.push(
      `configForms.get() 的入参必须仍是裸条目 id ${entryId}（0.1.7 里它就是 settings 命名空间），不得顺手换成 bundle 包名`,
    );
  }
  return problems;
}
