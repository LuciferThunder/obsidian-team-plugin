import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type TeamPlugin from './main';
import { AIProviderType, DEFAULT_DAILY_TEMPLATE, DEFAULT_MONTHLY_TEMPLATE } from './types';

export class TeamPluginSettingTab extends PluginSettingTab {
    plugin: TeamPlugin;

    constructor(app: App, plugin: TeamPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    // PluginSettingTab.display remains the supported settings UI entry for current Obsidian versions.
    display(): void {
        this.renderSettings();
    }

    private renderSettings(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ========== Server Settings ==========
        new Setting(containerEl).setName('Server').setHeading();

        new Setting(containerEl)
            .setName('服务器地址')
            .setDesc('团队协作后端服务器 HTTP API 地址 (例如: https://api.example.com)')
            .addText(text => text
                .setPlaceholder('https://api.example.com')
                .setValue(this.plugin.settings.serverUrl)
                .onChange(async (value) => {
                    this.plugin.settings.serverUrl = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('WebSocket 地址 (协同服务)')
            .setDesc('独立的 WebSocket 协同地址 (例如: wss://api.example.com/ws/collab)')
            .addText(text => text
                .setPlaceholder('wss://api.example.com/ws/collab')
                .setValue(this.plugin.settings.wsUrl)
                .onChange(async (value) => {
                    this.plugin.settings.wsUrl = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('API 密钥')
            .setDesc('服务器认证密钥')
            .addText(text => text
                .setPlaceholder('your-api-key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('用户名')
            .setDesc('在团队中显示的名称')
            .addText(text => text
                .setPlaceholder('Your Name')
                .setValue(this.plugin.settings.username)
                .onChange(async (value) => {
                    this.plugin.settings.username = value;
                    await this.plugin.saveSettings();
                })
            );

        // ========== AI Settings ==========
        new Setting(containerEl).setName('AI').setHeading();

        new Setting(containerEl)
            .setName('AI 提供商')
            .setDesc('选择用于文档总结和报告生成的 AI 服务')
            .addDropdown(dropdown => dropdown
                .addOption('dmxapi', 'DMXAPI (全模型代理)')
                .addOption('openai', 'OpenAI (GPT-4/3.5)')
                .addOption('claude', 'Claude (Anthropic)')
                .addOption('custom', '自定义 (OpenAI 兼容)')
                .setValue(this.plugin.settings.aiProvider)
                .onChange(async (value) => {
                    this.plugin.settings.aiProvider = value as AIProviderType;
                    // Auto-fill endpoint for DMXAPI
                    if (value === 'dmxapi' && !this.plugin.settings.aiEndpoint) {
                        this.plugin.settings.aiEndpoint = 'https://www.dmxapi.cn/v1/chat/completions';
                    }
                    await this.plugin.saveSettings();
                    this.renderSettings();
                })
            );

        new Setting(containerEl)
            .setName('AI API 密钥')
            .setDesc(this.plugin.settings.aiProvider === 'dmxapi'
                ? 'DMXAPI 令牌 (一个 Key 可调用所有模型)'
                : 'AI 服务的 API 密钥')
            .addText(text => text
                .setPlaceholder('sk-...')
                .setValue(this.plugin.settings.aiApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.aiApiKey = value;
                    await this.plugin.saveSettings();
                })
            );

        // Show endpoint for DMXAPI, custom, and optionally for openai/claude (proxy support)
        const showEndpoint = ['dmxapi', 'custom', 'openai', 'claude'].includes(this.plugin.settings.aiProvider);
        if (showEndpoint) {
            const endpointPlaceholders: Record<string, string> = {
                'dmxapi': 'https://www.dmxapi.cn/v1/chat/completions',
                'openai': 'https://api.openai.com/v1/chat/completions',
                'claude': 'https://api.anthropic.com/v1/messages',
                'custom': 'https://api.example.com/v1/chat/completions',
            };
            const placeholder = endpointPlaceholders[this.plugin.settings.aiProvider] || '';

            new Setting(containerEl)
                .setName('API 端点')
                .setDesc('API 地址 (留空使用默认地址，支持代理)')
                .addText(text => text
                    .setPlaceholder(placeholder)
                    .setValue(this.plugin.settings.aiEndpoint)
                    .onChange(async (value) => {
                        this.plugin.settings.aiEndpoint = value;
                        await this.plugin.saveSettings();
                    })
                );
        }

        // Model name
        const modelPlaceholders: Record<string, string> = {
            'dmxapi': 'gpt-4 / claude-sonnet-4-5-20250929 / gemini-3-pro',
            'openai': 'gpt-4',
            'claude': 'claude-3-sonnet-20240229',
            'custom': 'model-name',
        };
        new Setting(containerEl)
            .setName('模型')
            .setDesc('使用的 AI 模型名称')
            .addText(text => text
                .setPlaceholder(modelPlaceholders[this.plugin.settings.aiProvider] || 'gpt-4')
                .setValue(this.plugin.settings.aiModel)
                .onChange(async (value) => {
                    this.plugin.settings.aiModel = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('测试 AI 连接')
            .setDesc('验证 AI API 配置是否正确')
            .addButton(button => button
                .setButtonText('测试连接')
                .onClick(() => {
                    void (async () => {
                        button.setDisabled(true);
                        button.setButtonText('测试中...');

                        try {
                            const success = await this.plugin.summarizer.testConnection();
                            if (success) {
                                new Notice('AI 连接成功');
                            } else {
                                new Notice('AI 连接失败，请检查配置');
                            }
                        } catch (e) {
                            new Notice(`连接错误: ${e}`);
                        } finally {
                            button.setDisabled(false);
                            button.setButtonText('测试连接');
                        }
                    })();
                })
            );

        // ========== Report Settings ==========
        new Setting(containerEl).setName('Reports').setHeading();

        new Setting(containerEl)
            .setName('自动生成日报')
            .setDesc('在指定时间自动生成日报')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoGenerateDailyReport)
                .onChange(async (value) => {
                    this.plugin.settings.autoGenerateDailyReport = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('日报生成时间')
            .setDesc('自动生成日报的时间 (24小时制)')
            .addText(text => text
                .setPlaceholder('18:00')
                .setValue(this.plugin.settings.dailyReportTime)
                .onChange(async (value) => {
                    this.plugin.settings.dailyReportTime = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('日报模板')
            .setDesc('自定义日报模板 (留空使用默认模板)')
            .addTextArea(text => text
                .setPlaceholder(DEFAULT_DAILY_TEMPLATE)
                .setValue(this.plugin.settings.dailyReportTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.dailyReportTemplate = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('月报模板')
            .setDesc('自定义月报模板 (留空使用默认模板)')
            .addTextArea(text => text
                .setPlaceholder(DEFAULT_MONTHLY_TEMPLATE)
                .setValue(this.plugin.settings.monthlyReportTemplate)
                .onChange(async (value) => {
                    this.plugin.settings.monthlyReportTemplate = value;
                    await this.plugin.saveSettings();
                })
            );

        // ========== Plugin Sync Settings ==========
        new Setting(containerEl).setName('Plugin sync').setHeading();

        new Setting(containerEl)
            .setName('同步插件列表')
            .setDesc('与团队成员同步已安装的插件列表')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncPluginList)
                .onChange(async (value) => {
                    this.plugin.settings.syncPluginList = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('同步插件设置')
            .setDesc('同时同步插件的配置文件')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncPluginSettings)
                .onChange(async (value) => {
                    this.plugin.settings.syncPluginSettings = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('排除的插件')
            .setDesc('不参与同步的插件 ID，使用逗号分隔')
            .addText(text => text
                .setPlaceholder('plugin-id-1, plugin-id-2')
                .setValue(this.plugin.settings.excludedPlugins.join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.excludedPlugins = value
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => s.length > 0);
                    await this.plugin.saveSettings();
                })
            );

        // ========== Interface Settings ==========
        new Setting(containerEl).setName('界面').setHeading();

        new Setting(containerEl)
            .setName('语言')
            .setDesc('插件界面和 AI 输出语言')
            .addDropdown(dropdown => dropdown
                .addOption('zh', '中文')
                .addOption('en', 'English')
                .setValue(this.plugin.settings.language)
                .onChange(async (value) => {
                    this.plugin.settings.language = value as 'zh' | 'en';
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('调试模式')
            .setDesc('开启后会在控制台输出详细日志')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                })
            );
    }
}
