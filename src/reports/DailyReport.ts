import { App, TFile } from 'obsidian';
import { Report, ReportDocument, ReportStats, DEFAULT_DAILY_TEMPLATE } from '../types/report';
import { TeamPluginSettings } from '../types';
import { Summarizer, ProgressCallback } from '../ai/Summarizer';
import { endOfLocalDay, formatHourMinute, formatYearMonthDay, startOfLocalDay } from '../utils/dates';

export class DailyReport {
    private app: App;
    private settings: TeamPluginSettings;
    private summarizer: Summarizer;

    constructor(app: App, settings: TeamPluginSettings, summarizer: Summarizer) {
        this.app = app;
        this.settings = settings;
        this.summarizer = summarizer;
    }

    updateSettings(settings: TeamPluginSettings): void {
        this.settings = settings;
    }

    /**
     * Generate daily report for today
     */
    async generateTodayReport(onProgress?: ProgressCallback): Promise<Report> {
        const now = new Date();
        return await this.generateReport(startOfLocalDay(now), endOfLocalDay(now), onProgress);
    }

    /**
     * Generate daily report for a specific date range
     */
    async generateReport(startTime: number, endTime: number, onProgress?: ProgressCallback): Promise<Report> {
        // Get files modified in range
        const files = this.getModifiedFiles(startTime, endTime);

        // Build report documents
        const documents: ReportDocument[] = await Promise.all(
            files.map(async (file) => {
                const wordCount = await this.getWordCount(file);
                return {
                    path: file.path,
                    title: file.basename,
                    createdAt: file.stat.ctime,
                    modifiedAt: file.stat.mtime,
                    wordCount,
                };
            })
        );

        // Calculate stats
        const stats = await this.calculateStats(files, startTime);

        // Generate summary: Map-Reduce (full text) if AI is configured
        let summary = '';
        if (this.summarizer.isConfigured() && documents.length > 0) {
            try {
                summary = await this.summarizer.mapReduceReport(files, stats, {
                    type: 'daily',
                    includeStats: true,
                    language: this.settings.language,
                }, onProgress);
            } catch (e) {
                console.error('Failed to generate AI summary:', e);
                summary = this.generateBasicSummary(documents);
            }
        } else {
            summary = this.generateBasicSummary(documents);
        }

        const report: Report = {
            id: `daily-${startTime}`,
            type: 'daily',
            title: `日报 - ${formatYearMonthDay(startTime)}`,
            content: '',
            summary,
            dateRange: { start: startTime, end: endTime },
            createdAt: Date.now(),
            documents,
            stats,
        };

        // Generate content from template
        report.content = this.applyTemplate(report);

        return report;
    }

    /**
     * Get files modified within time range
     */
    private getModifiedFiles(startTime: number, endTime: number): TFile[] {
        const files = this.app.vault.getMarkdownFiles();

        return files.filter(file => {
            const mtime = file.stat.mtime;
            return mtime >= startTime && mtime <= endTime;
        }).sort((a, b) => b.stat.mtime - a.stat.mtime);
    }

    /**
     * Calculate report statistics
     */
    private async calculateStats(files: TFile[], startTime: number): Promise<ReportStats> {
        let totalWords = 0;
        let newDocuments = 0;
        let modifiedDocuments = 0;
        let newWords = 0;

        for (const file of files) {
            const wordCount = await this.getWordCount(file);
            totalWords += wordCount;

            if (file.stat.ctime >= startTime) {
                newDocuments++;
                newWords += wordCount;
            } else {
                modifiedDocuments++;
            }
        }

        return {
            totalDocuments: files.length,
            newDocuments,
            modifiedDocuments,
            totalWords,
            newWords,
        };
    }

    /**
     * Get word count for a file
     */
    private async getWordCount(file: TFile): Promise<number> {
        const content = await this.app.vault.cachedRead(file);
        const chineseChars = (content.match(/[\u4e00-\u9fa5]/g) || []).length;
        const englishWords = (content.match(/[a-zA-Z]+/g) || []).length;
        return chineseChars + englishWords;
    }

    /**
     * Generate basic summary without AI
     */
    private generateBasicSummary(documents: ReportDocument[]): string {
        if (documents.length === 0) {
            return '今日暂无文档更新。';
        }

        const docList = documents.slice(0, 5).map(d => d.title).join('、');
        return `今日共更新 ${documents.length} 个文档，包括：${docList}${documents.length > 5 ? ' 等' : ''}。`;
    }

    /**
     * Apply template to generate report content
     */
    private applyTemplate(report: Report): string {
        const template = this.settings.dailyReportTemplate || DEFAULT_DAILY_TEMPLATE;

        let content = template
            .replace('{{date}}', formatYearMonthDay(report.dateRange.start))
            .replace('{{summary}}', report.summary || '')
            .replace('{{stats.totalDocuments}}', String(report.stats.totalDocuments))
            .replace('{{stats.newDocuments}}', String(report.stats.newDocuments))
            .replace('{{stats.modifiedDocuments}}', String(report.stats.modifiedDocuments))
            .replace('{{stats.totalWords}}', String(report.stats.totalWords));

        // Handle documents loop
        const docSection = report.documents.map(doc => {
            return `### ${doc.title}\r\n- 路径: ${doc.path}\r\n- 修改时间: ${formatHourMinute(doc.modifiedAt)}\r\n- 字数: ${doc.wordCount}`;
        }).join('\n\n');

        content = content.replace(/{{#each documents}}[\s\S]*?{{\/each}}/g, docSection);

        return content;
    }

    /**
     * Save report to vault
     */
    async saveReport(report: Report, folderPath: string = 'reports/daily'): Promise<TFile> {
        const fileName = `${formatYearMonthDay(report.dateRange.start)}.md`;
        const filePath = `${folderPath}/${fileName}`;

        // Ensure folder exists
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.app.vault.createFolder(folderPath);
        }

        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, report.content);
            return existing;
        }

        return await this.app.vault.create(filePath, report.content);
    }
}
