// build-host 防回归：host.js 里的跨包依赖必须是 external 裸说明符，而不是被
// rolldown 内联进产物。
//
// 为什么盯这一点：external 判据是「按包名段匹配」的函数（build-host.mjs 的
// packageNameOf + isExternal）。若退化成字符串数组精确匹配，`@jayyuen666/dsh-plugin-shared/lib/*`
// 这类子路径说明符会被漏判为内部模块并整份内联——shared 的模块级状态因此在每个
// 插件里复制一份，表现为跨插件共享静默失联（本包 host 半的值导入是
// @deepseek-ai/schemastery —— 宿主 fork 的 schemastery，0.1.7 的 volatile 字段解析
// 只有它有实现，同理必须留在产物外；@deepseek-ai/dsh-home-paths 与口径 A 起在 dependencies 的
// @deepseek-ai/dsh-brand 同为值导入，各自在下面单独钉住）。
// 另一条断言防的是残留 `from "./lib/x.ts"`：Node 在 node_modules 内对 .ts 直接抛
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING，这种产物装机当场加载失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { buildHost } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

const hostJs = await buildHost();

describe("ctx-observe host 构建", () => {
  it("host.js 与最新构建逐字节一致（改 host.ts / lib/*.ts 后必须 node build-host.mjs）", async () => {
    const { pkgName, pkgDir, onDisk, built } = await hostFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] host.js 已过期：host.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-host.mjs`,
    );
  });

  it("host.js 保留宿主 fork schemastery 的裸说明符（external 未被内联）", () => {
    assert.ok(
      hostJs.includes('from "@deepseek-ai/schemastery"'),
      "@deepseek-ai/schemastery 必须以裸说明符形式留在产物里",
    );
    // 反向锁：不得退回公共 schemastery——它没有 .volatile()，解析出的 volatile 字段
    // 仍是普通值，设置卡写进去的值永远读不到（0.1.7 迁移的根因）。
    assert.ok(
      !/from\s+["']schemastery["']/u.test(hostJs),
      "host.js 不得再值导入公共 schemastery（0.1.7 volatile 解析只在宿主 fork 里）",
    );
  });

  it("host.js 保留 @deepseek-ai/dsh-brand 裸说明符（口径 A：值导入落 dependencies）", () => {
    // 本轮之前它在 devDependencies，于是 external 判据不认它、rolldown 把 brandString
    // 内联进产物（官方 branded-string 构造器复制一份进插件）。口径 A 裁定后必须反过来：
    // 说明符在产物里 = 依赖声明也一定在（两者由同一张表推导）。
    assert.ok(
      hostJs.includes('from "@deepseek-ai/dsh-brand"'),
      "dsh-brand 必须以裸说明符形式留在产物里（出现函数体定义即说明又落回了 dev）",
    );
    assert.ok(!/^function brandString\(/mu.test(hostJs), "host.js 不得再内联 brandString 的函数体");
  });

  it("host.js 保留 shared 各子路径的裸说明符（SP-D 起含 lib/record）", () => {
    // 逐个列名而不是只查包名前缀：前缀断言会被任意一条 shared 子路径满足，看不见
    // 某一条被内联（同 zvec-grep/ocr-review 那两份注释记的 SP-A 终审 Minor）。
    // 名单 = 本包 host 半**真的**值导入的那几条（实测产物里只有 locale 与 record）。
    for (const subpath of ["lib/locale", "lib/record", "lib/jsonl"]) {
      assert.ok(
        hostJs.includes(`from "@jayyuen666/dsh-plugin-shared/${subpath}"`),
        `shared/${subpath} 必须外部化（内联会把 shared 的模块级状态复制进本包产物）`,
      );
    }
  });

  it("host.js 保留 @deepseek-ai/dsh-home-paths 裸说明符（路径解析必须同源）", () => {
    // 这条比 schemastery 更要紧：home-paths 是**值导入**（dshHomePath 真的被调用），
    // 一旦从 package.json 的 dependencies 里漏掉，external 判据就不认它，rolldown 会
    // 把整份实现内联进 host.js——装机后本包与宿主各持一份 home 解析逻辑，DSH_HOME
    // 改了口径就分叉。裸说明符在产物里 = 依赖声明也一定在（两者由同一张表推导）。
    assert.ok(
      hostJs.includes('from "@deepseek-ai/dsh-home-paths"'),
      "home-paths 必须以裸说明符形式留在产物里（并据此确认它已进 dependencies）",
    );
  });

  it("host.js 不含指向 .ts 源码的残留说明符", () => {
    assert.ok(!/from\s+["']\.\/[^"']*\.ts["']/u.test(hostJs), "不得残留 ./lib/*.ts 说明符");
  });
});

describe("闸门的外部化面（shared/lib/trust）", () => {
  it("lib/trust 子路径保持裸说明符，且 guardTrust 的实现未被内联", async () => {
    // 这些包原先只钉了 http/project-key/record/jsonl 几枚子路径，`lib/trust` 是新增的第四个坑位：
    // external 的字符串项是精确匹配，子路径一旦漏掉就把整份判据复制进本包产物（判据分叉的起点）。
    const out = await buildHost();
    assert.ok(
      out.includes('from "@jayyuen666/dsh-plugin-shared/lib/trust"'),
      "shared/trust 必须外部化",
    );
    assert.ok(!/^function guardTrust\(/mu.test(out), "产物不得内联 guardTrust 的函数体");
  });
});
