import React, { useEffect, useState, useMemo, useCallback, useRef, useLayoutEffect, Fragment } from 'react';
import { type App, TFile } from 'obsidian';
import {
  scanProjects,
  groupBySource,
  groupByTag,
  groupBySystem,
  formatDate,
  getTags,
  getCategories,
  type ProjectInfo,
  type ProjectGroup,
} from '../data/projectScanner';
import { QuickDiaryModal, getDatePath, STATUS_OPTIONS } from './QuickDiaryModal';
import { ReportCreateModal } from './ReportCreateModal';
import { GraphModal } from './MiniGraph';
import { QuickTodoModal } from './QuickTodoModal';
import { ProjectFilesModal } from './ProjectFilesModal';
import { GanttPanel } from './GanttPanel';
import { FeishuPanel } from './FeishuPanel';
import { SessionsPanel } from './SessionsPanel';
import { CreateProjectModal } from './CreateProjectModal';
import { GANTT_DATA } from '../data/ganttData';
import { saveProjectMeta, getGanttOverrides, addCustomCategory, addCustomTag, removeCustomCategory, removeCustomTag, getCategoryUsage, getConfig, getDomainIcon, setDomainIcon } from '../data/settings';
import { writeUrlToReadme, removeUrlFromReadme } from '../data/projectScanner';
import {
  scanLogsByMonth,
  scanLogsRange,
  scanWeeklyReports,
  scanMonthlyReports,
  buildCalendarGrid,
  buildQuarterGrid,
  buildYearProjectChips,
  calendarColumns,
  MONTH_NAMES,
  type CalendarMonth,
  type QuarterWeekRow,
  type YearProjectChip,
  type WeeklyReportInfo,
  type MonthlyReportInfo,
  type LogEntry,
} from '../data/logScanner';
import {
  scanTasks,
  groupTasks,
  toggleTask as toggleTaskApi,
  type TaskItem,
} from '../data/taskScanner';

// ===== 常量 =====
type TabKey = 'calendar' | 'projects' | 'todos' | 'gantt' | 'feishu' | 'sessions';
type SortMode = 'source' | 'tag' | 'system';

const TABS = [
  { key: 'calendar' as const, label: '日历', icon: '📅' },
  { key: 'projects' as const, label: '项目', icon: '📂' },
  { key: 'todos' as const, label: '待办', icon: '✅' },
  { key: 'gantt' as const, label: '排期', icon: '📊' },
  { key: 'feishu' as const, label: '飞书', icon: '📡' },
  { key: 'sessions' as const, label: '会话', icon: '💬' },
];

