import { App, TFile } from 'obsidian';
import { Report, ReportDocument, ReportStats, DEFAULT_MONTHLY_TEMPLATE } from '../types/report';
import { TeamPluginSettings } from '../types';
import { Summarizer, ProgressCallback } from '../ai/Summarizer';
import { endOfLocalMonth, formatChineseMonth, formatDateTime, formatYearMonth, formatYearMonthDay, startOfLocalMonth } from '../utils/dates';

export class MonthlyReport {
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
     * Generate monthly report for current month
     */
    async generateCurrentMonthReport(onProgress?: ProgressCallback): Promise<Report> {
        const now = new Date();
        return await this.generateReport(startOfLocalMonth(now), endOfLocalMonth(now), onProgress);
    }

    /**
     * Generate monthly report for a specific month
     */
    async generateReport(startTime: number, endTime: number, onProgress?: ProgressCallback): Promise<Report> {
        // Get all files modified this month
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
        let highlights: string[] = [];

        if (this.summarizer.isConfigured() && documents.length > 0) {
            try {
                const aiReport = await this.summarizer.mapReduceReport(files, stats, {
                    type: 'monthly',
                    includeStats: true,
                    highlightCount: 5,
                    language: this.settings.language,
                }, onProgress);
                summary = aiReport;
                highlights = this.extractHighlights(aiReport);
            } catch (e) {
                console.error('Failed to generate AI summary:', e);
                summary = this.generateBasicSummary(documents, stats);
                highlights = this.generateBasicHighlights(documents);
            }
        } else {
            summary = this.generateBasicSummary(documents, stats);
            highlights = this.generateBasicHighlights(documents);
        }

        const report: Report = {
            id: `monthly-${startTime}`,
            type: 'monthly',
            title: `月报 - ${formatChineseMonth(startTime)}`,
            content: '',
            summary,
            dateRange: { start: startTime, end: endTime },
            createdAt: Date.now(),
            documents,
            stats,
        };

        // Generate content from template
        report.content = this.applyTemplate(report, highlights);

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
        let newWords = 0;
        let newDocuments = 0;
        let modifiedDocuments = 0;

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
    private generateBasicSummary(documents: ReportDocument[], stats: ReportStats): string {
        if (documents.length === 0) {
            return '本月暂无文档更新。';
        }

        return `本月共更新 ${stats.totalDocuments} 个文档，其中新建 ${stats.newDocuments} 个，修改 ${stats.modifiedDocuments} 个。总字数 ${stats.totalWords}，新增字数 ${stats.newWords}。`;
    }

    /**
     * Generate basic highlights
     */
    private generateBasicHighlights(documents: ReportDocument[]): string[] {
        return documents.slice(0, 5).map(doc =>
            `完成文档「${doc.title}」，共 ${doc.wordCount} 字`
        );
    }

    /**
     * Extract highlights from AI report
     */
    private extractHighlights(content: string): string[] {
        const lines = content.split('\n');
        const highlights: string[] = [];
        let inHighlights = false;

        for (const line of lines) {
            if (line.includes('亮点') || line.includes('重点')) {
                inHighlights = true;
                continue;
            }
            if (inHighlights && line.trim().startsWith('-')) {
                highlights.push(line.trim().substring(1).trim());
            }
            if (inHighlights && line.startsWith('#')) {
                break;
            }
        }

        return highlights.length > 0 ? highlights : this.generateBasicHighlights([]);
    }

    /**
     * Apply template to generate report content
     */
    private applyTemplate(report: Report, highlights: string[]): string {
        const template = this.settings.monthlyReportTemplate || DEFAULT_MONTHLY_TEMPLATE;

        let content = template
            .replace('{{month}}', formatChineseMonth(report.dateRange.start))
            .replace('{{summary}}', report.summary || '')
            .replace('{{stats.totalDocuments}}', String(report.stats.totalDocuments))
            .replace('{{stats.newDocuments}}', String(report.stats.newDocuments))
            .replace('{{stats.totalWords}}', String(report.stats.totalWords))
            .replace('{{stats.newWords}}', String(report.stats.newWords));

        // Handle highlights loop
        const highlightSection = highlights.map(h => `- ${h}`).join('\n');
        content = content.replace(/{{#each highlights}}[\s\S]*?{{\/each}}/g, highlightSection);

        // Handle documents loop
        const docSection = report.documents.slice(0, 20).map(doc => {
            return `### ${doc.title}\r\n- 创建时间: ${formatYearMonthDay(doc.createdAt ?? doc.modifiedAt)}\r\n- 最后修改: ${formatDateTime(doc.modifiedAt)}\r\n- 字数: ${doc.wordCount}`;
        }).join('\n\n');

        content = content.replace(/{{#each documents}}[\s\S]*?{{\/each}}/g, docSection);

        return content;
    }

    /**
     * Save report to vault
     */
    async saveReport(report: Report, folderPath: string = 'reports/monthly'): Promise<TFile> {
        const fileName = `${formatYearMonth(report.dateRange.start)}.md`;
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
