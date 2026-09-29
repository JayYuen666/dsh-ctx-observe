import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { clientFreshnessProblems } from "./client-freshness.ts";
import { bundleSlotPinProblems } from "./profile-bundle.ts";
import { schemaCoverageProblems } from "./schema-coverage.ts";

/** 产物相对本测试文件的位置（build-client.mjs 的输出落在包根）。 */
const CLIENT_BUNDLE_REL_PATH = "../client.js";

describe("ctx-observe 产物门禁（helper 交回问题清单，断言写在这里）", () => {
  it("client.js 与最新构建逐字节一致（改 src 后必须 node build-client.mjs）", async () => {
    assert.deepEqual(await clientFreshnessProblems(import.meta.url), []);
  });

  it("卡片覆盖 host schema 全部字段（改 host 字段必须同步卡片或声明豁免）", () => {
    assert.deepEqual(
      schemaCoverageProblems(import.meta.url, {
        allowUnbound: [
          {
            field: "fallbackWindow",
            reason:
              "非 volatile 部署假定值（cordis.yml config: 改，无卡位）；设置卡只承载用户可调的提醒节奏三旋钮",
          },
        ],
      }),
      [],
    );
  });

  it("漂移针：槽位 key = profile 的 bundle 包名，configForms 入参 = patch 裸条目 id", async () => {
    assert.deepEqual(await bundleSlotPinProblems(), []);
  });
});

describe("ctx-observe client 构建", () => {
  it("client.js 已产出且含卡片文案", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL_PATH, import.meta.url));
    assert.ok(existsSync(clientPath));
    const text = readFileSync(clientPath, "utf8");
    assert.ok(text.includes("ctx-observe"));
    assert.ok(text.includes("上下文观测"));
  });

  it("卡片 props 契约正确：读 useCard，不读会崩的 props.hooks（v7 修复）", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL_PATH, import.meta.url));
    const text = readFileSync(clientPath, "utf8");
    // 框架 InjectFace/PropsHooks（client-runner）：注入 { hooks: { card } } → prop useCard
    assert.ok(text.includes("useCard"), "必须用 useCard 读快照");
    assert.ok(!text.includes("props.hooks.card"), "不得读 props.hooks.card（浏览器崩溃根因）");
  });

  it("client.js 暴露全部 host schema 配置字段（v7 配置面完整）", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL_PATH, import.meta.url));
    const text = readFileSync(clientPath, "utf8");
    // host schema 字段（节选，断言只钉这四个）：metricsEnabled / contextThresholdTokens / contextRatio / remindRatio
    assert.ok(text.includes("metricsEnabled"), "metrics 开关");
    assert.ok(text.includes("contextThresholdTokens"), "显式阈值输入");
    assert.ok(text.includes("contextRatio"), "70% 比例输入");
    assert.ok(text.includes("remindRatio"), "重复间隔输入");
  });

  it("入口 inject 清单只列 0.1.7 仍在的服务（configForms 取代已移除的 settingsScope）", () => {
    const clientPath = fileURLToPath(new URL(CLIENT_BUNDLE_REL_PATH, import.meta.url));
    const text = readFileSync(clientPath, "utf8");
    // inject 清单就是装配契约：多一项（0.1.6 的 settingsScope 在 installed 0.1.7 全树
    // 零命中）或少一项都会让整条 client 入口挂不上。configForms 是它的替代面（installed
    // dsh-client-ui-settings/lib/types/client/config-form.d.ts:95-96 的 Context 增强
    // + :142 的 get(entryId)，首方先例 dsh-client-ui-settings-web-search/lib/client.js:288,300）。
    const raw = /const inject = \[(?<items>[^\]]*)\];/u.exec(text)?.groups?.["items"] ?? "";
    assert.ok(raw.length > 0, "产物里找不到入口 inject 清单");
    const items = raw
      .split(",")
      .map((piece) => piece.trim().replaceAll(/^["']|["']$/gu, ""))
      .filter((piece) => piece.length > 0);
    // 精确全等清单，不放宽为包含判定。
    assert.deepEqual(items, ["slots", "configForms", "locale"]);
    assert.ok(!text.includes("settingsScope"), "不得再向宿主索要已移除的 settingsScope 服务");
    assert.ok(text.includes("ctx.configForms.get(NS)"), "取表单走 configForms.get(条目 id)");
  });
});
