import { Plugin, WorkspaceLeaf, addIcon } from 'obsidian';
import { WorkbenchView, VIEW_TYPE } from './views/WorkbenchView';
import { initSettings } from './data/settings';
import { WorkbenchSettingsTab } from './views/SettingsTab';

// 猛士盾形 LOGO — 32x32 矢量（从 PNG 抠底追踪）
const MENGSHI_LOGO = `<svg viewBox="0 0 32 32"><rect x="8" y="4" width="2" height="1" fill="currentColor"/><rect x="24" y="4" width="1" height="1" fill="currentColor"/><rect x="8" y="5" width="3" height="1" fill="currentColor"/><rect x="23" y="5" width="2" height="1" fill="currentColor"/><rect x="8" y="6" width="4" height="1" fill="currentColor"/><rect x="22" y="6" width="3" height="1" fill="currentColor"/><rect x="8" y="7" width="5" height="1" fill="currentColor"/><rect x="21" y="7" width="4" height="1" fill="currentColor"/><rect x="5" y="8" width="1" height="1" fill="currentColor"/><rect x="8" y="8" width="6" height="1" fill="currentColor"/><rect x="20" y="8" width="5" height="1" fill="currentColor"/><rect x="27" y="8" width="2" height="1" fill="currentColor"/><rect x="5" y="9" width="2" height="1" fill="currentColor"/><rect x="8" y="9" width="7" height="1" fill="currentColor"/><rect x="19" y="9" width="6" height="1" fill="currentColor"/><rect x="26" y="9" width="3" height="1" fill="currentColor"/><rect x="5" y="10" width="11" height="1" fill="currentColor"/><rect x="18" y="10" width="11" height="1" fill="currentColor"/><rect x="5" y="11" width="3" height="1" fill="currentColor"/><rect x="9" y="11" width="20" height="1" fill="currentColor"/><rect x="5" y="12" width="3" height="1" fill="currentColor"/><rect x="10" y="12" width="14" height="1" fill="currentColor"/><rect x="25" y="12" width="4" height="1" fill="currentColor"/><rect x="5" y="13" width="3" height="1" fill="currentColor"/><rect x="11" y="13" width="12" height="1" fill="currentColor"/><rect x="25" y="13" width="4" height="1" fill="currentColor"/><rect x="5" y="14" width="3" height="1" fill="currentColor"/><rect x="12" y="14" width="9" height="1" fill="currentColor"/><rect x="25" y="14" width="4" height="1" fill="currentColor"/><rect x="5" y="15" width="3" height="1" fill="currentColor"/><rect x="13" y="15" width="7" height="1" fill="currentColor"/><rect x="25" y="15" width="4" height="1" fill="currentColor"/><rect x="5" y="16" width="3" height="1" fill="currentColor"/><rect x="14" y="16" width="5" height="1" fill="currentColor"/><rect x="25" y="16" width="4" height="1" fill="currentColor"/><rect x="5" y="17" width="3" height="1" fill="currentColor"/><rect x="10" y="17" width="1" height="1" fill="currentColor"/><rect x="15" y="17" width="3" height="1" fill="currentColor"/><rect x="25" y="17" width="4" height="1" fill="currentColor"/><rect x="5" y="18" width="3" height="1" fill="currentColor"/><rect x="10" y="18" width="2" height="1" fill="currentColor"/><rect x="16" y="18" width="1" height="1" fill="currentColor"/><rect x="22" y="18" width="1" height="1" fill="currentColor"/><rect x="25" y="18" width="4" height="1" fill="currentColor"/><rect x="5" y="19" width="3" height="1" fill="currentColor"/><rect x="10" y="19" width="3" height="1" fill="currentColor"/><rect x="21" y="19" width="2" height="1" fill="currentColor"/><rect x="25" y="19" width="4" height="1" fill="currentColor"/><rect x="5" y="20" width="3" height="1" fill="currentColor"/><rect x="10" y="20" width="4" height="1" fill="currentColor"/><rect x="19" y="20" width="4" height="1" fill="currentColor"/><rect x="25" y="20" width="4" height="1" fill="currentColor"/><rect x="5" y="21" width="3" height="1" fill="currentColor"/><rect x="10" y="21" width="5" height="1" fill="currentColor"/><rect x="18" y="21" width="5" height="1" fill="currentColor"/><rect x="25" y="21" width="4" height="1" fill="currentColor"/><rect x="5" y="22" width="3" height="1" fill="currentColor"/><rect x="9" y="22" width="5" height="1" fill="currentColor"/><rect x="19" y="22" width="10" height="1" fill="currentColor"/><rect x="5" y="23" width="8" height="1" fill="currentColor"/><rect x="20" y="23" width="9" height="1" fill="currentColor"/><rect x="5" y="24" width="7" height="1" fill="currentColor"/><rect x="21" y="24" width="8" height="1" fill="currentColor"/><rect x="5" y="25" width="6" height="1" fill="currentColor"/><rect x="22" y="25" width="7" height="1" fill="currentColor"/><rect x="5" y="26" width="5" height="1" fill="currentColor"/><rect x="24" y="26" width="5" height="1" fill="currentColor"/><rect x="5" y="27" width="4" height="1" fill="currentColor"/><rect x="25" y="27" width="4" height="1" fill="currentColor"/><rect x="5" y="28" width="3" height="1" fill="currentColor"/><rect x="26" y="28" width="3" height="1" fill="currentColor"/><rect x="5" y="29" width="2" height="1" fill="currentColor"/><rect x="27" y="29" width="2" height="1" fill="currentColor"/><rect x="5" y="30" width="1" height="1" fill="currentColor"/><rect x="28" y="30" width="1" height="1" fill="currentColor"/></svg>`;

// 飞书 LOGO — 32x32 矢量 (飞书蓝 #3370FF 圆角方底 + 飞鸟剪影)
const FEISHU_LOGO = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">` +
  `<rect x="1" y="1" width="30" height="30" rx="6" fill="#3370FF"/>` +
  // 飞鸟：流畅的 swift 剪影，右上方飞行姿态
  `<path d="M7 13 L12 8 L15 10 L18 9 L21 12 L22 15 L20 15 L19 13 L17 12 L14 13 L12 11 L10 14 L7 16 Z" fill="white" opacity="0.92"/>` +
  // 翅膀尖
  `<path d="M16 10 L23 6 L22 10 L18 12 Z" fill="white" opacity="0.85"/>` +
  // 尾羽
  `<path d="M12 14 L9 21 L13 17 L14 14 Z" fill="white" opacity="0.8"/>` +
  `<path d="M14 14 L16 22 L16 15 Z" fill="white" opacity="0.7"/>` +
  `</svg>`;

export default class MengshiWorkbenchPlugin extends Plugin {
  async onload(): Promise<void> {
    // 初始化数据存储
    await initSettings(this);

    // 注册猛士 LOGO 图标（供 Ribbon + 标签页使用）
    addIcon('mengshi-logo', MENGSHI_LOGO);
    addIcon('feishu-logo', FEISHU_LOGO);

    // 注册自定义视图
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new WorkbenchView(leaf));

    // 左侧 Ribbon 按钮
    this.addRibbonIcon('mengshi-logo', '猛士驾驶舱', () => {
      this.activateView();
    });

    // Command Palette 命令：打开工作台
    this.addCommand({
      id: 'open-workbench',
      name: '打开工作台',
      callback: () => this.activateView(),
    });

    // 注册设置页
    this.addSettingTab(new WorkbenchSettingsTab(this.app, this));

    // 启动时自动打开（仅首次）
    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  async onunload(): Promise<void> {
    // 清理工作台视图
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}
