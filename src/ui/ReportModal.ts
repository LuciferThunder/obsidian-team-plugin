import { App, Modal, Setting, Notice, TFile } from 'obsidian';
import { formatYearMonth, formatYearMonthDay } from '../utils/dates';
import { TeamPluginSettings, ReportType } from '../types';
import { DailyReport } from '../reports/DailyReport';
import { MonthlyReport } from '../reports/MonthlyReport';

export class ReportModal extends Modal {
    private settings: TeamPluginSettings;
    private dailyReport: DailyReport;
    private monthlyReport: MonthlyReport;

    private reportType: ReportType = 'daily';
    private useAI = true;
    private autoSave = true;
    private previewContent = '';

    constructor(
        app: App,
        settings: TeamPluginSettings,
        dailyReport: DailyReport,
        monthlyReport: MonthlyReport
    ) {
        super(app);
        this.settings = settings;
        this.dailyReport = dailyReport;
        this.monthlyReport = monthlyReport;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('team-report-modal');

        contentEl.createEl('h2', { text: '生成报告' });

        // Report type selection
        new Setting(contentEl)
            .setName('报告类型')
            .setDesc('选择要生成的报告类型')
            .addDropdown(dropdown => dropdown
                .addOption('daily', '日报')
                .addOption('monthly', '月报')
                .setValue(this.reportType)
                .onChange(value => {
                    this.reportType = value as ReportType;
                })
            );

        // Use AI summary
        new Setting(contentEl)
            .setName('使用 AI 总结')
            .setDesc('使用 AI 逐篇全文分析后生成报告（Map-Reduce 模式）')
            .addToggle(toggle => toggle
                .setValue(this.useAI)
                .onChange(value => {
                    this.useAI = value;
                })
            );

        // Auto save
        new Setting(contentEl)
            .setName('自动保存')
            .setDesc('生成后自动保存到 reports 文件夹')
            .addToggle(toggle => toggle
                .setValue(this.autoSave)
                .onChange(value => {
                    this.autoSave = value;
                })
            );

        const progressDiv = contentEl.createDiv('report-progress');

        const previewContainer = contentEl.createDiv('report-preview');
        previewContainer.createEl('h3', { text: '预览' });
        const previewEl = previewContainer.createEl('textarea', {
            cls: 'report-preview-content',
        });
        previewEl.placeholder = '点击"生成预览"查看报告内容';

        // Buttons
        new Setting(contentEl)
            .addButton(button => button
                .setButtonText('生成预览')
                .onClick(() => {
                    void (async () => {
                        button.setDisabled(true);
                        button.setButtonText('生成中...');
                        progressDiv.addClass('is-visible');

                        try {
                            await this.generatePreview(previewEl, progressDiv);
                        } finally {
                            button.setDisabled(false);
                            button.setButtonText('生成预览');
                            progressDiv.removeClass('is-visible');
                        }
                    })();
                })
            )
            .addButton(button => button
                .setButtonText('保存报告')
                .setCta()
                .onClick(() => {
                    void this.saveReport(previewEl.value);
                })
            )
            .addButton(button => button
                .setButtonText('取消')
                .onClick(() => {
                    this.close();
                })
            );
    }

    private async generatePreview(previewEl: HTMLTextAreaElement, progressDiv: HTMLDivElement) {
        try {
            const onProgress = (current: number, total: number, docTitle?: string) => {
                if (docTitle === '正在生成报告...') {
                    progressDiv.textContent = `正在汇总生成最终报告...`;
                } else {
                    progressDiv.textContent = `分析文档 ${current}/${total}：${docTitle || ''}`;
                }
            };

            let report;
            if (this.reportType === 'daily') {
                report = await this.dailyReport.generateTodayReport(onProgress);
            } else {
                report = await this.monthlyReport.generateCurrentMonthReport(onProgress);
            }

            this.previewContent = report.content;
            previewEl.value = report.content;

            new Notice('报告生成成功！');
        } catch (error) {
            console.error('Report generation error:', error);
            new Notice(`生成失败: ${error}`);
        }
    }

    private async saveReport(content: string) {
        if (!content) {
            new Notice('请先生成报告预览');
            return;
        }

        try {
            const folderPath = this.reportType === 'daily'
                ? 'reports/daily'
                : 'reports/monthly';

            const now = Date.now();
            const fileName = this.reportType === 'daily'
                ? `${formatYearMonthDay(now)}.md`
                : `${formatYearMonth(now)}.md`;

            const filePath = `${folderPath}/${fileName}`;

            // Ensure folder exists
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder) {
                await this.app.vault.createFolder(folderPath);
            }

            // Create file
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile instanceof TFile) {
                await this.app.vault.modify(existingFile, content);
            } else {
                await this.app.vault.create(filePath, content);
            }

            new Notice(`报告已保存到 ${filePath}`);
            this.close();
        } catch (error) {
            console.error('Save error:', error);
            new Notice(`保存失败: ${error}`);
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
