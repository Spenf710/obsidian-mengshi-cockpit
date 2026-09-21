/**
 * 数据扫描组装工具：从日志生成「周报/月报骨架按钮」所需的项目聚合草稿。
 * 供 ReportCreateModal 的「从日志提取草稿」模式调用。
 */
import { App, TFile } from 'obsidian';
import { getConfig } from './settings';

interface DraftLine {
  date: string;       // M/D
  summary: string;    // 一句话
}

export interface DraftProject {
  /** 项目原始名（去 emoji） */
  name: string;
  /** 项目标签（带 emoji 前缀） */
  label: string;
  /** 日期 + 一句话 列表，按天排序 */
  lines: DraftLine[];
}

export interface ReportDraft {
  /** 项目聚合结果（按命中条数降序） */
  projects: DraftProject[];
  /** 总日志条数 */
  total: number;
  /** 有日志的天数 */
  logDays: number;
  /** 状态分布 */
  statuses: { green: number; yellow: number; red: number };
  /** 自动摘要（高频项目名 + 主线） */
  aiSummary: string;
}

// ===== 复用 logScanner 的项目 → emoji 映射（保持周报/月报标签图标一致性） =====
// 注意：这里同步复制一份，避免 import 循环依赖；新增项目映射时两边需同步更新。
const PROJECT_EMOJI: [RegExp, string][] = [
  [/AI先锋大赛|先锋大赛/, '🏆'],
  [/猛士驾驶舱-DSH|驾驶舱-DSH/, '🔍'],
  [/猛士驾驶舱|驾驶舱插件|工作台/, '🖥️'],
  [/车型新品开发项目模板|新品开发模板/, '📋'],
  [/飞书项目/, '🔄'],
  [/武大MBA|MBA学员/, '🎤'],
  [/EPS工厂生产停线|EPS停线|生产停线/, '🏭'],
  [/EPS开模令|开模令/, '🔧'],
  [/供应商数字化培训|数字化培训/, '🎓'],
  [/月度业绩评价卡|评价卡/, '📊'],
  [/HTML-PPT|HTML幻灯片|html-ppt/, '🎨'],
  [/中级工程师|职称申报/, '📄'],
  [/FDE|QC课题/, '🧠'],
  [/RAG 底座/, '⚙️'],
  [/DSH原子笔记|DSH笔记|原子笔记/, '📚'],
  [/APQP/, '🔄'],
  [/设变变更|设变/, '🚀'],
  [/低合格率/, '📉'],
  [/检规/, '🔍'],
  [/MOS-PPAP|MOS PPAP|MOS/, '💼'],
  [/供应商质量大会|质量大会/, '🎪'],
  [/生长插件/, '🌱'],
  [/李尔座舱外观|外观手册/, '📖'],
  [/超级工程师/, '🏢'],
  [/部品风险清单/, '📋'],
  [/PPAP/, '⚙️'],
  [/Obsidian|知识库/, '📌'],
  [/AI模型选型|CC-Switch|AI工具链/, '🤖'],
  [/工作法解读/, '💡'],
  [/生成制造|量产问题/, '📋'],
  [/供应商约谈|供应商管理/, '🤝'],
  [/GCC|中控屏|量产设变/, '🚗'],
  [/模具/, '🛠️'],
  [/飞书 CLI|CLI 环境/, '⚙️'],
  [/应届生带教|新人培训|新员工/, '🧑‍🎓'],
  [/Git入门/, '📚'],
  [/培训/, '🎓'],
  [/数字化/, '💻'],
];
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{00A9}-\u{00AE}]/u;

/** 剥离开头整段 emoji（含 ZWJ/Variation Selector/空格），保留主干文字 */
function stripLeadingEmoji(name: string): string {
  const m = name.match(/^(\p{Extended_Pictographic}|\u{200D}|\u{FE0F}|\s)+/u);
  return m ? name.slice(m[0].length).trim() : name.trim();
}

/** 自动补 emoji：项目名前缀（首字符已是 emoji 则原样，否则按映射补） */
function ensureProjectEmoji(name: string): string {
  const t = name.trim();
  if (EMOJI_RE.test(Array.from(t)[0])) return t;
  for (const [re, em] of PROJECT_EMOJI) {
    if (re.test(t)) return `${em} ${t}`;
  }
  return `📁 ${t}`;
}

