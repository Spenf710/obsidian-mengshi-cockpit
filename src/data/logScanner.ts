import { App } from 'obsidian';
import { getConfig } from './settings';
import { getHoliday, type HolidayDay } from './holidayCalendar';

// ===== 类型 =====
export interface LogEntry {
  date: string;      // YYYY-MM-DD
  filePath: string;
  summary: string;   // 一句话
  status: string;    // 今日状态
}

export interface CalendarMonth {
  year: number;
  month: number;     // 1-12
  entries: Map<number, LogEntry>;  // dayNum → entry
}

// ===== 常量 =====
const MONTH_NAMES = [
  '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月',
];

export { MONTH_NAMES };

// ===== 扫描 =====
export async function scanLogsByMonth(
  app: App,
  year: number,
  month: number,
): Promise<CalendarMonth> {
  const entries = new Map<number, LogEntry>();
  const allFiles = app.vault.getFiles();

  // 匹配 工作日志/X月/YYYY-MM-DD.md 模式
  const prefix = `${getConfig().workLogPath}/${month}月/`;
  const datePrefix = `${year}-${String(month).padStart(2, '0')}`;

  for (const file of allFiles) {
    if (!file.path.startsWith(prefix)) continue;
    if (!file.name.startsWith(datePrefix)) continue;
    if (!file.name.endsWith('.md')) continue;

    // 从文件名解析日期
    const match = file.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;

    const date = match[1];
    const dayNum = parseInt(date.split('-')[2], 10);

    // 读取内容提取「一句话」和「今日状态」
    let summary = '';
    let status = '';
    try {
      const content = await app.vault.cachedRead(file);
      const summaryMatch = content.match(/\*\*一句话\*\*[：:]\s*(.+)/);
      if (summaryMatch) summary = summaryMatch[1].trim();

      const statusMatch = content.match(/\*\*今日状态\*\*[：:]\s*(.+)/);
      if (statusMatch) status = statusMatch[1].trim();
    } catch {
      // 读取失败则跳过摘要
    }

    entries.set(dayNum, { date, filePath: file.path, summary, status });
  }

  return { year, month, entries };
}

// ===== 获取所有有日志的月份列表（用于快速导航） =====
export async function getLogMonths(app: App): Promise<{ year: number; month: number }[]> {
  const months = new Set<string>();
  const allFiles = app.vault.getFiles();

  for (const file of allFiles) {
    if (!file.path.startsWith(getConfig().workLogPath + '/')) continue;
    const match = file.name.match(/^(\d{4})-(\d{2})-\d{2}\.md$/);
    if (!match) continue;
    months.add(`${match[1]}-${match[2]}`);
  }

  return Array.from(months)
    .map((key) => {
      const [y, m] = key.split('-').map(Number);
      return { year: y, month: m };
    })
    .sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });
}

// ===== 日历网格构建 =====

/** 拼接 YYYY-MM-DD */
export function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 解析日志摘要与状态（从日志正文提取「一句话」「今日状态」） */
export function parseLogFields(content: string): { summary: string; status: string } {
  const summaryMatch = content.match(/\*\*一句话\*\*[：:]\s*(.+)/);
  const statusMatch = content.match(/\*\*今日状态\*\*[：:]\s*(.+)/);
  return {
    summary: summaryMatch ? summaryMatch[1].trim() : '',
    status: statusMatch ? statusMatch[1].trim() : '',
  };
}

/**
 * 范围扫描：一次性获取某时间段内所有日志（按日期分桶，粒度到天）。
 * 供季视图（周行分桶）与年视图（月列分桶）共用；月视图仍走 scanLogsByMonth。
 */
export interface LogBucket {
  /** 桶日期 YYYY-MM-DD（桶的基准日） */
  date: string;
  /** 该桶内全部日志专属的一组状态/摘要（可能同一天已存在多条） */
  entries: LogEntry[];
}

export async function scanLogsRange(app: App, from: string, to: string): Promise<Map<string, LogEntry[]>> {
  const allFiles = app.vault.getFiles();
  const map = new Map<string, LogEntry[]>();
  const prefix = `${getConfig().workLogPath}/`;
  for (const file of allFiles) {
    if (!file.path.startsWith(prefix)) continue;
    if (!file.name.endsWith('.md')) continue;
    const match = file.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!match) continue;
    const date = match[1];
    if (date < from || date > to) continue;
    let summary = '';
    let status = '';
    try {
      const content = await app.vault.cachedRead(file);
      const f = parseLogFields(content);
      summary = f.summary; status = f.status;
    } catch { /* ignore */ }
    const arr = map.get(date);
    const entry: LogEntry = { date, filePath: file.path, summary, status };
    if (arr) arr.push(entry);
    else map.set(date, [entry]);
  }
  return map;
}

