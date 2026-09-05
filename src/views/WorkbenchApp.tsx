import React, { useEffect, useState, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
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
  buildCalendarGrid,
  MONTH_NAMES,
  WEEKDAYS,
  type CalendarMonth,
} from '../data/logScanner';
import {
  scanTasks,
  groupTasks,
  toggleTask as toggleTaskApi,
  type TaskItem,
  type TaskGroup as TaskGroupType,
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
  const [y, m, d] = ymd.split('-');
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
function CalendarPanel({ app }: { app: App }) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [calData, setCalData] = useState<CalendarMonth | null>(null);
  const [loading, setLoading] = useState(true);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState<number | null>(null);

  // 新增状态
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showGraphDate, setShowGraphDate] = useState<string | null>(null);
  const [editingStatusCell, setEditingStatusCell] = useState<number | null>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  const loadMonth = useCallback(
    async (y: number, m: number) => {
      setLoading(true);
      const data = await scanLogsByMonth(app, y, m);
      setCalData(data);
      setLoading(false);
    },
    [app],
  );

  useEffect(() => {
    loadMonth(year, month);
  }, [year, month, loadMonth]);

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
    return buildCalendarGrid(calData, today);
  }, [calData, today]);

  // 动态计算行高
  useLayoutEffect(() => {
    const wrap = tableWrapRef.current;
    if (!wrap || grid.length === 0) {
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
  }, [grid]);

  const goPrev = () => {
    if (month === 1) {
      setYear((y) => y - 1);
      setMonth(12);
    } else {
      setMonth((m) => m - 1);
    }
  };

  const goNext = () => {
    if (month === 12) {
      setYear((y) => y + 1);
      setMonth(1);
    } else {
      setMonth((m) => m + 1);
    }
  };

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
      {/* 导航 */}
      <div className="mswb-cal-nav">
        <button className="mswb-cal-nav-btn" onClick={goPrev}>
          ◀
        </button>
        <span className="mswb-cal-title">
          {year}年 {MONTH_NAMES[month - 1]}
        </span>
        <button className="mswb-cal-nav-btn" onClick={goNext}>
          ▶
        </button>
      </div>

      {/* 表格 */}
      {loading ? (
        <div className="mswb-cal-loading">加载中...</div>
      ) : (
        <div className="mswb-cal-table-wrap" ref={tableWrapRef}>
        <table className="mswb-cal-table">
          <thead>
            <tr>
              {WEEKDAYS.map((day) => (
                <th key={day}>{day}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((week, wi) => (
              <tr key={wi} style={{ height: rowHeight ?? undefined }}>
                {week.days.map((cell, ci) => {
                  if (!cell) {
                    return <td key={ci} className="mswb-cal-empty" />;
                  }

                  const isToday = cell.isToday;
                  const hasLog = cell.hasLog;
                  const entry = cell.entry;
                  const isSelected = selectedDate === fmtDate(cell.day);

                  return (
                    <td
                      key={ci}
                      className={`mswb-cal-day ${isToday ? 'today' : ''} ${hasLog ? 'has-log' : ''} ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleCellClick(cell.day)}
                      title={hasLog ? '点击编辑日记' : '点击创建日记'}
                    >
                      {/* 第一行：日期数字 + 状态 + 快捷按钮 */}
                      <div className="mswb-cal-day-row">
                        <div className="mswb-cal-day-num">{cell.day}</div>
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
        {calData?.entries.size ?? 0} 篇日志 · 点击日期编辑 · 点击状态快速切换
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
  const [emojiInput, setEmojiInput] = useState(project.emoji);
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
  const { groups, doneCount, undoneCount } = useMemo(() => {
    const filtered = tasks.filter((t) => {
      if (!showDone && t.done) return false;
      if (filterProject && t.project !== filterProject) return false;
      return true;
    });
    const done = filtered.filter((t) => t.done).length;
    return {
      groups: groupTasks(filtered),
      doneCount: done,
      undoneCount: filtered.length - done,
    };
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
