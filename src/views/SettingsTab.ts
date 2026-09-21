import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type { Plugin } from 'obsidian';
import {
  getConfig,
  setConfig,
  resetConfig,
  type PluginConfig,
  getSessionConfig,
  setSessionConfig,
  getFeishuConfig,
  setFeishuConfig,
} from '../data/settings';
import { installHarvestSkill, hasHarvestSkill } from '../data/harvestSkill';
import { installWorkReportSkill, hasWorkReportSkill } from '../data/workReportSkill';

// ===== 模块级防抖写盘（会话/飞书配置，避免逐键写 data.json） =====
// settings.ts 的 setSessionConfig/setFeishuConfig 每次调用都会 persist 整份 data.json，
// 输入框逐键触发会导致频繁写盘。这里按字段防抖：停止输入 600ms 后落盘一次。
const debounceTimers = new Map<string, number>();
function debounceRun(key: string, fn: () => void): void {
  const t = debounceTimers.get(key);
  if (t !== undefined) window.clearTimeout(t);
  debounceTimers.set(key, window.setTimeout(() => { debounceTimers.delete(key); fn(); }, 600));
}
function setSessionConfigDebounced(key: string, cfg: Parameters<typeof setSessionConfig>[0]): void {
  debounceRun('sess:' + key, () => void setSessionConfig(cfg));
}
function setFeishuConfigDebounced(key: string, cfg: Parameters<typeof setFeishuConfig>[0]): void {
  debounceRun('feishu:' + key, () => void setFeishuConfig(cfg));
}

/**
 * 设置页（原生 + 折叠分组）：
 * - 主分组 / 次级分组标题点击折叠，默认全部折叠
 * - 顶栏搜索框（输入时自动展开全部 + 过滤）
 * - 所有改动 onChange 即时生效，不再有「保存」按钮
 */
export class WorkbenchSettingsTab extends PluginSettingTab {
  private config: PluginConfig;
  private debounceTimers = new Map<string, number>();

  constructor(app: App, private plugin: Plugin) {
    super(app, plugin);
    this.config = { ...getConfig() };
  }

  display(): void {
    this.config = { ...getConfig() };
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('mswb-settings');

    // ===== 搜索（输入即展开 + 过滤） =====
    const search = new Setting(containerEl)
      .setName('搜索')
      .addSearch((s) => {
        s.setPlaceholder('搜索设置…');
        s.onChange((v) => this.applyFilter(v.trim().toLowerCase()));
      });
    // 过滤时此行走常驻，避免搜索框自身被隐藏导致无法继续输入
    search.settingEl.addClass('mswb-set-search');

    // ===== 分组 =====
    this.groupBase();
    this.groupCategory();
    this.groupPanel();
    this.groupSession();
    this.groupFeishu();

    // ===== 装配折叠（默认全折叠） =====
    this.wireCollapse();
  }

  // ---------- 折叠装配 ----------

  private collapseRegion(el: HTMLElement, want: boolean): void {
    if (want) el.setAttribute('data-col', '1');
    else el.removeAttribute('data-col');
  }