// ===== 季视图 / 年视图构建 =====

/** 季视图单元格：日 + 月份（跨月标注）+ 该天日志数/状态 + 节假日 */
export interface QuarterDayCell {
  day: number;
  month: number;
  year: number;
  isToday: boolean;
  count: number;
  /** 当天各篇日志的状态（用于状态点展示） */
  statuses: string[];
  holiday: HolidayDay | null;
}

export interface QuarterWeekRow {
  /** 该自然周起始日（周日） YYYY-MM-DD */
  weekStart: string;
  /** 该自然周结束日（周六） YYYY-MM-DD */
  weekEnd: string;
  /** 按当日列序排列的格子；null=不在季度内/被隐藏的周末 */
  cells: (QuarterDayCell | null)[];
}

/**
 * 构建季度视图：行=季度内自然周（周日~周六），列沿用日历列序。
 * 季度内的日期都参与构建（含跨月边界周；边界周日/周六可能落在上一/下一季度）。
 */
export function buildQuarterGrid(
  logs: Map<string, LogEntry[]>,
  year: number,
  quarter: number, // 1-4
  showSat: boolean,
  showSun: boolean,
  showHolidays: boolean,
): QuarterWeekRow[] {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const cols = calendarColumns(showSat, showSun);

  // 季度开始前的周日：可能落在上一季度（用于包含边界周）
  const qStart = new Date(year, startMonth - 1, 1);
  const lead = qStart.getDay(); // 0=Sun
  const periodFrom = new Date(year, startMonth - 1, 1);
  periodFrom.setDate(periodFrom.getDate() - lead); // 季度首日前导周日

  // 季度结束后的周六：可能落在下一季度
  const qEnd = new Date(year, endMonth, 0); // 季度最后一天
  const trail = qEnd.getDay();
  const periodTo = new Date(year, endMonth - 1, qEnd.getDate() + (6 === trail ? 0 : 6 - trail));

  // 按自然周（回退周日）分组；仅收录「落在季度内」的日期
  const periods = new Map<number, QuarterDayCell[]>();
  const scanFrom = new Date(periodFrom);
  const scanTo = new Date(periodTo);
  for (let d = new Date(scanFrom); d <= scanTo; d.setDate(d.getDate() + 1)) {
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (m < startMonth || m > endMonth) continue; // 只保留季度内日期
    const dow = d.getDay();
    if (dow === 6 && !showSat) continue;
    if (dow === 0 && !showSun) continue;

    const ws = new Date(d);
    ws.setDate(ws.getDate() - dow);
    ws.setHours(0, 0, 0, 0);
    const weekStart = ws.getTime();

    const dateStr = toDateStr(year, m, day);
    const dayLogs = logs.get(dateStr) ?? [];
    const cell: QuarterDayCell = {
      day,
      month: m,
      year,
      isToday: todayIs(year, m, day),
      count: dayLogs.length,
      statuses: dayLogs.map((l) => l.status).filter(Boolean),
      holiday: showHolidays ? getHoliday(dateStr) : null,
    };
    const list = periods.get(weekStart);
    if (list) list.push(cell);
    else periods.set(weekStart, [cell]);
  }

  const rows: QuarterWeekRow[] = [];
  const weekStarts = [...periods.keys()].sort((a, b) => a - b);
  for (const ws of weekStarts) {
    const sd = new Date(ws);
    const cells: (QuarterDayCell | null)[] = cols.map(() => null);
    for (const cell of periods.get(ws)!) {
      const date = new Date(cell.year, cell.month - 1, cell.day);
      const col = date.getDay() === 0 ? 6 : date.getDay() - 1;
      const colIdx = cols.findIndex((c) => c.index === col);
      if (colIdx >= 0) cells[colIdx] = cell;
    }
    // 计算周范围（含跨出季度的首尾，用于周标题）
    const se = new Date(sd); se.setDate(se.getDate() + 6);
    rows.push({
      weekStart: `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`,
      weekEnd: `${se.getFullYear()}-${String(se.getMonth() + 1).padStart(2, '0')}-${String(se.getDate()).padStart(2, '0')}`,
      cells,
    });
  }
  return rows;
}

