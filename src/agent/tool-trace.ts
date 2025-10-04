import * as fs from 'fs';
import * as path from 'path';

export interface ToolCallTrace {
  timestamp: string;
  tool: string;
  input: any;
  output: any;
  duration_ms: number;
  success: boolean;
  error?: string;
}

export interface WorkflowTrace {
  workflow_id: string;
  customer: string;
  started_at: string;
  completed_at?: string;
  tool_calls: ToolCallTrace[];
  final_state: any;
}

export class ToolTraceLogger {
  private trace: WorkflowTrace;
  private tracePath: string;

  constructor(workflowId: string, customer: string) {
    this.trace = {
      workflow_id: workflowId,
      customer,
      started_at: new Date().toISOString(),
      tool_calls: [],
      final_state: null
    };

    // Ensure runs directory exists
    const RUNS_DIR = path.join(process.cwd(), 'runs');
    if (!fs.existsSync(RUNS_DIR)) {
      fs.mkdirSync(RUNS_DIR, { recursive: true });
    }

    this.tracePath = path.join(RUNS_DIR, `trace-${workflowId}.json`);
  }

  /**
   * Log a tool call
   */
  logToolCall(
    tool: string,
    input: any,
    output: any,
    duration_ms: number,
    success: boolean = true,
    error?: string
  ): void {
    this.trace.tool_calls.push({
      timestamp: new Date().toISOString(),
      tool,
      input,
      output,
      duration_ms,
      success,
      error
    });

    // Save after each tool call
    this.save();
  }

  /**
   * Set final state and complete trace
   */
  complete(finalState: any): void {
    this.trace.completed_at = new Date().toISOString();
    this.trace.final_state = finalState;
    this.save();
  }

  /**
   * Save trace to file
   */
  private save(): void {
    try {
      fs.writeFileSync(this.tracePath, JSON.stringify(this.trace, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save tool trace:', error);
    }
  }

  /**
   * Get trace path
   */
  getTracePath(): string {
    return this.tracePath;
  }

  /**
   * Get trace summary
   */
  getSummary(): string {
    const totalCalls = this.trace.tool_calls.length;
    const successfulCalls = this.trace.tool_calls.filter(c => c.success).length;
    const totalDuration = this.trace.tool_calls.reduce((sum, c) => sum + c.duration_ms, 0);

    return `
Tool Call Summary:
- Total Calls: ${totalCalls}
- Successful: ${successfulCalls}
- Failed: ${totalCalls - successfulCalls}
- Total Duration: ${totalDuration}ms
- Trace saved to: ${this.tracePath}
    `.trim();
  }
}
