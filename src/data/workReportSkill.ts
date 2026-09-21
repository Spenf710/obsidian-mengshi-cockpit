/**
 * 通用「工作复盘」SKILL 一键注册
 *
 * 把内置的通用工作复盘 SKILL（日志 + 周报 + 月报最小流程）写入本机技能目录，免除手动拷贝：
 *   - Claude Code → ~/.claude/skills/work-report/SKILL.md
 *   - CodeM       → ~/.agents/skills/work-report/SKILL.md（CodeM 实测技能根目录）
 *
 * 模板为脱敏通用版（不含任何个人路径/知识库结构/云文档链接），安装后用户可按自己 vault 微调。
 * 目标文件已存在时先备份为 .bak 再覆盖，不破坏用户已有内容。
 * 定位：作为「一键生成周报/月报骨架」的上层能力，AI 基于日志/周报补全报告正文。
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

/** 技能目录名（与 description 触发词强绑定；改目录名需同步改 frontmatter name） */
const SKILL_DIR_NAME = 'work-report';

/** 内置通用模板（脱敏）：不含个人路径、不含内部目录结构、不绑定任何云服务 */
export const WORK_REPORT_SKILL_TEMPLATE = `---
name: work-report
description: 通用工作复盘整理。按标准模板整理本地日志，并据此生成周报/月报（纯本地知识库操作，不依赖任何外部服务，不绑定任何个人/项目信息）。适用于任意 Obsidian 或 Markdown 库，用户说"整理日志""写周报""写月报""工作总结""复盘"时触发。
---

# 工作复盘整理 Skill（通用最小版 v1.0）

> AI 读取本文件后，应能按最小标准流程，在**任意** Obsidian/Markdown 库内完成任务。
> 纯本地操作：只创建/修改库内 \`.md\` 文件，不调用任何外部 API、不同步任何云文档、不绑定任何个人或项目信息。

---

## 〇、配置（极简，均可省略）

所有目录名遵循如下顺序取用：**用户会话内指定 > 库内配置笔记 > 下列通用默认值**。

| 用途 | 默认目录 | 说明 |
|------|----------|------|
| 日志 | \`日志\` | 按 \`YYYY年/MM月/YYYY-MM-DD.md\` 存放 |
| 周报 | \`周报\` | 按 \`YYYY年/QN 季度/\` 存放 |
| 月报 | \`月报\` | 按 \`YYYY年/YYYY-MM.md\` 存放 |
| 模板 | \`模板/工作日志.md\` | 新建日志用；缺失则用内置精简模板 |

配置笔记约定：库根存在 \`模板/work-report-config.md\` 时，以其中给出的目录名为准。
若库内已有自己的日记/周报目录（无论叫什么），**优先沿用用户库实际结构**，不强制改名。

---

## 一、核心原则

1. **纯本地** — 不读云文档、不同步远程、不给外部系统发请求
2. **不编造** — 内容全部来自库内已有的日志/文档；缺失的数据宁可留空占位，不虚构
3. **机器可解析** — 每个生成文件都要带 frontmatter（见范本），供后续程序/脚本读取
4. **尊重既有内容** — 修改已有文件时保留用户手写正文，只补格式/链接/缺失板块
5. **不写敏感信息** — 不把账户、密钥、内网地址、私人链接写入生成文档

---

## 二、日志整理（触发词：整理日志 / 补日志 / 优化日志）

### 目标文件
今日日志：\`<日志目录>/YYYY年/MM月/YYYY-MM-DD.md\`（若库用固定模板则按模板名）。

### 数据发现（3 步）
1. 扫描库内最近 24 小时新增/修改的 \`.md\` 文件（排除日志/周报/月报/模板/\`.obsidian\`/\`.git\`）。
2. 检查目标日期当天的项目/子目录是否有新建内容（新建任务/文档等）。
3. 与当前会话上下文交叉核对，确认当天做了哪些事。

### 内容模板
\`\`\`markdown
---
date: YYYY-MM-DD
type: 日志
---

# 📅 YYYY-MM-DD xx

- **状态**：🟢 正常 / 🟡 忙碌 / 🔴 超负荷
- **一句话**：核心事项 + 关键结果（≤25 字）

## ✅ 完成
- [x] 任务/事项
    - 具体动作：量化描述 + 效果
    - 产出文档：[[文档名]]
    - 关联项目：[[项目/路径|项目名]]
- [ ] 进行中事项

## ⏭ 明日待办
- [ ] 事项 1
- [ ] 事项 2
\`\`\`
规则：
- **周五/节前**："明日待办"写下一工作日，不写休息日。
- **无日志当天**：新建空模板即可，不强行填充。
- **链接**：库内已有 \`[[双链]]\` 体系则用；没有则纯文本描述即可，不强制。

---

## 三、周报整理（触发词：写周报 / 周总结）

### 目标文件
\`<周报目录>/YYYY年/QN 季度/周报（M月D日~D日）.md\`（季度按 1-3→Q1、4-6→Q2、7-9→Q3、10-12→Q4）。

### 数据来源
该日期范围（通常是自然周，周一~周日）内的全部日志文件。

### 内容模板
\`\`\`markdown
---
date: 本周最后一天 YYYY-MM-DD
period: YYYY-MM-DD~YYYY-MM-DD
type: 周报
summary: "一句话概述（主线+关键结果）"
---

# 📅 周报（M月D日~D日）

## 本周完成
### 主题/项目 一
- 具体进展 1（保留数量/率/日期）
- 具体进展 2

### 主题/项目 二
- 具体进展

## 下周计划
### 主题/项目 一
- 计划事项
\`\`\`
规则：
- **按主题/项目分组**，不按日期罗列
- 各周只归档一周的完成与计划，不追加历史
- 日志有缺失时先提示用户补日志，再生成周报

---

## 四、月报整理（触发词：写月报 / 月汇总）

### 目标文件
\`<月报目录>/YYYY年/YYYY-MM.md\`。

### 数据来源
当月全部日志 + 覆盖该月（含跨月）的周报。

### 内容模板
\`\`\`markdown
---
date: 当月最后一天 YYYY-MM-DD
period: YYYY-MM-01~YYYY-MM-DD
type: 月报
summary: "一句话概述（主线+关键结果）"
---

# 📊 YYYY年MM月

## 统计
- 记录天数：N 天
- 本月亮点：3~5 条

## 按主题/项目汇总
### 主题一
- 该月进展要点（日期 + 关键事项）

### 主题二
- 该月进展要点

## 可复用经验 / 沉淀
- 值得留档的方法、结论、踩坑（如有）
\`\`\`
规则：
- 已存在月报则先询问是否覆盖；不改动当月日志/周报
- 相对周报做**只聚合压缩**，不逐条罗列

---

## 五、质量标准（自检）

| 项 | 日志 | 周报 | 月报 |
|----|------|------|------|
| frontmatter | ✅ | ✅ | ✅ |
| 日期/周期准确 | ✅ | ✅ | ✅ |
| 数据来源真实 | 扫描所得 | 日志所得 | 日志+周报所得 |
| 分主题结构 | — | ✅ | ✅ |
| 无外部依赖 | ✅ | ✅ | ✅ |

---

## 六、说明

- 本 Skill 是**最小通用版**：不绑定具体公司/项目/工具链，可在任意知识库直接使用。
- 若你希望结合**本地 AI 助手、云文档或专属项目体系**做增强，那是团队/个人定制范畴，不属于本文件范围。
- 版本：v1.0 — 2026-09-21 — 初始通用版。
`;

