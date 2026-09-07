import { App, Modal, TFile, Notice } from 'obsidian';
import { getAllCategories, getProjectMetaOverrides, getConfig } from '../data/settings';
import { centerModalInWorkbench } from './modalHelpers';

interface ProjectChoice {
  name: string;
  path: string;
  isDiary: boolean;
  category: string | null;
}

// 从文件夹名推断项目类别（不再硬编码文件夹名）
function inferCategory(folder: string, projectType: string): string | null {
  if (projectType === '车型') return '车型项目';
  const lower = folder.toLowerCase();
  if (lower.includes('ppap') || lower.includes('rpa')) return 'RPA自动化';
  if (lower.includes('eps') || lower.includes('ai') || lower.includes('开模令') || lower.includes('智能体') || lower.includes('超级工程师')) return 'AI智能体';
  if (lower.includes('多维表') || lower.includes('风险') || lower.includes('低合格率') || lower.includes('通报')) return '多维表';
  if (lower.includes('插件') || lower.includes('obsidian') || lower.includes('工作台') || lower.includes('工具')) return '工具开发';
  if (lower.includes('gcc') || lower.includes('rskd')) return '车型项目';
  return null;
}

function getProjectChoices(app: App): ProjectChoice[] {
  const now = new Date();
  const todayPath = `${getConfig().workLogPath}/${now.getMonth() + 1}月/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.md`;

  const choices: ProjectChoice[] = [];
  const metaOverrides = getProjectMetaOverrides();

  choices.push({ name: '📅 今天的日记', path: todayPath, isDiary: true, category: null });

  const roots = getConfig().projectRoots;
  const allFiles = app.vault.getFiles();

  for (const root of roots) {
    const rootPath = root + '/';
    const subFolders = new Set<string>();
    for (const f of allFiles) {
      if (f.path.startsWith(rootPath)) {
        const sub = f.path.slice(rootPath.length).split('/')[0];
        if (sub) subFolders.add(sub);
      }
    }

    for (const folder of subFolders) {
      const folderPath = rootPath + folder;
      const readme = allFiles.find(
        (f) => f.path.startsWith(folderPath + '/') && f.name.endsWith('.README.md'),
      );
      if (readme) {
        const name = folder.replace(/^\d+\./, '');
        // 类别：覆盖 > 文件夹名推断 > null
        const category = metaOverrides[folder]?.systemType
          || inferCategory(folder, '')
          || null;
        // emoji：维度信息来自推断类别
        const emoji = category === '车型项目' ? '🚗' : (category ? '⚙' : '📁');
        choices.push({ name: `${emoji} ${name}`, path: readme.path, isDiary: false, category });
      }
    }
  }

  return choices;
}

export class QuickTodoModal extends Modal {
  private text: string;
  private startDate: string;
  private dueDate: string;
  private priority: string; // '' | '⏫' | '🔼' | '🔽'
  private choices: ProjectChoice[];
  private filteredChoices: ProjectChoice[];
  private selectedPath: string;
  private isDiary: boolean;
  private filterCategory: string | null;
  private targetWrapper: HTMLElement | null = null;
  private targetParent: HTMLElement | null = null;
  private btnRow: HTMLElement | null = null;

