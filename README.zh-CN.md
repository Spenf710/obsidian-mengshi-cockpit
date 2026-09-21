# 猛士驾驶舱（Mengshi Cockpit）

> 一款 Obsidian 一体化工作台插件，把 **日历、项目、待办、甘特排期、飞书 (Lark)、Claude Code 会话** 集成到同一个交互面板。

[![Obsidian 插件](https://img.shields.io/badge/Obsidian-%20Plugin-7C3AED)](https://obsidian.md)
[![GitHub release](https://img.shields.io/github/v/release/Spenf710/obsidian-mengshi-cockpit.svg)](https://github.com/Spenf710/obsidian-mengshi-cockpit/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 英文文档：[README.md](README.md)

---

## 功能一览

| Tab | 名称 | 功能 | 亮点 |
|------|------|------|------|
| 📅 | 日历 | **两个视图**：日新（月粒度日网格+摘要+状态）与 月异（季度月卡+选中月周卡，周卡显示周报项目标签+忙度三色灯；月卡可进入对应月日新视图） | 空白格一键建日记、状态内嵌编辑、周报/月报**一键生成骨架**（从日志提取草稿） |
| 📂 | 项目 | 自动扫描项目文件夹、二维分类、卡片视图 | 自动发现新项目、标签/类别可编辑、链接可维护 |
| ✅ | 待办 | 聚合多来源 `- [ ]` 任务、勾选回写源文件 | 按项目归组、折叠已完成、智能跳过模板噪音 |
| 📊 | 排期 | 甘特时间线、拖拽排期、多阶段、里程碑 | 今日线、阶段条、README 双向同步 |
| 📡 | 飞书 | 飞书 Wiki / 云盘浏览、项目归类、链接检查、智能纪要 | 深度扫描、自动归类、访问统计、文件移动 |
| 💬 | 会话 | Claude Code **和 CodeM** 会话可视化、按项目归类、存档与收割状态 | 轮次详情、会话存档（清理范围外）、一键续接、已收割标记 |

> 🖊 **快捷录入**：底部 FAB 提供「日记 / 待办 / 新建项目」快捷录入，非独立面板。

---

## 报告生成与技能

- **一键生成周报 / 月报骨架**（日历 → 月异视图）：支持「📝 从日志提取草稿」（自动按项目聚合标签 + 每日一句话 + 状态统计，回填 `ai_summary`）或「🧱 空骨架（手填）」。
- **内置技能一键安装**（设置 → 会话 → Claude Code / CodeM）：
  - `session-harvest` — 把会话讨论总结归档为知识库笔记
  - `work-report` — 整理本地日志 → 生成周报 / 月报（纯本地，不绑定任何个人信息）
  - 写入 `~/.claude/skills/` 或 `~/.agents/skills/`；已有文件自动备份 `.bak`。

---

## 演示

日历看板展示 | 排期视图展示
:---:|:---:
![日历看板](assets/demo/日历看板展示.gif) | ![排期视图](assets/demo/排期视图展示.gif)

> 安装动图：见 `assets/demo/插件安装.gif`。

---

## 安装

### 方法一：从 Obsidian 社区插件库（推荐）

1. 打开 Obsidian → **设置 → 第三方插件 → 关闭安全模式**
2. 社区插件 → 浏览 → 搜索 **Mengshi Cockpit** → 安装并启用
3. 左侧出现猛士盾形图标，点击打开工作台

### 方法二：手动安装（Release 产物）

1. 在 [Releases](https://github.com/Spenf710/obsidian-mengshi-cockpit/releases) 下载最新 `main.js`、`manifest.json`、`styles.css`
2. 放入 vault 的 `.obsidian/plugins/mengshi-workbench/`
3. 设置 → 第三方插件 → 启用

### 方法三：源码构建

```bash
git clone https://github.com/Spenf710/obsidian-mengshi-cockpit.git
cd obsidian-mengshi-cockpit
npm install
# 构建到当前 vault 插件目录（推荐）：
OBSIDIAN_VAULT="C:/path/to/your/vault" npm run build
# 或构建到 ./dist 后手动拷贝：
npm run build
```

产物输出路径优先级：`OBSIDIAN_VAULT` 环境变量 → 当前目录 `.obsidian` → `./dist`。

---

## 首次配置

插件默认**零配置**可打开，但为获得最佳体验，请到 **设置 → 猛士驾驶舱** 里配置：

| 配置项 | 说明 | 默认 |
|--------|------|------|
| 工作日志目录 | 存放每日日志的文件夹 | 留空→「工作日志」 |
| 日记模板 | 新建日记用的模板文件 | `templates/工作日志.md` |
| 项目根目录 | 项目类文件夹，可添加多个 | 留空→需要手动添加 |
| 默认类别 / 标签 | 项目分类/标签词表 | `通用 / 其他` |
| Tab 页 | 可独立开关 6 个 Tab | 全开 |

### 飞书（可选）

飞书面板依赖外部工具 **lark-cli**（用户需自行安装并登录）：

```bash
npm install -g @larksuite/cli
lark-cli auth login
```

插件自动探测 lark-cli（含 npx 兜底）；未安装时会显示引导。

### 会话（可选）

会话面板读取本机 **Claude Code** 的会话记录（`~/.claude/projects/`），无需配置即可浏览；
「loop / 在 Claude 中打开」依赖 Claude Code CLI，未安装时按钮会给出引导提示。

---

## 数据与隐私

- 所有数据均在本机处理：读 vault 的 md 文件、可选读取 `~/.claude/projects` 的会话 jsonl、当打开飞书面板时调用飞书云 API（经 lark-cli 走你的账号凭证）。
- **不上传任何内容到第三方**：飞书调用仅在执行面板操作（浏览/搜索/统计）时发生。
- 设置项（含个性化覆盖）保存在 vault 的 `.obsidian/plugins/mengshi-workbench/data.json`。

---

## 开发

```bash
npm run dev    # watch 模式 + 静态文件同步
npm run build  # 生产构建
```

- 源码：`src/main.ts`（插件壳） + `src/data/*`（数据层）+ `src/views/*`（视图层）
- 构建：esbuild bundle → `main.js`；样式 `styles.css` 独立；`manifest.json` 版本与 Release tag 对齐

### 平台

| 项目 | 说明 |
|------|------|
| 最小版本 | Obsidian ≥ 1.7.2 |
| 桌面 | ✅（依赖 Node 运行时；Loop / 会话 / 飞书 CLI / 甘特图均桌面优先） |
| 移动端 | 不发布（`isDesktopOnly: true`，避免无法使用核心功能） |

---

## 致谢 & 许可

- 项目 logo 灵感来自军事风格，沿用自主自由创作，无第三方版权依赖。
- 本项目使用 [MIT License](LICENSE)。