export interface InstallWorkReportResult {
  ok: boolean;
  path: string;
  existed: boolean; // true = 目标文件原已存在（已备份为 .bak 后覆盖）
  error?: string;
}

/** 注册到指定 agent 的技能根目录 */
export function installWorkReportSkill(agent: 'claude' | 'codem' | 'both'): InstallWorkReportResult[] {
  const targets: string[] = [];
  if (agent === 'claude' || agent === 'both') {
    targets.push(path.join(os.homedir(), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md'));
  }
  if (agent === 'codem' || agent === 'both') {
    targets.push(path.join(os.homedir(), '.agents', 'skills', SKILL_DIR_NAME, 'SKILL.md'));
  }
  return targets.map(installOne);
}

function installOne(targetPath: string): InstallWorkReportResult {
  try {
    const existed = fs.existsSync(targetPath);
    if (existed) {
      // 备份已有内容，避免覆盖用户微调过的版本（仅备份一次，同名 .bak 覆盖）
      fs.copyFileSync(targetPath, `${targetPath}.bak`);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, WORK_REPORT_SKILL_TEMPLATE, 'utf8');
    return { ok: true, path: targetPath, existed };
  } catch (e: any) {
    return { ok: false, path: targetPath, existed: false, error: e?.message || String(e) };
  }
}

/** 探测某技能文件是否已安装 */
export function hasWorkReportSkill(agent: 'claude' | 'codem'): boolean {
  const target = agent === 'claude'
    ? path.join(os.homedir(), '.claude', 'skills', SKILL_DIR_NAME, 'SKILL.md')
    : path.join(os.homedir(), '.agents', 'skills', SKILL_DIR_NAME, 'SKILL.md');
  return fs.existsSync(target);
}