/** 年视图月份概要 */
export interface YearMonthSummary {
  month: number;      // 1-12
  logDays: number;    // 有日志的天数
  logCount: number;   // 日志总条数
  hasEntries: boolean;
}

export function buildYearSummaries(logs: Map<string, LogEntry[]>): YearMonthSummary[] {
  const out: YearMonthSummary[] = [];
  for (let m = 1; m <= 12; m++) {
    const md = `${String(m).padStart(2, '0')}`;
    const days = new Set<string>();
    let count = 0;
    for (const [dateStr, arr] of logs) {
      if (dateStr.slice(5, 7) !== md) continue;
      days.add(dateStr);
      count += arr.length;
    }
    out.push({ month: m, logDays: days.size, logCount: count, hasEntries: count > 0 });
  }
  return out;
}

/** 今天是某年某月某日 */
function todayIs(y: number, m: number, d: number): boolean {
  const t = new Date();
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

// ===== 项目 → emoji 映射（周报项目标签统一带图标；SKILL 总结强制用） =====
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

/** 自动补 emoji：项目名已带 emoji 则原样，否则按映射表补前缀 */
export function ensureProjectEmoji(name: string): string {
  const t = name.trim();
  if (EMOJI_RE.test(t.charAt(0))) return t;
  for (const [re, em] of PROJECT_EMOJI) {
    if (re.test(t)) return `${em} ${t}`;
  }
  return `📁 ${t}`;
}

/** 若以 emoji 开头，剥离开头整段 emoji（含 ZWJ 复合序列/变体选择符，如 🧑‍🎓、🖥️），保留主干文字；无则原样返回 */
export function stripLeadingEmoji(name: string): string {
  const m = name.match(/^(\p{Extended_Pictographic}|\u{200D}|\u{FE0F}|\s)+/u);
  return m ? name.slice(m[0].length).trim() : name.trim();
}

/** 判断是否为「非项目」的板块标题（章节/工作线/成果/风险等），应从项目标签过滤 */
function isSectionHeading(raw: string): boolean {
  if (/^(✅|📅|📌|📊|⚠️|🔧|🤝|🔬|📝|🗂️|🎨|🏗️|📖|🆕)/.test(raw) && !EMOJI_RE.test(raw.slice(6))) return true;
  return /^(一|二|三|四|五|六|七|八|九|十)[、.]/.test(raw)
    || /^工作线[一二三四五六]/.test(raw)
    || /^(核心|主要|其他|风险|资源|产出|技术要点|会议与培训|总结与建议|需要支持|关键成果|关键目标|项目进展|本周概览|上周|本周|下周|相关笔记|问题|成果|待办)/.test(raw)
    || ['会议与培训', '部门事务', '知识沉淀', '其他', '其他工作', '问题', '风险与应对', '资源需求', '协同建议', '产出清单', '技术要点'].some((s) => raw.includes(s));
}

/** 周报摘要：供季视图每周卡片展示 */
export interface WeeklyReportInfo {
  filePath: string;
  periodStart: string;  // YYYY-MM-DD
  periodEnd: string;    // YYYY-MM-DD（可能跨月）
  aiSummary: string;    // frontmatter ai_summary（一句话概述）
  projects: string[];   // ✅ 本周完成 下 ##/### 项目名（去序号、去板块）
}

/** 月报摘要：供年视图月份卡片展示 */
export interface MonthlyReportInfo {
  filePath: string;
  year: number;
  month: number;
  aiSummary: string;    // frontmatter ai_summary
  statuses: { green: number; yellow: number; red: number } | null; // 统计行解析
}

/** 解析 frontmatter YAML 块 → Record */
function parseFrontmatter(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!content.startsWith('---')) return out;
  const end = content.indexOf('\n---', 4);
  if (end < 0) return out;
  const block = content.slice(4, end);
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][\w]*):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** 根据 period 字符串解析日期范围（兼容 frontmatter period / 标题文件名） */
export function parsePeriodRange(periodStr: string): { start: string; end: string } | null {
  const m = periodStr.match(/(\d{4})-(\d{2})-(\d{2})\s*[~\-—至]\s*(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { start: `${m[1]}-${m[2]}-${m[3]}`, end: `${m[4]}-${m[5]}-${m[6]}` };
  // 兼容「M月D日~D日」文件名
  const m2 = periodStr.match(/(\d{1,2})月(\d{1,2})日?\s*[~\-—至]\s*(?:(\d{1,2})月)?(\d{1,2})日?/);
  if (m2) {
    const sm = +m2[1], sd = +m2[2], em = m2[3] ? +m2[3] : sm, ed = +m2[4];
    const p = (n: number) => String(n).padStart(2, '0');
    return { start: `2026-${p(sm)}-${p(sd)}`, end: `2026-${p(em)}-${p(ed)}` };
  }
  return null;
}

/**
 * 扫描某年全部周报（工作周报/YYYY年QN/*.md）。
 * 解析 frontmatter period/ai_summary + ✅ 本周完成 下的项目名（##/### 标题）。
 */
export async function scanWeeklyReports(app: App, year: number): Promise<WeeklyReportInfo[]> {
  const allFiles = app.vault.getFiles();
  const prefix = `工作周报/${year}年`;
  const out: WeeklyReportInfo[] = [];
  for (const file of allFiles) {
    if (!file.path.startsWith(prefix)) continue;
    if (!file.name.endsWith('.md')) continue;
    if (!file.name.includes('周工作总结')) continue;
    try {
      const content = await app.vault.cachedRead(file);
      const fm = parseFrontmatter(content);
      const period = parsePeriodRange(fm.period || file.name);
      if (!period) continue;
      // 提取 ✅ 本周完成 至 📅 下周计划 区间内的 h2/h3 项目名
      const projects: string[] = [];
      const doneIdx = content.indexOf('## ✅ 本周完成');
      const planIdx = content.indexOf('## 📅 下周计划');
      const slice = content.slice(
        doneIdx >= 0 ? doneIdx : 0,
        planIdx > doneIdx && doneIdx >= 0 ? planIdx : undefined,
      );
      const seen = new Set<string>();
      for (const l of slice.split('\n')) {
        const m = l.match(/^#{2,3}\s+(.+)$/);
        if (!m) continue;
        // 剔除尾随任意圆括号内容（如「（运维中）」「（4月7日-9日）」），但保留连字符（PPAP-RPA）
        let t = m[1]
          .replace(/^[\d]+[.、)）]?\s*/, '')   // 去序号
          .replace(/\s*[([（][^()）)]*[)）]\s*$/, '')  // 去尾随括号（含全/半角）
          .trim();
        if (t.length < 2 || t.length > 28) continue;
        if (isSectionHeading(t)) continue;      // 过滤「会议与培训/工作线X/风险…」等非项目标题
        t = stripLeadingEmoji(t);           // 剥离开头已带 emoji，避免二次叠加
        if (!t) continue;
        const labeled = ensureProjectEmoji(t); // 统一按映射补 emoji 前缀
        if (!seen.has(labeled)) { seen.add(labeled); projects.push(labeled); }
      }
      out.push({
        filePath: file.path,
        periodStart: period.start,
        periodEnd: period.end,
        aiSummary: fm.ai_summary || '',
        projects: projects.slice(0, 6),
      });
    } catch { /* 读取失败跳过 */ }
  }
  return out;
}

/**
 * 扫描某年全部月报（工作月报/YYYY年/YYYY-MM-月报.md）。
 * 解析 frontmatter period/ai_summary + 正文状态统计行。
 */
export async function scanMonthlyReports(app: App, year: number): Promise<MonthlyReportInfo[]> {
  const allFiles = app.vault.getFiles();
  const prefix = `工作月报/${year}年/`;
  const out: MonthlyReportInfo[] = [];
  for (const file of allFiles) {
    if (!file.path.startsWith(prefix)) continue;
    if (!file.name.endsWith('.md')) continue;
    const m = file.name.match(/^(\d{4})-(\d{2})-月报\.md$/);
    if (!m) continue;
    try {
      const content = await app.vault.cachedRead(file);
      const fm = parseFrontmatter(content);
      // 状态统计（正文 > 📝 行 或 frontmatter）
      const statLine = content.match(/🟢 在线\s*(\d+)\s*天[^🔴]*🟡 有点忙\s*(\d+)\s*天[^🔴]*🔴 忙炸了\s*(\d+)\s*天/) ||
                       content.match(/🟢\s*(\d+)[^🟡]*🟡\s*(\d+)[^🔴]*🔴\s*(\d+)/);
      let statuses: { green: number; yellow: number; red: number } | null = null;
      if (statLine) {
        statuses = { green: +statLine[1] || 0, yellow: +statLine[2] || 0, red: +statLine[3] || 0 };
      }
      out.push({
        filePath: file.path,
        year,
        month: +m[2],
        aiSummary: fm.ai_summary || '',
        statuses,
      });
    } catch { /* 跳过 */ }
  }
  return out;
}

/** 星期列固定顺序（index：0=周日 … 6=周六），周日列置左、周六列置右 */
export function calendarColumns(showSaturday: boolean, showSunday: boolean): { label: string; index: number }[] {
  const order = [6, 0, 1, 2, 3, 4, 5]; // 日 一 二 三 四 五 六
  const cols: { label: string; index: number }[] = [];
  for (const idx of order) {
    if (idx === 5 && !showSaturday) continue;
    if (idx === 6 && !showSunday) continue;
    if (idx === 5) cols.push({ label: '六', index: idx });
    else if (idx === 6) cols.push({ label: '日', index: idx });
    else cols.push({ label: '一二三四五'[idx], index: idx });
  }
  return cols;
}

export interface DayCell {
  day: number;           // 日期数字
  isToday: boolean;
  hasLog: boolean;
  entry?: LogEntry;
  /** 本轮日是要显示的星期序数（0=周一 … 6=周日），用于定位列 */
  col: number;
  /** 节假日标注（如「春节」「除夕」）；补班日（周末上班）也会给工作日名字 */
  holiday?: { name: string; isHoliday: boolean } | null;
}

export interface WeekRow {
  /** 按 columns 列序填充的细胞；null = 空位 */
  cells: (DayCell | null)[];
}

/**
 * 构建日历网格。周列（周六/周日是否显示）与节假日标注由配置决定：
 *   - opts 传入时优先生效（便于单测）
 *   - 未传时读 getConfig() 实时配置（保存设置后重载面板生效）
 * 按 7 天自然周遍历，只填充「该显示的列」对应的格子，跨周自动换行。
 */
export interface CalendarGridOptions {
  showSaturday?: boolean;
  showSunday?: boolean;
  showHolidays?: boolean;
}

export function buildCalendarGrid(
  calData: CalendarMonth,
  today: Date,
  opts?: CalendarGridOptions,
): WeekRow[] {
  const { year, month, entries } = calData;
  const cfg = getConfig();
  const showSat = opts?.showSaturday ?? (cfg.showSaturday !== false);
  const showSun = opts?.showSunday ?? (cfg.showSunday !== false);
  const showHolidays = opts?.showHolidays ?? (cfg.showHolidays !== false);

  const daysInMonth = new Date(year, month, 0).getDate();
  const cols = calendarColumns(showSat, showSun);

  // 收集当月所有需显示的日期，按「回退到周日」的自然周分组：
  // 同一自然周（周日~周六）强制同排，避免周分隔逻辑与列顺序不一致导致格位错位
  const periods = new Map<number, DayCell[]>();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay(); // 0=Sun
    const col = dow === 0 ? 6 : dow - 1; // 0=Mon … 6=Sun
    // 只在配置的显示列内构建格子（周六/周日可隐藏）
    if (dow === 6 && !showSat) continue;
    if (dow === 0 && !showSun) continue;

    // 该日期所在自然周的周日（分组键）
    const ws = new Date(year, month - 1, d);
    ws.setDate(ws.getDate() - dow);
    ws.setHours(0, 0, 0, 0);
    const weekStart = ws.getTime();

    const entry = entries.get(d);
    const dateStr = toDateStr(year, month, d);
    const cell: DayCell = {
      day: d,
      isToday: today.getFullYear() === year && today.getMonth() === month - 1 && today.getDate() === d,
      hasLog: !!entry,
      entry: entry ?? undefined,
      col,
      holiday: showHolidays ? getHoliday(dateStr) : null,
    };
    const list = periods.get(weekStart);
    if (list) list.push(cell);
    else periods.set(weekStart, [cell]);
  }

  // 按自然周顺序输出行；每行先按列序置空格，再填入该周日期（顺带去掉全空行）
  const grid: WeekRow[] = [];
  const weekStarts = [...periods.keys()].sort((a, b) => a - b);
  for (const ws of weekStarts) {
    const cells: (DayCell | null)[] = cols.map(() => null);
    for (const cell of periods.get(ws)!) {
      const colIdx = cols.findIndex((c) => c.index === cell.col);
      if (colIdx >= 0) cells[colIdx] = cell;
    }
    if (cells.some((c) => c !== null)) grid.push({ cells });
  }
  return grid;
}