  constructor(private app: App) {
    super(app);
    this.text = '';
    this.startDate = '';
    this.dueDate = '';
    this.priority = '';
    this.choices = getProjectChoices(app);
    this.filterCategory = null;
    this.filteredChoices = this.choices;
    this.selectedPath = this.choices[0]?.path ?? '';
    this.isDiary = this.choices[0]?.isDiary ?? false;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mswb-modal');

    contentEl.createEl('h3', { text: '✅ 快捷待办录入' });
    centerModalInWorkbench(this);

    // 待办内容（占满整行）
    const taskRow = contentEl.createDiv({ cls: 'mswb-modal-fullrow' });
    const taskInput = taskRow.createEl('input', {
      type: 'text',
      placeholder: '要做什么...',
      cls: 'mswb-modal-task-input',
    });
    taskInput.addEventListener('input', () => (this.text = taskInput.value));
    taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
    });

    // 日期 + 优先级（并排）
    const midRow = contentEl.createDiv({ cls: 'mswb-modal-inlinerow' });
    this.makeDateField(midRow, '🛫 开始', (v) => (this.startDate = v));
    this.makeDateField(midRow, '📅 截止', (v) => (this.dueDate = v));
    this.makeDropdownField(midRow, '优先级', [
      ['', '—'], ['⏫', '⏫ 最高'], ['🔼', '🔼 高'], ['🔽', '🔽 低'],
    ], (v) => (this.priority = v));

    // 类别 + 添加到（并排）
    const botRow = contentEl.createDiv({ cls: 'mswb-modal-inlinerow' });
    const categories = ['全部', ...getAllCategories()];
    this.makeDropdownField(botRow, '类别', categories.map((c) => [c, c]), (v) => this.setFilter(v === '全部' ? null : v), '全部');
    this.renderTargetDropdown(botRow);

    // 按钮
    this.btnRow = contentEl.createDiv({ cls: 'mswb-modal-actions' });
    this.btnRow.createEl('button', { text: '取消' }).addEventListener('click', () => this.close());
    const submitBtn = this.btnRow!.createEl('button', {
      text: '添加待办',
      cls: 'mswb-modal-submit',
    });
    submitBtn.disabled = !this.selectedPath;
    submitBtn.addEventListener('click', () => this.submit());
  }

  private setFilter(cat: string | null): void {
    this.filterCategory = cat;
    if (cat) {
      this.filteredChoices = this.choices.filter((c) => c.isDiary || c.category === cat);
    } else {
      this.filteredChoices = this.choices;
    }
    // 默认选日记（如果有），否则选第一个
    const diary = this.filteredChoices.find((c) => c.isDiary);
    this.selectedPath = diary?.path ?? this.filteredChoices[0]?.path ?? '';
    this.isDiary = diary?.isDiary ?? false;
    // 刷新下拉（放回原来的父元素）
    if (this.targetWrapper) this.targetWrapper.remove();
    this.renderTargetDropdown(this.targetParent ?? this.contentEl);
  }

  private makeDateField(parent: HTMLElement, label: string, onChange: (v: string) => void): void {
    const wrap = parent.createDiv({ cls: 'mswb-modal-field' });
    wrap.createEl('label', { text: label, cls: 'mswb-modal-label' });
    const input = wrap.createEl('input', { type: 'date', cls: 'mswb-modal-input' });
    input.addEventListener('input', () => onChange(input.value));
  }

  private makeDropdownField(parent: HTMLElement, label: string, options: string[][], onChange: (v: string) => void, defaultValue?: string): void {
    const wrap = parent.createDiv({ cls: 'mswb-modal-field' });
    wrap.createEl('label', { text: label, cls: 'mswb-modal-label' });
    const sel = wrap.createEl('select', { cls: 'mswb-modal-input' });
    for (const [val, text] of options) {
      sel.createEl('option', { value: val, text });
    }
    if (defaultValue) sel.value = defaultValue;
    sel.addEventListener('change', () => onChange(sel.value));
  }

  private renderTargetDropdown(el: HTMLElement): void {
    const wrap = el.createDiv({ cls: 'mswb-target-row mswb-modal-field' });
    this.targetWrapper = wrap;
    this.targetParent = el;
    wrap.createEl('label', { text: '添加到', cls: 'mswb-modal-label' });
    if (this.filteredChoices.length === 0) {
      wrap.createEl('span', { text: '无项目', cls: 'mswb-modal-warn' });
      return;
    }
    const sel = wrap.createEl('select', { cls: 'mswb-modal-input' });
    for (const c of this.filteredChoices) {
      sel.createEl('option', { value: c.path, text: c.name });
    }
    sel.value = this.selectedPath;
    sel.addEventListener('change', () => {
      this.selectedPath = sel.value;
      const choice = this.filteredChoices.find((c) => c.path === sel.value);
      this.isDiary = choice?.isDiary ?? false;
    });
  }

  private async submit(): Promise<void> {
    const trimmed = this.text.trim();
    if (!trimmed) { new Notice('请输入待办内容'); return; }
    if (!this.selectedPath) { new Notice('请选择目标文件'); return; }

    let file = this.app.vault.getAbstractFileByPath(this.selectedPath);
    if (!(file instanceof TFile)) {
      if (this.isDiary) {
        const folderPath = this.selectedPath.substring(0, this.selectedPath.lastIndexOf('/'));
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
          await this.app.vault.createFolder(folderPath);
        }
        const now = new Date();
        // 从模板文件渲染日记内容
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d2 = String(now.getDate()).padStart(2, '0');
        const dateStr = `${y}-${m}-${d2}`;
        const weekdayCN = ['日', '一', '二', '三', '四', '五', '六'];
        const dddd = `周${weekdayCN[now.getDay()]}`;
        const MDdd = `${parseInt(m)}月${parseInt(d2)}日 周${weekdayCN[now.getDay()]}`;
        const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
        const fmt = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;

        let tmpl = '';
        const tmplFile = this.app.vault.getAbstractFileByPath(getConfig().diaryTemplate);
        if (tmplFile instanceof TFile) {
          tmpl = await this.app.vault.read(tmplFile);
        }
        if (!tmpl) {
          tmpl = [
            '---', `title: ${dateStr}`, `date: ${dateStr}`, 'tags:', '  - 工作日志', '---',
            `# 📅 ${MDdd} · 工作日志`, '', '',
            '## ✅ 搞定了什么', '', '- ', '',
            '## ⏭ 明天要做', '- ', '',
          ].join('\n');
        }
        tmpl = tmpl
          .replace(/<% tp\.date\.now\("YYYY-MM-DD"\) %>/g, dateStr)
          .replace(/<% tp\.date\.now\("dddd"\) %>/g, dddd)
          .replace(/<% tp\.date\.now\("M月D日 ddd"\) %>/g, MDdd)
          .replace(/<% tp\.date\.yesterday\("YYYY-MM-DD"\) %>/g, fmt(yesterday))
          .replace(/<% tp\.date\.tomorrow\("YYYY-MM-DD"\) %>/g, fmt(tomorrow));

        file = await this.app.vault.create(this.selectedPath, tmpl);
      } else {
        new Notice('目标文件不存在'); return;
      }
    }

    // 构建 Tasks 插件格式的待办行
    let taskLine = `- [ ] ${trimmed}`;
    if (this.priority) taskLine += ` ${this.priority}`;
    if (this.startDate) taskLine += ` 🛫 ${this.startDate}`;
    if (this.dueDate) taskLine += ` 📅 ${this.dueDate}`;

    try {
      await this.app.vault.process(file, (content) => {
        if (this.isDiary) {
          const doneSection = content.match(/^##\s+.*搞定.*$/m);
          if (doneSection) {
            const idx = doneSection.index! + doneSection[0].length;
            const nextHeader = content.slice(idx).match(/\n(?=##\s)/);
            const insertAt = nextHeader ? idx + nextHeader.index! : content.length;
            return content.slice(0, insertAt) + '\n' + taskLine + '\n' + content.slice(insertAt);
          }
          return content.trimEnd() + '\n' + taskLine + '\n';
        } else {
          const todoSection = content.match(/^##\s+📋\s*待办事项\s*$/m);
          if (todoSection) {
            const idx = todoSection.index! + todoSection[0].length;
            const nextHeader = content.slice(idx).match(/\n(?=##\s)/);
            const insertAt = nextHeader ? idx + nextHeader.index! : content.length;
            return content.slice(0, insertAt) + '\n' + taskLine + '\n' + content.slice(insertAt);
          }
          const sepIdx = content.lastIndexOf('\n---');
          if (sepIdx >= 0) {
            return content.slice(0, sepIdx)
              + '\n\n## 📋 待办事项\n\n' + taskLine + '\n'
              + content.slice(sepIdx);
          }
          return content.trimEnd() + '\n\n## 📋 待办事项\n\n' + taskLine + '\n';
        }
      });
      new Notice('✅ 待办已添加');
      this.close();
    } catch (e) {
      new Notice(`❌ 添加失败：${e}`);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