// ===== 日期格式化 =====
function fmtShortDate(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

// ===== 入口 =====
export function WorkbenchApp({ app }: { app: App }) {
  const [activeTab, setActiveTab] = useState<TabKey>('calendar');
  const [refreshKey, setRefreshKey] = useState(0);

  // 根据配置过滤可见 Tab
  const visibleTabs = useMemo(() => {
    const cfg = getConfig();
    return TABS.filter((t) => cfg.visibleTabs?.[t.key] !== false);
  }, []);

  // 当前 Tab 被隐藏时自动切换到第一个可见 Tab
  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.find((t) => t.key === activeTab)) {
      setActiveTab(visibleTabs[0].key);
    }
  }, [visibleTabs, activeTab]);

  return (
    <div className="mswb-app">
      <nav className="mswb-tabs">
        {visibleTabs.map((tab) => (
          <button
            key={tab.key}
            className={`mswb-tab ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            <span className="mswb-tab-icon">{tab.icon}</span>
            <span className="mswb-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      <div className="mswb-panel">
        {activeTab === 'calendar' && <div key={`cal-${refreshKey}`} style={{height:'100%'}}><CalendarPanel app={app} /></div>}
        {activeTab === 'projects' && <div key={`proj-${refreshKey}`} style={{height:'100%'}}><ProjectsPanel app={app} /></div>}
        {activeTab === 'todos' && <div key={`todo-${refreshKey}`} style={{height:'100%'}}><TodosPanel app={app} /></div>}
        {activeTab === 'gantt' && <div key={`gantt-${refreshKey}`} style={{height:'100%'}}><GanttPanel app={app} /></div>}
        {activeTab === 'feishu' && <div key={`feishu-${refreshKey}`} style={{height:'100%'}}><FeishuPanel app={app} /></div>}
        {activeTab === 'sessions' && <div key={`sess-${refreshKey}`} style={{height:'100%'}}><SessionsPanel app={app} /></div>}
      </div>

      {/* 快捷录入按钮 */}
      <div className="mswb-fab">
        <button
          className="mswb-fab-btn"
          onClick={() => new QuickDiaryModal(app).open()}
          title="快捷日记录入"
        >
          <span className="mswb-fab-icon">✏️</span>
          <span className="mswb-fab-label">日记</span>
        </button>
        <button
          className="mswb-fab-btn"
          onClick={() => new QuickTodoModal(app).open()}
          title="快捷待办录入"
        >
          <span className="mswb-fab-icon">✅</span>
          <span className="mswb-fab-label">待办</span>
        </button>
        <button
          className="mswb-fab-btn"
          onClick={() => setRefreshKey((k) => k + 1)}
          title="刷新当前视图"
          style={{ marginLeft: 'auto' }}
        >
          <span className="mswb-fab-icon">🔄</span>
          <span className="mswb-fab-label">刷新</span>
        </button>
      </div>
    </div>
  );
}

// ===== 日历面板 =====
/** 日历视图粒度：month=日新视图（月粒度日网格）、drawer=月异视图（季度月卡+选中月周卡联动；日历剩余月入口进入对应月日新视图） */
type CalViewKind = 'month' | 'drawer';
const CAL_VIEWS: { key: CalViewKind; label: string; icon: string; hint: string }[] = [
  { key: 'month', label: '日新', icon: '📅', hint: '日新视图（按天记录）' },
  { key: 'drawer', label: '月异', icon: '🪟', hint: '月异视图（月度卡片+周度卡片联动）' },
];

function CalendarPanel({ app }: { app: App }) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.floor(today.getMonth() / 3) + 1);
  const [view, setView] = useState<CalViewKind>('month');
  const [calData, setCalData] = useState<CalendarMonth | null>(null);
  const [rangeLogs, setRangeLogs] = useState<Map<string, LogEntry[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerMonth, setDrawerMonth] = useState(today.getMonth() + 1);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState<number | null>(null);

  // 新增状态
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showGraphDate, setShowGraphDate] = useState<string | null>(null);
  const [editingStatusCell, setEditingStatusCell] = useState<number | null>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  const cfg = useMemo(() => getConfig(), []);
  const showSat = cfg.showSaturday !== false;
  const showSun = cfg.showSunday !== false;
  const showHolidays = cfg.showHolidays !== false;

  // 月视图数据
  const loadMonth = useCallback(
    async (y: number, m: number) => {
      setLoading(true);
      const data = await scanLogsByMonth(app, y, m);
      setCalData(data);
      setLoading(false);
    },
    [app],
  );

  // 月异视图数据：季度内全部日期
  const loadQuarter = useCallback(
    async (y: number, q: number) => {
      setLoading(true);
      const startMonth = (q - 1) * 3 + 1;
      const endMonth = startMonth + 2;
      const from = `${y}-${String(startMonth).padStart(2, '0')}-01`;
      const to = `${y}-${String(endMonth).padStart(2, '0')}-${String(new Date(y, endMonth, 0).getDate()).padStart(2, '0')}`;
      const logs = await scanLogsRange(app, from, to);
      setRangeLogs(logs);
      setLoading(false);
    },
    [app],
  );

  // 视图/年份切换
  useEffect(() => {
    if (view === 'month') loadMonth(year, month);
    else if (view === 'drawer') loadQuarter(year, quarter);
  }, [view, year, month, quarter, loadMonth, loadQuarter]);

  // 抽屉视图：切换季度时，选中月默认回到该季首月（若超出当前年范围则用 1 月兜底）
  useEffect(() => {
    if (view !== 'drawer') return;
    const qBase = (quarter - 1) * 3 + 1;
    if (drawerMonth < qBase || drawerMonth > qBase + 2) setDrawerMonth(qBase);
  }, [view, year, quarter, drawerMonth]);

  // 点击其他地方关闭状态下拉
  useEffect(() => {
    if (editingStatusCell === null) return;
    const onDown = (e: MouseEvent) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setEditingStatusCell(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editingStatusCell]);

  // 图谱按钮 → 打开 GraphModal
  useEffect(() => {
    if (!showGraphDate) return;
    const filePath = getDatePath(showGraphDate);
    new GraphModal(app, filePath, showGraphDate).open();
    setShowGraphDate(null);
  }, [showGraphDate, app]);

  const grid = useMemo(() => {
    if (!calData) return [];
    return buildCalendarGrid(calData, today, { showSaturday: showSat, showSunday: showSun, showHolidays: showHolidays });
  }, [calData, today, showSat, showSun, showHolidays]);

  // 抽屉视图数据（周粒度，供右栏周卡）
  const quarterGrid = useMemo<QuarterWeekRow[]>(() => {
    return buildQuarterGrid(rangeLogs ?? new Map(), year, quarter, showSat, showSun, showHolidays);
  }, [rangeLogs, year, quarter, showSat, showSun, showHolidays]);

  // 项目胶囊：每月日志「一句话」按 PROJECT_EMOJI 聚合高频项目（月异左栏占比条用）
  const yearMonthChips = useMemo<Map<number, YearProjectChip[]>>(() => {
    const map = new Map<number, YearProjectChip[]>();
    for (let m = 1; m <= 12; m++) {
      const chips = buildYearProjectChips(rangeLogs ?? new Map(), m);
      if (chips.length > 0) map.set(m, chips);
    }
    return map;
  }, [rangeLogs]);

  // 年视图三色灯：直接从当月日志统计状态分布（与月报文件解耦，始终反映真实日志）
  const monthStatusMap = useMemo(() => {
    const map = new Map<number, { green: number; yellow: number; red: number }>();
    for (const [dateStr, entries] of rangeLogs ?? new Map()) {
      const m = parseInt(dateStr.slice(5, 7), 10);
      let cur = map.get(m);
      if (!cur) { cur = { green: 0, yellow: 0, red: 0 }; map.set(m, cur); }
      for (const e of entries) {
        if (e.status.includes('🟢')) cur.green++;
        else if (e.status.includes('🟡')) cur.yellow++;
        else if (e.status.includes('🔴')) cur.red++;
      }
    }
    return map;
  }, [rangeLogs]);

  // 季视图周报数据（把该年周报按 weekStart~weekEnd 关联）
  const [weeklyReports, setWeeklyReports] = useState<WeeklyReportInfo[]>([]);
  useEffect(() => {
    let alive = true;
    scanWeeklyReports(app, year).then((list) => { if (alive) setWeeklyReports(list); });
    return () => { alive = false; };
  }, [app, year]);

  // 年视图月报数据
  const [monthlyReports, setMonthlyReports] = useState<MonthlyReportInfo[]>([]);
  useEffect(() => {
    let alive = true;
    scanMonthlyReports(app, year).then((list) => { if (alive) setMonthlyReports(list); });
    return () => { alive = false; };
  }, [app, year]);

  // 周报/月报一键生成：创建后刷新对应列表，让空态即时消失
  const createWeekly = useCallback((weekStart: string) => {
    const start = new Date(weekStart + 'T12:00:00');
    const end = new Date(start); end.setDate(end.getDate() + 6);
    new ReportCreateModal(app, {
      kind: 'weekly', start, end,
      onCreated: () => { setWeeklyReports((prev) => prev.slice()); },
    }).open();
  }, [app]);
  const createMonthly = useCallback((m: number) => {
    new ReportCreateModal(app, {
      kind: 'monthly', month: m, year,
      onCreated: () => { setMonthlyReports((prev) => prev.slice()); },
    }).open();
  }, [app, year]);

  // 判断某周是否被某周报覆盖
  const weeklyByWeek = useMemo(() => {
    const map = new Map<string, WeeklyReportInfo>(); // 自然周start(周一) → 周报
    for (const w of weeklyReports) {
      // 周报归属到「起始日(周一)」所在自然周的周一，与季度网格的自然周 key 对齐；
      // 跨自然周的老周报（如 4/7~4/17）归回其起始周，与起始周三色灯对齐。
      const ws = sundayOf(w.periodStart);
      if (!map.has(ws)) map.set(ws, w);
    }
    return map;
  }, [weeklyReports]);

  // 某月是否已有月报
  const monthlyMap = useMemo(() => {
    const map = new Map<number, MonthlyReportInfo>();
    for (const m of monthlyReports) map.set(m.month, m);
    return map;
  }, [monthlyReports]);

  // 最终季视图行 = 周行 + 周报关联信息
  const quarterRowsWithWeekly = useMemo<{ row: QuarterWeekRow; report?: WeeklyReportInfo }[]>(() => {
    return quarterGrid.map((row) => ({ row, report: weeklyByWeek.get(row.weekStart) }));
  }, [quarterGrid, weeklyByWeek]);

  // 动态计算行高（仅日新/月视图用；月异视图卡片自行撑开）
  useLayoutEffect(() => {
    if (view === 'drawer') { setRowHeight(null); return; }
    const wrap = tableWrapRef.current;
    const rows = grid;
    if (!wrap || rows.length === 0) {
      setRowHeight(null);
      return;
    }
    const BORDER_SPACING = 3;
    const resize = () => {
      const table = wrap.querySelector('table');
      const thead = table?.querySelector('thead');
      if (!table || !thead) return;
      const tbodyRows = table.querySelectorAll('tbody tr');
      const rowCount = tbodyRows.length;
      if (rowCount === 0) return;
      const overhead = BORDER_SPACING * (rowCount + 1);
      const available = wrap.clientHeight - thead.clientHeight - overhead;
      setRowHeight(Math.max(24, Math.floor(available / rowCount)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [view, grid, quarterGrid]);

  const goPrev = () => {
    if (view === 'month') {
      if (month === 1) { setYear((y) => y - 1); setMonth(12); }
      else setMonth((m) => m - 1);
    } else {
      // 月异视图：按季度翻页
      if (quarter === 1) { setYear((y) => y - 1); setQuarter(4); }
      else setQuarter((q) => q - 1);
    }
  };

  const goNext = () => {
    if (view === 'month') {
      if (month === 12) { setYear((y) => y + 1); setMonth(1); }
      else setMonth((m) => m + 1);
    } else {
      // 月异视图：按季度翻页
      if (quarter === 4) { setYear((y) => y + 1); setQuarter(1); }
      else setQuarter((q) => q + 1);
    }
  };

  // 标题
  const viewTitle = useMemo(() => {
    if (view === 'month') return `${year}年 ${MONTH_NAMES[month - 1]}`;
    return `${year}年 第${quarter}季度`;
  }, [view, year, month, quarter]);

  // 抽屉视图：当前季度三个起始月（用于左栏月卡与周列过滤）
  const drawerBase = (quarter - 1) * 3 + 1;
  const drawerMonths = [drawerBase, drawerBase + 1, drawerBase + 2];

  // 抽屉视图：右栏周列表 = 选中月所在季度的所有自然周行（复用季视图数据）
  const drawerWeeks = useMemo(() => {
    if (view !== 'drawer') return [] as { row: QuarterWeekRow; report?: WeeklyReportInfo }[];
    return quarterRowsWithWeekly.filter(({ row }) => {
      const wm = parseInt(row.weekStart.slice(5, 7), 10);
      return wm === drawerMonth;
    });
  }, [view, quarterRowsWithWeekly, drawerMonth]);

  // 抽屉视图：左栏月卡渲染所需的工作量统计（每月 logDays + logCount）
  const drawerMonthMeta = useMemo(() => {
    const map = new Map<number, { logDays: number; logCount: number }>();
    for (const [dateStr, arr] of rangeLogs ?? new Map()) {
      const m = parseInt(dateStr.slice(5, 7), 10);
      let cur = map.get(m);
      if (!cur) { cur = { logDays: 0, logCount: 0 }; map.set(m, cur); }
      cur.logDays++;
      cur.logCount += arr.length;
    }
    return map;
  }, [rangeLogs]);

  // 格式化日期 YYYY-MM-DD
  const fmtDate = useCallback(
    (day: number) =>
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    [year, month],
  );

  // 点击 cell → 打开日记弹窗
  const handleCellClick = useCallback(
    (day: number) => {
      const dateStr = fmtDate(day);
      setSelectedDate(dateStr);
      const modal = new QuickDiaryModal(app, dateStr);
      modal.onAfterClose = () => {
        loadMonth(year, month);
      };
      modal.open();
    },
    [app, year, month, fmtDate, loadMonth],
  );

  // 直接打开日记文件
  const openLogFile = useCallback(
    (day: number) => {
      const dateStr = fmtDate(day);
      const filePath = getDatePath(dateStr);
      const file = app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        app.workspace.getLeaf(false).openFile(file);
      }
    },
    [app, fmtDate],
  );

  // 快速更新日记状态
  const updateDiaryStatus = useCallback(
    async (day: number, newStatus: string) => {
      const dateStr = fmtDate(day);
      const filePath = getDatePath(dateStr);
      const file = app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        setEditingStatusCell(null);
        return;
      }
      try {
        await app.vault.process(file, (content) => {
          return content.replace(/\*\*今日状态\*\*[：:].*/, `**今日状态**：${newStatus}`);
        });
        // 即时更新本地数据
        setCalData((prev) => {
          if (!prev) return prev;
          const newEntries = new Map(prev.entries);
          const existing = newEntries.get(day);
          if (existing) {
            newEntries.set(day, { ...existing, status: newStatus });
          }
          return { ...prev, entries: newEntries };
        });
      } catch { /* 静默 */ }
      setEditingStatusCell(null);
    },
    [app, fmtDate],
  );

// ===== 日历 cell 状态 badge（模块级组件，避免嵌套定义导致每次渲染重挂载） =====
function CalStatusBadge({
  status, isOpen, dropdownRef, onToggle, onChange,
}: {
  status: string; isOpen: boolean;
  dropdownRef: React.RefObject<HTMLDivElement>;
  onToggle: () => void; onChange: (s: string) => void;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const el = spanRef.current;
    if (!el) return;

    // 临时解除约束，测量文字真实宽度
    // 注：用 style 属性/removeProperty 完成动态测量（静态对象传入 setCssProps 会被社区 obsidianmd 规则标记）
    const prevMax = el.style.maxWidth;
    el.style.removeProperty('max-width');
    const textWidth = el.scrollWidth;
    if (prevMax) {
      el.style.maxWidth = prevMax;
    }

    // 获取所在行可用宽度
    const row = el.closest('.mswb-cal-day-row') as HTMLElement | null;
    if (!row) return;
    const rowWidth = row.clientWidth;
    // 扣除日期数字 + 按钮占位 + 间距
    const dateEl = row.querySelector('.mswb-cal-day-num') as HTMLElement | null;
    const dateW = dateEl ? dateEl.offsetWidth : 24;
    const btnsW = 42;  // 📄🔗 两个按钮约 42px
    const gapW = 12;   // gap 间距
    const available = rowWidth - dateW - btnsW - gapW;

    setCompact(textWidth > available);
  }, [status]);

  // surrogate-pair 安全提取
  const emoji = status.match(/^(🟢|🟡|🔴)/)?.[1] || '⚪';

  return (
    <span
      ref={(el) => {
        (spanRef as any).current = el;
        if (isOpen && el) (dropdownRef as any).current = el;
      }}
      className="mswb-cal-status clickable"
      style={{ whiteSpace: 'nowrap', maxWidth: '72px', textOverflow: 'clip', flexShrink: 1 }}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      {compact ? emoji : status}
      {isOpen && (
        <div className="mswb-status-dropdown">
          {Object.values(STATUS_OPTIONS).map((s: string) => (
            <div
              key={s}
              className={`mswb-status-option ${s === status ? 'current' : ''}`}
              onClick={(e) => { e.stopPropagation(); onChange(s); }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

  return (
    <div className="mswb-calendar">
      {/* 导航：视图切换 + 日期导航 同一行 */}
      <div className="mswb-cal-nav">
        <div className="mswb-cal-view-switch">
          {CAL_VIEWS.map((v) => (
            <button
              key={v.key}
              className={`mswb-cal-view-btn${view === v.key ? ' active' : ''}`}
              onClick={() => setView(v.key)}
              title={v.hint}
            >
              {v.icon}{v.label}
            </button>
          ))}
        </div>
        <button className="mswb-cal-nav-btn" onClick={goPrev}>
          ◀
        </button>
        <span className="mswb-cal-title">{viewTitle}</span>
        <button className="mswb-cal-nav-btn" onClick={goNext}>
          ▶
        </button>
      </div>

      {/* 表格 */}
      {loading ? (
        <div className="mswb-cal-loading">加载中...</div>
      ) : view === 'drawer' ? (
        <DrawerTableView
          monthQuarters={drawerMonths}
          monthStatusMap={monthStatusMap}
          monthlyMap={monthlyMap}
          yearMonthChips={yearMonthChips}
          selMonth={drawerMonth}
          monthLogMeta={drawerMonthMeta}
          drawerWeeks={drawerWeeks}
          onSelectMonth={(m: number) => setDrawerMonth(m)}
          onEnterMonth={(m: number) => {
            const ym = year * 12 + (m - 1);
            const ny = Math.floor(ym / 12);
            const nm = (ym % 12) + 1;
            setYear(ny); setMonth(nm); setQuarter(Math.floor((nm - 1) / 3) + 1); setView('month');
          }}
          openMonthly={(relPath: string) => openVaultFile(app, relPath)}
          openReport={(relPath: string) => openVaultFile(app, relPath)}
          createWeekly={createWeekly}
          createMonthly={createMonthly}
        />
      ) : (
        <div className="mswb-cal-table-wrap" ref={tableWrapRef}>
          <table className="mswb-cal-table">
            <thead>
              <tr>
                {calendarColumns(showSat, showSun).map((c) => (
                  <th key={c.index}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((week, wi) => (
                <tr key={wi} style={{ height: rowHeight ?? undefined }}>
                  {week.cells.map((cell, ci) => {
                    if (!cell) {
                      return <td key={ci} className="mswb-cal-empty" />;
                    }
                    const isToday = cell.isToday;
                    const hasLog = cell.hasLog;
                    const entry = cell.entry;
                    const isSelected = selectedDate === fmtDate(cell.day);
                    const isHoliday = cell.holiday;

                    return (
                      <td
                        key={ci}
                        className={`mswb-cal-day ${isToday ? 'today' : ''} ${hasLog ? 'has-log' : ''} ${isSelected ? 'selected' : ''} ${isHoliday ? (isHoliday.isHoliday ? 'holiday' : 'makeup-day') : ''} ${!hasLog && !isToday && (isHoliday?.isHoliday) ? 'holiday-empty' : ''}`}
                        onClick={() => handleCellClick(cell.day)}
                        title={hasLog ? '点击编辑日记' : '点击创建日记'}
                      >
                        {/* 第一行：日期数字 + 状态 + 快捷按钮 */}
                        <div className="mswb-cal-day-row">
                          <div className="mswb-cal-day-num">{cell.day}</div>
                          {/* 节假日 / 补班标注（红底=休，蓝底=班） */}
                          {isHoliday && (
                            <span className={`mswb-cal-holiday ${isHoliday.isHoliday ? 'holiday' : 'makeup'}`}>
                              {isHoliday.name}
                            </span>
                          )}
                          {entry?.status && (
                            <CalStatusBadge
                              status={entry.status}
                              isOpen={editingStatusCell === cell.day}
                              dropdownRef={statusDropdownRef}
                              onToggle={() =>
                                setEditingStatusCell(editingStatusCell === cell.day ? null : cell.day)
                              }
                              onChange={(s: string) => updateDiaryStatus(cell.day, s)}
                            />
                          )}
                          {hasLog && (
                            <>
                              <button
                                className="mswb-cal-open-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openLogFile(cell.day);
                                }}
                                title="在编辑器中打开"
                              >
                                📄
                              </button>
                              <button
                                className="mswb-cal-open-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShowGraphDate(showGraphDate === fmtDate(cell.day) ? null : fmtDate(cell.day));
                                }}
                                title="查看双链图谱"
                              >
                                🔗
                              </button>
                            </>
                          )}
                        </div>

                        {/* 一句话摘要（纯文本） */}
                        {entry?.summary && (
                          <div className="mswb-cal-summary" title={entry.summary}>
                            {entry.summary}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mswb-cal-hint">
        {view === 'month'
          ? `${calData?.entries.size ?? 0} 篇日志 · 点击日期编辑 · 点击状态快速切换`
          : '月异视图 · 点击月度卡片切换 · 点击周卡查看周报详情'}
      </div>
    </div>
  );
}

/** 打开 vault 内文件（周报/月报点开用） */
function openVaultFile(app: App, relPath: string): void {
  const file = app.vault.getAbstractFileByPath(relPath);
  if (file instanceof TFile) {
    app.workspace.getLeaf(false).openFile(file);
  }
}

/** 某日期（YYYY-MM-DD）所在自然周的周一（周一起始；周日归回本周一） */
function sundayOf(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 状态 → 圆点颜色 */
function statusColor(s: string): string {
  if (s.includes('🟢')) return 'var(--color-green, #30a46c)';
  if (s.includes('🟡')) return 'var(--color-yellow, #f5a623)';
  if (s.includes('🔴')) return 'var(--color-red, #e5484d)';
  return 'var(--text-faint)';
}

// ===== 抽屉视图主组件 =====
const CHIP_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a623', '#9a41cf', '#d97706', '#0d9488', '#64748b', '#b45309', '#c0287c'];

/** 稳定哈希：由项目名派生一个固定色板索引（同类目跨月同色） */
function hashChipIndex(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}

/** 月卡忙度色块：按月内🟢🟡🔴占比切段（占满卡片宽） */
function MonthBar({ st }: { st?: { green: number; yellow: number; red: number } }) {
  const total = st ? st.green + st.yellow + st.red : 0;
  if (!total) return null;
  const seg = (v: number, c: string, key: string) =>
    v > 0 ? <span key={key} style={{ flexGrow: v, background: c }} className="mswb-cal-monthbar-seg" /> : null;
  return (
    <div className="mswb-cal-monthbar" title="忙碌强度">
      {seg(st.green, 'var(--color-green, #30a46c)', 'g')}
      {seg(st.yellow, 'var(--color-yellow, #f5a623)', 'y')}
      {seg(st.red, 'var(--color-red, #e5484d)', 'r')}
    </div>
  );
}

/** 月卡内的占比条：一行色块按项目命中占比切段；下方一行小图例（色点+项目名） */
function ChipBar({ chips, onChip }: {
  chips: YearProjectChip[];
  onChip?: (label: string) => void;
}) {
  const total = chips.reduce((s, c) => s + c.count, 0);
  if (total === 0) return null;
  return (
    <div className="mswb-cal-chipbar">
      <div className="mswb-cal-chipbar-row">
        {chips.map((c) => (
          <span
            key={c.label}
            className="mswb-cal-chipbar-seg"
            title={`${c.label} · ${c.count} 条`}
            style={{
              flexGrow: c.count,
              background: c.other ? 'var(--color-grey, #888)' : CHIP_COLORS[hashChipIndex(c.label, CHIP_COLORS.length)],
            }}
          />
        ))}
      </div>
      <div className="mswb-cal-chipbar-legend">
        {chips.map((c) => (
          <span
            key={c.label}
            className={`mswb-cal-chipbar-item${c.other ? ' other' : ''}`}
            onClick={(e) => { e.stopPropagation(); onChip?.(c.label); }}
            title={`${c.label} · ${c.count} 条`}
          >
            <i style={{ background: c.other ? 'var(--color-grey, #888)' : CHIP_COLORS[hashChipIndex(c.label, CHIP_COLORS.length)] }} />
            {c.label.replace(/^[^\s]+\s/, '')}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 抽屉视图：左栏 3 月卡（占比条+图例）+ 右栏选中月周卡（纵向，复用季视图卡片） */
function DrawerTableView({
  monthQuarters, monthStatusMap, monthlyMap, yearMonthChips, selMonth,
  monthLogMeta, drawerWeeks, onSelectMonth, onEnterMonth, openMonthly, openReport,
  createWeekly, createMonthly,
}: {
  monthQuarters: number[];
  monthStatusMap: Map<number, { green: number; yellow: number; red: number }>;
  monthlyMap: Map<number, { filePath: string; aiSummary: string }>;
  yearMonthChips: Map<number, YearProjectChip[]>;
  selMonth: number;
  monthLogMeta: Map<number, { logDays: number; logCount: number }>;
  drawerWeeks: { row: QuarterWeekRow; report?: { filePath: string; aiSummary: string; projects: string[] } }[];
  onSelectMonth: (m: number) => void;
  onEnterMonth: (m: number) => void;
  openMonthly: (relPath: string) => void;
  openReport: (relPath: string) => void;
  createWeekly: (weekStart: string) => void;
  createMonthly: (m: number) => void;
}) {
  return (
    <div className="mswb-cal-drawer">
      {/* 左栏：季度三月的月卡 */}
      <div className="mswb-cal-drawer-months">
        {monthQuarters.map((m) => {
          const isSel = m === selMonth;
          const st = monthStatusMap.get(m);
          const mp = monthlyMap.get(m);
          const chips = yearMonthChips.get(m);
          const rangeDays = monthLogMeta.get(m);
          return (
            <div
              key={m}
              className={`mswb-cal-drawer-month${isSel ? ' selected' : ''}${(rangeDays?.logCount ?? 0) > 0 ? ' has-log' : ''}`}
              onClick={() => onSelectMonth(m)}
              title={mp ? `${m}月 · 已有月报` : `${m}月`}
            >
              <div className="mswb-cal-year-head" style={{ marginBottom: 4 }}>
                <span className="mswb-cal-year-month">{m}月</span>
                <div className="mswb-cal-year-head-right">
                  {st && (st.green > 0 || st.yellow > 0 || st.red > 0) && (
                    <span className="mswb-cal-year-lights" title="🟢在线 / 🟡有点忙 / 🔴忙炸">
                      {st.green > 0 && <span className="mswb-cal-year-lamp green">{st.green}</span>}
                      {st.yellow > 0 && <span className="mswb-cal-year-lamp yellow">{st.yellow}</span>}
                      {st.red > 0 && <span className="mswb-cal-year-lamp red">{st.red}</span>}
                    </span>
                  )}
                  {mp ? (
                    <button className="mswb-cal-year-open-ico" onClick={(ev) => { ev.stopPropagation(); openMonthly(mp.filePath); }} title="打开当月月报">📄</button>
                  ) : (
                    <button className="mswb-cal-year-open-ico" onClick={(ev) => { ev.stopPropagation(); createMonthly(m); }} title="一键创建本月月报骨架">➕</button>
                  )}
                  {(rangeDays?.logCount ?? 0) > 0 && (
                    <button className="mswb-cal-year-open-ico" onClick={(ev) => { ev.stopPropagation(); onEnterMonth(m); }} title="进入月视图">✍️</button>
                  )}
                </div>
              </div>
              {/* 占比条：项目命中占比 */}
              {chips && chips.length > 0 ? (
                <ChipBar chips={chips} />
              ) : (
                <div className="mswb-cal-drawer-empty">无记录</div>
              )}
            </div>
          );
        })}
      </div>
      {/* 右栏：选中月的周卡（纵向） */}
      <div className="mswb-cal-drawer-weeks">
        {drawerWeeks.length === 0 ? (
          <div className="mswb-cal-drawer-empty-big">本月暂无周记录</div>
        ) : (
          drawerWeeks.map(({ row, report }, ri) => {
            const sM = parseInt(row.weekStart.slice(5, 7));
            const sD = parseInt(row.weekStart.slice(8, 10));
            let green = 0, yellow = 0, red = 0, logDays = new Set<number>();
            for (const c of row.cells) {
              if (!c) continue;
              if (c.count > 0) logDays.add(c.day);
              for (const s of c.statuses) {
                if (s.includes('🟢')) green++;
                else if (s.includes('🟡')) yellow++;
                else if (s.includes('🔴')) red++;
              }
            }
            const hasLog = logDays.size > 0 || (report?.projects.length ?? 0) > 0;
            // 周范围文案：7月1周（7/1~7/5）——统一 M/D 格式，兼容跨月/跨季
            const eDNum = parseInt(row.weekEnd.slice(8, 10));
            const eMNum = parseInt(row.weekEnd.slice(5, 7));
            const wkInMonth = Math.floor((sD - 1) / 7) + 1;
            const rangeLabel = `${sM}月${wkInMonth}周（${sM}/${sD}~${eMNum}/${eDNum}）`;
            return (
              <div
                key={ri}
                className={`mswb-cal-week-card${report ? ' with-report' : ''}${hasLog ? ' has-log' : ''}`}
                title="点击可编辑当周日志"
              >
                <div className="mswb-cal-week-head">
                  <span className="mswb-cal-week-range">{rangeLabel}</span>
                  <div className="mswb-cal-week-head-right">
                    {hasLog && (
                      <span className="mswb-cal-week-lights">
                        {green > 0 && <span className="mswb-cal-week-lamp green">{green}</span>}
                        {yellow > 0 && <span className="mswb-cal-week-lamp yellow">{yellow}</span>}
                        {red > 0 && <span className="mswb-cal-week-lamp red">{red}</span>}
                      </span>
                    )}
                    {report && (
                      <button className="mswb-cal-report-btn" onClick={(ev) => { ev.stopPropagation(); openReport(report.filePath); }} title="打开当周周报">📄</button>
                    )}
                  </div>
                </div>
                <div className="mswb-cal-week-main">
                  {report ? (
                    <>
                      <div className="mswb-cal-week-tags">
                        {(report.projects.length ? report.projects : ['本周无项目标签']).slice(0, 6).map((t, i) => (
                          <span key={i} className="mswb-cal-week-tag">
                            {t.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim()}
                          </span>
                        ))}
                      </div>
                      {report.aiSummary && <div className="mswb-cal-week-ai" title={report.aiSummary}>{report.aiSummary}</div>}
                    </>
                  ) : (
                    <div className="mswb-cal-week-ai mswb-cal-week-ai-empty">
                      <div>{hasLog ? '本周有日志，暂无周报' : '— 本周无记录 —'}</div>
                      <div><button className="mswb-cal-cmd" onClick={(ev) => { ev.stopPropagation(); createWeekly(row.weekStart); }} title="创建周工作总结骨架文件">➕ 一键生成周报</button></div>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ===== 项目总览面板 =====
function ProjectsPanel({ app }: { app: App }) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortMode, setSortMode] = useState<SortMode>('source');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    scanProjects(app).then((data) => {
      setProjects(data);
      setLoading(false);
    });
  }, [app, refreshKey]);

  // 未配置项目根目录（新用户零配置）→ 提供直接新建入口（无需先进设置）
  const noRoots = (getConfig().projectRoots ?? []).length === 0;
  if (noRoots) {
    return (
      <div className="mswb-placeholder">
        <div className="mswb-placeholder-icon" style={{ fontSize: 32 }}>📂</div>
        <p style={{ margin: '0 0 8px' }}>尚未配置项目根目录</p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>可直接新建项目（自动创建存放文件夹），或在「设置 → 猛士驾驶舱 → 项目根目录」手动添加</p>
        <button
          className="mswb-sort-btn active"
          style={{ marginTop: 16, padding: '6px 24px' }}
          onClick={() => new CreateProjectModal(app).open()}
        >
          🆕 新建项目
        </button>
      </div>
    );
  }

  const groups = useMemo<ProjectGroup[]>(() => {
    if (sortMode === 'source') return groupBySource(projects);
    if (sortMode === 'tag') return groupByTag(projects);
    if (sortMode === 'system') return groupBySystem(projects);
    return [{ key: 'all', label: `全部项目（${projects.length}）`, projects }];
  }, [projects, sortMode]);

  const stats = useMemo(() => {
    return {
      total: projects.length,
      totalFiles: projects.reduce((s, p) => s + p.fileCount, 0),
      tags: new Set(projects.map((p) => p.tag)).size,
      systems: new Set(projects.map((p) => p.systemType)).size,
    };
  }, [projects]);

  // 日期 Map：GANTT_DATA 为基础，ganttOverrides 覆盖（与甘特图同源）
  const dateMap = useMemo(() => {
    const map = new Map<string, { start: string; end: string }>();
    for (const t of GANTT_DATA) {
      map.set(t.id, { start: t.start, end: t.end });
    }
    const overrides = getGanttOverrides();
    for (const [id, ov] of Object.entries(overrides)) {
      const existing = map.get(id);
      if (existing) {
        if (ov.start) existing.start = ov.start;
        if (ov.end) existing.end = ov.end;
      } else if (ov.start && ov.end) {
        map.set(id, { start: ov.start, end: ov.end });
      }
    }
    return map;
  }, [refreshKey]);

  if (loading) {
    return (
      <div className="mswb-placeholder">
        <div className="mswb-placeholder-icon">🔍</div>
        <p>扫描项目中...</p>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="mswb-placeholder">
        <div className="mswb-placeholder-icon" style={{ fontSize: 32 }}>📂</div>
        <p>未发现项目</p>
        <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>可直接新建项目（自动创建项目文件夹），或在现有项目文件夹下放 README 后手动刷新</p>
        <button
          className="mswb-sort-btn active"
          style={{ marginTop: 16, padding: '6px 24px' }}
          onClick={() => new CreateProjectModal(app).open()}
        >
          🆕 新建项目
        </button>
      </div>
    );
  }

  return (
    <div className="mswb-projects">
      {/* 统计栏 */}
      <div className="mswb-proj-stats">
        <span className="mswb-stat">
          <strong>{stats.total}</strong> 个项目
        </span>
        <span className="mswb-stat">
          <strong>{stats.totalFiles}</strong> 篇文档
        </span>
        <span className="mswb-stat">
          <strong>{stats.tags}</strong> 个标签
        </span>
        <span className="mswb-stat">
          <strong>{stats.systems}</strong> 类系统
        </span>
        <button
          className="mswb-sort-btn active"
          onClick={() => new CreateProjectModal(app).open()}
          style={{ marginLeft: 'auto' }}
        >
          🆕 新建项目
        </button>
      </div>

      {/* 排序切换 */}
      <div className="mswb-proj-sort">
        {([
          { key: 'source', label: '📂 按领域' },
          { key: 'tag', label: '🏷 按标签' },
          { key: 'system', label: '⚙ 按类别' },
        ] as { key: SortMode; label: string }[]).map((opt) => (
          <button
            key={opt.key}
            className={`mswb-sort-btn ${sortMode === opt.key ? 'active' : ''}`}
            onClick={() => setSortMode(opt.key)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* 分组列表 */}
      <div className="mswb-proj-groups">
        {groups.map((group) => (
          <ProjectGroupBlock key={group.key} group={group} app={app} dateMap={dateMap} onMetaChange={() => setRefreshKey((k) => k + 1)} />
        ))}
      </div>
    </div>
  );
}

// ===== 分组块 =====
function ProjectGroupBlock({
  group,
  app,
  dateMap,
  onMetaChange,
}: {
  group: ProjectGroup;
  app: App;
  dateMap: Map<string, { start: string; end: string }>;
  onMetaChange?: () => void;
}) {
  const [editingDomain, setEditingDomain] = useState(false);
  const domainIcon = getDomainIcon(group.key);
  const domainRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!editingDomain) return;
    const onDown = (e: MouseEvent) => {
      if (domainRef.current && !domainRef.current.contains(e.target as Node)) setEditingDomain(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editingDomain]);

  return (
    <div className="mswb-proj-group">
      <div className="mswb-proj-group-header">
        <span
          ref={domainRef}
          style={{ cursor: 'pointer', position: 'relative', userSelect: 'none' }}
          onClick={() => setEditingDomain(!editingDomain)}
          title="点击更换领域图标"
        >
          {domainIcon}
          {editingDomain && (
            <span className="mswb-emoji-popup" style={{ top: '100%', left: 0 }} onClick={(e) => e.stopPropagation()}>
              {['🚀','💻','🚗','🏭','🔍'].map((e) => (
                <span key={e} className="mswb-emoji-opt" onClick={async () => {
                  await setDomainIcon(group.key, e);
                  setEditingDomain(false);
                  onMetaChange?.();
                }}>{e}</span>
              ))}
            </span>
          )}
        </span>
        <h3>{group.label}</h3>
        <span className="mswb-badge">{group.projects.length}</span>
      </div>
      <div className="mswb-proj-cards">
        {group.projects.map((p) => (
          <ProjectCard key={p.folderPath} project={p} app={app} dateMap={dateMap} onMetaChange={onMetaChange} />
        ))}
      </div>
    </div>
  );
}

// ===== 项目卡片 =====
function ProjectCard({ project, app, dateMap, onMetaChange }: { project: ProjectInfo; app: App; dateMap: Map<string, { start: string; end: string }>; onMetaChange?: () => void }) {
  const [baseUrl, setBaseUrl] = useState(project.baseUrl ?? '');
  const [editing, setEditing] = useState(false);
  const [editingTag, setEditingTag] = useState<'tag' | 'systemType' | 'emoji' | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLSpanElement>(null);

  // 点击菜单外部关闭
  useEffect(() => {
    if (!editingTag) return;
    const onDown = (e: MouseEvent) => {
      const clicked = e.target as Node;
      if (editingTag === 'emoji' && emojiRef.current && !emojiRef.current.contains(clicked)) {
        setEditingTag(null);
      } else if (menuRef.current && !menuRef.current.contains(clicked)) {
        setEditingTag(null); setShowCustom(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editingTag]);

  const openFile = (path: string) => {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      app.workspace.getLeaf(false).openFile(file);
    }
  };

  const handleSaveUrl = async () => {
    const trimmed = baseUrl.trim();
    if (trimmed) {
      await writeUrlToReadme(app, project.folderPath, trimmed, project.name);
    } else {
      await removeUrlFromReadme(app, project.folderPath);
    }
    setEditing(false);
    onMetaChange?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSaveUrl();
    if (e.key === 'Escape') setEditing(false);
  };

  return (
    <div className="mswb-card">
      {/* 头部 */}
      <div className="mswb-card-head">
        <span
          ref={emojiRef}
          className="mswb-card-emoji"
          onClick={(e) => { e.stopPropagation(); setEditingTag('emoji'); }}
          title="点击更换图标"
          style={{ cursor: 'pointer', position: 'relative' }}
        >
          {project.emoji}
          {editingTag === 'emoji' && (
            <span className="mswb-emoji-popup" onClick={(e) => e.stopPropagation()}>
              {[
                '🤖','📦','🛡️','🔄','📉','🧠','🔍','📋','⚙','🔧',
                '💻','🔬','📊','🎯','⭐','🚗','🌍','🏭','🔩','📐',
              ].map((e) => (
                <span
                  key={e}
                  className="mswb-emoji-opt"
                  onClick={async () => {
                    await saveProjectMeta(project.folderName, { emoji: e });
                    setEditingTag(null);
                    onMetaChange?.();
                  }}
                  title={e}
                >{e}</span>
              ))}
            </span>
          )}
        </span>
        <div className="mswb-card-title-group">
          <h4 className="mswb-card-title">{project.name}</h4>
          <div className="mswb-card-tags">
            {editingTag === 'tag' ? (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <span
                  className="mswb-tag mswb-tag-tag"
                  style={{ cursor: 'pointer', outline: '1px solid var(--interactive-accent)' }}
                  onClick={() => setEditingTag(null)}
                >
                  {project.tag}
                </span>
                <span className="mswb-tag-menu" ref={menuRef}>
                  {showCustom ? (
                    <input
                      className="mswb-tag-edit-select"
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && customInput.trim()) {
                          await addCustomTag(customInput.trim());
                          await saveProjectMeta(project.folderName, { tag: customInput.trim() });
                          setCustomInput(''); setShowCustom(false); setEditingTag(null);
                          onMetaChange?.();
                        }
                        if (e.key === 'Escape') { setCustomInput(''); setShowCustom(false); setEditingTag(null); }
                      }}
                      placeholder="输入新标签…"
                      autoFocus
                    />
                  ) : (
                    <>
                      {getTags().map((v) => {
                        const isBase = getConfig().baseTags.includes(v);
                        return (
                          <span key={v} className="mswb-tag-menu-item" onClick={async () => {
                            try { await saveProjectMeta(project.folderName, { tag: v }); } catch { /* 保存失败时静默忽略 */ }
                            setEditingTag(null);
                            onMetaChange?.();
                          }}>
                            {v}
                            {!isBase && (
                              <button
                                className="mswb-tag-menu-del"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  try { await removeCustomTag(v); } catch { /* 删除失败时静默忽略 */ }
                                  onMetaChange?.();
                                }}
                                title="删除此标签"
                              >
                                ✕
                              </button>
                            )}
                          </span>
                        );
                      })}
                      <span className="mswb-tag-menu-divider" />
                      <span
                        className="mswb-tag-menu-item"
                        onClick={() => { setShowCustom(true); setCustomInput(''); }}
                      >
                        + 自定义…
                      </span>
                    </>
                  )}
                </span>
              </span>
            ) : (
              <span
                className="mswb-tag mswb-tag-tag"
                onClick={() => { setEditingTag('tag'); setShowCustom(false); }}
                title="点击编辑标签"
                style={{ cursor: 'pointer' }}
              >
                {project.tag}
              </span>
            )}
            {editingTag === 'systemType' ? (
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <span
                  className="mswb-tag mswb-tag-system"
                  style={{ cursor: 'pointer', outline: '1px solid var(--interactive-accent)' }}
                  onClick={() => setEditingTag(null)}
                >
                  {project.systemType}
                </span>
                <span className="mswb-tag-menu" ref={menuRef}>
                  {showCustom ? (
                    <input
                      className="mswb-tag-edit-select"
                      value={customInput}
                      onChange={(e) => setCustomInput(e.target.value)}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter' && customInput.trim()) {
                          try {
                            await addCustomCategory(customInput.trim());
                            await saveProjectMeta(project.folderName, { systemType: customInput.trim() });
                          } catch { /* 保存失败时静默忽略 */ }
                          setCustomInput(''); setShowCustom(false); setEditingTag(null);
                          onMetaChange?.();
                        }
                        if (e.key === 'Escape') { setCustomInput(''); setShowCustom(false); setEditingTag(null); }
                      }}
                      placeholder="输入新类别…"
                      autoFocus
                    />
                  ) : (
                    <>
                      {getCategories().map((c) => {
                        const isBase = getConfig().baseCategories.includes(c);
                        const usage = isBase ? 0 : getCategoryUsage(c);
                        return (
                          <span key={c} className="mswb-tag-menu-item" onClick={async (e) => {
                            if ((e.target as HTMLElement).closest('.mswb-tag-menu-del')) return;
                            try {
                              await saveProjectMeta(project.folderName, { systemType: c });
                            } catch { /* 保存失败时静默忽略 */ }
                            setEditingTag(null);
                            onMetaChange?.();
                          }}>
                            {c}
                            {!isBase && (
                              <button
                                className="mswb-tag-menu-del"
                                disabled={usage > 0}
                                onClick={usage === 0 ? async (e) => {
                                  e.stopPropagation();
                                  try { await removeCustomCategory(c); } catch { /* 删除失败时静默忽略 */ }
                                  onMetaChange?.();
                                } : undefined}
                                title={usage > 0 ? `有 ${usage} 个项目使用，不可删除` : '删除此类别'}
                              >
                                ✕
                              </button>
                            )}
                          </span>
                        );
                      })}
                      <span className="mswb-tag-menu-divider" />
                      <span
                        className="mswb-tag-menu-item"
                        onClick={() => { setShowCustom(true); setCustomInput(''); }}
                      >
                        + 自定义…
                      </span>
                    </>
                  )}
                </span>
              </span>
            ) : (
              <span
                className="mswb-tag mswb-tag-system"
                onClick={() => { setEditingTag('systemType'); setShowCustom(false); }}
                title="点击编辑系统类别"
                style={{ cursor: 'pointer' }}
              >
                {project.systemType}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 描述 */}
      <p className="mswb-card-desc">{project.description}</p>

      {/* 元信息 */}
      <div className="mswb-card-meta">
        <span className="mswb-meta-item" title="文档数量">
          📄 {project.fileCount} 篇
        </span>
        {(() => {
          const gd = dateMap.get(project.folderName);
          if (gd) {
            return (
              <span className="mswb-meta-item" title={`${gd.start} ~ ${gd.end}`}>
                📅 {fmtShortDate(gd.start)} ~ {fmtShortDate(gd.end)}
              </span>
            );
          }
          return null;
        })()}
        <span className="mswb-meta-item" title="最近更新">
          🕐 {formatDate(project.lastModified)}
        </span>
      </div>

      {/* 操作按钮 */}
      <div className="mswb-card-actions">
        {project.readmePath && (
          <button
            className="mswb-action-btn"
            onClick={() => openFile(project.readmePath!)}
          >
            📋 README
          </button>
        )}
        <button
          className="mswb-action-btn"
          onClick={() =>
            new ProjectFilesModal(app, project.folderPath, project.name).open()
          }
        >
          📄 文件（{project.fileCount}）
        </button>
        {editing ? (
          <div className="mswb-action-edit">
            <input
              className="mswb-action-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSaveUrl}
              placeholder="输入云文档链接"
              autoFocus
            />
          </div>
        ) : baseUrl ? (
          <a
            className="mswb-action-link"
            href={baseUrl}
            target="_blank"
            rel="noopener"
            title="左键打开 · 右键编辑"
            onContextMenu={(e) => {
              e.preventDefault();
              setEditing(true);
            }}
          >
            📊 云文档
          </a>
        ) : (
          <button
            className="mswb-action-btn"
            style={{ opacity: 0.5 }}
            onClick={() => setEditing(true)}
          >
            📊 + 云文档
          </button>
        )}
      </div>
    </div>
  );
}

// ===== 待办面板 =====
function TodosPanel({ app }: { app: App }) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [filterProject, setFilterProject] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    const data = await scanTasks(app);
    setTasks(data);
    setLoading(false);
  }, [app]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // 提取所有项目名用于筛选
  const projectList = useMemo(() => {
    const set = new Map<string, string>(); // key → label
    for (const t of tasks) {
      if (t.project && t.projectName) {
        set.set(t.project, t.projectName);
      }
    }
    return Array.from(set.entries()).sort(([, a], [, b]) => a.localeCompare(b, 'zh'));
  }, [tasks]);

  // 筛选后分组
  const { groups } = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (!showDone && t.done) return false;
      if (filterProject && t.project !== filterProject) return false;
      return true;
    });
    return { groups: groupTasks(filtered) };
  }, [tasks, showDone, filterProject]);

  const handleToggle = async (task: TaskItem) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === task.id ? { ...t, done: !t.done } : t,
      ),
    );
    await toggleTaskApi(app, task);
  };

  const openFile = (path: string, line: number) => {
    const file = app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const leaf = app.workspace.getLeaf(false);
      leaf.openFile(file, { eState: { line } });
    }
  };

  if (loading) {
    return (
      <div className="mswb-placeholder">
        <div className="mswb-placeholder-icon">🔍</div>
        <p>扫描待办中...</p>
      </div>
    );
  }

  const totalDone = tasks.filter((t) => t.done).length;
  const totalUndone = tasks.length - totalDone;

  return (
    <div className="mswb-todos">
      {/* 统计 + 筛选 */}
      <div className="mswb-proj-stats">
        <span className="mswb-stat">
          <strong>{totalUndone}</strong> 待办
        </span>
        <span className="mswb-stat">
          <strong>{totalDone}</strong> 已完成
        </span>
        {/* 项目筛选下拉 */}
        <select
          className="mswb-tag-edit-select"
          value={filterProject ?? ''}
          onChange={(e) => setFilterProject(e.target.value || null)}
          style={{ marginLeft: 8 }}
        >
          <option value="">全部项目</option>
          {projectList.map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <button
          className="mswb-sort-btn"
          onClick={() => setShowDone(!showDone)}
          style={{ marginLeft: 'auto' }}
        >
          {showDone ? '🔽 隐藏已完成' : '▶ 显示已完成'}
        </button>
      </div>

      {/* 分组列表 */}
      <div className="mswb-todo-groups">
        {groups.map((group) => {
          const groupDone = group.tasks.filter((t) => t.done).length;
          const groupTotal = group.tasks.length;
          return (
            <div key={group.key} className="mswb-todo-group">
              <div className="mswb-proj-group-header">
                <span className="mswb-todo-emoji">{group.emoji}</span>
                <h3>{group.label}</h3>
                {groupTotal > 0 && (
                  <span className="mswb-badge">
                    {groupDone}/{groupTotal}
                  </span>
                )}
              </div>
              <div className="mswb-todo-list">
                {group.tasks.map((task) => {
                  const isDone = task.done;
                  return (
                    <div
                      key={task.id}
                      className={`mswb-todo-item ${isDone ? 'done' : ''}`}
                    >
                      <button
                        className={`mswb-todo-check ${isDone ? 'done' : ''}`}
                        onClick={() => handleToggle(task)}
                        title={isDone ? '取消完成' : '标记完成'}
                      >
                        {isDone ? '✓' : '○'}
                      </button>
                      <span
                        className="mswb-todo-text"
                        onClick={() => openFile(task.filePath, task.line)}
                        title={`${task.fileName}:${task.line + 1}`}
                      >
                        {task.text}
                      </span>
                      <span title={formatDate(task.mtime)} className="mswb-todo-time">
                        {formatDate(task.mtime)}
                      </span>
                      <span
                        className="mswb-todo-source"
                        onClick={() => openFile(task.filePath, task.line)}
                      >
                        {task.fileName}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mswb-cal-hint">
        点击任务文字跳转到源文件 · 点击 ○ 标记完成
        {filterProject && ` · 已筛选: ${projectList.find(([k]) => k === filterProject)?.[1] ?? filterProject}`}
      </div>
    </div>
  );
}
