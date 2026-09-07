import { App } from 'obsidian';
import { getConfig } from './settings';

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
const WEEKDAYS = ['一', '二', '三', '四', '五', '六'];

export { MONTH_NAMES, WEEKDAYS };

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
export interface DayCell {
  day: number;           // 日期数字
  isToday: boolean;
  hasLog: boolean;
  entry?: LogEntry;
}

export interface WeekRow {
  days: (DayCell | null)[];  // 6 columns Mon-Sat, null = empty cell
}

export function buildCalendarGrid(
  calData: CalendarMonth,
  today: Date,
): WeekRow[] {
  const { year, month, entries } = calData;

  const firstDay = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();

  // 计算本月第一天是周几（1=Mon, 7=Sun）
  let firstDow = firstDay.getDay(); // 0=Sun, 1=Mon
  if (firstDow === 0) firstDow = 7; // 转换为 1=Mon, 7=Sun

  // 收集本月所有非周日的日期
  const cells: DayCell[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = ((firstDow - 1) + (d - 1)) % 7 + 1; // 1=Mon, 7=Sun
    if (dow === 7) continue; // 跳过周日

    const entry = entries.get(d);
    cells.push({
      day: d,
      isToday:
        today.getFullYear() === year &&
        today.getMonth() === month - 1 &&
        today.getDate() === d,
      hasLog: !!entry,
      entry: entry ?? undefined,
    });
  }

  // 按周分组到 6 列网格
  const grid: WeekRow[] = [];
  let week: (DayCell | null)[] = [];
  let lastCol = -1;

  for (const cell of cells) {
    const date = new Date(year, month - 1, cell.day);
    let dow = date.getDay();
    if (dow === 0) dow = 7;
    const col = dow - 1; // 0=Mon, 5=Sat

    if (col <= lastCol) {
      // 新的一周
      while (week.length < 6) week.push(null);
      grid.push({ days: week });
      week = [];
    }
    while (week.length < col) week.push(null);
    week.push(cell);
    lastCol = col;
  }
  while (week.length < 6) week.push(null);
  if (week.some((c) => c !== null)) {
    grid.push({ days: week });
  }

  return grid;
}