/** 「是否板块/非项目标题」——与周报解析一致，过滤掉被误当项目的板块条目 */
function isSectionHeading(raw: string): boolean {
  const t = raw.trim();
  return /^(一|二|三|四|五|六|七|八|九|十)[、.]/.test(t)
    || /^工作线[一二三四五六]/.test(t)
    || /^(核心|主要|其他|风险|资源|产出|技术要点|会议与培训|总结与建议|需要支持|关键成果|关键目标|项目进展|本周概览|上周|本周|下周|相关笔记|问题|成果|待办)/.test(t)
    || ['会议与培训', '部门事务', '知识沉淀', '其他', '其他工作', '问题', '风险与应对', '资源需求', '协同建议', '产出清单', '技术要点'].some((s) => t.includes(s));
}

/** 将「一句话」归类到项目：用 PROJECT_EMOJI 匹配高频项目名，未命中归「其他事务」 */
function projectKeyOf(summary: string): string | null {
  const t = stripLeadingEmoji(summary).trim();
  if (!t) return null;
  // 1) 按映射表命中 → 取该规则主词（规则第一个备选，作为项目名）
  for (const [re] of PROJECT_EMOJI) {
    if (re.test(t)) return re.source.split('|')[0].trim();
  }
  return null;
}

/** 扫描 range 内日志，聚合项目草稿 */
export async function buildReportDraft(
  app: App,
  from: string, // YYYY-MM-DD
  to: string,   // YYYY-MM-DD
): Promise<ReportDraft> {
  const allFiles = app.vault.getFiles();
  const prefix = `${getConfig().workLogPath}/`;
  const entries: { date: string; summary: string; status: string }[] = [];

  for (const file of allFiles) {
    if (!file.path.startsWith(prefix)) continue;
    if (!file.name.endsWith('.md')) continue;
    const m = file.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const date = m[1];
    if (date < from || date > to) continue;
    try {
      const content = await app.vault.cachedRead(file);
      const summaryMatch = content.match(/\*\*一句话\*\*[：:]\s*(.+)/);
      const statusMatch = content.match(/\*\*今日状态\*\*[：:]\s*(.+)/);
      entries.push({
        date,
        summary: summaryMatch ? summaryMatch[1].trim() : '',
        status: statusMatch ? statusMatch[1].trim() : '',
      });
    } catch { /* 读取失败跳过 */ }
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : 1));

  // 统计状态
  const statuses = { green: 0, yellow: 0, red: 0 };
  const logDays = new Set<string>();
  for (const e of entries) {
    logDays.add(e.date);
    if (e.status.includes('🟢')) statuses.green++;
    else if (e.status.includes('🟡')) statuses.yellow++;
    else if (e.status.includes('🔴')) statuses.red++;
  }

  // 按项目聚合
  const byProj = new Map<string, DraftLine[]>();
  for (const e of entries) {
    if (!e.summary) continue;
    const key = projectKeyOf(e.summary) ?? '其他事务';
    // 兜底桶（未命中任何映射的日志归入「其他事务」）跳过板块过滤：
    // isSectionHeading('其他事务') 命中「其他」关键词会把整桶丢弃，
    // 导致未映射到项目的日常零散日志全部从草稿消失、统计失真。
    // 真实项目主词（如「培训」「数字化」）仍走板块过滤拦截误命中的板块标题。
    if (key !== '其他事务' && isSectionHeading(stripLeadingEmoji(key))) continue;
    const arr = byProj.get(key) ?? [];
    arr.push({ date: `${e.date.slice(5, 7)}/${e.date.slice(8, 10)}`, summary: e.summary });
    byProj.set(key, arr);
  }

  const projects: DraftProject[] = [...byProj.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 8)
    .map(([name, lines]) => ({
      name: stripLeadingEmoji(name),
      label: ensureProjectEmoji(name),
      lines,
    }));

  // 自动摘要
  const topNames = projects.filter((p) => p.label !== '📁 其他事务').slice(0, 2).map((p) => p.name);
  const aiSummary = entries.filter((e) => e.summary).length > 0
    ? `${topNames.length ? topNames.join('+') + '+' : ''}等${projects.length}类事务`
    : '';

  return {
    projects,
    total: entries.length,
    logDays: logDays.size,
    statuses,
    aiSummary,
  };
}