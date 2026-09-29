// test/schema-coverage.ts —— 卡片字段覆盖门禁（多包共用，复制式分发，同 client-freshness.ts）。
//
// 背景：host.ts 用 `Schema.object({...})` 声明 N 个设置字段，
// client 卡片只渲染 M 个（M < N）→ 那 N-M 个字段用户无法从 UI 触及，只能改 settings 底层或
// 读源码。本轮踩坑：quality-gate 的 `memoryFeedback`（功能性开关——host.ts 的
// `if (isCodeFailure && cfg.memoryFeedback)` 决定是否把门禁失败写入记忆库，且有专门测试）在卡片
// 漏项，两轮审查后才被发现。
//
// 做法：解析 host.ts 的 Schema.object 字段名 + client 源码树（src/** + lib/**）实际绑定的
// 字段名，断言后者 ⊇ 前者。漏项必须显式列入 allowUnbound 并给理由——测试同时校验
// allowUnbound 里的每一项确实未被绑定（防止"挂名豁免"绕过门禁）。
//
// 用法（各包 test/build-client.test.ts 的用例里断言一次；helper 交回**问题清单**，
// 空数组即通过 —— 同 client-freshness.ts 的理由）：
//   assert.deepEqual(schemaCoverageProblems(import.meta.url), []);
//   assert.deepEqual(schemaCoverageProblems(import.meta.url, {
//     allowUnbound: [{ field: 'x', reason: '仅 CLI 侧使用，UI 无入口' }],
//   }), []);
//
// 注意：绑定识别是"出现即算绑定"的宽松启发式（见 isBoundField），假阳性只会让门禁
// 更宽松（不会假绿漏拦功能性缺失）；假阴性会立刻报错，故宁可宽不可严。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AllowUnbound {
  field: string;
  reason: string;
}

/** 从 host.ts 抽取 `Schema.object({...})` 块内的字段名。 */
function hostSchemaFields(hostTs: string): string[] {
  const marker = "Schema.object(";
  const start = hostTs.indexOf(marker);
  if (start === -1) {
    return [];
  }
  // 从 Schema.object( 的左括号起做深度匹配，取到对应右括号
  const open = hostTs.indexOf("(", start);
  if (open === -1) {
    return [];
  }
  let depth = 0;
  let end = -1;
  for (let i = open; i < hostTs.length; i += 1) {
    const char = hostTs[i] ?? "";
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    return [];
  }
  const block = hostTs.slice(open + 1, end);
  return [...block.matchAll(/^(?<indent>\s{2,})(?<field>[A-Za-z_$][\w$]*):\s*Schema\./gmu)].map(
    (match) => match.groups?.["field"] ?? "",
  );
}

/** 捕获组取值（严格模式下 matchAll 捕获为 `string | undefined`，这里收口为 string）。 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

/** 扫描一个 client 源文件，收集作为「设置写入第一参」出现的字段名字面量。 */
function boundFieldsIn(src: string): Set<string> {
  const out = new Set<string>();
  // 输入行组件的 field prop：field: 'x'
  for (const match of src.matchAll(/\bfield\s*:\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu)) {
    out.add(group(match, 1));
  }
  // 各种写入惯用法：props.set('x' / set('x' / unset('x' / fireAndForget('x' / writeSet('x'
  //   刻意不要求限定 receiver——各包惯用法不同（props.set / fireAndForget / writer.set），
  //   收得太紧会假阴性。字段名是否算"绑定"由 declareSchemaCoverage 与 host 字段名交集判定。
  for (const match of src.matchAll(
    /\b(?:set|unset|fireAndForget|writeSet|commit)\s*\(\s*["'](?<name>[A-Za-z_$][\w$]*)["']/gu,
  )) {
    out.add(group(match, 1));
  }
  return out;
}

/** 递归收集目录下所有 .ts 源文件文本（跳过 node_modules）。 */
function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    if (entry !== "node_modules" && entry !== "test") {
      const filePath = path.join(dir, entry);
      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        out.push(...walk(filePath));
      } else if (entry.endsWith(".ts")) {
        out.push(readFileSync(filePath, "utf8"));
      }
    }
  }
  return out;
}

/** client 侧实际绑定的字段名集合（src/** + lib/** + client-entry 同级单文件）。 */
function clientBoundFields(pkgDir: string): Set<string> {
  const out = new Set<string>();
  for (const src of [...walk(path.join(pkgDir, "src")), ...walk(path.join(pkgDir, "lib"))]) {
    for (const field of boundFieldsIn(src)) {
      out.add(field);
    }
  }
  return out;
}

/**
 * 「卡片字段覆盖 host schema」门禁的问题清单（空数组即通过）。
 *
 * 交回清单而不是自己登记用例：登记只能发生在用例文件的 describe/用例体内，
 * 且断言得写在那个体内才看得见（vitest require-hook + expect-expect）。
 * 调用点写法见本文件头。
 */
export function schemaCoverageProblems(
  testFileUrl: string,
  opts: { allowUnbound?: AllowUnbound[] } = {},
): string[] {
  const testDir = path.dirname(fileURLToPath(testFileUrl));
  const pkgDir = path.resolve(testDir, "..");
  const pkgName =
    /"name":\s*"(?<name>[^"]+)"/u.exec(readFileSync(path.resolve(pkgDir, "package.json"), "utf8"))
      ?.groups?.["name"] ?? "unknown";
  const hostTs = readFileSync(path.resolve(pkgDir, "host.ts"), "utf8");
  const hostFields = hostSchemaFields(hostTs);
  const bound = clientBoundFields(pkgDir);
  const exemptions = new Map((opts.allowUnbound ?? []).map((item) => [item.field, item.reason]));
  const problems: string[] = [];

  if (hostFields.length === 0) {
    problems.push("host.ts 未找到 Schema.object 字段（解析失败或该包无设置）");
  }
  const missing = hostFields.filter((field) => !bound.has(field));
  const unexempted = missing.filter((field) => !exemptions.has(field));
  if (unexempted.length > 0) {
    problems.push(
      `[${pkgName}] 以下 host 设置字段卡片未暴露：${unexempted.join(", ")}\n` +
        `host 字段全集：${hostFields.join(", ")}\n` +
        `卡片已绑定：${[...bound].join(", ")}\n` +
        `→ 补卡片控件；若确实不该有 UI 入口，在 schemaCoverageProblems 的 allowUnbound 里\n` +
        `  显式声明 { field, reason }（测试会校验被豁免项确实未绑定，防止挂名豁免）。`,
    );
  }
  // 反向校验：豁免项若其实已绑定，说明豁免过时——删除即可，留着会让门禁失效。
  const stale = [...exemptions].filter(([field]) => bound.has(field));
  if (stale.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 已过时——这些字段其实已绑定，请删除豁免声明：${stale.map(([field, reason]) => `${field}（${reason}）`).join(", ")}`,
    );
  }
  // 豁免必须有理由，否则等于无门禁。
  const noReason = [...exemptions].filter(
    ([, reason]) => typeof reason !== "string" || reason.trim().length === 0,
  );
  if (noReason.length > 0) {
    problems.push(
      `[${pkgName}] allowUnbound 项缺少 reason：${noReason.map(([field]) => field).join(", ")}`,
    );
  }
  return problems;
}