  private wireCollapse(): void {
    const root = this.containerEl;

    // 主分组：box 内第一个 heading 控制其后全部兄弟（含次级 sub）
    root.querySelectorAll<HTMLElement>('.mswb-set-box').forEach((box) => {
      const head = box.querySelector<HTMLElement>(':scope > .setting-item-heading');
      if (!head) return;
      const region = Array.from(box.children).filter((el) => el !== head) as HTMLElement[];
      head.addClass('is-collapsed');
      region.forEach((el) => this.collapseRegion(el, true));
      head.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const coll = head.classList.toggle('is-collapsed');
        region.forEach((el) => this.collapseRegion(el, coll));
      });
    });

    // 次级分组：sub 内 heading 控制 mswb-set-sub-items
    root.querySelectorAll<HTMLElement>('.mswb-set-sub').forEach((sub) => {
      const sh = sub.querySelector<HTMLElement>(':scope > .setting-item-heading');
      const items = sub.querySelector<HTMLElement>(':scope > .mswb-set-sub-items');
      if (!sh || !items) return;
      if (!sh.classList.contains('is-collapsed')) {
        sh.addClass('is-collapsed');
        this.collapseRegion(items, true);
      }
      sh.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const coll = sh.classList.toggle('is-collapsed');
        this.collapseRegion(items, coll);
      });
    });
  }

  // ---------- 搜索过滤 ----------

  private applyFilter(kw: string): void {
    const root = this.containerEl;
    // 搜索时全部展开（保证「搜索到但组折叠」不遮挡）
    root.querySelectorAll<HTMLElement>('[data-col="1"]').forEach((el) => el.removeAttribute('data-col'));
    root.querySelectorAll<HTMLElement>('.is-collapsed').forEach((el) => el.removeClass('is-collapsed'));

    // 逐设置项过滤：搜索框所在行常驻（mswb-set-search），其余按文本匹配，不重建 DOM，
    // 避免删空关键词时整页重建导致输入框失焦、折叠状态丢失。
    root.querySelectorAll<HTMLElement>('.setting-item').forEach((el) => {
      const pinned = el.classList.contains('mswb-set-search');
      const keep = pinned || !kw || (el.textContent ?? '').toLowerCase().includes(kw);
      el.style.display = keep ? '' : 'none';
    });
  }

  // ---------- 即时持久化（输入防抖，避免逐键写盘） ----------

  /** 输入类设置防抖：停止输入 600ms 后落盘一次，避免每次击键都写 data.json */
  private persistDebounced(key: string, patch: Partial<PluginConfig>): void {
    if (this.debounceTimers.has(key)) window.clearTimeout(this.debounceTimers.get(key)!);
    const timer = window.setTimeout(() => {
      this.debounceTimers.delete(key);
      this.persist(patch);
    }, 600);
    this.debounceTimers.set(key, timer);
  }

  // ---------- 即时持久化 ----------

  private persist(patch: Partial<PluginConfig>): void {
    this.config = { ...this.config, ...patch };
    void setConfig(this.config);
  }

  // ===== 📁 基础路径 =====
  private groupBase(): void {
    const box = this.containerEl.createDiv({ cls: 'mswb-set-box' });
    new Setting(box).setHeading().setName('📁 基础路径');

    new Setting(box)
      .setName('工作日志目录')
      .setDesc('存放每日日志的文件夹')
      .addText((t) =>
        t.setValue(this.config.workLogPath)
          .setPlaceholder('工作日志')
          .onChange((v) => this.persistDebounced('workLogPath', { workLogPath: v })));

    new Setting(box)
      .setName('日记模板')
      .setDesc('新建日记所用的模板文件')
      .addText((t) =>
        t.setValue(this.config.diaryTemplate)
          .setPlaceholder('templates/工作日志.md')
          .onChange((v) => this.persistDebounced('diaryTemplate', { diaryTemplate: v })));

    new Setting(box)
      .setName('项目根目录')
      .setDesc('项目分类目录，可添加多个')
      .addText((t) => {
        t.setPlaceholder('例: 项目管理-客户');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && t.getValue().trim()) {
            this.config.projectRoots.push(t.getValue().trim());
            t.setValue('');
            this.persist({ projectRoots: [...this.config.projectRoots] });
            this.renderRoots(box);
          }
        });
      })
      .addButton((b) => b.setButtonText('+').onClick(() => {
        const input = box.querySelector('input[placeholder="例: 项目管理-客户"]') as HTMLInputElement;
        if (input && input.value.trim()) {
          this.config.projectRoots.push(input.value.trim());
          input.value = '';
          this.persist({ projectRoots: [...this.config.projectRoots] });
          this.renderRoots(box);
        }
      }));

    const roots = box.createDiv();
    this.renderRoots(roots);
  }

  // ===== 🏷️ 类别与标签 =====
  private groupCategory(): void {
    const box = this.containerEl.createDiv({ cls: 'mswb-set-box' });
    new Setting(box).setHeading().setName('🏷️ 类别与标签');

    let catBox: HTMLDivElement;
    new Setting(box)
      .setName('默认类别')
      .setDesc('项目分类的默认选项')
      .addText((t) => {
        t.setPlaceholder('新类别名');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && t.getValue().trim()) {
            if (!this.config.baseCategories.includes(t.getValue().trim())) {
              this.config.baseCategories.push(t.getValue().trim());
              t.setValue('');
              this.persist({ baseCategories: [...this.config.baseCategories] });
              this.renderList(catBox, this.config.baseCategories, (v) => this.persist({ baseCategories: v }));
            }
          }
        });
      })
      .addButton((b) => b.setButtonText('+').onClick(() => {
        const input = box.querySelector('input[placeholder="新类别名"]') as HTMLInputElement;
        if (input && input.value.trim() && !this.config.baseCategories.includes(input.value.trim())) {
          this.config.baseCategories.push(input.value.trim());
          input.value = '';
          this.persist({ baseCategories: [...this.config.baseCategories] });
          this.renderList(catBox, this.config.baseCategories, (v) => this.persist({ baseCategories: v }));
        }
      }));
    catBox = box.createDiv();
    this.renderList(catBox, this.config.baseCategories, (v) => this.persist({ baseCategories: v }));

    let tagBox: HTMLDivElement;
    new Setting(box)
      .setName('默认标签')
      .setDesc('项目标签的默认选项')
      .addText((t) => {
        t.setPlaceholder('新标签名');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && t.getValue().trim()) {
            if (!this.config.baseTags.includes(t.getValue().trim())) {
              this.config.baseTags.push(t.getValue().trim());
              t.setValue('');
              this.persist({ baseTags: [...this.config.baseTags] });
              this.renderList(tagBox, this.config.baseTags, (v) => this.persist({ baseTags: v }));
            }
          }
        });
      })
      .addButton((b) => b.setButtonText('+').onClick(() => {
        const input = box.querySelector('input[placeholder="新标签名"]') as HTMLInputElement;
        if (input && input.value.trim() && !this.config.baseTags.includes(input.value.trim())) {
          this.config.baseTags.push(input.value.trim());
          input.value = '';
          this.persist({ baseTags: [...this.config.baseTags] });
          this.renderList(tagBox, this.config.baseTags, (v) => this.persist({ baseTags: v }));
        }
      }));
    tagBox = box.createDiv();
    this.renderList(tagBox, this.config.baseTags, (v) => this.persist({ baseTags: v }));
  }

  // ===== 🎛️ 面板显示 =====
  private groupPanel(): void {
    const box = this.containerEl.createDiv({ cls: 'mswb-set-box' });
    new Setting(box).setHeading().setName('🎛️ 面板显示');

    const TAB_LABELS: Record<string, string> = {
      calendar: '📅 日历',
      projects: '📂 项目',
      todos: '✅ 待办',
      gantt: '📊 排期',
      feishu: '📡 飞书',
      sessions: '💬 会话',
    };
    for (const [key, label] of Object.entries(TAB_LABELS)) {
      const isVisible = this.config.visibleTabs?.[key] !== false;
      new Setting(box)
        .setName(label)
        .setDesc('显示此面板')
        .addToggle((t) => t.setValue(isVisible).onChange((v) => {
          const visibleTabs = { ...(this.config.visibleTabs ?? {}) };
          visibleTabs[key] = v;
          this.persist({ visibleTabs });
        }));
    }

    // 次级：日历显示
    const sub = box.createDiv({ cls: 'mswb-set-sub' });
    new Setting(sub).setHeading().setName('日历显示');
    const subItems = sub.createDiv({ cls: 'mswb-set-sub-items' });

    new Setting(subItems)
      .setName('显示周六')
      .setDesc('日历是否显示周六列')
      .addToggle((t) => t.setValue(this.config.showSaturday !== false).onChange((v) => this.persist({ showSaturday: v })));
    new Setting(subItems)
      .setName('显示周日')
      .setDesc('日历是否显示周日列（周日常需补班）')
      .addToggle((t) => t.setValue(this.config.showSunday !== false).onChange((v) => this.persist({ showSunday: v })));
    new Setting(subItems)
      .setName('显示节假日 / 调休补班')
      .setDesc('按国务院安排标注休假日（红）与补班日（蓝）')
      .addToggle((t) => t.setValue(this.config.showHolidays !== false).onChange((v) => this.persist({ showHolidays: v })));
  }

  // ===== 💬 会话（含各自智能体的技能注册） =====
  private groupSession(): void {
    const box = this.containerEl.createDiv({ cls: 'mswb-set-box' });
    new Setting(box).setHeading().setName('💬 会话');

    // 次级：Claude Code
    const subC = box.createDiv({ cls: 'mswb-set-sub' });
    new Setting(subC).setHeading().setName('Claude Code');
    const cItems = subC.createDiv({ cls: 'mswb-set-sub-items' });

    new Setting(cItems)
      .setName('会话目录')
      .setDesc('会话 .jsonl 根目录，默认 ~/.claude/projects')
      .addText((t) =>
        t.setValue(getSessionConfig().sessionRootDir)
          .setPlaceholder('留空自动检测')
          .onChange((v) => void setSessionConfigDebounced('sessionRootDir', { sessionRootDir: v.trim() })));

    new Setting(cItems)
      .setName('claude CLI 路径')
      .setDesc('起新会话用，留空自动检测')
      .addText((t) =>
        t.setValue(getSessionConfig().claudeCliPath)
          .setPlaceholder('claude')
          .onChange((v) => void setSessionConfigDebounced('claudeCliPath', { claudeCliPath: v.trim() })));

    new Setting(cItems)
      .setName('会话存档目录')
      .setDesc('存档存放位置，留空默认 ~/.claude/archives（清理范围外）')
      .addText((t) =>
        t.setValue(getSessionConfig().archiveDir)
          .setPlaceholder('留空使用默认路径')
          .onChange((v) => void setSessionConfigDebounced('archiveDir', { archiveDir: v.trim() })));

    // 收割技能名（claude 会话的「已收割」识别名单）
    new Setting(cItems)
      .setName('收割技能名')
      .setDesc('会话「已收割」按此名单匹配，默认 session-harvest，多个用逗号分隔')
      .addText((t) =>
        t.setValue((getSessionConfig().harvestSkillNames || ['session-harvest']).join(','))
          .setPlaceholder('session-harvest')
          .onChange((v) => void setSessionConfigDebounced('harvestSkillNames', { harvestSkillNames: v.split(',').map((s) => s.trim()).filter(Boolean) })));

    // 技能注册：Claude Code 专属（只装 claude）
    this.skillInstallRow(cItems, '会话知识收割', '「总结对话 → 归档为笔记」', 'claude', installHarvestSkill, hasHarvestSkill);
    this.skillInstallRow(cItems, '工作复盘整理', '「整理日志 → 生成周报 / 月报」', 'claude', installWorkReportSkill, hasWorkReportSkill);

    // 次级：CodeM
    const subM = box.createDiv({ cls: 'mswb-set-sub' });
    new Setting(subM).setHeading().setName('CodeM');
    const mItems = subM.createDiv({ cls: 'mswb-set-sub-items' });

    new Setting(mItems)
      .setName('CodeM 会话目录')
      .setDesc('默认 ~/.codem/sessions')
      .addText((t) =>
        t.setValue(getSessionConfig().codemRootDir)
          .setPlaceholder('留空自动检测')
          .onChange((v) => void setSessionConfigDebounced('codemRootDir', { codemRootDir: v.trim() })));

    new Setting(mItems)
      .setName('codem CLI 路径')
      .setDesc('「在 CodeM 中打开」用，留空自动检测')
      .addText((t) =>
        t.setValue(getSessionConfig().codemCliPath)
          .setPlaceholder('codem')
          .onChange((v) => void setSessionConfigDebounced('codemCliPath', { codemCliPath: v.trim() })));

    // 技能注册：CodeM 专属（只装 codem）
    this.skillInstallRow(mItems, '会话知识收割', '「总结对话 → 归档为笔记」', 'codem', installHarvestSkill, hasHarvestSkill);
    this.skillInstallRow(mItems, '工作复盘整理', '「整理日志 → 生成周报 / 月报」', 'codem', installWorkReportSkill, hasWorkReportSkill);
  }

  // ===== 技能注册行（单智能体单按钮） =====
  private skillInstallRow(
    parent: HTMLElement,
    title: string,
    desc: string,
    agent: 'claude' | 'codem',
    install: (a: 'claude' | 'codem' | 'both') => { ok: boolean; existed: boolean; path: string; error?: string }[],
    has: (a: 'claude' | 'codem') => boolean,
  ): void {
    const agentName = agent === 'claude' ? 'Claude Code' : 'CodeM';
    const installed = has(agent);
    new Setting(parent)
      .setName(title)
      .setDesc(`${desc} · 装到 ${agentName}`)
      .addButton((b) => {
        b.setButtonText(installed ? '✅ 已装' : `🛠 安装`).setCta();
        b.onClick(async () => {
          const r = install(agent)[0];
          new Notice(r.ok ? `✅ 已注册${r.existed ? '（已备份 .bak）' : ''}: ${r.path}` : `❌ ${r.error}`);
          b.setButtonText('✅ 已装');
        });
      });
  }

  // ===== 📡 飞书 =====
  private groupFeishu(): void {
    const box = this.containerEl.createDiv({ cls: 'mswb-set-box' });
    new Setting(box).setHeading().setName('📡 飞书');

    new Setting(box)
      .setName('lark-cli 路径')
      .setDesc('留空自动检测，失败时手动指定')
      .addText((t) =>
        t.setValue(getFeishuConfig().larkCliPath)
          .setPlaceholder('留空自动检测')
          .onChange((v) => void setFeishuConfigDebounced('larkCliPath', { larkCliPath: v.trim() })));

    new Setting(box)
      .setName('扫描文件夹上限')
      .setDesc('深度扫描最多遍历文件夹数（默认 100）')
      .addText((t) =>
        t.setValue(String(getFeishuConfig().scanFolderLimit ?? 100))
          .setPlaceholder('100')
          .onChange((v) => void setFeishuConfig({ scanFolderLimit: parseInt(v, 10) || 100 })));

    new Setting(box)
      .setName('扫描并发数')
      .setDesc('并行加载批次（默认 5，文件夹多可调大）')
      .addText((t) =>
        t.setValue(String(getFeishuConfig().scanConcurrency ?? 5))
          .setPlaceholder('5')
          .onChange((v) => void setFeishuConfig({ scanConcurrency: parseInt(v, 10) || 5 })));
  }

  // ===== 辅助渲染 =====
  private renderRoots(container: HTMLElement): void {
    container.empty();
    if (this.config.projectRoots.length === 0) {
      container.createEl('p', { text: '（无）', cls: 'setting-item-description' });
      return;
    }
    for (let i = 0; i < this.config.projectRoots.length; i++) {
      const row = container.createDiv({ cls: 'setting-item' });
      row.createSpan({ text: this.config.projectRoots[i], cls: 'setting-item-name' });
      const btn = row.createEl('button', { text: '✕', cls: 'mswb-del-btn' });
      btn.addEventListener('click', () => {
        this.config.projectRoots.splice(i, 1);
        this.persist({ projectRoots: [...this.config.projectRoots] });
        this.renderRoots(container);
      });
    }
  }

  private renderList(container: HTMLElement, items: string[], onChange: (v: string[]) => void): void {
    container.empty();
    for (let i = 0; i < items.length; i++) {
      const row = container.createDiv({ cls: 'setting-item' });
      row.createSpan({ text: items[i], cls: 'setting-item-name' });
      const btn = row.createEl('button', { text: '✕', cls: 'mswb-del-btn' });
      btn.addEventListener('click', () => {
        items.splice(i, 1);
        onChange([...items]);
        this.renderList(container, items, onChange);
      });
    }
  }
}